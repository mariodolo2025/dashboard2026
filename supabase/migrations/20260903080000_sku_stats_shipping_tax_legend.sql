-- B2C Sales Explorer: the Net sales card gets the ship/tax legend the
-- E-commerce Net Revenue card already has. Two new summary fields:
--   shippingExTaxAud  shipping charged on these orders, ex tax (same k basis
--                     as net — netAud + shippingExTaxAud = the E-commerce
--                     "incl. shipping · excl. tax" revenue base)
--   taxesTotalAud     all tax collected on goods + shipping in the window
-- Shipping is prorated per line at import, so the sums stay correct under a
-- SKU filter. Patched in place with count-guarded anchored replaces.
--
-- Verified against 2026-08: net 519,351.05 + ship 49,742.06 = 569,093 =
-- the E-commerce Net Revenue for August to the dollar; taxesTotal 29,714.07
-- matches that card's "tax out" figure.
do $do$
declare
  src text;
  n int;
begin
  select pg_get_functiondef(oid) into src
  from pg_proc where proname = 'shopify_sku_stats_multi'
    and pronamespace = 'public'::regnamespace;
  if src is null then raise exception 'shopify_sku_stats_multi not found'; end if;

  -- 1. lines CTE: per-line ex-tax shipping and total tax, in AUD
  n := (length(src) - length(replace(src, 'l.net_usd * (1 - x.k) * f.r as tax_aud', ''))) / length('l.net_usd * (1 - x.k) * f.r as tax_aud');
  if n <> 1 then raise exception 'anchor 1 matched % times', n; end if;
  src := replace(src,
    'l.net_usd * (1 - x.k) * f.r as tax_aud',
    'l.net_usd * (1 - x.k) * f.r as tax_aud,
           coalesce(l.shipping_usd,0) * x.k * f.r as shipping_extax_aud,
           coalesce(l.taxes_usd,0) * f.r as taxes_total_aud');

  -- 2. cur_totals: aggregate them
  n := (length(src) - length(replace(src, 'coalesce(sum(tax_aud),0) tax_aud, coalesce(sum(tax_usd),0) tax_usd,', ''))) / length('coalesce(sum(tax_aud),0) tax_aud, coalesce(sum(tax_usd),0) tax_usd,');
  if n <> 1 then raise exception 'anchor 2 matched % times', n; end if;
  src := replace(src,
    'coalesce(sum(tax_aud),0) tax_aud, coalesce(sum(tax_usd),0) tax_usd,',
    'coalesce(sum(tax_aud),0) tax_aud, coalesce(sum(tax_usd),0) tax_usd,
           coalesce(sum(shipping_extax_aud),0) shipping_extax_aud,
           coalesce(sum(taxes_total_aud),0) taxes_total_aud,');

  -- 3. summary: expose both
  n := (length(src) - length(replace(src, '''taxExcludedAud'', round(tax_aud::numeric,2), ''taxExcludedUsd'', round(tax_usd::numeric,2),', ''))) / length('''taxExcludedAud'', round(tax_aud::numeric,2), ''taxExcludedUsd'', round(tax_usd::numeric,2),');
  if n <> 1 then raise exception 'anchor 3 matched % times', n; end if;
  src := replace(src,
    '''taxExcludedAud'', round(tax_aud::numeric,2), ''taxExcludedUsd'', round(tax_usd::numeric,2),',
    '''taxExcludedAud'', round(tax_aud::numeric,2), ''taxExcludedUsd'', round(tax_usd::numeric,2),
        ''shippingExTaxAud'', round(shipping_extax_aud::numeric,2),
        ''taxesTotalAud'', round(taxes_total_aud::numeric,2),');

  execute src;
end
$do$;
