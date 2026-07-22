-- variant_id -> sku lookup. The upgrade pixel identifies products by variant_id
-- (that is what cart/add.js takes), but every sales table keys on sku, so without
-- this bridge a click event can never be tied to the product it was for.
create table if not exists shopify_variant_map (
  variant_id    bigint primary key,
  product_id    bigint,
  sku           text,
  product_title text,
  variant_title text,
  synced_at     timestamptz not null default now()
);
create index if not exists shopify_variant_map_sku_idx on shopify_variant_map (sku);
alter table shopify_variant_map enable row level security;

comment on table shopify_variant_map is
  'Shopify variant_id -> sku bridge. Lets upgrade_events (which carry variant_id) join to sales/SKU-keyed data.';
