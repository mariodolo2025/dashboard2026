-- =============================================================================
-- Web Upgrade cache refresh: ONE combination per run (Codex P0, 31-Aug-2026).
--
-- The old refresh was a function computing eleven window×environment
-- combinations in a single transaction (~279s of work). Its sub-blocks caught
-- per-combo errors, but a statement timeout on the outer call rolled back
-- EVERYTHING: it failed 20 of its last 28 runs and every failure left the
-- cache exactly as stale as before. Raising the timeout was a band-aid.
--
-- A procedure with per-combo COMMIT was tried first and rejected: pg_cron
-- sends multi-statement commands as one implicit transaction, and the MCP
-- runner wraps calls the same way — COMMIT inside the procedure then dies
-- with "invalid transaction termination" (2D000). The equivalent that needs
-- no transaction control:
--
--   web_upgrade_perf_cache_refresh_tick() — computes the SINGLE highest-
--   priority combination whose cache is older than 6 hours, or cleans up old
--   rows if none is stale. One transaction = one combo. cron job 12 now runs
--   it every 10 minutes, so the full set converges continuously and a slow or
--   killed tick costs one combo, never the set.
--
--   * production combos first, in the order the panel asks for them (the
--     unclamped today-30 it opens with, then 7/30d, yesterday, 90/365d);
--     'all' (QA) last;
--   * pg_try_advisory_lock so ticks never overlap a slow predecessor;
--   * the slowest live combo measures ~113s, inside the cron session's 120s
--     default statement_timeout — and shrinking as the events tables shrink.
--
-- Reader side: web_upgrade_performance now treats cache older than 24 hours
-- as a miss instead of serving it forever (patched in place below). Younger-
-- but-stale keeps serving — falling back to live on mild staleness would
-- resurrect the 50s timeouts the cache exists to prevent.
-- =============================================================================

drop function if exists web_upgrade_perf_cache_refresh();
drop procedure if exists web_upgrade_perf_cache_refresh();

create or replace function web_upgrade_perf_cache_refresh_tick()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  launch date := date '2026-07-23';   -- LAUNCH_DAY in WebUpgradeTab.tsx
  today  date := (now() at time zone 'Australia/Brisbane')::date;
  r      record;
  t0     timestamptz;
  v      jsonb;
  ms     integer;
  got    boolean;
begin
  select pg_try_advisory_lock(hashtext('wu_cache_refresh')) into got;
  if not got then
    return jsonb_build_object('skipped', 'lock held');
  end if;

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
      and c.computed_at > now() - interval '6 hours'
  )
  order by ord
  limit 1;

  if r.f is null then
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
$$;

revoke all on function web_upgrade_perf_cache_refresh_tick() from public;
revoke all on function web_upgrade_perf_cache_refresh_tick() from anon;
revoke all on function web_upgrade_perf_cache_refresh_tick() from authenticated;

-- Reader TTL, applied in place to keep the rest of the wrapper byte-identical.
do $mig$
declare src text; n int; anchor text;
begin
  select pg_get_functiondef(oid) into src from pg_proc where proname = 'web_upgrade_performance';
  anchor := 'where c.p_from = v_from and c.p_to = v_to and c.environment = v_env;';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then
    if src like '%interval ''24 hours''%' then
      raise notice 'reader TTL already applied';
    else
      raise exception 'wrapper anchor x%', n;
    end if;
  else
    src := replace(src, anchor,
      'where c.p_from = v_from and c.p_to = v_to and c.environment = v_env
        and c.computed_at > now() - interval ''24 hours'';');
    execute src;
  end if;
end
$mig$;

-- cron job 12: schedule '*/10 * * * *', command
--   select public.web_upgrade_perf_cache_refresh_tick();
-- (applied via cron.alter_job; recorded here for the repo.)
