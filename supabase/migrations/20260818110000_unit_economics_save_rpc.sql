-- =============================================================================
-- Advertising — the workbook constants can be updated without a developer
-- =============================================================================
-- Applied 2026-08-18 (Management API; MCP intermittent this session).
--
-- WHY. Mario, looking at the tab: "de donde sale ese target mer de 2.77? porque
-- parece estar hardcodeado en ambas capturas."
--
-- It is not hardcoded — breakeven and target are derived by advertising_dashboard
-- from advertising_unit_economics, and there is no literal anywhere in the UI.
-- But he was right in practice: that table held exactly ONE row, July 2026,
-- inserted by a migration (updated_by 'claude-plan6'), and nothing in the
-- product could add the next month. A number that can only change when a
-- developer writes SQL is, from the outside, indistinguishable from a constant.
--
-- Same posture as advertising_plan_save: SECURITY DEFINER, the table keeps its
-- SELECT-only policies, and the actor is taken from the session JWT so the
-- client cannot claim to be someone else.
--
-- The six inputs are exactly the cells of Juan's monthly workbook. The two MER
-- thresholds stay DERIVED in the dashboard RPC — they are never stored, so they
-- cannot drift from the inputs they come from.
--
-- VALIDATION mirrors the table's CHECK constraints and adds the one they cannot
-- express: cm1 − target margin − fixed/revenue must be positive, otherwise no
-- finite MER reaches the target and the verdict chart would be drawing a line
-- that means nothing. Rejected with a named error the UI can explain.

create or replace function public.advertising_unit_economics_save(
  p_month                 date,
  p_cm1_pct               numeric,
  p_fixed_costs_usd       numeric,
  p_revenue_per_order_usd numeric,
  p_pct_new_customers     numeric,
  p_target_margin_pct     numeric,
  p_baseline_revenue_usd  numeric,
  p_source                text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor text;
  v_month date := date_trunc('month', p_month)::date;
  v_den   numeric;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  v_actor := coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', ''),
    auth.uid()::text);

  if p_cm1_pct is null or p_cm1_pct <= 0 or p_cm1_pct >= 1 then
    raise exception 'CM1_INVALID' using errcode = '22023';
  end if;
  if p_target_margin_pct is null or p_target_margin_pct < 0 or p_target_margin_pct >= 1 then
    raise exception 'TARGET_MARGIN_INVALID' using errcode = '22023';
  end if;
  if p_fixed_costs_usd is null or p_fixed_costs_usd < 0 then
    raise exception 'FIXED_COSTS_INVALID' using errcode = '22023';
  end if;
  if p_revenue_per_order_usd is null or p_revenue_per_order_usd <= 0 then
    raise exception 'REVENUE_PER_ORDER_INVALID' using errcode = '22023';
  end if;
  if p_pct_new_customers is null or p_pct_new_customers <= 0 or p_pct_new_customers > 1 then
    raise exception 'PCT_NEW_INVALID' using errcode = '22023';
  end if;
  if p_baseline_revenue_usd is null or p_baseline_revenue_usd <= 0 then
    raise exception 'BASELINE_REVENUE_INVALID' using errcode = '22023';
  end if;

  -- The one the table's CHECKs cannot see: the target must be reachable.
  v_den := p_cm1_pct - p_target_margin_pct - (p_fixed_costs_usd / p_baseline_revenue_usd);
  if v_den <= 0 then
    raise exception 'TARGET_UNREACHABLE' using errcode = '22023';
  end if;

  insert into advertising_unit_economics
    (month, cm1_pct, fixed_costs_usd, revenue_per_order_usd, pct_new_customers,
     target_margin_pct, baseline_revenue_usd, source, updated_by, updated_at)
  values
    (v_month, p_cm1_pct, p_fixed_costs_usd, p_revenue_per_order_usd, p_pct_new_customers,
     p_target_margin_pct, p_baseline_revenue_usd,
     nullif(btrim(coalesce(p_source, '')), ''), v_actor, now())
  on conflict on constraint advertising_unit_economics_pkey do update set
    cm1_pct               = excluded.cm1_pct,
    fixed_costs_usd       = excluded.fixed_costs_usd,
    revenue_per_order_usd = excluded.revenue_per_order_usd,
    pct_new_customers     = excluded.pct_new_customers,
    target_margin_pct     = excluded.target_margin_pct,
    baseline_revenue_usd  = excluded.baseline_revenue_usd,
    source                = excluded.source,
    updated_by            = excluded.updated_by,
    updated_at            = now();

  return jsonb_build_object(
    'month', to_char(v_month, 'YYYY-MM'),
    'breakevenMer', round(1 / p_cm1_pct, 2),
    'targetMer', round(1 / v_den, 2),
    'updatedBy', v_actor);
end
$function$;

revoke all on function public.advertising_unit_economics_save(date, numeric, numeric, numeric, numeric, numeric, numeric, text) from public;
revoke all on function public.advertising_unit_economics_save(date, numeric, numeric, numeric, numeric, numeric, numeric, text) from anon;
grant execute on function public.advertising_unit_economics_save(date, numeric, numeric, numeric, numeric, numeric, numeric, text) to authenticated, service_role;
