-- =============================================================================
-- Web Upgrade cache — cache the windows the PANEL actually asks for
-- =============================================================================
-- Applied 2026-08-17 (Management API; MCP 503 all session). Third and final
-- correction of the same shipment. Both earlier versions cached windows the
-- panel never requests, so every preset missed and fell through to the live
-- path — measured through the browser at 3.5-9.5 s while a hit costs ~10 ms.
--
-- WHAT THE PANEL ACTUALLY SENDS (read from WebUpgradeTab.tsx, not assumed):
--   * The preset buttons CLAMP `from` to LAUNCH_DAY 2026-07-23 — "there are no
--     events before the theme went live". The component's own comment spells
--     out the consequence: "Once clamped to launch, 30 / 90 / 365 days all
--     collapse onto the same window." So those three presets are ONE window
--     today, not three.
--   * The range the panel opens with is NOT clamped and is not a preset:
--     `{ from: subDays(now, 30), to: now }` — today−30, one day wider than the
--     30-day preset. It is the most common request of all, and neither of my
--     first two versions cached it.
--   * `to` is the store's day. The first version used the database's UTC day,
--     which is a day behind Brisbane for ten hours of every day (fixed in
--     20260817150000; kept here).
--
-- ONLY TODAY IS ANCHORED. A first version also cached today−1 (insurance for a
-- viewer whose browser clock sits west of Brisbane, since the opening range
-- comes from the browser while the presets come from store time). It doubled
-- the work to 16 combinations and the refresh blew past 900 s — each 12-month
-- computation evicts the buffer cache and makes the next one cold, so the cost
-- compounds instead of adding up. Reliability of the cron beats covering a
-- hypothetical viewer: 8 combinations, ~60 s. A foreign-timezone viewer simply
-- gets the live path, which is what they got before any of this existed.
--
-- Windows are de-duplicated before computing, so the collapsed presets are
-- computed once, not three times.
--
-- LESSON, recorded because it cost three attempts: a cache key must be derived
-- from the caller's own rules, not from a plausible reconstruction of them. The
-- panel's clamp and its unclamped default were both in the component, in plain
-- sight, before any of this was written.

create or replace function public.web_upgrade_perf_cache_refresh()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '900s'
as $function$
declare
  launch date := date '2026-07-23';   -- LAUNCH_DAY in WebUpgradeTab.tsx
  today  date := (now() at time zone 'Australia/Brisbane')::date;
  r      record;
  t0     timestamptz;
  v      jsonb;
  ms     integer;
  ok     integer := 0;
  detail jsonb := '[]'::jsonb;
begin
  for r in
    with anchors as (select today d)
    select distinct f, t, e
    from anchors a
    cross join lateral (values
      -- the range the panel opens with: unclamped, today-30
      (a.d - 30, a.d),
      -- presets, `from` clamped to launch exactly as the component does
      (a.d - 1, a.d - 1),
      (greatest(a.d - 6,   launch), a.d),
      (greatest(a.d - 29,  launch), a.d),
      (greatest(a.d - 89,  launch), a.d),
      (greatest(a.d - 364, launch), a.d)
    ) ranges(f, t)
    cross join (values ('production'), ('all')) envs(e)
    where f <= t
  loop
    t0 := clock_timestamp();
    begin
      v := web_upgrade_performance_live(r.f, r.t, r.e);
      ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
      insert into web_upgrade_perf_cache (p_from, p_to, environment, payload, computed_at, compute_ms)
      values (r.f, r.t, r.e, v, now(), ms)
      on conflict (p_from, p_to, environment) do update set
        payload     = excluded.payload,
        computed_at = excluded.computed_at,
        compute_ms  = excluded.compute_ms;
      ok := ok + 1;
      detail := detail || jsonb_build_object('from', r.f, 'to', r.t, 'env', r.e, 'ms', ms);
    exception when others then
      detail := detail || jsonb_build_object('from', r.f, 'to', r.t, 'env', r.e, 'error', sqlerrm);
    end;
  end loop;

  delete from web_upgrade_perf_cache where computed_at < now() - interval '3 days';

  return jsonb_build_object('brisbaneToday', today, 'refreshed', ok, 'detail', detail);
end
$function$;

revoke all on function public.web_upgrade_perf_cache_refresh() from public;
revoke all on function public.web_upgrade_perf_cache_refresh() from anon;
grant execute on function public.web_upgrade_perf_cache_refresh() to service_role;
