-- =============================================================================
-- Web Upgrade panel reads the integer visits table; the cache and its job go
-- =============================================================================
-- docs/PLAN-DISK-IO-2026-10-06.md, step A (points 5-7).
--
-- web_upgrade_performance_live now counts distinct visitors in
-- web_upgrade_visits_daily (integer ids, 20261006160000) instead of
-- web_upgrade_sessions_daily (text ids). Nothing else in the function changed.
--
-- Verified before switching, old function vs new, full JSON output equal:
--   yesterday, 7 d, 30 d (production), Aug-2026 (production), 7 d and
--   yesterday (all). The old since-launch call no longer finished (cut at
--   120 s), so that window was checked on the only part that changed: the
--   distinct-visitor count of all 14 scopes over 23-Jul -> 5-Oct and the
--   per-day count of 75 days, old table vs new: all equal.
-- Database time of the new function (6-Oct-2026, Small instance, warm):
--   since launch 3.18 s · 30 d 1.58 s · 7 d 0.39 s · 1 d 0.12 s.
--   Old: 7 d 26 s, 30 d ~100 s, since launch > 120 s.
--
-- With every window computed in seconds, the precomputed cache
-- (web_upgrade_perf_cache) and the job that refreshed it every 10 minutes
-- (web-upgrade-cache-refresh, the one that took the database down on 5-Oct)
-- are removed. No background job is left that could keep retrying.

CREATE OR REPLACE FUNCTION public.web_upgrade_performance_live(p_from date, p_to date, p_environment text DEFAULT 'production'::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
 SET work_mem TO '64MB'
AS $function$
with envs0 as (
  select case when p_environment = 'all'
              then (select coalesce(array_agg(distinct environment), array['production']) from web_upgrade_daily_counts)
              else array[p_environment] end arr
),
-- Integer ids for the visit counts (web_upgrade_visits_daily). Same set of
-- environments as the names above, so every count covers the same rows.
envs as (
  select e.arr,
         coalesce((select array_agg(x.env_id) from web_upgrade_env x where x.environment = any(e.arr)), array[]::smallint[]) eids
  from envs0 e
),
sc_all as (select scope_id from web_upgrade_scope where scope = 'all'),
fxlast as (select rate from currency_exchange_rates order by year desc, month desc limit 1),
dc as (
  -- every count the panel needs, aggregated once over the window
  select module, action, sum(n) n
  from web_upgrade_daily_counts
  where d between p_from and p_to and environment = any((select arr from envs)::text[])
  group by module, action
),
mod_sess as (
  select substring(sc.scope from 8) module, count(distinct v.visitor_id) sessions
  from web_upgrade_scope sc
  join web_upgrade_visits_daily v on v.scope_id = sc.scope_id
  where sc.scope = any(array['module:Compatibility Guide','module:Machine finder (product page)',
                          'module:Compatible Additions (product page)','module:Compatible Additions (cart)',
                          'module:Rewards','module:Other'])
    and v.d between p_from and p_to and v.env_id = any((select eids from envs)::smallint[])
  group by 1
),
rw_scopes as (
  select coalesce(array_agg(distinct 'reward:' || reward_name), array[]::text[]) arr
  from web_upgrade_daily_rewards
  where d between p_from and p_to and environment = any((select arr from envs)::text[])
),
sales as (
  select a.order_id, a.pesado_source, a.order_attribution_id, a.order_date, a.sku, a.quantity,
    coalesce(nullif(btrim(regexp_replace(regexp_replace(a.pesado_machine, '^(Compatible with your|The)\s+', '', 'i'), '^Breville\s*/\s*', '', 'i')), ''), 'Unknown') machine,
    coalesce(nullif(btrim(a.pesado_machine), ''), 'Unknown') machine_raw,
    case
      when a.sku ilike 'PSD-HD%' then 'Shower Screens'
      when a.sku ilike 'PSD-HE%' or a.sku ilike 'EP-BR%' then 'Filter Baskets'
      when a.sku ilike 'PF%' then 'Portafilters'
      when a.sku ilike 'EXT%' or a.sku ilike 'PRE%' then 'Bundles'
      when a.sku ilike 'PSD-puck%' then 'Puck Screens'
      when a.sku ilike '%distribut%' or a.sku ilike '%tamp%' or a.sku ilike '%ring%' or a.sku ilike '%crusher%' then 'Distribution & Prep'
      else 'Accessories' end family,
    case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end net_aud
  from upgrade_order_attribution a
  left join shopify_sales_lines l on l.order_id = a.order_id and l.sku = a.sku
  left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
  where (p_environment = 'all' or a.pesado_environment = p_environment)
    and a.order_date between p_from and p_to
),
buyer_ids as (
  select distinct a.pesado_attribution_id aid
  from upgrade_order_attribution a
  where (p_environment = 'all' or a.pesado_environment = p_environment)
    and a.order_date between p_from and p_to
    and a.pesado_attribution_id is not null
),
buyer_vids as (
  select vi.visitor_id from web_upgrade_visitor vi join buyer_ids b on b.aid = vi.attribution_id
),
basket as (
  select l.order_id,
         sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) rev,
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
),
prelaunch_win as (
  select min(period_from) pf, max(period_to) pt from web_upgrade_baseline where window_days = 84
),
prelaunch as (
  select count(*) orders, round(avg(rev), 2) aov, round(avg(units), 2) items
  from (
    select l.order_id,
           sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) rev,
           sum(l.quantity) units
    from shopify_sales_lines l
    left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
    where l.order_date between (select pf from prelaunch_win) and (select pt from prelaunch_win)
    group by l.order_id) pb
)
select jsonb_build_object(
  'params', jsonb_build_object('from', p_from, 'to', p_to, 'environment', p_environment,
                               'weeks', round(web_upgrade_weeks(p_from, p_to), 1)),
  'totals', jsonb_build_object(
    'exposedSessions', (select count(distinct v.visitor_id) from web_upgrade_visits_daily v
                         where v.scope_id = (select scope_id from sc_all) and v.d between p_from and p_to
                           and v.env_id = any((select eids from envs)::smallint[])),
    'totalEvents', (select coalesce(sum(n), 0)::bigint from dc where module not in ('__bar','__meta')),
    'directOrders', (select count(distinct order_id) from sales),
    'directLines', (select count(*) from sales),
    'directRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),
    'assistedOrders', (select count(distinct order_attribution_id) from sales where order_attribution_id is not null)
  ),
  'storeShare', (select jsonb_build_object(
      'storeOrders', count(*),
      'storeRevenue', round(coalesce(sum(rev), 0)),
      'upgradeOrders', (select count(distinct order_id) from sales),
      'upgradeOrderRevenue', (select round(coalesce(sum(b2.rev), 0)) from basket b2 where b2.order_id in (select distinct order_id from sales)),
      'attributedRevenue', (select round(coalesce(sum(net_aud), 0)) from sales),
      'preLaunchAov', (select aov from prelaunch),
      'preLaunchItems', (select items from prelaunch),
      'preLaunchOrders', (select orders from prelaunch),
      'preLaunchFrom', (select to_char(pf, 'YYYY-MM-DD') from prelaunch_win),
      'preLaunchTo', (select to_char(pt, 'YYYY-MM-DD') from prelaunch_win),
      'orderSharePct', case when count(*) > 0 then round(100.0 * (select count(distinct order_id) from sales) / count(*), 1) end,
      'revenueSharePct', case when coalesce(sum(rev), 0) > 0 then round(100.0 * (select coalesce(sum(net_aud), 0) from sales) / sum(rev), 1) end
    ) from basket),
  'orderImpact', web_upgrade_order_impact(p_from, p_to, p_environment),
  'compatibilityBar', (select jsonb_object_agg(v.surface, jsonb_build_object(
      'views', v.views, 'clicks', v.clicks,
      'sessions', coalesce(bs_v.ns, 0), 'clickSessions', coalesce(bs_c.ns, 0),
      'ctr', case when v.views > 0 then round(100.0 * v.clicks / v.views, 1) end))
    from (
      select case when c.action like 'compatibility!_bar!_%' escape '!' then 'mobile' else 'desktop' end surface,
             coalesce(sum(c.n) filter (where c.action like '%!_view' escape '!'), 0)::bigint views,
             coalesce(sum(c.n) filter (where c.action like '%!_click' escape '!'), 0)::bigint clicks
      from dc c where c.module = '__bar'
      group by 1) v
    left join lateral (
      select count(distinct vd.visitor_id) ns from web_upgrade_visits_daily vd
      where vd.scope_id = (select scope_id from web_upgrade_scope where scope = 'bar:' || v.surface || ':view')
        and vd.d between p_from and p_to and vd.env_id = any((select eids from envs)::smallint[])) bs_v on true
    left join lateral (
      select count(distinct vd.visitor_id) ns from web_upgrade_visits_daily vd
      where vd.scope_id = (select scope_id from web_upgrade_scope where scope = 'bar:' || v.surface || ':click')
        and vd.d between p_from and p_to and vd.env_id = any((select eids from envs)::smallint[])) bs_c on true),
  'modules', (select coalesce(jsonb_agg(jsonb_build_object(
      'module', m.module, 'sessions', m.sessions, 'views', m.views, 'selects', m.selects,
      'clicks', m.clicks, 'adds', m.adds,
      'ctr', case when m.views > 0 then round(100.0 * m.clicks / m.views, 1) else null end,
      'addsPerSession', case when m.sessions > 0 then round(m.adds::numeric / m.sessions, 2) else null end,
      'orders', coalesce(so.ords, 0),
      'revenue', coalesce(so.rev, 0),
      'aov', so.aov
    ) order by m.sessions desc, m.module), '[]'::jsonb)
    from (
      select c.module,
        coalesce(max(ms.sessions), 0) sessions,
        coalesce(sum(c.n) filter (where c.action like '%view'), 0)::bigint views,
        coalesce(sum(c.n) filter (where c.action like '%select' or c.action like '%open'), 0)::bigint selects,
        coalesce(sum(c.n) filter (where c.action like '%click'), 0)::bigint clicks,
        coalesce(sum(c.n) filter (where c.action like '%success'), 0)::bigint adds
      from dc c left join mod_sess ms on ms.module = c.module
      where c.module not in ('__bar','__meta') and c.module <> 'Rewards'
      group by c.module) m
    left join (
      select mod as module,
             count(*) ords,
             round(sum(attr_rev)) rev,
             round(avg(basket_rev), 2) aov
      from (
        select web_upgrade_module_of_source(s.pesado_source) mod, s.order_id,
               sum(s.net_aud) attr_rev,
               min(b.rev) basket_rev
        from sales s join basket b on b.order_id = s.order_id
        group by 1, 2) t
      group by mod) so on so.module = m.module),
  'compatFunnel', (select jsonb_build_object(
      'pageViews',   (select coalesce(sum(n), 0)::bigint from dc where module = 'Compatibility Guide' and action = 'compatibility_page_view'),
      'modelSelect', (select coalesce(sum(n), 0)::bigint from dc where module = 'Compatibility Guide' and action = 'compatibility_model_select'),
      'addClicks',   (select coalesce(sum(n), 0)::bigint from dc where module = 'Compatibility Guide' and action = 'compatibility_add_click'),
      'addSuccess',  (select coalesce(sum(n), 0)::bigint from dc where module = 'Compatibility Guide' and action = 'compatibility_add_success'),
      'sessions',    coalesce((select sessions from mod_sess where module = 'Compatibility Guide'), 0),
      'completeKit', (select coalesce(sum(n), 0)::bigint from dc where module = '__meta' and action = '__complete_kit'),
      'orders',      (select count(distinct order_id) from sales where pesado_source like 'compatibility%')
    )),
  'byBrand', (select coalesce(jsonb_agg(jsonb_build_object(
      'brand', brand, 'selects', selects, 'addClicks', clicks, 'adds', adds) order by selects desc, adds desc), '[]'::jsonb) from (
      select coalesce(nullif(bm.brand, ''), 'Unknown') brand,
        coalesce(sum(bm.selects), 0)::bigint selects,
        coalesce(sum(bm.add_clicks), 0)::bigint clicks,
        coalesce(sum(bm.adds), 0)::bigint adds
      from web_upgrade_daily_brand_model bm
      where bm.d between p_from and p_to and bm.environment = any((select arr from envs)::text[])
      group by 1) b),
  'byModel', (select coalesce(jsonb_agg(jsonb_build_object(
      'brand', brand, 'model', model, 'selects', selects, 'addClicks', clicks, 'adds', adds) order by brand, selects desc, adds desc), '[]'::jsonb) from (
      select coalesce(nullif(bm.brand, ''), 'Unknown') brand,
        coalesce(nullif(bm.model, ''), '(model not sent)') model,
        coalesce(sum(bm.selects), 0)::bigint selects,
        coalesce(sum(bm.add_clicks), 0)::bigint clicks,
        coalesce(sum(bm.adds), 0)::bigint adds
      from web_upgrade_daily_brand_model bm
      where bm.d between p_from and p_to and bm.environment = any((select arr from envs)::text[])
      group by 1, 2) mo),
  'byScreen', (select coalesce(jsonb_agg(jsonb_build_object(
      'sku', sku, 'fitment', fitment, 'title', title,
      'clicks', clicks, 'adds', adds, 'attributedRevenue', attr_rev,
      'unitsPerWeek', upw, 'baselineUnitsPerWeek', base_upw,
      'deltaPct', case when base_upw > 0 then round(100.0 * (upw - base_upw) / base_upw, 1) else null end
    ) order by clicks desc nulls last, adds desc), '[]'::jsonb) from (
      select m.sku, web_upgrade_fitment(m.sku) fitment,
             max(coalesce(m.variant_title, m.product_title)) title,
             coalesce(sum(dv.add_clicks), 0)::bigint clicks,
             coalesce(sum(dv.adds), 0)::bigint adds,
             round(coalesce((select sum(s.net_aud) from sales s where s.sku = m.sku), 0)) attr_rev,
             round(coalesce((select a2.units from act a2 where a2.sku = m.sku), 0) / web_upgrade_weeks(p_from, p_to), 1) upw,
             coalesce(web_upgrade_baseline_upw(m.sku, 84), 0) base_upw
      from (select variant_id, sum(add_clicks) add_clicks, sum(adds) adds
            from web_upgrade_daily_variant
            where d between p_from and p_to and environment = any((select arr from envs)::text[])
            group by 1) dv
      join shopify_variant_map m on m.variant_id = dv.variant_id
      where m.sku is not null group by m.sku) sc),
  'rewards', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', reward_name, 'unlocks', n, 'sessions', sess, 'bought', bought) order by tier), '[]'::jsonb) from (
      select r.reward_name,
        case r.reward_name
          when 'free_shipping' then 1 when 'discount_10' then 2 when 'discount_15' then 3 else 9 end tier,
        r.n, coalesce(s.sess, 0) sess, coalesce(s.bought, 0) bought
      from (select reward_name, sum(unlocks)::bigint n
            from web_upgrade_daily_rewards
            where d between p_from and p_to and environment = any((select arr from envs)::text[])
            group by 1) r
      left join (
        select substring(sc.scope from 8) reward_name,
               count(distinct vd.visitor_id) sess,
               count(distinct vd.visitor_id) filter (where vd.visitor_id in (select visitor_id from buyer_vids)) bought
        from web_upgrade_scope sc
        join web_upgrade_visits_daily vd on vd.scope_id = sc.scope_id
        where sc.scope = any((select arr from rw_scopes)::text[])
          and vd.d between p_from and p_to and vd.env_id = any((select eids from envs)::smallint[])
        group by 1) s on s.reward_name = r.reward_name) rw),
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
  'byMachine', (select coalesce(jsonb_agg(jsonb_build_object('machine', machine, 'orders', ords, 'lines', lines, 'revenue', rev, 'variants', variants) order by rev desc, lines desc), '[]'::jsonb) from (
      select machine, count(distinct order_id) ords, count(*) lines, round(coalesce(sum(net_aud), 0)) rev,
             case when count(distinct machine_raw) > 1 then (
               select jsonb_agg(jsonb_build_object('label', label, 'orders', o, 'lines', l, 'revenue', r) order by r desc) from (
                 select s2.machine_raw label, count(distinct s2.order_id) o, count(*) l, round(coalesce(sum(s2.net_aud), 0)) r
                 from sales s2 where s2.machine = mm.machine group by s2.machine_raw) v
             ) end variants
      from sales mm group by machine) mm2),
  'byFamily', (select coalesce(jsonb_agg(jsonb_build_object('family', family, 'lines', lines, 'revenue', rev) order by rev desc, lines desc), '[]'::jsonb) from (
      select family, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by family) ff),
  'trend', (select coalesce(jsonb_agg(jsonb_build_object(
      'd', to_char(days.d, 'YYYY-MM-DD'), 'events', coalesce(tc.cnt, 0), 'sessions', coalesce(ts.sess, 0),
      'attributedRevenue', coalesce(ar.rev, 0), 'storeRevenue', coalesce(sr.rev, 0)) order by days.d), '[]'::jsonb)
    from (select generate_series(p_from, least(p_to, current_date), interval '1 day')::date d) days
    left join (select c.d, sum(c.n)::bigint cnt from web_upgrade_daily_counts c
               where c.d between p_from and p_to and c.environment = any((select arr from envs)::text[])
                 and c.module not in ('__bar','__meta')
               group by c.d) tc on tc.d = days.d
    left join (select vd.d, count(distinct vd.visitor_id) sess from web_upgrade_visits_daily vd
               where vd.scope_id = (select scope_id from sc_all) and vd.d between p_from and p_to
                 and vd.env_id = any((select eids from envs)::smallint[])
               group by vd.d) ts on ts.d = days.d
    left join (select s.order_date dd, round(coalesce(sum(s.net_aud), 0)) rev from sales s group by s.order_date) ar on ar.dd = days.d
    left join (select l.order_date dd,
                      round(sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end)) rev
               from shopify_sales_lines l
               left join currency_exchange_rates r on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
               where l.order_date between p_from and p_to
               group by l.order_date) sr on sr.dd = days.d)
) $function$;

-- The reader keeps its signature (the panel passes p_fresh) and simply
-- computes. 50 s ceiling as before.
create or replace function public.web_upgrade_performance(
  p_from date, p_to date, p_environment text default 'production'::text, p_fresh boolean default false)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '50s'
as $function$
  select public.web_upgrade_performance_live(p_from, p_to, coalesce(p_environment, 'production'));
$function$;

-- The cache and its job.
select cron.unschedule(jobid) from cron.job where jobname = 'web-upgrade-cache-refresh';
delete from public.ops_jobs where jobname = 'web-upgrade-cache-refresh';
drop function if exists public.web_upgrade_perf_cache_refresh_tick();
drop table if exists public.web_upgrade_perf_cache;
drop function if exists public.web_upgrade_performance_live_v2(date, date, text);
