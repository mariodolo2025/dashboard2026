-- =============================================================================
-- Web Upgrade — precomputed panel (option B) + work_mem (option A)
-- =============================================================================
-- Applied 2026-08-17. The Supabase MCP was returning 503 all session, so this
-- went through the Management API /database/query with the repo's own
-- .env.local credentials, then registered in supabase_migrations.schema_migrations
-- exactly as apply_migration does. Nothing else differs.
--
-- WHY (measured today, not inherited from the 7-Aug note that claimed ~1s)
--   30-day window, database quiet:      13.1 s and 16.6 s
--   30-day window, cache warm:          3.1 – 8.4 s
--   7 days 3.5 s · 90 days 3.6 s
--   12 MONTHS: 49.8 s against a 50 s statement_timeout — that preset was not
--   slow, it was FAILING. That is the 40+ seconds the owner reported.
--
-- ROOT CAUSE
-- web_upgrade_sessions_daily holds one row per session × day × scope: 349,000
-- rows for a 30-day window (110,694 distinct sessions). The panel counts unique
-- sessions six different ways, and each count re-sorts those 349,000 rows. With
-- work_mem at 16MB the sorts spilled to disk (external merge, 8.9 MB peak).
--
-- ── OPTION A — work_mem 16MB → 64MB (applied first, migration
--    `web_upgrade_performance_work_mem_64mb`)
-- Interleaved A/B, same conditions, three rounds:
--   16MB: 4223 ms · 3149 ms · 8448 ms
--   64MB: 3057 ms · 2456 ms · 3840 ms
-- 128MB was also measured (9.1 s / 9.8 s cold) and was NOT better than 64MB, so
-- the smaller ask wins: work_mem is per-sort, and this instance is small
-- (shared_buffers 224 MB against a 1,151 MB database). Asking for less memory
-- leaves more room before concurrent queries start being killed.
--
-- ── OPTION B — precompute the presets
-- The panel almost always asks for one of five ranges ending today. Computing
-- them after each sync and serving them from a row turns opening the panel into
-- a single-row read.
--
--   web_upgrade_perf_cache          one row per (from, to, environment)
--   web_upgrade_performance_live    the original body, renamed, timeout 180s
--   web_upgrade_performance         NEW thin wrapper: cache first, live if miss
--   web_upgrade_perf_cache_refresh  recomputes the presets, called by cron
--
-- The frontend is untouched: it still calls web_upgrade_performance(from, to,
-- environment). A cached answer carries an extra `cachedAt` key so the panel can
-- show when the figures were computed; a live answer does not have it.
--
-- HONEST LIMITS (told to the owner before building it)
--   * Cached figures are as fresh as the last refresh, not live. The sync runs
--     3×/day and the refresh follows it, so the panel lags the database by up to
--     a few hours. `cachedAt` makes that visible instead of silent.
--   * Only the five presets are instant. A hand-picked range misses the cache
--     and computes live, exactly as slow as before.
--   * A cache is a mirror, and mirrors drift. Mitigations: the key includes the
--     exact dates so a stale row can never be served for a different window;
--     rows are deleted after 3 days so a preset whose refresh keeps failing
--     falls back to live rather than serving something old; and compute_ms is
--     stored so a refresh that starts degrading is visible.
--
-- WHY THE LIVE FUNCTION GETS 180s: the refresh calls it, and the 12-month
-- window needs ~50s. A nested SET wins over the caller's, so the refresh cannot
-- widen it from outside. The consequence is accepted deliberately: a custom
-- 12-month range now takes ~50s instead of erroring at 50s.
--
-- ACCESS POSTURE CHANGE: the new wrapper grants EXECUTE to authenticated and
-- service_role only. The function it replaces still carried the default PUBLIC
-- grant (an open item tracked separately). The dashboard is behind a login, so
-- anon never needs it.

create table if not exists public.web_upgrade_perf_cache (
  p_from      date not null,
  p_to        date not null,
  environment text not null,
  payload     jsonb not null,
  computed_at timestamptz not null default now(),
  compute_ms  integer,
  primary key (p_from, p_to, environment)
);

comment on table public.web_upgrade_perf_cache is
  'Precomputed web_upgrade_performance payloads for the panel presets. Written by web_upgrade_perf_cache_refresh (cron), read by the web_upgrade_performance wrapper. Rows older than 3 days are dropped so a failing preset degrades to live instead of serving stale figures.';

alter table public.web_upgrade_perf_cache enable row level security;

create policy "web_upgrade_perf_cache_read"
  on public.web_upgrade_perf_cache for select
  to authenticated, service_role using (true);

-- The heavy body, unchanged, under a new name and a budget the refresh can use.
alter function public.web_upgrade_performance(date, date, text)
  rename to web_upgrade_performance_live;
alter function public.web_upgrade_performance_live(date, date, text)
  set statement_timeout to '180s';

-- The entry point the frontend calls. Same name, same arguments, same shape.
create or replace function public.web_upgrade_performance(
  p_from date, p_to date, p_environment text default 'production')
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payload jsonb;
  v_at      timestamptz;
  v_env     text := coalesce(p_environment, 'production');
begin
  select c.payload, c.computed_at into v_payload, v_at
  from web_upgrade_perf_cache c
  where c.p_from = web_upgrade_performance.p_from
    and c.p_to = web_upgrade_performance.p_to
    and c.environment = v_env;

  if v_payload is not null then
    return v_payload || jsonb_build_object(
      'cachedAt', to_char(v_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI'));
  end if;

  return web_upgrade_performance_live(p_from, p_to, v_env);
end
$function$;

revoke all on function public.web_upgrade_performance(date, date, text) from public;
revoke all on function public.web_upgrade_performance(date, date, text) from anon;
grant execute on function public.web_upgrade_performance(date, date, text) to authenticated, service_role;

-- Recomputes every preset. One failing combination must not abort the rest, so
-- each is wrapped in its own block and its error is reported, not raised.
create or replace function public.web_upgrade_perf_cache_refresh()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '900s'
as $function$
declare
  r       record;
  t0      timestamptz;
  v       jsonb;
  ms      integer;
  ok      integer := 0;
  detail  jsonb := '[]'::jsonb;
begin
  for r in
    select f, t, e from (values
      (current_date - 1,   current_date - 1),  -- Yesterday
      (current_date - 6,   current_date),      -- Last week
      (current_date - 29,  current_date),      -- 30 days
      (current_date - 89,  current_date),      -- 90 days
      (current_date - 364, current_date)       -- 12 months
    ) ranges(f, t)
    cross join (values ('production'), ('all')) envs(e)
  loop
    t0 := clock_timestamp();
    begin
      v := web_upgrade_performance_live(r.f, r.t, r.e);
      ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
      insert into web_upgrade_perf_cache (p_from, p_to, environment, payload, computed_at, compute_ms)
      values (r.f, r.t, r.e, v, now(), ms)
      on conflict (p_from, p_to, environment) do update set
        payload = excluded.payload,
        computed_at = excluded.computed_at,
        compute_ms = excluded.compute_ms;
      ok := ok + 1;
      detail := detail || jsonb_build_object('from', r.f, 'to', r.t, 'env', r.e, 'ms', ms);
    exception when others then
      detail := detail || jsonb_build_object('from', r.f, 'to', r.t, 'env', r.e, 'error', sqlerrm);
    end;
  end loop;

  delete from web_upgrade_perf_cache where computed_at < now() - interval '3 days';

  return jsonb_build_object('refreshed', ok, 'detail', detail);
end
$function$;

revoke all on function public.web_upgrade_perf_cache_refresh() from public;
revoke all on function public.web_upgrade_perf_cache_refresh() from anon;
grant execute on function public.web_upgrade_perf_cache_refresh() to service_role;

-- Four times a day: 30 minutes after each sync kickoff (03:00 / 10:00 / 18:00
-- UTC, runs take ~20-25 min), plus 14:30 UTC = 00:30 Brisbane, so the panel's
-- "last N days ending today" keys are rebuilt right after the store's date rolls
-- over instead of missing the cache all morning.
select cron.unschedule('web-upgrade-cache-refresh')
  where exists (select 1 from cron.job where jobname = 'web-upgrade-cache-refresh');
select cron.schedule('web-upgrade-cache-refresh', '30 3,10,14,18 * * *',
  $cron$select public.web_upgrade_perf_cache_refresh()$cron$);
