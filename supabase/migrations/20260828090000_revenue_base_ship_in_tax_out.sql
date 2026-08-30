-- =============================================================================
-- Revenue base change (Mario, 28-Aug-2026): revenue = net sales + shipping
-- charged − all tax. Shipping is income Dolo keeps; tax is a pass-through to
-- the tax office and was never revenue. Matches Shopify's "Net sales +
-- Shipping charges".
--
-- Applied IN PLACE to the three functions that report store revenue, via
-- pg_get_functiondef + anchored replace with guards (the project's patch
-- pattern) so the rest of each body stays byte-identical:
--
--   ecommerce_dashboard      row-level, in the sh CTE → flows into kpis
--                            (revenue, MER, POAS, contribution margin, AOV),
--                            trend, prior, market, family, products, geo
--   advertising_dashboard    rev_daily + the summary sum → blended MER, CAC
--   growth_forecast_report   ONLY the monthly fit series (mrev): the fitted
--                            elasticity moves to the new base (b 0.736→0.754,
--                            R² 0.892→0.896). The per-SKU mix CTE keeps
--                            merchandise revenue — shipping is not a product.
--
-- Verified on 29-Aug-2026 data: ecommerce revenue 21,629 → 22,660 AUD
-- (= +shipping 2,263 − taxes 1,233), MER 2.78 → 2.92, and
-- advertising_dashboard reports the identical 22,659.84.
--
-- Still pending on this base (Mario ↔ Juan): the unit-economics cells in
-- advertising_unit_economics (CM1%, fixed costs, target margin) were built on
-- the old base; breakeven/target MER read them live and stay slightly stale
-- until Juan re-expresses them. B2C Sales Explorer intentionally keeps its
-- own basis (ex tax AND ex shipping) because its contract is to match
-- Shopify Analytics "Net sales" to the cent.
--
-- Re-running this file is safe: an anchor that no longer matches raises
-- instead of double-applying.
-- =============================================================================
do $mig$
declare
  src text;
  n int;
  anchor text;
begin
  select pg_get_functiondef(oid) into src from pg_proc where proname = 'ecommerce_dashboard';
  anchor := 'select v.order_date, v.net_aud, v.gross_aud';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'ecommerce anchor x%', n; end if;
  src := replace(src, anchor,
    'select v.order_date, v.net_aud + v.shipping_aud - v.taxes_aud as net_aud, v.gross_aud');
  execute src;

  select pg_get_functiondef(oid) into src from pg_proc where proname = 'advertising_dashboard';
  anchor := 'sum(v.net_aud) rev,';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'adv anchor1 x%', n; end if;
  src := replace(src, anchor, 'sum(v.net_aud + v.shipping_aud - v.taxes_aud) rev,');
  anchor := 'sum(v.net_aud / coalesce(r.rate,';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'adv anchor2 x%', n; end if;
  src := replace(src, anchor, 'sum((v.net_aud + v.shipping_aud - v.taxes_aud) / coalesce(r.rate,');
  anchor := 'coalesce(sum(net_aud), 0) from shopify_sales_by_variant';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'adv anchor3 x%', n; end if;
  src := replace(src, anchor, 'coalesce(sum(net_aud + shipping_aud - taxes_aud), 0) from shopify_sales_by_variant');
  execute src;

  select pg_get_functiondef(oid) into src from pg_proc where proname = 'growth_forecast_report';
  anchor := '(''month'', order_date)::date m,' || E'\n' || '         sum(net_usd * (select rate from fxlast)) rev';
  n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if n <> 1 then raise exception 'growth anchor x%', n; end if;
  src := replace(src, anchor,
    '(''month'', order_date)::date m,' || E'\n' || '         sum((net_usd + coalesce(shipping_usd,0) - coalesce(taxes_usd,0)) * (select rate from fxlast)) rev');
  execute src;
end
$mig$;
