-- =============================================================================
-- Web Upgrade event archive — a cycle that can always finish
-- =============================================================================
-- docs/PLAN-DISK-IO-2026-10-06.md, step B.
--
-- The hourly archive (wu-events-archive, auto mode) has answered HTTP 500 on
-- every call since 31-Aug-2026 18:45 UTC. Its export read
--   where event_timestamp < before and id > cursor order by id limit 5000
-- walking the primary key. Once the last old row was exported, the next page
-- had nothing to find and walked the whole table until the statement timeout
-- cut it (~10 s). The cycle never reached "done", never reached the purge, and
-- upgrade_events grew to ~75 days / 1.65 GB against a 14-day target.
--
-- The new cycle:
--   * Fixes its set at the start: rows with event_timestamp < before AND
--     id <= max_id (the newest id when the cycle began). Rows are immutable,
--     so that set cannot change under it.
--   * Exports one environment at a time in (event_timestamp, id) order, on the
--     existing index (environment, event_timestamp). An empty page ends the
--     environment at once: the index range is simply over.
--   * Purges only what it exported: same set, same environments, in the same
--     (event_timestamp, id) order on the same index, from its own cursor, so
--     it never rescans what it already deleted and always ends.
--   * The purge goes through the same GUC as wu_events_purge_batch, so the
--     slim mirror's trigger does not retract the daily rollups.
--
-- The stuck cycle (before 17-Aug, cursor 425425, 85 parts in until-20260817)
-- is abandoned: the new cycle re-exports those rows into its own folder. The
-- duplicates in Storage are identical rows with the same id.

alter table public.wu_archive_state
  add column if not exists max_id        bigint,
  add column if not exists cursor_env    text,
  add column if not exists cursor_ts     timestamptz,
  add column if not exists envs_done     text[] not null default '{}',
  add column if not exists export_max_id bigint,
  add column if not exists purge_cursor  bigint not null default 0,
  add column if not exists deleted       bigint not null default 0,
  add column if not exists started_at    timestamptz,
  add column if not exists last_message  text,
  -- A call holds the cycle for 3 minutes; an overlapping call (cron and a
  -- manual run) finds it taken and leaves without touching anything.
  add column if not exists locked_until  timestamptz;

comment on column public.wu_archive_state.max_id is
  'Newest upgrade_events id when the cycle started. The cycle''s set is event_timestamp < before_ts AND id <= max_id.';
comment on column public.wu_archive_state.envs_done is
  'Environments whose rows in the set are fully exported. The purge never touches any other.';
comment on column public.wu_archive_state.export_max_id is
  'Highest id exported in this cycle: the purge walks ids up to here and no further.';

-- Distinct environments by skipping along the (environment, event_timestamp)
-- index: one probe per environment, no table scan.
create or replace function public.wu_events_envs()
returns setof text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with recursive e(environment) as (
    (select u.environment from public.upgrade_events u
     where u.environment is not null order by u.environment limit 1)
    union all
    select (select u.environment from public.upgrade_events u
            where u.environment > e.environment order by u.environment limit 1)
    from e where e.environment is not null
  )
  select environment from e where environment is not null;
$function$;

-- One export page: the next rows of one environment in (event_timestamp, id)
-- order. The explicit event_timestamp >= bound lets the index start at the
-- cursor; the row comparison then breaks ties on id.
create or replace function public.wu_events_export_page(
  p_before timestamptz, p_max_id bigint, p_env text,
  p_after_ts timestamptz, p_after_id bigint, p_limit integer default 5000)
returns setof public.upgrade_events
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '60s'
as $function$
  select u.*
  from public.upgrade_events u
  where u.environment = p_env
    and u.event_timestamp < p_before
    and u.id <= p_max_id
    and (p_after_ts is null
         or (u.event_timestamp >= p_after_ts and (u.event_timestamp, u.id) > (p_after_ts, p_after_id)))
  order by u.event_timestamp, u.id
  limit greatest(p_limit, 1);
$function$;

-- Is there anything to archive? One index probe per environment.
create or replace function public.wu_events_oldest()
returns timestamptz
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select min(o.ts) from public.wu_events_envs() env(e)
  cross join lateral (select min(u.event_timestamp) ts from public.upgrade_events u where u.environment = env.e) o;
$function$;

-- One purge batch, in the SAME order and on the SAME index as the export: one
-- environment, rows of the cycle's set after the (event_timestamp, id) cursor.
-- Walking ids instead would, once the old rows ran out, scan every newer row
-- up to the cycle's highest id looking for stragglers - the same unbounded
-- walk that broke the export. Returns how many went and the new cursor.
drop function if exists public.wu_events_purge_range(timestamptz, bigint, text[], bigint, integer);
create or replace function public.wu_events_purge_range(
  p_before timestamptz, p_max_id bigint, p_env text,
  p_after_ts timestamptz, p_after_id bigint, p_limit integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '60s'
as $function$
declare
  ids     bigint[];
  last_ts timestamptz;
  last_id bigint;
  n       int;
begin
  -- The slim mirror's delete trigger must not retract the daily rollups:
  -- these events are archived, not undone (same rule as wu_events_purge_batch).
  perform set_config('app.web_upgrade_rollup_skip', '1', true);

  select array_agg(x.id order by x.event_timestamp, x.id),
         (array_agg(x.event_timestamp order by x.event_timestamp desc, x.id desc))[1],
         (array_agg(x.id order by x.event_timestamp desc, x.id desc))[1]
    into ids, last_ts, last_id
  from (
    select u.id, u.event_timestamp
    from public.upgrade_events u
    where u.environment = p_env
      and u.event_timestamp < p_before
      and u.id <= p_max_id
      and (p_after_ts is null
           or (u.event_timestamp >= p_after_ts and (u.event_timestamp, u.id) > (p_after_ts, p_after_id)))
    order by u.event_timestamp, u.id
    limit greatest(p_limit, 1)
  ) x;

  if ids is null then
    return jsonb_build_object('deleted', 0, 'lastTs', null, 'lastId', null);
  end if;

  delete from public.upgrade_events u where u.id = any(ids);
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n, 'lastTs', last_ts, 'lastId', last_id);
end
$function$;

revoke all on function public.wu_events_envs() from public, anon, authenticated;
revoke all on function public.wu_events_export_page(timestamptz, bigint, text, timestamptz, bigint, integer) from public, anon, authenticated;
revoke all on function public.wu_events_oldest() from public, anon, authenticated;
revoke all on function public.wu_events_purge_range(timestamptz, bigint, text, timestamptz, bigint, integer) from public, anon, authenticated;
grant execute on function public.wu_events_envs() to service_role;
grant execute on function public.wu_events_export_page(timestamptz, bigint, text, timestamptz, bigint, integer) to service_role;
grant execute on function public.wu_events_oldest() to service_role;
grant execute on function public.wu_events_purge_range(timestamptz, bigint, text, timestamptz, bigint, integer) to service_role;

-- Abandon the stuck cycle; the next call starts a clean one.
update public.wu_archive_state set
  phase = 'idle', last_message = 'reset 2026-10-06: the 31-Aug cycle (before 17-Aug, cursor 425425) never finished; restarted with the keyset export',
  updated_at = now()
where id = 1;
