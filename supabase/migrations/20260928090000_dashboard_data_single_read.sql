-- =============================================================================
-- The front page and By Channel read their period in ONE statement
-- =============================================================================
-- Mario, 2026-09-28, on the "Failed to load data: HTTP error! status: 500"
-- popup: "me tiene los huevos al plato este error, hace meses que esta y nunca lo
-- arreglas, basta." Then, on the plan: "hacelo".
--
-- WHAT THE LOGS SAID (last 24 h before this migration): 21 of 75 loads failed,
-- every one with "unleashed_sales_lines: canceling statement due to statement
-- timeout". PostgREST cancels any statement after 8 s.
--
-- WHY. dashboard-data read four tables in 1,000-row pages, ~40 requests per
-- period, and any one of them running past 8 s took the whole screen down:
--
--   - Unleashed lines were paged by id. For a filtered range the planner chose
--     to walk the primary key over all 212,154 rows, filtering as it went:
--     4.2 s for June with every page in memory, past 8 s whenever the database
--     was busy (the 03:00 UTC sync, the 5-minute Shopify sync).
--   - Shopify was paged by OFFSET over a GROUP BY view, so every page
--     re-aggregated everything before it: 21 pages for a year, the last one
--     alone 2.4 s. It had not failed yet; it was next.
--   - Even the plain date-range read of Unleashed lines touched 141k rows to
--     keep 11k, because 95% of them are Shopify orders mirrored into Unleashed
--     under Web customers that the screen throws away.
--
-- The same popup has been there for months with DIFFERENT causes — the parsed
-- CSV snapshot running out of memory until 21-Sep, then a sequential scan on
-- aim2026_demand_detail, then this. Each fix moved the slow spot instead of
-- removing the pattern. This removes the pattern:
--
--   1. Two indexes built for exactly this read (created CONCURRENTLY on
--      2026-09-28; the statements below are no-ops that document them):
--        - Unleashed lines: only the non-Web rows, carrying every column the
--          screen reads, so the answer comes from the index alone.
--            1 year: 4,401 ms -> 235 ms, 0 heap fetches.
--        - Shopify lines: (day, sku, country) carrying the money columns, so
--          the view aggregates straight off the index.
--            1 year, whole: 197 ms (was 21 pages, the last 2.4 s).
--   2. dashboard_data(): every array the screen needs, in one statement, one
--      round trip. No pages, no 1,000-row cap, no 40 chances to fail.
--
-- FAITHFULNESS. Nothing here changes a number. Unleashed rows are the same
-- rows (the Web filter in this function is the index's superset; dashboard-data
-- still applies the exact filter it applied before). Shopify comes from the
-- same shopify_sales_by_variant view, so its formulas cannot drift. Costs are
-- the same Default Purchase Price and landed_cost_rates row.

create index if not exists idx_usl_dashboard_nonweb
  on public.unleashed_sales_lines (order_date)
  include (id, order_number, product_code, product, customer, quantity, sub_total, status, warehouse, product_group, customer_type)
  where source in ('frozen','api')
    and (lower(btrim(coalesce(customer_type, ''))) <> 'web' or lower(btrim(customer)) like '%-onlinesale');

comment on index public.idx_usl_dashboard_nonweb is
  'dashboard_data(): the non-Web sales lines by day, carrying every column the front page and By Channel read. The predicate must stay textually identical to the one in dashboard_data() or the planner stops using it.';

create index if not exists idx_ssl_dashboard_day
  on public.shopify_sales_lines (order_date, sku, country)
  include (currency, quantity, net_native, net_usd, taxes_usd, shipping_usd)
  where source = 'api';

comment on index public.idx_ssl_dashboard_day is
  'dashboard_data() via shopify_sales_by_variant: lets the view aggregate a period straight off the index. Keep the INCLUDE list in step with the columns that view sums.';

create or replace function public.dashboard_data(p_from date, p_to date)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
-- Headroom, not the plan: a year measures ~0.5 s. The 8 s PostgREST default
-- is what turned a busy minute into a failed screen.
set statement_timeout = '30s'
as $function$
  select json_build_object(
    'unleashed', coalesce((
      select json_agg(u)
      from (
        select l.id, l.order_date, l.order_number, l.product_code, l.product, l.customer,
               l.quantity, l.sub_total, l.status, l.warehouse, l.product_group, l.customer_type
        from public.unleashed_sales_lines l
        where l.source in ('frozen','api')
          -- Identical to idx_usl_dashboard_nonweb's predicate: a superset of
          -- the screen's Web rule. dashboard-data applies the exact rule.
          and (lower(btrim(coalesce(l.customer_type, ''))) <> 'web' or lower(btrim(l.customer)) like '%-onlinesale')
          and l.order_date >= coalesce(p_from, date '1900-01-01')
          and l.order_date <= coalesce(p_to, date '2999-12-31')
      ) u), '[]'::json),
    'shopify', coalesce((
      select json_agg(s)
      from (
        select v.order_date, v.sku, v.country, v.quantity, v.net_aud, v.taxes_aud, v.shipping_aud
        from public.shopify_sales_by_variant v
        where v.order_date >= coalesce(p_from, date '1900-01-01')
          and v.order_date <= coalesce(p_to, date '2999-12-31')
      ) s), '[]'::json),
    'meta', coalesce((
      select json_agg(m)
      from (
        select d.date, d.currency, d.spend, d.conversion_value
        from public.meta_ads_daily d
        where d.date >= coalesce(p_from, date '1900-01-01')
          and d.date <= coalesce(p_to, date '2999-12-31')
      ) m), '[]'::json),
    'params', coalesce((
      select json_agg(p)
      from (select sku, product_cost_china from public.aim2026_sku_parameters) p), '[]'::json),
    'fx', coalesce((
      select json_agg(f)
      from (select year, month, rate from public.currency_exchange_rates) f), '[]'::json),
    'landedRates', (
      select c.config_data -> 'default'
      from public.aim2026_cost_config c
      where c.config_type = 'landed_cost_rates'
      limit 1)
  );
$function$;

comment on function public.dashboard_data(date, date) is
  'Everything the front page and By Channel need for a period, in one statement: non-Web Unleashed sales lines (AUD), Shopify by day/sku/country (shopify_sales_by_variant), Meta spend, Default Purchase Prices, FX and landing rates. Called only by the dashboard-data edge function (service role). Replaces ~40 paged PostgREST reads that failed whenever one of them passed 8 s.';

revoke all on function public.dashboard_data(date, date) from public, anon, authenticated;
grant execute on function public.dashboard_data(date, date) to service_role;
