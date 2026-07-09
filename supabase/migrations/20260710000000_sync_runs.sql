-- Auto-sync orchestration log. A "run" is one full refresh cycle (Unleashed
-- sales + inventory steps, later Shopify/Meta). Because each step must finish
-- under the 150s edge limit, a run is advanced ONE step per driver tick (a
-- cron every minute), recording each step's result — so the whole thing runs
-- unattended and every update is auditable.
--
--   kickoff cron (N times/day) → creates a run (status='running', cursor=0)
--   driver cron  (every minute) → runs the run's next step, advances cursor
--   when cursor = total_steps   → status='done'
--
-- Each step function keeps its own incremental watermark (fetch only what
-- changed since its last OK), so runs stay light. A step that errors is logged
-- and the run continues; its source's watermark simply isn't advanced, so the
-- next run retries the gap.

create table if not exists sync_runs (
  id bigint generated always as identity primary key,
  status text not null default 'running',     -- running | done | error
  cursor int not null default 0,               -- index of the next step to run
  total_steps int not null,
  steps jsonb not null default '[]'::jsonb,    -- [{ name, status, rows, ms, message, at }]
  trigger text,                                -- cron | button | manual
  locked_at timestamptz,                       -- set while a step is executing; the driver
                                               -- claims it atomically so two ticks can't run
                                               -- the same step at once (a step can outlast the
                                               -- 1-minute driver interval)
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists sync_runs_started_idx on sync_runs (started_at desc);
alter table sync_runs enable row level security;

-- Atomic step claim. Done in raw SQL (not a supabase-js update+select) because
-- the client re-filters the returned row on the just-set locked_at and yields no
-- row, which would make every claim look "busy". Returns the claimed run (0 or 1
-- rows): a row only if the lock was free or older than p_lock_minutes (dead).
create or replace function sync_claim_step(p_run_id bigint, p_lock_minutes int)
returns setof sync_runs
language sql
security definer
set search_path = public
as $$
  update sync_runs
  set locked_at = now(), updated_at = now()
  where id = p_run_id
    and status = 'running'
    and cursor < total_steps
    and (locked_at is null or locked_at < now() - make_interval(mins => p_lock_minutes))
  returning *;
$$;
grant execute on function sync_claim_step(bigint, int) to service_role, anon, authenticated;
