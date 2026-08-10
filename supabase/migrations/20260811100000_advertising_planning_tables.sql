-- =============================================================================
-- Advertising Plan 6 — unit-economics config + monthly plan tables
-- =============================================================================
-- Applied 2026-08-11 via MCP apply_migration, name `advertising_planning_tables`.
-- Plan: ADVERTISING/plans/06-mejoras-post-revision.md — B2 (verdict lines) and
-- B4 (budget simulator, Juan's formulas verbatim).
--
-- WHY
-- The verdict chart needs two reference lines (break-even MER, target MER) and
-- the budget simulator needs Juan's four constants. All of them come from the
-- monthly unit-economics workbook ("PESADO_58_5_-_Ecommerce_Unit_Economics_
-- July2026_FINAL VERSION.xlsx", received 2026-08-11). They change once a month
-- at most, so they live in a tiny config table with a validity month — NOT
-- hardcoded in the RPC and NOT recomputed from raw data (v2 can derive CM1%
-- from the dashboard's own cost data; v1 stays faithful to the workbook).
--
-- UNITS: stored in USD exactly as the workbook states them (fidelity to the
-- source). The tab converts for display; the derived MER lines are unitless.
--
-- DERIVED, NOT STORED (the RPC computes them so they can never drift from the
-- inputs):
--   breakeven_mer = 1 / cm1_pct                                   -> 1.42x
--   target_mer    = 1 / (cm1_pct - target_margin_pct
--                        - fixed_costs_usd / baseline_revenue_usd) -> 2.77x
-- Both verified against the workbook's own cells (Unit Economics rows 49-50).

create table public.advertising_unit_economics (
  month                   date primary key,   -- month the workbook describes (first day)
  cm1_pct                 numeric not null check (cm1_pct > 0 and cm1_pct < 1),
  fixed_costs_usd         numeric not null check (fixed_costs_usd >= 0),
  revenue_per_order_usd   numeric not null check (revenue_per_order_usd > 0),
  pct_new_customers       numeric not null check (pct_new_customers > 0 and pct_new_customers <= 1),
  target_margin_pct       numeric not null check (target_margin_pct >= 0 and target_margin_pct < 1),
  baseline_revenue_usd    numeric not null check (baseline_revenue_usd > 0),
  source                  text,
  updated_at              timestamptz not null default now(),
  updated_by              text
);

comment on table public.advertising_unit_economics is
  'Monthly constants from Juan''s unit-economics workbook. Feeds the verdict-chart MER lines and the budget simulator. USD, as the workbook states them. Refresh ritual: one row per month when the workbook is filled.';

-- The monthly budget plan (simulator "commit"): empty until Mario/Juan decide a
-- month's plan. When a row exists for the month being viewed, the tab tracks
-- actual MTD revenue/orders/CAC/MER against the trajectory the plan requires
-- (Juan's "if the ads team cannot commit to the lift, the row is fiction" check,
-- made automatic). Writing from the UI is deliberately NOT enabled in v1 —
-- pending decision on who commits a plan (pending v2).
create table public.advertising_monthly_plan (
  month              date primary key,
  planned_spend_usd  numeric not null check (planned_spend_usd >= 0),
  target_profit_usd  numeric not null,
  notes              text,
  updated_at         timestamptz not null default now(),
  updated_by         text
);

comment on table public.advertising_monthly_plan is
  'Committed monthly ad budget + accepted operating profit (Juan''s Scale plan §4). One row per month; absence = no committed plan, simulator runs free.';

alter table public.advertising_unit_economics enable row level security;
alter table public.advertising_monthly_plan enable row level security;

-- Read for the dashboard session; writes stay service-role/SQL only (no insert/
-- update policies on purpose — the definer RPC reads these regardless, the
-- policies matter for direct PostgREST reads).
create policy "advertising_unit_economics_read"
  on public.advertising_unit_economics for select
  to authenticated, service_role using (true);

create policy "advertising_monthly_plan_read"
  on public.advertising_monthly_plan for select
  to authenticated, service_role using (true);

-- July 2026 seed — the workbook's own numbers, checked cell by cell:
--   CM1 70.6% ($55.07 of $77.99) · fixed $48,559 ("All Costs extracted from
--   Mario's dashboard") · revenue/order $77.99 · new customers 3,976 of 4,304
--   orders = 92.4% · target margin 20% · baseline revenue $335,654.
--   Derived: breakeven 1/0.706 = 1.42x; target 1/(0.706-0.20-0.14467) = 2.77x —
--   both equal the workbook's displayed values.
insert into public.advertising_unit_economics
  (month, cm1_pct, fixed_costs_usd, revenue_per_order_usd, pct_new_customers,
   target_margin_pct, baseline_revenue_usd, source, updated_by)
values
  ('2026-07-01', 0.706, 48559, 77.99, 0.924, 0.20, 335654,
   'PESADO_58_5_-_Ecommerce_Unit_Economics_July2026_FINAL VERSION.xlsx (Juan, received 2026-08-11)',
   'claude-plan6');
