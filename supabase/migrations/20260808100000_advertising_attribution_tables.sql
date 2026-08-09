-- =============================================================================
-- Advertising — attribution capture tables (Bloque 1, raw journey)
-- =============================================================================
-- Applied as migration 'advertising_attribution_tables' on 2026-08-09 via MCP.
-- Design: docs/DESIGN-ADVERTISING-TAB.md §4 Bloque 1.
-- 2026-08-09: singleton guard added as migration 'advertising_sync_state_singleton_guard'.

-- Advertising Bloque 1 — raw journey capture (spec DESIGN-ADVERTISING-TAB §4).
-- RAW: exactly what Shopify returns, no interpretation. Buckets/models compute
-- at read time (motor, Plan 4). New tables only — touches nothing existing.

create table public.shopify_order_attribution (
  order_id text primary key,
  order_date date not null,
  order_updated_at timestamptz,
  ready boolean not null default false,
  moments_count int,
  days_to_conversion int,
  customer_order_index int,          -- 1 = first purchase (CAC blended)
  first_occurred_at timestamptz,
  first_source text, first_referrer text, first_landing text,
  first_utm_source text, first_utm_medium text, first_utm_campaign text,
  first_utm_content text, first_utm_term text,
  last_occurred_at timestamptz,
  last_source text, last_referrer text, last_landing text,
  last_utm_source text, last_utm_medium text, last_utm_campaign text,
  last_utm_content text, last_utm_term text,
  synced_at timestamptz not null default now()
);
create index shopify_order_attribution_date_idx
  on public.shopify_order_attribution (order_date);
create index shopify_order_attribution_pending_idx
  on public.shopify_order_attribution (order_date) where not ready;

create table public.shopify_order_journey_moments (
  order_id text not null,
  seq int not null,                  -- 0-based, in occurredAt order
  occurred_at timestamptz,
  source text, referrer text, landing text,
  utm_source text, utm_medium text, utm_campaign text,
  utm_content text, utm_term text,
  primary key (order_id, seq)
);

create table public.shopify_attribution_sync_state (
  id int primary key default 1 check (id = 1),
  last_modified_watermark timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  rows_total bigint
);

alter table public.shopify_order_attribution enable row level security;
alter table public.shopify_order_journey_moments enable row level security;
alter table public.shopify_attribution_sync_state enable row level security;
-- No client policies: the edge function writes with service role; the future
-- RPC reads as SECURITY DEFINER (Plan 4). Same posture as the rollup tables.
