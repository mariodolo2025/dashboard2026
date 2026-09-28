-- =============================================================================
-- dashboard_load_log — every front page / By Channel load, and how it went
-- =============================================================================
-- Mario, 2026-09-28: "me tiene los huevos al plato este error, hace meses que
-- esta y nunca lo arreglas". For months the only monitor of that screen was
-- Mario seeing a popup. The edge-function logs keep a day at most and nobody
-- reads them unprompted.
--
-- dashboard-data writes one row per load: the period asked for, whether it
-- worked, how long it took and, when it failed, why. The Connections panel
-- reads the last 24 h (dashboard_load_health) so a failure, or loads creeping
-- towards the limit, show up there first.
--
-- Small by construction: a few hundred rows a day. Rows older than 90 days are
-- dropped by the same function that reads the panel, so it never needs a job.

create table if not exists public.dashboard_load_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  from_day        date,
  to_day          date,
  ok              boolean not null,
  elapsed_ms      integer,
  rows_unleashed  integer,
  rows_shopify    integer,
  message         text
);

create index if not exists dashboard_load_log_at_idx on public.dashboard_load_log (at desc);

comment on table public.dashboard_load_log is
  'One row per dashboard-data call (front page and By Channel): period, ok/failed, elapsed ms, and the error when it failed. Written by the edge function with the service role; summarised for the Connections panel by dashboard_load_health().';

alter table public.dashboard_load_log enable row level security;
-- No policies: only the service role (edge functions) reads or writes it.

-- ── Summary for the Connections panel ────────────────────────────────────────
create or replace function public.dashboard_load_health()
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v json;
begin
  delete from public.dashboard_load_log where at < now() - interval '90 days';

  select json_build_object(
    'loads24h',   count(*),
    'failed24h',  count(*) filter (where not ok),
    'p95Ms24h',   percentile_disc(0.95) within group (order by elapsed_ms) filter (where ok),
    'maxMs24h',   max(elapsed_ms) filter (where ok),
    'lastFailure', (select json_build_object('at', l.at, 'from', l.from_day, 'to', l.to_day, 'message', l.message)
                      from public.dashboard_load_log l
                     where not l.ok and l.at > now() - interval '24 hours'
                     order by l.at desc limit 1)
  ) into v
  from public.dashboard_load_log
  where at > now() - interval '24 hours';
  return v;
end
$function$;

comment on function public.dashboard_load_health() is
  'Last-24h health of the front page / By Channel loads, for the Connections panel: count, failures, p95 and max elapsed ms, last failure. Also prunes dashboard_load_log rows older than 90 days.';

revoke all on function public.dashboard_load_health() from public, anon, authenticated;
grant execute on function public.dashboard_load_health() to service_role;

-- Added the same day, once the first measurements were in: how much of each
-- load is the database and how much is the edge function's own work.
alter table public.dashboard_load_log add column if not exists db_ms integer;
comment on column public.dashboard_load_log.db_ms is
  'Milliseconds spent waiting for dashboard_data() (the database). elapsed_ms minus this is the edge function''s own work: parsing, mapping, serialising.';
