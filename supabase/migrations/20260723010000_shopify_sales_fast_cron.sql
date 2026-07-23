-- Near-real-time sales for the Web Upgrade tab.
--
-- The upgrade funnel is instant (the pixel posts each event as it happens) but the
-- SALES half only moved 3×/day with the orchestrator, so "added to cart" could sit
-- next to a stale "0 orders" for hours. This runs shopify-sales-sync on its own
-- every 15 minutes, which cuts the lag to ~15 min.
--
-- The cron passes an explicit 2-hour lookback via `updatedSince`, which the function
-- already supports, instead of relying on its own watermark. That watermark never
-- actually engages: shopify-sales-sync reads `st.last_updated_at`, but the state
-- table's column is `last_modified_watermark`, so the lookup is always undefined and
-- every call silently falls back to LIVE_BOUNDARY — re-pulling every order since
-- 2026-07-01 (~5,300 orders / 22 pages) on each run. Correct, but far too heavy to
-- repeat 96×/day. Measured: full replay 5,284 orders / 22 pages / ~30s vs the 2-hour
-- window 142 orders / 1 page / 3.8s.
--
-- The column mismatch is deliberately NOT fixed here. shopify-sales-sync is the sales
-- pipeline, and the 3×/day orchestrator currently depends on that full-replay
-- behaviour as a reconciling safety net that re-checks every order since the boundary.
-- Changing it is a separate, carefully-tested job; the cron simply asks for the window
-- it needs. A 2-hour lookback generously covers several consecutive missed runs.
--
-- Two deliberate safeguards against colliding with the full orchestrator chain,
-- which runs shopify-sales-sync as one of its own steps:
--   1. The WHERE guard makes the call a no-op while a sync_run is 'running'.
--   2. Minutes 7/22/37/52 never coincide with the orchestrator kickoff (minute 0).
-- Even without them the function replaces each order wholesale, so a double run is
-- idempotent rather than corrupting — but not racing at all is better.
--
-- The guard is BOUNDED to runs younger than 40 minutes on purpose: an unbounded
-- "is anything running?" check would let a single wedged run block the fast sync
-- forever. 40m matches the orchestrator's own STUCK_MINUTES backstop, past which it
-- declares a run abandoned anyway.
--
-- Note this refreshes the TABLES (shopify_sales_lines, upgrade_order_attribution),
-- which is what the Web Upgrade and E-commerce RPCs read. The CSV export and the
-- pre-parsed dashboard snapshot still rebuild on the 3×/day chain, unchanged.
select cron.schedule(
  'shopify-sales-fast',
  '7,22,37,52 * * * *',
  $cmd$
  select net.http_post(
    url:='https://teewkafclgpfpczftvah.supabase.co/functions/v1/shopify-sales-sync',
    body:=jsonb_build_object('updatedSince', to_char(now() - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    headers:=jsonb_build_object(
      'Authorization','Bearer <SUPABASE_ANON_KEY>',
      'Content-Type','application/json'),
    timeout_milliseconds:=120000)
  where not exists (
    select 1 from sync_runs
    where status = 'running' and started_at > now() - interval '40 minutes');
  $cmd$
);
