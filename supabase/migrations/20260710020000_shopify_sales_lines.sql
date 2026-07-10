-- Shopify sales, DB-first (mirrors unleashed_sales_lines). Stored PER ORDER-LINE
-- (keyed by order_id, sku, country) so an edited/refunded order can be re-pulled
-- by updated_at and its rows replaced wholesale — late returns are reflected
-- instead of permanently overstating net sales. shopify_sales_by_variant
-- aggregates to the (day, SKU, country) shape the "Total sales by product variant"
-- CSV / dashboard reads.
--
-- USD basis (the crux): Shopify's report values foreign sales at MARKET FX, not
-- the order's Markets rate. net_usd converts the PRESENTMENT (native) amount at
-- the month's market rate. net_native + net_usd_orderrate are captured so a truer
-- native-currency basis is possible later with no re-sync.
--   net_usd = gross_usd - discounts_usd - returns_usd   (Shopify "net sales", market FX)
drop view if exists shopify_sales_by_variant;
drop table if exists shopify_sales_lines;
create table shopify_sales_lines (
  id bigint generated always as identity primary key,
  order_id text not null,
  order_date date not null,               -- order creation day (shop-local)
  order_updated_at timestamptz,           -- Shopify updated_at (watermark cursor)
  sku text not null,
  product_title text,
  variant_title text,
  country text not null default 'NA',      -- normalized 2-letter shipping country
  currency text,
  quantity numeric not null default 0,     -- net items sold (after returns)
  gross_usd numeric not null default 0,
  discounts_usd numeric not null default 0,
  returns_usd numeric not null default 0,
  net_usd numeric not null default 0,
  taxes_usd numeric not null default 0,
  shipping_usd numeric not null default 0,
  net_native numeric,                      -- net in the customer's currency
  net_usd_orderrate numeric,               -- net at Shopify's day-of-purchase rate
  source text not null default 'api',
  synced_at timestamptz not null default now(),
  unique (order_id, sku, country)
);
create index if not exists shopify_sales_lines_agg_idx on shopify_sales_lines (order_date, sku, country);
alter table shopify_sales_lines enable row level security;

-- Aggregated (day, SKU, country) view the CSV export reads, in AUD. Native for AUD
-- orders (rate-independent, exactly what customers paid); USD/other converted at the
-- month's market rate from currency_exchange_rates — no USD round-trip / double FX.
create view shopify_sales_by_variant as
select l.order_date, l.sku, l.country,
  max(l.product_title) as product_title,
  max(l.variant_title) as variant_title,
  sum(l.quantity)      as quantity,
  sum(case when l.currency = 'AUD' then l.net_native else l.net_usd * coalesce(r.rate, 1.54) end) as net_aud,
  sum(l.gross_usd     * coalesce(r.rate, 1.54)) as gross_aud,
  sum(l.discounts_usd * coalesce(r.rate, 1.54)) as discounts_aud,
  sum(l.returns_usd   * coalesce(r.rate, 1.54)) as returns_aud,
  sum(l.taxes_usd     * coalesce(r.rate, 1.54)) as taxes_aud,
  sum(l.shipping_usd  * coalesce(r.rate, 1.54)) as shipping_aud
from shopify_sales_lines l
left join currency_exchange_rates r
  on r.year = extract(year from l.order_date)::int and r.month = extract(month from l.order_date)::int
where l.source = 'api'
group by l.order_date, l.sku, l.country;

create table if not exists shopify_sales_sync_state (
  id int primary key default 1,
  last_updated_at timestamptz,   -- newest Shopify updated_at the API has synced (cursor)
  last_run_at timestamptz,
  last_run_status text,
  rows_live int,
  constraint shopify_sales_sync_state_singleton check (id = 1)
);
