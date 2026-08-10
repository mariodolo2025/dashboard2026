-- =============================================================================
-- Advertising Plan 6 C2 — order_name on shopify_order_attribution + live index
-- =============================================================================
-- Applied 2026-08-11 via MCP apply_migration, name `attribution_order_name`.
-- Plan: ADVERTISING/plans/06-mejoras-post-revision.md — C2 (Live Orders).
--
-- WHY
-- The Live Orders block shows the order the way a human knows it (PSD#65185).
-- We only stored Shopify's internal numeric id. The GraphQL `name` field is the
-- visible number; shopify-attribution-sync now requests and stores it (function
-- v2 deployed alongside this migration — additive field, same query cost).
--
-- BACKFILL POLICY (deliberate): only recent orders get the name. Live Orders
-- shows the latest 12, so backfilling from 2026-08-01 covers it with margin;
-- re-running the standard backfill later extends coverage for free since the
-- sync now always writes the field. Older rows render as '#'||order_id.
-- Backfill executed right after the function deploy:
--   {"backfill": {"from": "2026-07-31", "to": "<today>"}}  -- from one day
--   earlier than the target Brisbane day, per the UTC-window rule (README).
--
-- The index exists for the RPC's live_base CTE (top-12 by order_created_at):
-- without it that CTE is a 59k-row sort on every dashboard call.

alter table public.shopify_order_attribution add column order_name text;

comment on column public.shopify_order_attribution.order_name is
  'Shopify visible order number (GraphQL `name`, e.g. PSD#65185). Captured by shopify-attribution-sync since 2026-08-11; null for rows not yet re-synced — display falls back to ''#''||order_id.';

create index idx_shopify_order_attribution_created_desc
  on public.shopify_order_attribution (order_created_at desc);
