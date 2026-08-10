-- =============================================================================
-- Advertising Plan 6 B3 — advertising_incrementality() RPC
-- =============================================================================
-- Applied 2026-08-11 via MCP apply_migration, name `advertising_incrementality_rpc`.
-- Plan: ADVERTISING/plans/06-mejoras-post-revision.md — B3 ("Is Google adding
-- sales?").
--
-- WHAT IT ANSWERS
-- Whether paid Google is adding sales or claiming sales that arrived free. The
-- yardstick is the WHOLE Google bag (paid + organic + pre-gate mixto, one
-- referrer-based detection across all 13 months) divided by the REST of the
-- store — never "% of total", which self-inflates because the bag sits inside
-- the total.
--
-- THE COUNTERFACTUAL BAND — constants, not computed here
-- 326 rolling 10-day windows over 2025-07-10..2026-05-31 (the whole zero-spend
-- period): min 20.1 / p25 25.6 / median 28.1 / p75 31.4 / max 62.3 (% of rest).
-- Same-period reference 1-10 Aug 2025: 27.3%. Derived 2026-08-11 with the exact
-- query preserved in the session transcript; the period is CLOSED (spend started
-- 2026-06-25), so these can never change — embedding beats recomputing a frozen
-- distribution on every call. LESSON recorded the same day: comparing a 10-day
-- window against MONTHLY ratios understated the noise (monthly max 34.9 vs
-- 10-day max 62.3) and briefly produced a wrong "above all history" reading.
--
-- BRAND-CUT EXPERIMENT (readout, auto-updating)
-- Brand spend dropped ~$375/day -> ~$50/day around 2026-08-06 (same day as the
-- UTM gate). pre = 2026-08-01..05 (full spend), post = 2026-08-06..latest order
-- date. If the bag holds while brand spend stays cut, brand was harvesting.
-- Serious verdict date: 2026-08-31. Confirmed with Mario 2026-08-11: no internal
-- promos in 7-10 Aug (only Kieran's content replacement), so the post-cut
-- organic surge is not a marketing-push artifact.
--
-- PERFORMANCE
-- One pass: advertising_order_channels is referenced EXACTLY ONCE (cls CTE,
-- materialized); referencing it per sub-block would re-materialize ~138k moment
-- classifications each time (the 7.9s-per-reference lesson of 04-motor). The
-- function is called lazily by the Leadership view only.
-- MEASURED after apply (2026-08-11): 15.6s warm — under the 25s timeout but the
-- only query in the system whose input window can never shrink (fixed 2025-07-01
-- start). ESCAPE HATCH when it crosses ~20s: pre-aggregate closed months into a
-- monthly rollup and compute only the open month live (review 2026-08-11).
--
-- VERIFIED after apply (2026-08-11): monthly has 14 months; 2026-07 ratioPct
-- 36.4 == the hand-derived figure (the left-join universe fix did not move the
-- closed months — historic attribution coverage is ~100%, so the band constants
-- remain valid); brandCut pre 30.9 == hand-derived; post updates as days accrue
-- (49.7 with 11-Aug partial in); brandSpendPerDayAud post $59/day (calendar
-- divisor).
--
-- Access posture: authenticated + service_role only, like advertising_dashboard.
-- =============================================================================

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
rev as (
  select l.order_id, l.order_date,
         sum(case when l.currency = 'AUD' then l.net_native
                  else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) net_aud
  from shopify_sales_lines l
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int
   and r.month = extract(month from l.order_date)::int
  where l.order_date >= date '2025-07-01'
  group by 1, 2
),
cls as materialized (
  -- the ONE reference to the view (see PERFORMANCE above).
  -- LEFT join (review 2026-08-11): a sales order with no attribution row yet
  -- (capture gap — the freshest day, attribution sync lagging sales sync) must
  -- stay in the universe as non-google, mirroring the dashboard's full-join
  -- semantics. An inner join dropped it from BOTH sides and inflated ratioPct
  -- exactly on the days read against the frozen band.
  select r.order_date, r.net_aud,
         coalesce(oc.last_bucket in ('google-mixto-pre','google-organic','google-brand',
                            'google-nonbrand','google-shopping-proxy','google-paid-other'), false) is_goog
  from rev r
  left join advertising_order_channels oc using (order_id)
),
monthly as (
  -- goog coalesced (review 2026-08-11): a zero bag is DATA (bag genuinely 0),
  -- not a gap — the null-never-0 rule covers missing data, not true zeros.
  select date_trunc('month', order_date)::date mes,
         sum(net_aud) total,
         coalesce(sum(net_aud) filter (where is_goog), 0) goog,
         count(*) filter (where is_goog) goog_orders
  from cls group by 1
),
sp as (
  select date_trunc('month', date)::date mes,
         sum(spend_aud) spend
  from google_ads_daily group by 1
),
latest as (select max(order_date) d from cls),
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
  -- both per-day figures divide by CALENDAR days of their window (review
  -- 2026-08-11): dividing post by days-with-rows inflated it when a day had
  -- no brand row loaded, and a fully-stopped campaign would have read null.
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
  'band', jsonb_build_object(
    'windows', 326,
    'windowDays', 10,
    'period', '2025-07-10..2026-05-31 (zero Google spend)',
    'minPct', 20.1, 'p25Pct', 25.6, 'medianPct', 28.1, 'p75Pct', 31.4, 'maxPct', 62.3,
    'samePeriodAug2025Pct', 27.3),
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
