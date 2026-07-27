-- storeShare.preLaunchAov — the store's average order value BEFORE the upgrades,
-- so the counterfactual in the Store context modal compares module orders against
-- the pre-launch store instead of against today's other shoppers (which was
-- circular: same window, same season, self-selected groups).
--
-- Window: the frozen 84-day baseline period (2026-04-29 → 2026-07-21), read from
-- web_upgrade_baseline so it stays tied to the same pre-launch snapshot the
-- Products view compares against. Same net_aud conversion as the `basket` CTE.
--
-- Mirrors an in-place patch applied 2026-07-28.

do $do$
declare src text;
begin
  select pg_get_functiondef(oid) into src from pg_proc where proname = 'web_upgrade_performance';

  src := replace(src,
$old$act as (
  select sku, sum(quantity) units, sum(net_aud) rev
  from shopify_sales_by_variant
  where order_date between p_from and least(p_to, current_date) group by sku
)
select jsonb_build_object($old$,
$new$act as (
  select sku, sum(quantity) units, sum(net_aud) rev
  from shopify_sales_by_variant
  where order_date between p_from and least(p_to, current_date) group by sku
),
prelaunch_win as (
  select min(period_from) pf, max(period_to) pt from web_upgrade_baseline where window_days = 84
),
prelaunch as (
  select count(*) orders, round(avg(rev), 2) aov, round(avg(units), 2) items
  from (
    select l.order_id,
           sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end) rev,
           sum(l.quantity) units
    from shopify_sales_lines l
    left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
    where l.order_date between (select pf from prelaunch_win) and (select pt from prelaunch_win)
    group by l.order_id) pb
)
select jsonb_build_object($new$);

  src := replace(src,
$old2$      'attributedRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),$old2$,
$new2$      'attributedRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),
      'preLaunchAov', (select aov from prelaunch),
      'preLaunchItems', (select items from prelaunch),
      'preLaunchOrders', (select orders from prelaunch),
      'preLaunchFrom', (select to_char(pf, 'YYYY-MM-DD') from prelaunch_win),
      'preLaunchTo', (select to_char(pt, 'YYYY-MM-DD') from prelaunch_win),$new2$);

  if src not like '%prelaunch_win%' then raise exception 'prelaunch CTE patch did not apply'; end if;
  if src not like '%preLaunchAov%' then raise exception 'preLaunchAov field patch did not apply'; end if;

  execute src;
end $do$;

notify pgrst, 'reload schema';
