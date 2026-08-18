-- =============================================================================
-- Growth forecast — ad budget → demand → production plan.  Reports tab.
-- =============================================================================
-- One jsonb, same shape as ecommerce_dashboard / advertising_dashboard, so the
-- report makes ONE call. Everything here is MEASURED; the projection itself
-- (elasticity dial, horizon, ramp, production runs) lives in the UI because it
-- is interactive.
--
-- Design notes worth keeping:
--
-- 1. ELASTICITY is fitted here, not in the browser, so both the report and any
--    future consumer read the same number. It is a log-log regression of store
--    revenue on Meta spend: revenue = a x spend^b. b < 1 means each extra dollar
--    buys less — the whole point of the report.
--    p_exclude_months is an explicit, auditable list rather than an outlier
--    rule: JULY 2026 is excluded because that month was the shower-screen
--    changeover (no new creative, no new budget), so it says nothing about
--    saturation. Including it drags b from 0.736 to 0.683 and R2 from 0.892 to
--    0.816. The exclusion is a judgement and is returned in the payload so the
--    UI can show it.
--
-- 2. MER, NOT META ROAS. Meta reported $538k of conversion value in June against
--    $709k of actual Shopify revenue: its ROAS only counts what it can claim.
--    Total store revenue / total ad spend is the honest ratio for "how much will
--    the store sell if I spend more".
--
-- 3. RENAMED SKUS ARE CONSOLIDATED. PSD-HD-EX54 and PSD-HD-54 became
--    PSD-HD-BR54 in Jul-2026, PSD-HD-MV58 became PSD-HD-BR58. Without this the
--    same physical product appears three times, each copy looks small, and the
--    production plan builds stock for SKUs that no longer sell.
--
-- 4. UNIT ECONOMICS ARE READ, NEVER RECALCULATED. cm1 / breakeven / target come
--    from advertising_unit_economics (Juan's workbook) — the same row the
--    Advertising tab reads, so the two screens can never disagree.
--
-- 5. SHIPPING COST COMES FROM XERO, split by market with Starshipit ratios.
--    Starshipit's own freight_charge is NOT used for money: it under-captured
--    DHL eCommerce by $105k. Same method as the starshipit-market edge function.
-- =============================================================================

create or replace function public.growth_forecast_report(
  p_lookback_days   int      default 90,
  p_baseline_months int      default 3,
  p_exclude_months  date[]   default array['2026-07-01']::date[]
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '50s'
as $function$
with
fxlast as (select rate from currency_exchange_rates order by year desc, month desc limit 1),
-- ── Monthly measured series (complete months only) ──────────────────────────
mrev as materialized (
  select date_trunc('month', order_date)::date m,
         sum(net_usd * (select rate from fxlast)) rev
  from shopify_sales_lines
  where order_date >= '2025-07-01'
    and order_date < date_trunc('month', current_date)
  group by 1
),
mspend as materialized (
  select date_trunc('month', a.date)::date m,
         sum(case when a.currency = 'USD' then a.spend * r.rate else a.spend end) spend
  from meta_ads_daily a
  left join currency_exchange_rates r
    on r.year = extract(year from a.date)::int and r.month = extract(month from a.date)::int
  where a.date >= '2025-07-01' and a.date < date_trunc('month', current_date)
  group by 1
),
series as (
  select v.m, s.spend, v.rev, (v.m = any(p_exclude_months)) excluded
  from mrev v join mspend s using (m)
  where s.spend > 0 and v.rev > 0
),
fit as (
  select regr_slope(ln(rev), ln(spend)) b, regr_r2(ln(rev), ln(spend)) r2, count(*) n
  from series where not excluded
),
-- Baseline = the last N complete months, the level the ramp starts from.
base as (
  select avg(spend) spend, avg(rev) rev
  from (select spend, rev from series order by m desc limit p_baseline_months) t
),
-- ── Product mix over the lookback window ────────────────────────────────────
-- Renamed SKUs collapse onto their current code (note 3).
canon as (
  select case sku when 'PSD-HD-EX54' then 'PSD-HD-BR54'
                  when 'PSD-HD-54'   then 'PSD-HD-BR54'
                  when 'PSD-HD-MV58' then 'PSD-HD-BR58'
                  else sku end csku,
         quantity, net_usd
  from shopify_sales_lines
  -- '(no sku)' is the placeholder the sync writes for lines Shopify returns
  -- without a product code (gift cards, manual line items). It is not a product
  -- and must not take a slot in the top-50 or a share of the mix.
  where order_date >= current_date - p_lookback_days
    and sku is not null and sku <> '' and sku <> '(no sku)'
),
mix as (
  select csku, sum(net_usd * (select rate from fxlast)) rev_aud, sum(quantity) units
  from canon group by 1 having sum(quantity) > 0
),
mixtot as (select sum(rev_aud) t from mix),
prod as (
  select m.csku sku,
         left(coalesce(nullif(p.product_description, ''), m.csku), 46) name,
         m.rev_aud / (select t from mixtot) share,
         m.rev_aud / m.units price,
         coalesce((k.kpi_data->>'sohMainWH')::numeric, 0)
           + coalesce((k.kpi_data->>'sohChina')::numeric, 0)
           + coalesce((k.kpi_data->>'container')::numeric, 0) stock,
         coalesce(nullif(p.lead_time_days, 0), 45) lead,
         coalesce(p.product_cost_china, 0) cost,
         -- Assembled goods are built from components: the plan may show a
         -- quantity but the lead time belongs to their parts, so the UI flags
         -- them instead of scheduling a factory run.
         coalesce(a.sku is not null, false) assembled
  from mix m
  left join aim2026_sku_parameters p on p.sku = m.csku
  left join aim2026_kpi_cache k      on k.sku = m.csku
  left join aim2026_assembled_products a on a.sku = m.csku
  order by m.rev_aud desc
  limit 50
),
-- ── US free-shipping threshold (USD — the currency US customers are charged) ─
usord as materialized (
  select order_id, sum(net_usd) usd, sum(shipping_usd) charged
  from shopify_sales_lines
  where country = 'US' and order_date >= current_date - 180
  group by 1
),
ustot as (select count(*) n, avg(usd) aov from usord),
thr(t) as (values (100),(90),(85),(80),(75),(60),(50),(0)),
usthr as (
  select thr.t,
         count(*) filter (where o.usd >= thr.t) orders,
         coalesce(sum(o.charged) filter (where o.usd >= thr.t), 0) give_up
  from thr cross join usord o group by thr.t
),
-- ── Shipping: Xero money, Starshipit destination split (note 5) ─────────────
ratios as (
  select carrier_key,
         sum(freight_charge) filter (where market = 'AU') / nullif(sum(freight_charge), 0) au,
         sum(freight_charge) filter (where market = 'US') / nullif(sum(freight_charge), 0) us,
         sum(freight_charge) filter (where market not in ('AU','US')) / nullif(sum(freight_charge), 0) ot
  from starshipit_market_monthly
  where (year * 100 + month) between 202507 and 202606
  group by 1
),
xf as (
  select case when contact_name ilike '%australia%post%'                        then 'auspost'
              when contact_name ilike '%dhl%e-commerce%'
                or contact_name ilike '%dhl%ecommerce%'                          then 'dhl_ecommerce'
              when contact_name ilike '%ups%'                                    then 'ups' end ck,
         sum(net_amount) amt
  from xero_account_lines
  where account_name = 'Freight & Courier'
    and journal_date between '2025-07-01' and '2026-06-30'
  group by 1
),
shipcost as (
  select sum(x.amt * r.au) au, sum(x.amt * r.us) us, sum(x.amt * r.ot) ot
  from xf x join ratios r on r.carrier_key = x.ck where x.ck is not null
),
shiporders as (
  select sum(orders) filter (where market = 'AU') au,
         sum(orders) filter (where market = 'US') us,
         sum(orders) filter (where market not in ('AU','US')) ot
  from starshipit_market_monthly where (year * 100 + month) between 202507 and 202606
),
shiprev as (
  select sum(revenue_ex_gst) filter (where market = 'AU') au,
         sum(revenue_ex_gst) filter (where market = 'US') us,
         sum(revenue_ex_gst) filter (where market not in ('AU','US')) ot,
         sum(orders) filter (where market = 'AU') oau,
         sum(orders) filter (where market = 'US') ous,
         sum(orders) filter (where market not in ('AU','US')) oot
  from shopify_shipping_revenue_monthly
)
select jsonb_build_object(
  'baselineMonths', p_baseline_months,
  'lookbackDays',   p_lookback_days,
  'baseline', (select jsonb_build_object(
      'spend', round(spend), 'revenue', round(rev),
      'mer', round((rev / nullif(spend, 0))::numeric, 4)) from base),
  'fit', (select jsonb_build_object(
      'b', round(b::numeric, 4), 'r2', round(r2::numeric, 4), 'n', n,
      'excluded', to_jsonb(p_exclude_months)) from fit),
  'history', coalesce((select jsonb_agg(jsonb_build_object(
      'month', to_char(m, 'YYYY-MM'), 'spend', round(spend), 'revenue', round(rev),
      'mer', round((rev / nullif(spend, 0))::numeric, 2), 'excluded', excluded
    ) order by m) from series), '[]'::jsonb),
  'unitEconomics', (select jsonb_build_object(
      'cm1', cm1_pct,
      'breakevenMer', round((1 / nullif(cm1_pct, 0))::numeric, 2),
      -- Juan's operating target: cover fixed costs and leave target_margin_pct.
      'targetMer', round((1 / nullif(cm1_pct - target_margin_pct
          - fixed_costs_usd / nullif(baseline_revenue_usd, 0), 0))::numeric, 2),
      'month', to_char(month, 'YYYY-MM'), 'source', source)
    from advertising_unit_economics order by month desc limit 1),
  'products', coalesce((select jsonb_agg(jsonb_build_object(
      'sku', sku, 'name', name,
      'share', round(share::numeric, 5), 'price', round(price::numeric, 2),
      'stock', round(stock), 'lead', lead, 'cost', round(cost::numeric, 2),
      'assembled', assembled)) from prod), '[]'::jsonb),
  'us', jsonb_build_object(
      'orders', (select n from ustot),
      'aov', (select round(aov::numeric, 2) from ustot),
      'windowDays', 180,
      'thresholds', coalesce((select jsonb_agg(jsonb_build_object(
          'threshold', t, 'orders', orders, 'giveUp', round(give_up::numeric, 0)
        ) order by t desc) from usthr), '[]'::jsonb),
      'currentThreshold', 100,
      -- What the store bills for shipping today, over the same window. With
      -- giveUp this is what makes "extra cost versus today" computable in the
      -- UI instead of an absolute that answers nothing.
      'chargedTotal', (select round(sum(charged)::numeric, 0) from usord)),
  'fxRate', (select round(rate::numeric, 4) from fxlast),
  'shipping', jsonb_build_array(
      jsonb_build_object('market', 'US', 'orders', (select us from shiporders),
        'costPerParcel', (select round((us / nullif((select us from shiporders), 0))::numeric, 2) from shipcost),
        'chargedPerParcel', (select round((us / nullif(ous, 0))::numeric, 2) from shiprev)),
      jsonb_build_object('market', 'AU', 'orders', (select au from shiporders),
        'costPerParcel', (select round((au / nullif((select au from shiporders), 0))::numeric, 2) from shipcost),
        'chargedPerParcel', (select round((au / nullif(oau, 0))::numeric, 2) from shiprev)),
      jsonb_build_object('market', 'Other', 'orders', (select ot from shiporders),
        'costPerParcel', (select round((ot / nullif((select ot from shiporders), 0))::numeric, 2) from shipcost),
        'chargedPerParcel', (select round((ot / nullif(oot, 0))::numeric, 2) from shiprev)))
);
$function$;

comment on function public.growth_forecast_report(int, int, date[]) is
  'Growth forecast inputs for the Reports tab: measured monthly spend/revenue series, fitted elasticity (log-log, with an explicit month-exclusion list), baseline, product mix with stock and lead times, unit economics read from advertising_unit_economics, US free-shipping threshold distribution and per-market shipping economics (Xero money, Starshipit split). The projection itself is computed in the UI.';

grant execute on function public.growth_forecast_report(int, int, date[]) to authenticated, service_role;
