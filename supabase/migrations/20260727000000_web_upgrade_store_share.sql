-- storeShare: the weight of the upgrade modules in the WHOLE store for the
-- window — % of all store orders containing a module-added line and % of all
-- store net revenue that is module-attributed. Store totals come from the
-- basket CTE (every order in the window). Patched in place:
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('web_upgrade_performance(date,date,text)'::regprocedure);
  v_def := replace(v_def,
    $$'orderImpact', web_upgrade_order_impact(p_from, p_to, p_environment),$$,
    $$'storeShare', (select jsonb_build_object(
      'storeOrders', count(*),
      'storeRevenue', round(coalesce(sum(rev), 0)),
      'upgradeOrders', (select count(distinct order_id) from sales),
      'attributedRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),
      'orderSharePct', case when count(*) > 0 then round(100.0 * (select count(distinct order_id) from sales) / count(*), 1) end,
      'revenueSharePct', case when coalesce(sum(rev), 0) > 0 then round(100.0 * (select coalesce(sum(net_aud), 0) from sales) / sum(rev), 1) end
    ) from basket),
  'orderImpact', web_upgrade_order_impact(p_from, p_to, p_environment),$$);
  execute v_def;
end $do$;

notify pgrst, 'reload schema';
