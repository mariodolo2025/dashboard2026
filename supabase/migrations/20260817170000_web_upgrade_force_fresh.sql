-- =============================================================================
-- Web Upgrade — the refresh button actually refreshes
-- =============================================================================
-- Applied 2026-08-17 (Management API; MCP 503 all session).
--
-- The panel already had a refresh button (WebUpgradeTab.tsx, next to the date
-- picker). Once the presets started being served from web_upgrade_perf_cache,
-- that button re-fetched the same snapshot: it looked like it worked and did
-- nothing. A control that lies is worse than no control.
--
-- The wrapper gains p_fresh. When true it skips the cache, computes live, AND
-- writes the result back — so the person who waited for the recompute leaves
-- the fresh figures behind for whoever opens the panel next, instead of every
-- viewer paying the same cost.
--
-- Signature change, so the 3-argument version is dropped and recreated in ONE
-- statement — no window where the frontend's call has nothing to resolve to.
-- p_fresh defaults to false, so the existing three-argument call from the
-- frontend keeps resolving to this function unchanged.
--
-- The function becomes VOLATILE (it writes on the fresh path). PostgREST calls
-- RPCs by POST, so nothing about how the frontend invokes it changes.
--
-- `cachedAt` is only attached when the answer really came from the cache. A
-- forced refresh returns without it, so the header flips back to "Live from DB"
-- and the owner can see the difference between the two.

drop function if exists public.web_upgrade_performance(date, date, text);

create function public.web_upgrade_performance(
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
begin
  if not coalesce(p_fresh, false) then
    select c.payload, c.computed_at into v_payload, v_at
    from web_upgrade_perf_cache c
    where c.p_from = web_upgrade_performance.p_from
      and c.p_to = web_upgrade_performance.p_to
      and c.environment = v_env;

    if v_payload is not null then
      return v_payload || jsonb_build_object(
        'cachedAt', to_char(v_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI'));
    end if;
  end if;

  v_payload := web_upgrade_performance_live(p_from, p_to, v_env);

  -- Leave the recompute behind for the next viewer. Never let a cache write
  -- failure lose the answer the user is waiting for.
  begin
    insert into web_upgrade_perf_cache (p_from, p_to, environment, payload, computed_at, compute_ms)
    values (p_from, p_to, v_env, v_payload, now(), null)
    on conflict (p_from, p_to, environment) do update set
      payload     = excluded.payload,
      computed_at = excluded.computed_at,
      compute_ms  = excluded.compute_ms;
  exception when others then
    null;
  end;

  return v_payload;
end
$function$;

revoke all on function public.web_upgrade_performance(date, date, text, boolean) from public;
revoke all on function public.web_upgrade_performance(date, date, text, boolean) from anon;
grant execute on function public.web_upgrade_performance(date, date, text, boolean) to authenticated, service_role;
