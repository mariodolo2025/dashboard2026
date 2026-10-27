-- =============================================================================
-- shopify_lines_replace_orders — replace whole orders in one transaction
-- =============================================================================
-- docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, Fase 4b S1 (approved by Mario
-- 27-Oct-2026), after the MRD session reported Shopify orders missing from
-- shopify_sales_lines (Shopify vs database, all orders: Sep-2026 7,179 vs
-- 7,110; Dec-2025 6,115 vs 5,982; every month Jul-2025..Feb-2026 short).
--
-- Root cause: shopify-sales-sync deleted the rows of EVERY order it had read,
-- then upserted the new rows in separate calls. When one order came back twice
-- in the same run (a run of more than one page while Shopify was updating
-- orders, e.g. a batch of fulfilments: the order moves to a later page), the
-- upsert failed with "ON CONFLICT DO UPDATE command cannot affect row a second
-- time" (seen 26-Oct-2026 23:30 UTC) and every order of the run was left with
-- no rows. The 5-minute cron re-reads only the last 2 hours, so an order whose
-- last update left that window before a good run was lost for good.
--
-- Now: the function keeps one version per order (the newest), and each chunk of
-- orders is replaced here, DELETE + INSERT in one transaction. If anything
-- fails the chunk keeps its old rows. Same table, same columns: the MRD reads
-- shopify_sales_lines and shopify_sales_by_variant.

create or replace function public.shopify_lines_replace_orders(p_order_ids text[], p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare d integer; i integer;
begin
  delete from public.shopify_sales_lines
  where source = 'api' and order_id = any(coalesce(p_order_ids, '{}'));
  get diagnostics d = row_count;

  insert into public.shopify_sales_lines
    (order_id, order_date, order_updated_at, sku, product_title, variant_title, country, currency,
     quantity, gross_usd, discounts_usd, returns_usd, net_usd, taxes_usd, shipping_usd,
     net_native, net_usd_orderrate, source)
  select x.order_id, x.order_date, x.order_updated_at, x.sku, x.product_title, x.variant_title,
         coalesce(x.country, 'NA'), x.currency,
         coalesce(x.quantity, 0), coalesce(x.gross_usd, 0), coalesce(x.discounts_usd, 0),
         coalesce(x.returns_usd, 0), coalesce(x.net_usd, 0), coalesce(x.taxes_usd, 0),
         coalesce(x.shipping_usd, 0), x.net_native, x.net_usd_orderrate, coalesce(x.source, 'api')
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
    order_id text, order_date date, order_updated_at timestamptz, sku text, product_title text,
    variant_title text, country text, currency text, quantity numeric, gross_usd numeric,
    discounts_usd numeric, returns_usd numeric, net_usd numeric, taxes_usd numeric,
    shipping_usd numeric, net_native numeric, net_usd_orderrate numeric, source text);
  get diagnostics i = row_count;

  return jsonb_build_object('deleted', d, 'inserted', i);
end
$function$;

revoke all on function public.shopify_lines_replace_orders(text[], jsonb) from public, anon, authenticated;
grant execute on function public.shopify_lines_replace_orders(text[], jsonb) to service_role;
