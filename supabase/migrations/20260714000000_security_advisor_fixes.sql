-- Security Advisor (Postgres linter) fixes for the DB-first automation objects:
--  1. shopify_sales_by_variant ran with its owner's rights (bypassing RLS). Make it
--     run with the caller's rights. The ecommerce_dashboard RPC still reads it fine
--     (that function is SECURITY DEFINER = executes as postgres, which owns the tables).
--  2/3. The internal sync-state tables had RLS disabled while exposed to PostgREST.
--     Only edge functions touch them via the service role (which bypasses RLS), so
--     enabling RLS with no policies simply denies anon/authenticated — the intended state.
alter view public.shopify_sales_by_variant set (security_invoker = on);
alter table public.meta_ads_sync_state enable row level security;
alter table public.shopify_sales_sync_state enable row level security;
