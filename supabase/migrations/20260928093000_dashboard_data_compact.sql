-- =============================================================================
-- dashboard_data(): rows as arrays, the exact Web rule, 60 s of headroom
-- =============================================================================
-- Measured the same day as 20260928090000, under a sync run started on purpose
-- (the test the earlier fixes never had): a month stayed at 0.1-0.4 s, but a
-- 12-month period ranged 1.6-5.5 s while the assemblies step ran, and reached
-- 14 s when two such loads overlapped. Nearly all of it was the database
-- building and shipping JSON — the edge function's own work is 25-95 ms.
--
-- So this ships less:
--   - Rows are JSON ARRAYS, not objects: the column names are no longer
--     repeated on every one of 30,000 rows. Two years went from 13.4 MB to
--     roughly half.
--   - The exact Web rule (Web-type customers dropped unless they are one of the
--     three *-OnlineSale storefronts) now runs here, so customer_type no longer
--     travels. The index predicate stays in the WHERE, textually identical, so
--     the planner keeps using idx_usl_dashboard_nonweb.
--   - is_charge (a line with no product code, which the sync stores with its
--     description in both columns) is decided here, so the description no
--     longer travels either.
--   - Frozen history carries synthetic ids ('frozen-N'); they are sent as null.
--
-- statement_timeout 30 s -> 60 s: long periods during a sync are slow, and a
-- slow answer is better than a failed one. A month needs a fraction of a second.
--
-- Column order is the contract with dashboard-data (see U_* / S_* there):
--   unleashed: [line_id, order_date, order_number, product_code, is_charge,
--               customer, quantity, sub_total, status, warehouse, product_group]
--   shopify:   [order_date, sku, country, quantity, net_aud, taxes_aud, shipping_aud]

create or replace function public.dashboard_data(p_from date, p_to date)
returns json
language sql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '60s'
as $function$
  select json_build_object(
    'format', 'arrays-v1',
    'unleashed', coalesce((
      select json_agg(json_build_array(
               case when l.source = 'api' then l.id end,
               l.order_date, l.order_number, l.product_code,
               (coalesce(l.product_code, '') = coalesce(l.product, '')
                 and not exists (select 1 from public.aim2026_sku_parameters p
                                  where btrim(p.sku) = btrim(l.product_code))),
               l.customer, l.quantity, l.sub_total, l.status, l.warehouse, l.product_group))
      from public.unleashed_sales_lines l
      where l.source in ('frozen','api')
        -- idx_usl_dashboard_nonweb's predicate, verbatim, so the index is used:
        and (lower(btrim(coalesce(l.customer_type, ''))) <> 'web' or lower(btrim(l.customer)) like '%-onlinesale')
        -- the screen's exact rule (was applied in the edge function until now):
        and (lower(btrim(coalesce(l.customer_type, ''))) <> 'web'
             or (lower(btrim(l.customer)) like '%-onlinesale'
                 and (lower(btrim(l.customer)) like 'dolo-%'
                      or lower(btrim(l.customer)) like 'artisanbarista-%'
                      or lower(btrim(l.customer)) like 'pesado-%')))
        and l.order_date >= coalesce(p_from, date '1900-01-01')
        and l.order_date <= coalesce(p_to, date '2999-12-31')), '[]'::json),
    'shopify', coalesce((
      select json_agg(json_build_array(v.order_date, v.sku, v.country, v.quantity, v.net_aud, v.taxes_aud, v.shipping_aud))
      from public.shopify_sales_by_variant v
      where v.order_date >= coalesce(p_from, date '1900-01-01')
        and v.order_date <= coalesce(p_to, date '2999-12-31')), '[]'::json),
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
  'Everything the front page and By Channel need for a period, in one statement (format arrays-v1: see migration 20260928093000 for the column order). Non-Web Unleashed sales lines in AUD with the exact storefront rule applied, Shopify by day/sku/country from shopify_sales_by_variant, Meta spend, Default Purchase Prices, FX and landing rates. Called only by the dashboard-data edge function (service role).';

revoke all on function public.dashboard_data(date, date) from public, anon, authenticated;
grant execute on function public.dashboard_data(date, date) to service_role;
