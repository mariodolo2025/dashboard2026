-- Web Upgrade v2 redesign, data prerequisites (mirrors an in-place patch applied 2026-07-27):
--
-- 1. storeShare.upgradeOrderRevenue — full order total of every order that contains at least
--    one attributed (_pesado_source) line. Sits between attributedRevenue (only the lines a
--    module added) and storeRevenue (everything): the middle bar of the Store context modal.
--
-- 2. trend[] gains attributedRevenue + storeRevenue per day, and is now driven by a
--    generate_series over the range (capped at current_date) so days with zero events still
--    appear. Previously trend only carried events/sessions and was drawn nowhere.

do $do$
declare src text;
begin
  select pg_get_functiondef(oid) into src from pg_proc where proname = 'web_upgrade_performance';

  src := replace(src,
    $old1$'upgradeOrders', (select count(distinct order_id) from sales),$old1$,
    $new1$'upgradeOrders', (select count(distinct order_id) from sales),
      'upgradeOrderRevenue', (select round(coalesce(sum(b2.rev), 0)) from basket b2 where b2.order_id in (select distinct order_id from sales)),$new1$);

  src := replace(src,
    $old2$'trend', (select coalesce(jsonb_agg(jsonb_build_object('d', to_char(d, 'YYYY-MM-DD'), 'events', cnt, 'sessions', sess) order by d), '[]'::jsonb) from (
      select d, count(*) cnt, count(distinct attribution_id) sess from ev group by d) t)$old2$,
    $new2$'trend', (select coalesce(jsonb_agg(jsonb_build_object(
      'd', to_char(days.d, 'YYYY-MM-DD'), 'events', coalesce(t.cnt, 0), 'sessions', coalesce(t.sess, 0),
      'attributedRevenue', coalesce(ar.rev, 0), 'storeRevenue', coalesce(sr.rev, 0)) order by days.d), '[]'::jsonb)
    from (select generate_series(p_from, least(p_to, current_date), interval '1 day')::date d) days
    left join (select d, count(*) cnt, count(distinct attribution_id) sess from ev group by d) t on t.d = days.d
    left join (select s.order_date dd, round(coalesce(sum(s.net_aud), 0)) rev from sales s group by s.order_date) ar on ar.dd = days.d
    left join (select l.order_date dd,
                      round(sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end)) rev
               from shopify_sales_lines l
               left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
               where l.order_date between p_from and p_to
               group by l.order_date) sr on sr.dd = days.d)$new2$);

  if src not like '%upgradeOrderRevenue%' then raise exception 'patch 1 (upgradeOrderRevenue) did not apply'; end if;
  if src not like '%storeRevenue%' then raise exception 'patch 2 (trend) did not apply'; end if;

  execute src;
end $do$;

notify pgrst, 'reload schema';
