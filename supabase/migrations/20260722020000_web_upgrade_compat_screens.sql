-- Web Upgrade tab: compatibility-guide funnel, per-screen engagement, and the
-- before/after against the frozen pre-launch baseline.
--
-- Three corrections ride along:
--  * machine_% now maps to ONE module. The finder fires machine_finder_view /
--    machine_model_select / machine_screen_add_*, but only machine_screen_* was
--    mapped, so its VIEWS landed in "Other" while its clicks landed in the module,
--    leaving that module with a permanently undefined CTR. It is also no longer
--    called "Choose your Breville": Gaggia, E61, La Marzocco and DeLonghi all
--    show up in it.
--  * %select / %open steps were counted nowhere. On a compatibility guide, picking
--    your machine IS the funnel, so it gets its own column.
--  * adds/sessions was labelled a rate but exceeds 100% whenever one session adds
--    twice — it is returned as an average per session instead.
--
-- web_upgrade_weeks caps the window at today: a full-year range divided real sales
-- by future weeks and invented a ~50% drop against the baseline.
create or replace function web_upgrade_weeks(p_from date, p_to date) returns numeric
language sql immutable as $$
  select greatest((least(p_to, current_date) - p_from + 1) / 7.0, 0.1);
$$;

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
      when action like 'product_recommendation%' then 'Compatible Additions'
      when action like 'recommendation%'       then 'Complete your setup'
      when action = 'reward_unlocked'          then 'Rewards'
      else 'Other' end module
  from upgrade_events
  where (p_environment = 'all' or environment = p_environment)
    and coalesce(event_timestamp, received_at)::date between p_from and p_to
),
-- add_click / add_success carry the variant; the guide sends variant_ids as a CSV.
ev_variant as (
  select action,
         nullif(coalesce(payload->>'variant_id', split_part(payload->>'variant_ids', ',', 1)), '')::bigint vid
  from ev
  where action like '%!_add!_click' escape '!' or action like '%!_add!_success' escape '!'
),
sales as (
  select a.order_id, a.pesado_source, a.order_attribution_id, a.order_date, a.sku,
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
  -- The guide, end to end. The middle step (picking your machine) is the heart of
  -- the guide and was invisible in the view/click/add columns alone.
  'compatFunnel', (select jsonb_build_object(
      'pageViews',   count(*) filter (where action = 'compatibility_page_view'),
      'modelSelect', count(*) filter (where action = 'compatibility_model_select'),
      'addClicks',   count(*) filter (where action = 'compatibility_add_click'),
      'addSuccess',  count(*) filter (where action = 'compatibility_add_success'),
      'sessions',    count(distinct attribution_id),
      'completeKit', count(*) filter (where payload->>'source' = 'compatibility_complete_kit')
    ) from ev where module = 'Compatibility Guide'),
  -- compatibility_model_select records the BRAND but not the model, so model is
  -- only known at add time (a theme-side gap, not a query one).
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
      'clicks', clicks, 'adds', adds,
      'attributedRevenue', attr_rev,
      'unitsPerWeek', upw, 'baselineUnitsPerWeek', base_upw,
      'deltaPct', case when base_upw > 0 then round(100.0 * (upw - base_upw) / base_upw, 1) else null end
    ) order by clicks desc nulls last, adds desc), '[]'::jsonb) from (
      select m.sku,
             web_upgrade_fitment(m.sku) fitment,
             max(coalesce(m.variant_title, m.product_title)) title,
             count(*) filter (where e.action like '%click')   clicks,
             count(*) filter (where e.action like '%success') adds,
             round(coalesce((select sum(s.net_aud) from sales s where s.sku = m.sku), 0)) attr_rev,
             round(coalesce((select a2.units from act a2 where a2.sku = m.sku), 0) / web_upgrade_weeks(p_from, p_to), 1) upw,
             coalesce((select b.units_per_week from web_upgrade_baseline b where b.sku = m.sku and b.window_days = 84), 0) base_upw
      from ev_variant e join shopify_variant_map m on m.variant_id = e.vid
      where m.sku is not null
      group by m.sku) sc),
  'rewards', (select coalesce(jsonb_agg(jsonb_build_object('name', reward_name, 'unlocks', n, 'sessions', sess) order by reward_name), '[]'::jsonb) from (
      select coalesce(payload->>'reward_name', '?') reward_name, count(*) n, count(distinct attribution_id) sess
      from ev where action = 'reward_unlocked' group by 1) rw),
  'bySource', (select coalesce(jsonb_agg(jsonb_build_object('source', pesado_source, 'lines', lines, 'revenue', rev) order by rev desc), '[]'::jsonb) from (
      select pesado_source, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by pesado_source) s),
  'byMachine', (select coalesce(jsonb_agg(jsonb_build_object('machine', machine, 'orders', ords, 'lines', lines, 'revenue', rev) order by rev desc, lines desc), '[]'::jsonb) from (
      select machine, count(distinct order_id) ords, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by machine) mm),
  'byFamily', (select coalesce(jsonb_agg(jsonb_build_object('family', family, 'lines', lines, 'revenue', rev) order by rev desc, lines desc), '[]'::jsonb) from (
      select family, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by family) ff),
  'trend', (select coalesce(jsonb_agg(jsonb_build_object('d', to_char(d, 'YYYY-MM-DD'), 'events', cnt, 'sessions', sess) order by d), '[]'::jsonb) from (
      select d, count(*) cnt, count(distinct attribution_id) sess from ev group by d) t)
) $$;

grant execute on function web_upgrade_performance(date, date, text) to anon, authenticated;
notify pgrst, 'reload schema';
