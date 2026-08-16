-- =============================================================================
-- Web Upgrade — the forced refresh really does write its result back
-- =============================================================================
-- Applied 2026-08-17 (Management API; MCP 503 all session).
--
-- TWO BUGS, one hiding the other.
--
-- 1. The function's parameters are named p_from / p_to, which are ALSO the
--    column names of web_upgrade_perf_cache, so plpgsql refuses the INSERT with
--    42702 "column reference p_from is ambiguous".
--    Qualifying the VALUES as web_upgrade_performance.p_from is NOT enough: the
--    bare names in `on conflict (p_from, p_to, environment)` collide too, and
--    that clause takes column names, so there is nothing to qualify them with.
--    Proven with a one-function repro before fixing it. The fix targets the
--    primary key BY NAME — `on conflict on constraint web_upgrade_perf_cache_pkey`
--    — which mentions no column names at all.
--    (web_upgrade_perf_cache_refresh was never affected: it has no parameters,
--    so nothing there collides.)
--
-- 2. That failure was invisible because the write was wrapped in
--    `exception when others then null` — added deliberately so a cache problem
--    could never lose the answer the user is waiting for. It did its job and
--    swallowed a genuine bug with it. Verified from the browser: the refresh
--    button recomputed for 10.18 s, flipped the header to "Live from DB", and
--    left the stored snapshot untouched at its old timestamp.
--
-- Fix: qualify the parameters, and make the handler RAISE WARNING instead of
-- swallowing. The user still gets their answer if the cache write fails, but
-- the failure now appears in the logs instead of nowhere.
--
-- LESSON: a catch-all that discards the error is a place bugs go to hide. If it
-- must not raise, it must still say something.

create or replace function public.web_upgrade_performance(
  p_from        date,
  p_to          date,
  p_environment text default 'production',
  p_fresh       boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '50s'
as $function$
declare
  v_payload jsonb;
  v_at      timestamptz;
  v_env     text := coalesce(p_environment, 'production');
  -- Plain copies so nothing downstream has to fight the parameter/column
  -- name clash again.
  v_from    date := p_from;
  v_to      date := p_to;
begin
  if not coalesce(p_fresh, false) then
    select c.payload, c.computed_at into v_payload, v_at
    from web_upgrade_perf_cache c
    where c.p_from = v_from and c.p_to = v_to and c.environment = v_env;

    if v_payload is not null then
      return v_payload || jsonb_build_object(
        'cachedAt', to_char(v_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI'));
    end if;
  end if;

  v_payload := web_upgrade_performance_live(v_from, v_to, v_env);

  -- Leave the recompute behind for the next viewer. Conflict target given BY
  -- CONSTRAINT NAME: a column list here would collide with the parameters.
  begin
    insert into web_upgrade_perf_cache (p_from, p_to, environment, payload, computed_at, compute_ms)
    values (v_from, v_to, v_env, v_payload, now(), null)
    on conflict on constraint web_upgrade_perf_cache_pkey do update set
      payload     = excluded.payload,
      computed_at = excluded.computed_at,
      compute_ms  = excluded.compute_ms;
  exception when others then
    raise warning 'web_upgrade_perf_cache write failed for % .. % / %: %',
      v_from, v_to, v_env, sqlerrm;
  end;

  return v_payload;
end
$function$;

revoke all on function public.web_upgrade_performance(date, date, text, boolean) from public;
revoke all on function public.web_upgrade_performance(date, date, text, boolean) from anon;
grant execute on function public.web_upgrade_performance(date, date, text, boolean) to authenticated, service_role;
