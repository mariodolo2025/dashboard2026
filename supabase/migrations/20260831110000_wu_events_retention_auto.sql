-- =============================================================================
-- Automatic retention for upgrade_events (Codex P1, 31-Aug-2026).
--
-- The 30-Aug purge was hand-driven; without automation the table walks back to
-- 662MB (~20k events/day). cron job 14 (hourly, :45) now POSTs
-- wu-events-archive {auto:true}: each call advances ONE slice of an
-- export→purge cycle recorded in wu_archive_state, so no invocation is ever
-- big enough to hurt the 1GB instance.
--
--   idle   → rows older than keepDays(14)? start a cycle (cutoff frozen).
--   export → up to 5 pages to the private wu-archive bucket, cursor advances.
--   purge  → delete ONLY ids <= the exported cursor: a row is provably in the
--            Storage backup before it can die, BY CONSTRUCTION — the 30-Aug
--            manual flow compared counts instead, and late-arriving rows made
--            equality brittle.
--
-- The purge RPC gains p_max_id for that guarantee. The 2-arg signature is
-- dropped and the 3-arg one defaults p_max_id to null, so existing manual
-- callers keep working unchanged.
-- =============================================================================
create table if not exists wu_archive_state (
  id int primary key default 1 check (id = 1),
  phase text not null default 'idle',          -- idle | export | purge
  before_ts timestamptz,
  cursor_id bigint not null default 0,
  part int not null default 0,
  exported bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into wu_archive_state (id) values (1) on conflict (id) do nothing;
alter table wu_archive_state enable row level security;
create policy "service role only" on wu_archive_state
  for all to service_role using (true) with check (true);

drop function if exists wu_events_purge_batch(timestamptz, int);

create or replace function wu_events_purge_batch(p_before timestamptz, p_limit int default 10000, p_max_id bigint default null)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  n int;
begin
  perform set_config('app.web_upgrade_rollup_skip', '1', true);
  delete from upgrade_events
  where id in (
    select id from upgrade_events
    where event_timestamp < p_before
      and (p_max_id is null or id <= p_max_id)
    order by id
    limit p_limit
  );
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function wu_events_purge_batch(timestamptz, int, bigint) from public;
revoke all on function wu_events_purge_batch(timestamptz, int, bigint) from anon;
revoke all on function wu_events_purge_batch(timestamptz, int, bigint) from authenticated;
grant execute on function wu_events_purge_batch(timestamptz, int, bigint) to service_role;

-- cron job 14: '45 * * * *' → net.http_post(.../wu-events-archive, {"auto":true})
-- with the anon JWT header, same shape as the sync kickoff jobs. Applied via
-- cron.schedule; recorded here for the repo.
