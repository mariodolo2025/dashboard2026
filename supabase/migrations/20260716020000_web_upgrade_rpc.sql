-- Web Upgrade performance — aggregation RPC for the tab. Joins upgrade_events
-- (on-site funnel) with upgrade_order_attribution (direct sales, joined to
-- shopify_sales_lines for AUD revenue). environment filters preview (test) vs
-- production; commercial stats default to production.
create or replace function web_upgrade_performance(
  p_from date, p_to date, p_environment text default 'production'
) returns jsonb
language sql stable security definer set search_path = public
as $$
with ev as (
  select attribution_id, action, payload, coalesce(event_timestamp, received_at)::date d,
    case
      when action like 'compatibility%' then 'Compatibility Guide'
      when action like 'machine_screen%' then 'Choose your Breville'
      when action like 'product_recommendation%' then 'Compatible Additions'
      when action like 'recommendation%' then 'Complete your setup'
      when action = 'reward_unlocked' then 'Rewards'
      else 'Other' end module
  from upgrade_events
  where (p_environment = 'all' or environment = p_environment)
    and coalesce(event_timestamp, received_at)::date between p_from and p_to
),
sales as (
  select a.order_id, a.pesado_source, a.order_attribution_id, a.order_date,
    case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end net_aud
  from upgrade_order_attribution a
  left join shopify_sales_lines l on l.order_id = a.order_id and l.sku = a.sku
  left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where (p_environment = 'all' or a.pesado_environment = p_environment)
    and a.order_date between p_from and p_to
)
select jsonb_build_object(
  'params', jsonb_build_object('from', p_from, 'to', p_to, 'environment', p_environment),
  'totals', jsonb_build_object(
    'exposedSessions', (select count(distinct attribution_id) from ev),
    'totalEvents', (select count(*) from ev),
    'directOrders', (select count(distinct order_id) from sales),
    'directLines', (select count(*) from sales),
    'directRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),
    'assistedOrders', (select count(distinct order_attribution_id) from sales where order_attribution_id is not null)
  ),
  'modules', (select coalesce(jsonb_agg(jsonb_build_object(
      'module', module, 'sessions', sessions, 'views', views, 'clicks', clicks, 'adds', adds,
      'ctr', case when views > 0 then round(100.0 * clicks / views, 1) else null end,
      'addRate', case when sessions > 0 then round(100.0 * adds / sessions, 1) else null end
    ) order by sessions desc, module), '[]'::jsonb) from (
      select module,
        count(distinct attribution_id) sessions,
        count(*) filter (where action like '%view') views,
        count(*) filter (where action like '%click') clicks,
        count(*) filter (where action like '%success') adds
      from ev where module <> 'Rewards' group by module) m),
  'rewards', (select coalesce(jsonb_agg(jsonb_build_object('name', reward_name, 'unlocks', n, 'sessions', sess) order by reward_name), '[]'::jsonb) from (
      select coalesce(payload->>'reward_name', '?') reward_name, count(*) n, count(distinct attribution_id) sess
      from ev where action = 'reward_unlocked' group by 1) rw),
  'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', pesado_source, 'lines', lines, 'revenue', rev) order by rev desc), '[]'::jsonb) from (
      select pesado_source, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by pesado_source) s),
  'trend', (select coalesce(jsonb_agg(jsonb_build_object('d', to_char(d, 'YYYY-MM-DD'), 'events', cnt, 'sessions', sess) order by d), '[]'::jsonb) from (
      select d, count(*) cnt, count(distinct attribution_id) sess from ev group by d) t)
) $$;

grant execute on function web_upgrade_performance(date, date, text) to anon, authenticated;
