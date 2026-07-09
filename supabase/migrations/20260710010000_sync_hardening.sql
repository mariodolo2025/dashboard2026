-- Hardening of the auto-sync orchestrator after an adversarial review.
-- Fixes (stock-integrity first):
--   A) Concurrent double-run of a step: the lock-reclaim window must be LARGER
--      than any step's possible wall-clock, so a reclaim only ever fires on a
--      genuinely dead worker — never on a live background task. LOCK_MINUTES is
--      raised to 10 in the function (edge wall-clock maxes ~400s = 6.7 min).
--   B) Infinite re-run / wedge: a step that keeps killing its worker used to loop
--      forever because each reclaim bumped updated_at and defeated the stale
--      guard. An `attempts` counter (reset to 0 when the cursor advances) caps
--      retries; on the cap the run is marked 'error' so the next kickoff starts
--      fresh instead of the subsystem staying wedged.
--   C) Duplicate concurrent runs: a partial unique index enforces at most one
--      'running' run atomically, so two racing kickoffs (button + cron) can't both
--      insert.
--   D) Security: sync_claim_step is service-role only, and p_lock_minutes is
--      clamped (a negative value used to make the reclaim predicate always true).

-- (B) per-step attempt counter
alter table sync_runs add column if not exists attempts int not null default 0;

-- (C) at most one running run.
-- First collapse any pre-existing duplicate 'running' rows (from pre-hardening
-- kickoff races or a stuck run) — keep the newest, fail the rest — otherwise the
-- unique index below would abort the whole migration on exactly the databases
-- this fix targets. Idempotent: a no-op once at most one running row remains.
update sync_runs set status = 'error', locked_at = null,
    finished_at = coalesce(finished_at, now()), updated_at = now()
  where status = 'running'
    and id not in (select id from sync_runs where status = 'running' order by started_at desc limit 1);

create unique index if not exists sync_runs_one_running on sync_runs (status) where status = 'running';

-- (A,B,D) reworked atomic claim. plpgsql so it can both "give up" and claim.
create or replace function sync_claim_step(p_run_id bigint, p_lock_minutes int, p_max_attempts int default 3)
returns setof sync_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock int := greatest(coalesce(p_lock_minutes, 10), 1); -- clamp: never <= 0 (a negative made reclaim always true)
  v_max  int := greatest(coalesce(p_max_attempts, 3), 1);
begin
  -- Give up: the current step has been claimed too many times (its worker keeps
  -- dying). Only fires at a point where we'd otherwise reclaim (lock free/dead),
  -- so we never fail a run out from under a live worker.
  update sync_runs
    set status = 'error',
        locked_at = null,
        updated_at = now(),
        finished_at = now(),
        steps = steps || jsonb_build_array(jsonb_build_object(
          'name', 'step ' || cursor || ' gave up', 'status', 'error', 'rows', null, 'ms', 0,
          'message', format('exceeded %s attempts', v_max),
          'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
    where id = p_run_id
      and status = 'running'
      and cursor < total_steps
      and attempts >= v_max
      and (locked_at is null or locked_at < now() - make_interval(mins => v_lock));

  -- Claim: only if the lock is free or dead (older than v_lock ⇒ worker gone).
  return query
    update sync_runs
      set locked_at = now(), updated_at = now(), attempts = attempts + 1
      where id = p_run_id
        and status = 'running'
        and cursor < total_steps
        and (locked_at is null or locked_at < now() - make_interval(mins => v_lock))
      returning *;
end $$;

-- (D) service-role only; drop the old 2-arg signature and its over-broad grants.
-- (anon/authenticated are granted by Supabase default privileges on new functions,
-- so they must be revoked explicitly — a `revoke from public` alone doesn't.)
revoke all on function sync_claim_step(bigint, int, int) from public, anon, authenticated;
grant execute on function sync_claim_step(bigint, int, int) to service_role;
drop function if exists sync_claim_step(bigint, int);
