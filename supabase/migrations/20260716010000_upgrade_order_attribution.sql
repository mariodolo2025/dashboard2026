-- Web Upgrade performance — order-side attribution captured from Shopify order
-- line-item properties (_pesado_*) and order note_attributes (__pesado_*). One row
-- per upgrade-attributed (order_id, sku). Joins to upgrade_events on
-- pesado_attribution_id (direct) / order_attribution_id (assisted). Populated
-- additively by shopify-sales-sync; the sales pipeline is untouched.
create table if not exists upgrade_order_attribution (
  id bigserial primary key,
  order_id text not null,
  order_date date,
  sku text,
  quantity numeric,
  pesado_source text,
  pesado_attribution_id text,
  pesado_machine text,
  pesado_reason text,
  pesado_rank text,
  pesado_target_tier text,
  pesado_gap_before text,
  pesado_parent_product text,
  pesado_environment text,
  order_attribution_id text,
  order_environment text,
  synced_at timestamptz not null default now()
);
create index if not exists upgrade_oa_order_idx on upgrade_order_attribution (order_id);
create index if not exists upgrade_oa_attr_idx on upgrade_order_attribution (pesado_attribution_id);
alter table upgrade_order_attribution enable row level security;
