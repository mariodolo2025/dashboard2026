-- =============================================================================
-- Security — close public read on the backup tables and two views
-- =============================================================================
-- Applied 2026-08-18 (Management API; the MCP was 503 for most of the session).
--
-- FOUND BY TESTING, NOT BY READING THE LINTER. The Supabase security advisor
-- returned 115 findings; most are hygiene. These nine were different: they were
-- genuinely downloadable by anyone, right now, using the anon key that ships
-- inside the website's own JavaScript bundle. Verified by calling the public
-- REST endpoint with that key and reading the row counts back:
--
--   aim2026_demand_detail_bkp_20260728            139,786 rows
--   aim2026_demand_detail_bkp_ene_abr_20260728     54,580
--   aim2026_demand_history_bkp_20260728            17,481
--   aim2026_demand_history_bkp_ene_abr_20260728     3,340
--   aim2026_sku_parameters_bkp_20260804             1,539
--   upgrade_events_archive_20260722                   422
--   sales_audit_snapshot_20260724                     391
--   aim2026_skus_without_cost (view)                  207
--   aim2026_demand_sanity (view)                  returns rows
--   aim2026_demand_detail_bkp_so20333                  10
--
-- That is demand per SKU and period, SKU cost parameters and a sales audit
-- snapshot — what the business sells and how much of it.
--
-- SAFE TO CLOSE: grep across src/ and supabase/functions/ finds ZERO references
-- to any of them. They are dated backups and diagnostic views; the application
-- never reads them. service_role (the syncs, the edge functions) is unaffected
-- by both RLS and these grants.
--
-- Two mechanisms, deliberately both:
--   * RLS enabled with NO policy — the default answer becomes "no rows" for
--     every PostgREST caller, so a future accidental grant cannot reopen this.
--   * grants revoked from anon and authenticated — nothing reaches the tables
--     even before RLS is consulted.
--
-- The two views cannot carry RLS, so they get security_invoker = on (the rule
-- this project adopted after ad_spend_unified leaked 770 rows on 2026-08-09):
-- the caller's own permissions apply to the underlying tables instead of the
-- view owner's. aim2026_demand_sanity was additionally flagged ERROR
-- security_definer_view by the advisor; this clears it.
--
-- NOT DONE HERE, on purpose: dropping the backups. They exist because a demand
-- incident destroyed data once (see docs/HANDOVER.md); deleting them is a
-- separate decision with its own risk, and closing the door does not require
-- burning the room.

alter table public.aim2026_demand_detail_bkp_20260728            enable row level security;
alter table public.aim2026_demand_detail_bkp_ene_abr_20260728    enable row level security;
alter table public.aim2026_demand_history_bkp_20260728           enable row level security;
alter table public.aim2026_demand_history_bkp_ene_abr_20260728   enable row level security;
alter table public.aim2026_sku_parameters_bkp_20260804           enable row level security;
alter table public.aim2026_demand_detail_bkp_so20333             enable row level security;
alter table public.upgrade_events_archive_20260722               enable row level security;
alter table public.sales_audit_snapshot_20260724                 enable row level security;

revoke all on public.aim2026_demand_detail_bkp_20260728          from anon, authenticated;
revoke all on public.aim2026_demand_detail_bkp_ene_abr_20260728  from anon, authenticated;
revoke all on public.aim2026_demand_history_bkp_20260728         from anon, authenticated;
revoke all on public.aim2026_demand_history_bkp_ene_abr_20260728 from anon, authenticated;
revoke all on public.aim2026_sku_parameters_bkp_20260804         from anon, authenticated;
revoke all on public.aim2026_demand_detail_bkp_so20333           from anon, authenticated;
revoke all on public.upgrade_events_archive_20260722             from anon, authenticated;
revoke all on public.sales_audit_snapshot_20260724               from anon, authenticated;

-- Views: the caller's permissions must apply, not the owner's.
alter view public.aim2026_skus_without_cost set (security_invoker = on);
alter view public.aim2026_demand_sanity     set (security_invoker = on);

revoke all on public.aim2026_skus_without_cost from anon;
revoke all on public.aim2026_demand_sanity     from anon;
