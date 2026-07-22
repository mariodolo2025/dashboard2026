-- Basket impact: AOV and items-per-order for orders that used an upgrade module.
--
-- upgrade_order_attribution only stores the ATTRIBUTED LINES, so it cannot answer
-- "what was the whole order worth" — the order has to be re-joined to
-- shopify_sales_lines and summed in full. Note that order-level history only
-- exists from the API boundary (2026-07-01) onward; before that the sales history
-- is aggregated per (day, sku, country) with no order_id, so this comparison is
-- only meaningful for the live period. That is fine: upgrade attribution starts now.
--
-- Split out as its own function because the null handling matters and is easy to
-- get wrong inline: with zero upgrade orders there is no basket to average and no
-- lift to report. An earlier inline version coalesced the missing average to 0 and
-- confidently reported "-100% AOV" when the honest answer is "nothing to compare".
create or replace function web_upgrade_order_impact(p_from date, p_to date, p_environment text)
returns jsonb language sql stable security definer set search_path = public as $$
with sales as (
  select distinct a.order_id from upgrade_order_attribution a
  where (p_environment = 'all' or a.pesado_environment = p_environment)
    and a.order_date between p_from and p_to
),
basket as (
  select l.order_id,
         sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end) rev,
         sum(l.quantity) units
  from shopify_sales_lines l
  left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where l.order_date between p_from and p_to
  group by l.order_id
),
q as (select b.rev, b.units, exists (select 1 from sales s where s.order_id = b.order_id) is_up from basket b)
select jsonb_build_object(
  'upgradeOrders', (select count(*) from q where is_up),
  'upgradeAov',    (select round(avg(rev), 2)   from q where is_up),
  'upgradeItems',  (select round(avg(units), 2) from q where is_up),
  'otherOrders',   (select count(*) from q where not is_up),
  'otherAov',      (select round(avg(rev), 2)   from q where not is_up),
  'otherItems',    (select round(avg(units), 2) from q where not is_up),
  'aovLiftPct', (select case when u.a is not null and o.a > 0 then round(100.0 * (u.a - o.a) / o.a, 1) end
                 from (select avg(rev) a from q where is_up) u, (select avg(rev) a from q where not is_up) o),
  'itemsLiftPct', (select case when u.a is not null and o.a > 0 then round(100.0 * (u.a - o.a) / o.a, 1) end
                 from (select avg(units) a from q where is_up) u, (select avg(units) a from q where not is_up) o)
) $$;

grant execute on function web_upgrade_order_impact(date, date, text) to anon, authenticated;

-- web_upgrade_performance also changes here:
--  * gains 'orderImpact' (the function above)
--  * bySource gains orders / addedItems / addedPerOrder / aov / itemsPerOrder. AOV
--    and items are the WHOLE basket of those orders. An order that used two modules
--    is counted under each source, so the rows do not sum to the totals.
--  * "Compatible Additions" is split into "(cart)" and "(PDP)". They are two
--    different surfaces: the cart drawer fires recommendation_* with rank/reason/
--    target_tier/gap_before fully populated and writes _pesado_source =
--    compatible_additions, while the PDP panel fires product_recommendation_* with
--    those fields EMPTY and writes product_compatible_additions. Reporting them as
--    one number would hide that difference.
create or replace function web_upgrade_performance(
  p_from date, p_to date, p_environment text default 'production'
) returns jsonb
language sql stable security definer set search_path = public set statement_timeout = '25s'
as $$
with ev as (
  select attribution_id, action, payload, coalesce(event_timestamp, received_at)::date d,
    case
      when action like 'compatibility%'        then 'Compatibility Guide'
      when action like 'machine!_%' escape '!' then 'Machine finder (PDP)'
      when action like 'product_recommendation%' then 'Compatible Additions (PDP)'
      when action like 'recommendation%'       then 'Compatible Additions (cart)'
      when action = 'reward_unlocked'          then 'Rewards'
      else 'Other' end module
  from upgrade_events
  where (p_environment = 'all' or environment = p_environment)
    and coalesce(event_timestamp, received_at)::date between p_from and p_to
),
ev_variant as (
  select action,
         nullif(coalesce(payload->>'variant_id', split_part(payload->>'variant_ids', ',', 1)), '')::bigint vid
  from ev
  where action like '%!_add!_click' escape '!' or action like '%!_add!_success' escape '!'
),
sales as (
  select a.order_id, a.pesado_source, a.order_attribution_id, a.order_date, a.sku, a.quantity,
    coalesce(nullif(btrim(a.pesado_machine), ''), 'Unknown') machine,
    case
      when a.sku ilike 'PSD-HD%' then 'Shower Screens'
      when a.sku ilike 'PSD-HE%' or a.sku ilike 'EP-BR%' then 'Filter Baskets'
      when a.sku ilike 'PF%' then 'Portafilters'
      when a.sku ilike 'EXT%' or a.sku ilike 'PRE%' then 'Bundles'
      when a.sku ilike 'PSD-puck%' then 'Puck Screens'
      when a.sku ilike '%distribut%' or a.sku ilike '%tamp%' or a.sku ilike '%ring%' or a.sku ilike '%crusher%' then 'Distribution & Prep'
      else 'Accessories' end family,
    case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end net_aud
  from upgrade_order_attribution a
  left join shopify_sales_lines l on l.order_id = a.order_id and l.sku = a.sku
  left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where (p_environment = 'all' or a.pesado_environment = p_environment)
    and a.order_date between p_from and p_to
),
basket as (
  select l.order_id,
         sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end) rev,
         sum(l.quantity) units
  from shopify_sales_lines l
  left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where l.order_date between p_from and p_to
  group by l.order_id
),
src_ord as (select distinct pesado_source, order_id from sales),
act as (
  select sku, sum(quantity) units, sum(net_aud) rev
  from shopify_sales_by_variant
  where order_date between p_from and least(p_to, current_date) group by sku
)
select jsonb_build_object(
  'params', jsonb_build_object('from', p_from, 'to', p_to, 'environment', p_environment,
                               'weeks', round(web_upgrade_weeks(p_from, p_to), 1)),
  'totals', jsonb_build_object(
    'exposedSessions', (select count(distinct attribution_id) from ev),
    'totalEvents', (select count(*) from ev),
    'directOrders', (select count(distinct order_id) from sales),
    'directLines', (select count(*) from sales),
    'directRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),
    'assistedOrders', (select count(distinct order_attribution_id) from sales where order_attribution_id is not null)
  ),
  'orderImpact', web_upgrade_order_impact(p_from, p_to, p_environment),
  'modules', (select coalesce(jsonb_agg(jsonb_build_object(
      'module', module, 'sessions', sessions, 'views', views, 'selects', selects, 'clicks', clicks, 'adds', adds,
      'ctr', case when views > 0 then round(100.0 * clicks / views, 1) else null end,
      'addsPerSession', case when sessions > 0 then round(adds::numeric / sessions, 2) else null end
    ) order by sessions desc, module), '[]'::jsonb) from (
      select module,
        count(distinct attribution_id) sessions,
        count(*) filter (where action like '%view') views,
        count(*) filter (where action like '%select' or action like '%open') selects,
        count(*) filter (where action like '%click') clicks,
        count(*) filter (where action like '%success') adds
      from ev where module <> 'Rewards' group by module) m),
  'compatFunnel', (select jsonb_build_object(
      'pageViews',   count(*) filter (where action = 'compatibility_page_view'),
      'modelSelect', count(*) filter (where action = 'compatibility_model_select'),
      'addClicks',   count(*) filter (where action = 'compatibility_add_click'),
      'addSuccess',  count(*) filter (where action = 'compatibility_add_success'),
      'sessions',    count(distinct attribution_id),
      'completeKit', count(*) filter (where payload->>'source' = 'compatibility_complete_kit')
    ) from ev where module = 'Compatibility Guide'),
  'byBrand', (select coalesce(jsonb_agg(jsonb_build_object(
      'brand', brand, 'selects', selects, 'addClicks', clicks, 'adds', adds) order by selects desc, adds desc), '[]'::jsonb) from (
      select coalesce(nullif(payload->>'brand',''), 'Unknown') brand,
        count(*) filter (where action = 'compatibility_model_select') selects,
        count(*) filter (where action = 'compatibility_add_click')    clicks,
        count(*) filter (where action = 'compatibility_add_success')  adds
      from ev where module = 'Compatibility Guide' and payload->>'brand' is not null
      group by 1) b),
  'byScreen', (select coalesce(jsonb_agg(jsonb_build_object(
      'sku', sku, 'fitment', fitment, 'title', title,
      'clicks', clicks, 'adds', adds, 'attributedRevenue', attr_rev,
      'unitsPerWeek', upw, 'baselineUnitsPerWeek', base_upw,
      'deltaPct', case when base_upw > 0 then round(100.0 * (upw - base_upw) / base_upw, 1) else null end
    ) order by clicks desc nulls last, adds desc), '[]'::jsonb) from (
      select m.sku, web_upgrade_fitment(m.sku) fitment,
             max(coalesce(m.variant_title, m.product_title)) title,
             count(*) filter (where e.action like '%click')   clicks,
             count(*) filter (where e.action like '%success') adds,
             round(coalesce((select sum(s.net_aud) from sales s where s.sku = m.sku), 0)) attr_rev,
             round(coalesce((select a2.units from act a2 where a2.sku = m.sku), 0) / web_upgrade_weeks(p_from, p_to), 1) upw,
             coalesce((select b.units_per_week from web_upgrade_baseline b where b.sku = m.sku and b.window_days = 84), 0) base_upw
      from ev_variant e join shopify_variant_map m on m.variant_id = e.vid
      where m.sku is not null group by m.sku) sc),
  'rewards', (select coalesce(jsonb_agg(jsonb_build_object('name', reward_name, 'unlocks', n, 'sessions', sess) order by reward_name), '[]'::jsonb) from (
      select coalesce(payload->>'reward_name', '?') reward_name, count(*) n, count(distinct attribution_id) sess
      from ev where action = 'reward_unlocked' group by 1) rw),
  'bySource', (select coalesce(jsonb_agg(jsonb_build_object(
      'source', src, 'orders', ords, 'lines', lines, 'revenue', rev,
      'addedItems', added, 'addedPerOrder', case when ords > 0 then round(added::numeric / ords, 2) else null end,
      'aov', aov, 'itemsPerOrder', ipo) order by rev desc), '[]'::jsonb) from (
      select s.pesado_source src,
             count(distinct s.order_id) ords, count(*) lines,
             round(coalesce(sum(s.net_aud), 0)) rev,
             coalesce(sum(s.quantity), 0) added,
             (select round(avg(b.rev), 2) from basket b
               where b.order_id in (select o.order_id from src_ord o where o.pesado_source = s.pesado_source)) aov,
             (select round(avg(b.units), 2) from basket b
               where b.order_id in (select o.order_id from src_ord o where o.pesado_source = s.pesado_source)) ipo
      from sales s group by s.pesado_source) q),
  'byMachine', (select coalesce(jsonb_agg(jsonb_build_object('machine', machine, 'orders', ords, 'lines', lines, 'revenue', rev) order by rev desc, lines desc), '[]'::jsonb) from (
      select machine, count(distinct order_id) ords, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by machine) mm),
  'byFamily', (select coalesce(jsonb_agg(jsonb_build_object('family', family, 'lines', lines, 'revenue', rev) order by rev desc, lines desc), '[]'::jsonb) from (
      select family, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by family) ff),
  'trend', (select coalesce(jsonb_agg(jsonb_build_object('d', to_char(d, 'YYYY-MM-DD'), 'events', cnt, 'sessions', sess) order by d), '[]'::jsonb) from (
      select d, count(*) cnt, count(distinct attribution_id) sess from ev group by d) t)
) $$;

grant execute on function web_upgrade_performance(date, date, text) to anon, authenticated;
notify pgrst, 'reload schema';
