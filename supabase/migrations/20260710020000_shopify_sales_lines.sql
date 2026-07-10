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

-- Aggregated (day, SKU, country) view the CSV export reads.
create view shopify_sales_by_variant as
select order_date, sku, country,
  max(product_title)  as product_title,
  max(variant_title)  as variant_title,
  sum(quantity)       as quantity,
  sum(gross_usd)      as gross_usd,
  sum(discounts_usd)  as discounts_usd,
  sum(returns_usd)    as returns_usd,
  sum(net_usd)        as net_usd,
  sum(taxes_usd)      as taxes_usd,
  sum(shipping_usd)   as shipping_usd
from shopify_sales_lines
where source = 'api'
group by order_date, sku, country;

create table if not exists shopify_sales_sync_state (
  id int primary key default 1,
  last_updated_at timestamptz,   -- newest Shopify updated_at the API has synced (cursor)
  last_run_at timestamptz,
  last_run_status text,
  rows_live int,
  constraint shopify_sales_sync_state_singleton check (id = 1)
);
