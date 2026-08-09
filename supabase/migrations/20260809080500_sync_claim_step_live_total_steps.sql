-- sync_claim_step: trust the caller's live STEPS.length, not the frozen row.
--
-- Design gap this closes: sync_runs.total_steps is written once at kickoff,
-- and the claim gate was `cursor < total_steps` (frozen), while the
-- orchestrator's TS pre-check compares `cursor >= STEPS.length` against the
-- constant compiled into the CURRENTLY DEPLOYED function. If a deploy changes
-- the number of steps while a run is in flight, the two disagree:
--   * STEPS grows (17 -> 18): at cursor 17 the TS pre-check (17 >= 18) says
--     "keep going" but the frozen gate (17 < 17) refuses every claim -> each
--     driver tick returns busy -> the run wedges until the 40-minute
--     STUCK_MINUTES backstop fails it, and the new final step never runs.
--   * STEPS shrinks: the TS marks the run done early; the row keeps a stale
--     total_steps. Cosmetic — the dangerous case is the wedge above.
--
-- Fix (one source of truth): the orchestrator now passes its live
-- STEPS.length as p_total_steps. Both gates use
-- coalesce(p_total_steps, total_steps), and a successful claim refreshes the
-- row's total_steps to the live value so observers can never permanently
-- disagree with the code. p_total_steps defaults to null, so the previously
-- deployed orchestrator keeps its exact old behaviour between applying this
-- migration and deploying the new function code.
--
-- The 3-arg signature must be DROPPED, not kept alongside: PostgREST would
-- see the call { p_run_id, p_lock_minutes, p_max_attempts } match both the
-- 3-arg function and the 4-arg one (via its default) and fail the RPC with
-- 300 Multiple Choices.

drop function if exists sync_claim_step(bigint, int, int);

create or replace function sync_claim_step(
  p_run_id bigint,
  p_lock_minutes int,
  p_max_attempts int default 3,
  p_total_steps int default null
)
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
      and cursor < coalesce(p_total_steps, total_steps)
      and attempts >= v_max
      and (locked_at is null or locked_at < now() - make_interval(mins => v_lock));

  -- Claim: only if the lock is free or dead (older than v_lock ⇒ worker gone).
  -- Gate on the live length; a successful claim also refreshes total_steps.
  return query
    update sync_runs
      set locked_at = now(), updated_at = now(), attempts = attempts + 1,
          total_steps = coalesce(p_total_steps, total_steps)
      where id = p_run_id
        and status = 'running'
        and cursor < coalesce(p_total_steps, total_steps)
        and (locked_at is null or locked_at < now() - make_interval(mins => v_lock))
      returning *;
end $$;

-- Service-role only, same policy as 20260710010000_sync_hardening.sql.
-- (anon/authenticated are granted by Supabase default privileges on new
-- functions, so they must be revoked explicitly.)
revoke all on function sync_claim_step(bigint, int, int, int) from public, anon, authenticated;
grant execute on function sync_claim_step(bigint, int, int, int) to service_role;
