-- =============================================================================
-- Two mitigations for the 57014 a user query hit during a cache-refresh burst
-- (2026-09-02 ~20:40, shopify_sku_stats_multi FY window, 1GB instance):
--
-- 1. Tiered staleness in the WU cache tick. The heavy combo (launch→today,
--    ~54s compute) was refreshing every 6h like the light ones, and each
--    recompute saturates the box for ~1 min. Its data moves daily at most:
--    refresh it every 24h. Panel-critical light combos stay at 6h.
--    Heavy = ord%10 >= 5 (prios 5/6 collapse to launch→today while the
--    launch is <90 days old; the modulo also covers the 'all' twin at +10).
--
-- 2. authenticated statement_timeout 8s → 15s. A user-facing query that
--    normally runs 2-4s should survive a busy minute instead of erroring.
--    anon stays at 3s.
-- =============================================================================

create or replace function public.web_upgrade_perf_cache_refresh_tick()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  launch date := date '2026-07-23';
  today  date := (now() at time zone 'Australia/Brisbane')::date;
  r      record;
  t0     timestamptz;
  v      jsonb;
  ms     integer;
  got    boolean;
begin
  -- one refresh at a time; a slow tick simply makes the next ones no-op
  select pg_try_advisory_lock(hashtext('wu_cache_refresh')) into got;
  if not got then
    return jsonb_build_object('skipped', 'lock held');
  end if;

  -- the single highest-priority combination whose cache is stale.
  -- Light combos (short windows, the panel reads them) go stale at 6h;
  -- the heavy launch→today combo only at 24h — its recompute is the one
  -- that can starve concurrent user queries.
  select f, t, e into r
  from (
    with anchors as (select today d)
    select f, t, e, min(prio + eprio) as ord
    from anchors a
    cross join lateral (values
      (a.d - 30,                     a.d,     1),
      (greatest(a.d - 6,   launch),  a.d,     2),
      (greatest(a.d - 29,  launch),  a.d,     3),
      (a.d - 1,                      a.d - 1, 4),
      (greatest(a.d - 89,  launch),  a.d,     5),
      (greatest(a.d - 364, launch),  a.d,     6)
    ) ranges(f, t, prio)
    cross join (values ('production', 0), ('all', 10)) envs(e, eprio)
    where f <= t
    group by f, t, e
  ) combos
  where not exists (
    select 1 from web_upgrade_perf_cache c
    where c.p_from = combos.f and c.p_to = combos.t and c.environment = combos.e
      and c.computed_at > now() - (case when combos.ord % 10 >= 5
                                        then interval '24 hours'
                                        else interval '6 hours' end)
  )
  order by ord
  limit 1;

  if r.f is null then
    -- nothing stale: use the idle tick for cleanup instead
    delete from web_upgrade_perf_cache where computed_at < now() - interval '3 days';
    perform pg_advisory_unlock(hashtext('wu_cache_refresh'));
    return jsonb_build_object('fresh', true, 'brisbaneToday', today);
  end if;

  t0 := clock_timestamp();
  v := web_upgrade_performance_live(r.f, r.t, r.e);
  ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
  insert into web_upgrade_perf_cache (p_from, p_to, environment, payload, computed_at, compute_ms)
  values (r.f, r.t, r.e, v, now(), ms)
  on conflict (p_from, p_to, environment) do update set
    payload     = excluded.payload,
    computed_at = excluded.computed_at,
    compute_ms  = excluded.compute_ms;

  perform pg_advisory_unlock(hashtext('wu_cache_refresh'));
  return jsonb_build_object('from', r.f, 'to', r.t, 'env', r.e, 'ms', ms);
end
$function$;

alter role authenticated set statement_timeout = '15s';
notify pgrst, 'reload config';
