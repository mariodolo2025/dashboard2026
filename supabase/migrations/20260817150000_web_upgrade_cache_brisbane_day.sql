-- =============================================================================
-- Web Upgrade cache — key the presets on the BRISBANE day, not the UTC day
-- =============================================================================
-- Applied 2026-08-17 (Management API; the MCP was 503 all session).
--
-- THE BUG, caught minutes after shipping the cache: the refresh built its keys
-- from `current_date`, which is the database's UTC day, while the panel asks
-- for the store's Brisbane day (src/lib/storeDate.ts exists precisely because
-- of this distinction — and this function walked straight into it).
--
-- Brisbane is UTC+10, so from 14:00 UTC until midnight UTC the store is already
-- on the next day. During those ten hours EVERY preset missed the cache and
-- fell through to the live path. Observed live through the browser: the panel
-- asked for 2026-07-19 → 2026-08-17 while the cache held 2026-07-18 →
-- 2026-08-16, and the call took 9.48 s instead of the ~10 ms a hit costs.
--
-- Same class of mistake this project already documented for the B2C explorer
-- ("the dashboard asked for the previous day between midnight and 10am").
--
-- Only the date source changes. Everything else — the five presets, the two
-- environments, the per-combination error isolation, the 3-day cleanup — is
-- unchanged. The returned jsonb now also reports which Brisbane day it built,
-- so a future mismatch is visible in the cron log instead of silent.

create or replace function public.web_upgrade_perf_cache_refresh()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '900s'
as $function$
declare
  today  date := (now() at time zone 'Australia/Brisbane')::date;
  r      record;
  t0     timestamptz;
  v      jsonb;
  ms     integer;
  ok     integer := 0;
  detail jsonb := '[]'::jsonb;
begin
  for r in
    select f, t, e from (values
      (today - 1,   today - 1),  -- Yesterday
      (today - 6,   today),      -- Last week
      (today - 29,  today),      -- 30 days
      (today - 89,  today),      -- 90 days
      (today - 364, today)       -- 12 months
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
