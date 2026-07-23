-- Near-real-time sales for the Web Upgrade tab.
--
-- The upgrade funnel is instant (the pixel posts each event as it happens) but the
-- SALES half only moved 3×/day with the orchestrator, so "added to cart" could sit
-- next to a stale "0 orders" for hours. This runs shopify-sales-sync on its own
-- every 15 minutes, which cuts the lag to ~15 min.
--
-- Cheap by construction: the function is incremental on the updated_at watermark,
-- so a 15-minute gap pulls a handful of orders, not the whole history. (The 5,245-
-- order run seen earlier was only because the watermark was ~4.5 h stale.)
--
-- Two deliberate safeguards against colliding with the full orchestrator chain,
-- which runs shopify-sales-sync as one of its own steps:
--   1. The WHERE guard makes the call a no-op while any sync_run is 'running'.
--   2. Minutes 7/22/37/52 never coincide with the orchestrator kickoff (minute 0).
-- Even without them the function replaces each order wholesale, so a double run is
-- idempotent rather than corrupting — but not racing at all is better.
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
    body:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Authorization','Bearer <SUPABASE_ANON_KEY>',
      'Content-Type','application/json'),
    timeout_milliseconds:=120000)
  where not exists (select 1 from sync_runs where status = 'running');
  $cmd$
);
