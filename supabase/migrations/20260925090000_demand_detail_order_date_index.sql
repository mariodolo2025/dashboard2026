-- =============================================================================
-- aim2026_demand_detail gets an index on the column the dashboard reads it by
-- =============================================================================
-- Mario, 2026-09-25, on the front page: "Failed to load data: HTTP error!
-- status: 500 — a veces tambien falla al cargar la primera vez."
--
-- dashboard-data reads this table by order_date. The table has five indexes and
-- not one of them starts with order_date, so every read was a sequential scan
-- of all 194,754 rows (68 MB) to keep the 12,611 inside a one-month window:
--
--   Seq Scan on aim2026_demand_detail (actual time=7.481..1366.390 rows=12611)
--     Filter: order_date >= '2026-08-26' AND order_date <= '2026-09-25'
--     Rows Removed by Filter: 182143
--
-- 1.37 s per page, thirteen pages for a month, and the statement timeout kills
-- whichever page is unlucky. That is the "sometimes": with the table already in
-- cache the run just fits, cold it does not. period_date is indexed, but it is
-- the demand period, not the day the order was placed, and the screens ask by
-- order date.
--
-- The id column rides along so the function can page by key (…where id > last)
-- instead of by offset, which re-walked the same rows once per page.
--
-- Additive: nothing is dropped, no query is rewritten, no number moves.

create index if not exists idx_aim2026_detail_order_date
  on public.aim2026_demand_detail (order_date, id);

comment on index public.idx_aim2026_detail_order_date is
  'Added 2026-09-25 for dashboard-data, which reads this table by order_date. Without it every By Channel / front page load was a full scan of 194k rows and hit the statement timeout at random.';

analyze public.aim2026_demand_detail;
