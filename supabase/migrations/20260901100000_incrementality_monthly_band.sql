-- =============================================================================
-- Advertising incrementality — a yardstick in the chart's own unit,
-- on top of the closed-month rollup
-- =============================================================================
-- Mario, 2026-09-01, after August closed: "podés corregir el problema del
-- gráfico para tratar de ver la situación más claramente?"
--
-- ── 1. THE BUG BEING FIXED (a units bug, not an arithmetic one) ──────────────
-- The chart draws ONE BAR PER MONTH, but every reference drawn over those bars
-- came from the 10-DAY band: the shaded p25–p75, the dashed median, and the
-- reading rule ("10-day windows reached 62.3% with zero spend").
--
-- Ten-day windows are far noisier than months, so that yardstick is unusable on
-- this chart: 62.3% is a ceiling no month can reach, which means no month can
-- ever read as a signal and the panel could never produce a verdict.
--
-- The header of the original migration (20260811120000) already recorded this
-- exact lesson — and the UI drew the 10-day band over the monthly bars anyway.
-- This closes that gap: the project's rule "una sola unidad de medida por
-- pantalla" applied to a chart that broke it.
--
-- ADDED, nothing removed:
--   * `monthlyBand` — the same distribution over the CLOSED months that had ZERO
--     Google spend, computed live from the very `monthly` CTE that feeds the
--     bars, so band and bars can never disagree.
--   * `latestClosedMonth` — the last complete month, its ratio, and whether it
--     cleared the best zero-spend month.
--   * `band` (10-day) is untouched and still returned: the "Last 10 days" card
--     is a 10-day reading and must keep a 10-day yardstick.
--
-- BASELINE: a month enters it when its Google spend is exactly zero AND the
-- month is closed. That is 2025-07..2026-05 (11 months) — spend started
-- 2026-06-25, so June 2026 (A$684) drops out on its own, no hardcoded date.
--
-- VERIFIED after apply: monthlyBand n=11, min 24.6 / p25 26.7 / median 28.4 /
-- p75 30.3 / max 34.9 (2026-02). The monthly and 10-day MEDIANS agree (28.4 vs
-- 28.1) — the aggregation is consistent; it is the TAIL the 10-day window
-- inflates, and the tail is exactly what the old reading rule quoted.
-- latestClosedMonth = 2026-08 at 41.6%, above the zero-spend maximum.
--
-- ── 2. THE ROLLUP THIS FILE ALSO CARRIES ─────────────────────────────────────
-- MY MISTAKE, recorded so it is not repeated. A first version of this migration
-- was built by editing the body in supabase/migrations/20260811120000, which was
-- the newest copy of this function ON THE BRANCH I WAS ON. It was not the
-- deployed body: on 2026-08-31, migration 20260831100000_advertising_
-- incrementality_rollup moved closed months into advertising_incrementality_
-- monthly and made the live scan start at 2026-08-01, after measuring 17.3s
-- average / 22.9s max against the 25s timeout.
--
-- That migration WAS committed, properly documented, on ui-redesign. My branch
-- (feat/advertising-tab) was 23 commits behind and never had it — so my `create
-- or replace`, built from the stale file, reverted the optimisation silently.
-- No error, no conflict: the function simply went back to scanning 14 months.
-- I noticed only because the migration LOG on the server listed a name the repo
-- on my branch did not contain.
--
-- ROOT CAUSE: working for hours on a branch 23 commits behind the deployed one,
-- without checking. Not a missing file — a stale checkout.
--
-- TWO RULES OUT OF IT:
--   * `git fetch` + compare against the deploy branch BEFORE starting, and
--     certainly before touching anything shared.
--   * before `create or replace` on a function, read the DEPLOYED body
--     (pg_get_functiondef). A repo file only records what someone once applied.
--
-- The branch has since been fast-forwarded, so the rollup file is present. This
-- file supersedes it: same rollup-backed body, plus the monthly band. Applying
-- them in order (…0831100000 then this) leaves exactly this body.
--
-- HOW THE ROLLUP IS READ. `live_from` is derived from the table itself — the
-- month after the last frozen one — so extending the rollup later needs no
-- change here, and an empty table falls back to the original full scan.
-- Every other block (last-10-days, brand-cut, brand spend) only ever needed
-- 2026-08 onward, so they read the live CTE unchanged.
--
-- NOTE for whoever comes next: nothing refreshes advertising_incrementality_
-- monthly. It was frozen once, through 2026-07, so the live window grows by one
-- month each month. Fine for now (2 months live vs 14), worth a tick when it
-- creeps back up.
--
-- VERIFIED after apply: the 15-month array, brandCut (31.0 → 43.1) and
-- last10Days (40.6) are identical to what the deployed function returned before
-- any of today's changes.

create or replace function public.advertising_incrementality()
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '25s'
set work_mem to '16MB'
as $function$
with fxlast as (
  select rate from currency_exchange_rates order by year desc, month desc limit 1
),
-- Closed months are immutable (historic attribution coverage ~100%, which is
-- also what the frozen band constants rely on), so they are read, not recomputed.
live_from as (
  select coalesce(
    (select max(mes) + interval '1 month' from advertising_incrementality_monthly),
    date '2025-07-01')::date d
),
rev as (
  select l.order_id, l.order_date,
         sum(case when l.currency = 'AUD' then l.net_native
                  else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) net_aud
  from shopify_sales_lines l
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int
   and r.month = extract(month from l.order_date)::int
  where l.order_date >= (select d from live_from)
  group by 1, 2
),
cls as materialized (
  -- the ONE reference to the view: referencing it per sub-block would
  -- re-materialise the moment classifications each time (the 7.9s-per-reference
  -- lesson of plan 04-motor).
  -- LEFT join: a sales order with no attribution row yet (the freshest day,
  -- attribution sync lagging sales sync) must stay in the universe as
  -- non-google. An inner join dropped it from BOTH sides and inflated ratioPct
  -- exactly on the days read against the frozen band.
  select r.order_date, r.net_aud,
         coalesce(oc.last_bucket in ('google-mixto-pre','google-organic','google-brand',
                            'google-nonbrand','google-shopping-proxy','google-paid-other'), false) is_goog
  from rev r
  left join advertising_order_channels oc using (order_id)
),
live_monthly as (
  -- goog coalesced: a zero bag is DATA (the bag genuinely was 0), not a gap —
  -- the null-never-0 rule covers missing data, not true zeros.
  select date_trunc('month', order_date)::date mes,
         sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog,
         count(*) filter (where is_goog) goog_orders
  from cls group by 1
),
monthly as (
  select mes, total, goog, goog_orders
  from advertising_incrementality_monthly
  where mes < (select d from live_from)
  union all
  select mes, total, goog, goog_orders from live_monthly
),
sp as (
  select date_trunc('month', date)::date mes,
         sum(spend_aud) spend
  from google_ads_daily group by 1
),
latest as (select max(order_date) d from cls),

-- ── the monthly ratios, i.e. exactly the series the bars draw ────────────────
mrat as (
  select m.mes,
         100 * m.goog / nullif(m.total - m.goog, 0) ratio,
         coalesce(s.spend, 0) spend
  from monthly m left join sp s using (mes)
  where m.total - m.goog > 0
),
mzero as (
  select mes, ratio from mrat
  where spend = 0
    and mes < date_trunc('month', (select d from latest))::date
),
mband as (
  select count(*) n,
         round(min(ratio)::numeric, 1) min_pct,
         round(percentile_cont(0.25) within group (order by ratio::float8)::numeric, 1) p25_pct,
         round(percentile_cont(0.50) within group (order by ratio::float8)::numeric, 1) med_pct,
         round(percentile_cont(0.75) within group (order by ratio::float8)::numeric, 1) p75_pct,
         round(max(ratio)::numeric, 1) max_pct,
         to_char(min(mes), 'YYYY-MM') || '..' || to_char(max(mes), 'YYYY-MM') period,
         (select to_char(mes, 'YYYY-MM') from mzero order by ratio desc limit 1) max_month
  from mzero
),
mlast as (
  select mes, ratio, spend from mrat
  where mes < date_trunc('month', (select d from latest))::date
  order by mes desc limit 1
),

last10 as (
  select sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog
  from cls where order_date > (select d from latest) - 10
),
cut_pre as (
  select sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog
  from cls where order_date between date '2026-08-01' and date '2026-08-05'
),
cut_post as (
  select sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog,
         count(distinct order_date) days
  from cls where order_date >= date '2026-08-06'
),
brand_spend as (
  -- both per-day figures divide by CALENDAR days of their window: dividing post
  -- by days-with-rows inflated it when a day had no brand row loaded, and a
  -- fully-stopped campaign would have read null.
  select
    (select coalesce(sum(spend_aud), 0) / 5 from google_ads_daily
      where campaign = 'brand-search' and date between '2026-08-01' and '2026-08-05') pre_per_day,
    (select coalesce(sum(spend_aud), 0)
       / greatest(((select d from latest) - date '2026-08-06') + 1, 1)
     from google_ads_daily
      where campaign = 'brand-search' and date >= '2026-08-06') post_per_day
)
select jsonb_build_object(
  'monthly', (select coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(m.mes, 'YYYY-MM'),
      'bagAud', round(m.goog, 2),
      'restAud', round(m.total - m.goog, 2),
      'ratioPct', round(100 * m.goog / nullif(m.total - m.goog, 0), 1),
      'googleOrders', m.goog_orders,
      'googleSpendAud', round(coalesce(s.spend, 0), 2)
    ) order by m.mes), '[]'::jsonb)
    from monthly m left join sp s using (mes)),
  -- 10-day band: FROZEN constants (the zero-spend period is closed, they can
  -- never change). Kept for the "Last 10 days" card, the only 10-day reading.
  'band', jsonb_build_object(
    'windows', 326,
    'windowDays', 10,
    'period', '2025-07-10..2026-05-31 (zero Google spend)',
    'minPct', 20.1, 'p25Pct', 25.6, 'medianPct', 28.1, 'p75Pct', 31.4, 'maxPct', 62.3,
    'samePeriodAug2025Pct', 27.3),
  -- Monthly band: computed from the same series the chart draws.
  'monthlyBand', (select jsonb_build_object(
      'months', n, 'period', period,
      'minPct', min_pct, 'p25Pct', p25_pct, 'medianPct', med_pct,
      'p75Pct', p75_pct, 'maxPct', max_pct, 'maxMonth', max_month)
    from mband),
  'latestClosedMonth', (select jsonb_build_object(
      'month', to_char(l.mes, 'YYYY-MM'),
      'ratioPct', round(l.ratio, 1),
      'googleSpendAud', round(l.spend, 2),
      'aboveZeroSpendMax', l.ratio > (select max_pct from mband))
    from mlast l),
  'last10Days', (select jsonb_build_object(
      'to', to_char((select d from latest), 'YYYY-MM-DD'),
      'bagAud', round(goog, 2),
      'ratioPct', round(100 * goog / nullif(total - goog, 0), 1))
    from last10),
  'brandCut', jsonb_build_object(
    'cutDate', '2026-08-06',
    'verdictDate', '2026-08-31',
    'pre', (select jsonb_build_object(
        'from', '2026-08-01', 'to', '2026-08-05', 'days', 5,
        'bagAud', round(goog, 2),
        'ratioPct', round(100 * goog / nullif(total - goog, 0), 1),
        'brandSpendPerDayAud', (select round(pre_per_day, 0) from brand_spend))
      from cut_pre),
    'post', (select jsonb_build_object(
        'from', '2026-08-06', 'to', to_char((select d from latest), 'YYYY-MM-DD'),
        'days', days,
        'bagAud', round(goog, 2),
        'ratioPct', round(100 * goog / nullif(total - goog, 0), 1),
        'brandSpendPerDayAud', (select round(post_per_day, 0) from brand_spend))
      from cut_post))
)
$function$;

revoke all on function public.advertising_incrementality() from public;
revoke all on function public.advertising_incrementality() from anon;
grant execute on function public.advertising_incrementality() to authenticated, service_role;
