-- =============================================================================
-- IC13 — the baseline becomes per rate band. Fixes a wrong number on the tab.
--
-- What was wrong (Mario caught it, 14-Oct-2026): the frozen baseline was ONE
-- mean, A$13.66, over every Australia Post label on a US order. 84% of those
-- labels are one-item parcels from the US$10 band, whose own cost is A$11.38;
-- the rest are heavy free-shipping parcels at A$19.93. Averaging them put the
-- yardstick A$2 above the band that carries 85% of the orders, so the tab
-- reported the rule costing A$8.18 per order when the like-for-like figure on
-- the hero basket is A$10.46. The direction was right and every conclusion
-- built on it was understated.
--
-- Two further corrections folded in here:
--   * The standard rate CHANGED on 21-Sep-2026: that basket went A$12.43 ->
--     A$11.38. A baseline that reaches back before the change measures a rate
--     Australia Post no longer charges, so the frozen window now starts there.
--   * The 'live' band (customers who picked the carrier-calculated quote) was
--     never on the standard service at all - they bought ECM8 express at
--     A$29.37. Its baseline is what those orders really cost, so IC13 shows up
--     as CHEAPER for them, which is the truth.
--
-- The bands are the Shopify US rate card, read off what the customer was
-- actually charged (charged_shipping_native, USD) rather than re-deriving the
-- cart total - discounts and gift cards move the total, never the charge.
-- A band with no row here falls back to the segment's single baseline, so a
-- rate-card change cannot blank the tab; it just reads coarser until a row is
-- added.
-- =============================================================================

create table if not exists ddp_segment_baselines (
  segment_code      text not null references ddp_service_segments(code) on delete cascade,
  band_key          text not null,
  band_label        text not null,
  -- What the customer pays in this band, USD, for the label on the chip.
  charged_usd       numeric,
  sort_order        int not null default 0,
  baseline_cost_aud numeric not null,
  baseline_median_aud numeric,
  baseline_orders   integer,
  baseline_from     date not null,
  baseline_to       date not null,
  note              text,
  updated_at        timestamptz not null default now(),
  primary key (segment_code, band_key)
);
-- RLS in the same breath as the table (the 3-Oct-2026 Supabase mail).
alter table ddp_segment_baselines enable row level security;
drop policy if exists "ddp_segment_baselines read" on ddp_segment_baselines;
drop policy if exists "ddp_segment_baselines service" on ddp_segment_baselines;
create policy "ddp_segment_baselines read" on ddp_segment_baselines
  for select to authenticated using (true);
create policy "ddp_segment_baselines service" on ddp_segment_baselines
  for all to service_role using (true) with check (true);

-- Frozen from the standard labels issued between the 21-Sep rate change and
-- the day the rule started. Computed here once, then never recomputed.
insert into ddp_segment_baselines (
  segment_code, band_key, band_label, charged_usd, sort_order,
  baseline_cost_aud, baseline_median_aud, baseline_orders,
  baseline_from, baseline_to, note)
select 'US-IC13', b.band_key, b.band_label, b.charged_usd, b.sort_order,
       round(avg(l.freight_cost_aud)::numeric, 2),
       round(percentile_cont(0.5) within group (order by l.freight_cost_aud::float8)::numeric, 2),
       count(*)::int,
       date '2026-09-21', date '2026-10-13',
       b.note
from (values
  ('std20', 'US$20 · cart under US$46',      20.0, 1, 'Lightest parcels in the book. Only a handful of orders a month, so the mean is thin.'),
  ('std10', 'US$10 · cart US$46-99.99',      10.0, 2, 'The hero basket: 85% of US orders, ~73% of them one single product. This is the band the rule is really about.'),
  ('free',  'Free · cart US$100+',            0.0, 3, 'Heavy baskets, AOV ~A$219. Dolo already carried the whole label here BEFORE the rule - that loss is not new.'),
  ('live',  'Carrier-calculated · live quote', null, 4, 'Customers who chose the live Starshipit quote. They were never on the standard service: these are ECM8 express labels, so IC13 is CHEAPER for them.')
) as b(band_key, band_label, charged_usd, sort_order, note)
join lateral (
  select s.freight_cost_aud
  from ddp_shipments s
  where s.country_code = 'US'
    and s.ss_carrier = 'Australia Post'
    and s.freight_cost_aud is not null
    and coalesce(s.ss_service_code, 'x') <> 'IC13'
    and s.freight_matched_at >= timestamptz '2026-09-21 00:00:00+10'
    and s.freight_matched_at <  timestamptz '2026-10-14 00:00:00+10'
    and case
          when round(coalesce(s.charged_shipping_native, 0)::numeric, 2) = 0.00  then 'free'
          when round(coalesce(s.charged_shipping_native, 0)::numeric, 2) = 10.00 then 'std10'
          when round(coalesce(s.charged_shipping_native, 0)::numeric, 2) = 20.00 then 'std20'
          else 'live'
        end = b.band_key
) l on true
group by b.band_key, b.band_label, b.charged_usd, b.sort_order, b.note
on conflict (segment_code, band_key) do nothing;

update ddp_service_segments
set baseline_note = 'Superseded by ddp_segment_baselines: the baseline is now ONE PER RATE BAND, '
  || 'frozen from the standard labels issued between the 21-Sep-2026 rate change and the day the '
  || 'rule started. This single mean is only the fallback for a band with no row of its own.',
  updated_at = now()
where code = 'US-IC13';

-- ── the view's query, rebuilt on the per-band baseline ──────────────────────
-- Same two universes as before (MONEY = every label carrying the service;
-- ADHERENCE = orders placed since the rule). What changes is the yardstick:
-- every order is now compared against the frozen baseline OF ITS OWN RATE
-- BAND, and the bands are reported separately, because the blended figure hid
-- the only thing that matters - 85% of the orders and ~70% of the damage sit
-- in one band.
create or replace function public.ddp_service_segment_dashboard(
  p_code text,
  p_from date,
  p_to date,
  p_ledger_limit integer default 300
) returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
with seg as (
  select * from ddp_service_segments where code = p_code and active
),
base as (
  select s.*,
         (s.order_date at time zone 'Australia/Brisbane')::date      as day,
         coalesce(s.ss_service_code = g.service_code, false)         as is_seg,
         (s.freight_cost_aud is not null)                            as labelled,
         (s.order_date >= g.rule_from)                               as since_rule,
         bk.band_key,
         coalesce(bb.band_label, 'Other')                            as band_label,
         coalesce(bb.sort_order, 99)                                 as band_sort,
         bb.charged_usd                                              as band_charged_usd,
         -- The band's own frozen baseline; the segment-wide mean only when a
         -- band has no row (a rate-card change reads coarser, never blank).
         coalesce(bb.baseline_cost_aud, g.baseline_cost_aud)          as baseline,
         (bb.baseline_cost_aud is not null)                           as baseline_is_band
  from ddp_shipments s
  join seg g on g.country_code = s.country_code
  cross join lateral (
    select case
      when round(coalesce(s.charged_shipping_native, 0)::numeric, 2) = 0.00  then 'free'
      when round(coalesce(s.charged_shipping_native, 0)::numeric, 2) = 10.00 then 'std10'
      when round(coalesce(s.charged_shipping_native, 0)::numeric, 2) = 20.00 then 'std20'
      else 'live' end as band_key
  ) bk
  left join ddp_segment_baselines bb
    on bb.segment_code = g.code and bb.band_key = bk.band_key
  where (s.order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
),
ic      as (select * from base where is_seg and labelled),
adh     as (select * from base where since_rule),
adh_lab as (select * from adh where labelled),
rate as (
  select count(*)::numeric / 28.0 as per_day
  from ddp_shipments s
  join seg g on g.country_code = s.country_code
  where (s.order_date at time zone 'Australia/Brisbane')::date
        between ((now() at time zone 'Australia/Brisbane')::date - 28)
            and ((now() at time zone 'Australia/Brisbane')::date - 1)
),
-- ── one row per rate band: where the money actually is ─────────────────────
-- 'orders' counts the whole window; 'segment' counts only the labels carrying
-- the service, so extraPerOrder is null in a band no such label has reached
-- yet. A null there is the honest answer, not a zero.
band_rows as (
    select band_key, max(band_label) as band_label, max(band_sort) as sort_order,
      max(band_charged_usd) as band_charged_usd,
      round(max(baseline), 2)        as baseline,
      bool_or(baseline_is_band)      as is_band,
      count(*)                       as n,
      count(*) filter (where labelled) as nl,
      count(*) filter (where is_seg)   as ni,
      round(avg(coalesce(charged_shipping_aud, 0)), 2)                 as charged_avg,
      round(avg(freight_cost_aud) filter (where is_seg), 2)            as cost_avg,
      round(avg(freight_cost_aud - baseline) filter (where is_seg), 2) as extra,
      round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud) filter (where is_seg), 2) as margin,
      -- Per-order figure x this band's own order count, scaled to a month.
      -- Never a sum of the window: the window is whatever was selected.
      round(avg(freight_cost_aud - baseline) filter (where is_seg)
            * count(*) * 30.44
            / greatest((p_to - p_from) + 1, 1))                        as extra_monthly,
      round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud) filter (where is_seg)
            * count(*) * 30.44
            / greatest((p_to - p_from) + 1, 1))                        as margin_monthly
    from base group by band_key
),
-- The headline, weighted by ORDER COUNT across the bands, not by the handful
-- of labels that happen to have arrived. Averaging the labels themselves made
-- the first IC13 label in a band of 51 orders count as much as the band of
-- 1,458 - and that band's IC13 is CHEAPER than what those customers used to
-- buy, so the blended figure read A$6.72 when the real exposure is A$9.50.
-- Bands with no IC13 label yet are excluded and their share is reported, so
-- the number never pretends to cover orders it has not seen.
band_agg as (
  select
    round(sum(extra  * n) filter (where extra  is not null)
          / nullif(sum(n) filter (where extra  is not null), 0), 2) as extra_per_order,
    round(sum(margin * n) filter (where margin is not null)
          / nullif(sum(n) filter (where margin is not null), 0), 2) as margin_per_order,
    round(100.0 * sum(n) filter (where extra is not null)
          / nullif(sum(n), 0), 1)                                   as covered_pct,
    round(sum(extra_monthly)  filter (where extra_monthly  is not null)) as extra_monthly,
    round(sum(margin_monthly) filter (where margin_monthly is not null)) as margin_monthly
  from band_rows
),
kpis as (
  select jsonb_build_object(
    'segOrders',      (select count(*) from ic),
    -- Band-weighted (see band_agg); the raw label average is kept alongside
    -- so nobody has to guess which one they are reading.
    'extraPerOrder',  (select extra_per_order from band_agg),
    'extraPerOrderRaw', (select round(avg(freight_cost_aud - baseline), 2) from ic),
    'bandsCoveredPct', (select covered_pct from band_agg),
    'extraTotal',     (select round(sum(freight_cost_aud - baseline)) from ic),
    'costAvg',        (select round(avg(freight_cost_aud), 2) from ic),
    'costMedian',     (select round(percentile_cont(0.5) within group (order by freight_cost_aud::float8)::numeric, 2) from ic),
    'chargedAvg',     (select round(avg(coalesce(charged_shipping_aud, 0)), 2) from ic),
    'marginPerOrder', (select margin_per_order from band_agg),
    'marginPerOrderRaw', (select round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud), 2) from ic),
    'marginTotal',    (select round(sum(coalesce(charged_shipping_aud, 0) - freight_cost_aud)) from ic),
    'freeShipOrders', (select count(*) from ic where coalesce(charged_shipping_aud, 0) = 0),
    'freeShipPct',    (select case when count(*) = 0 then null
                       else round(100.0 * count(*) filter (where coalesce(charged_shipping_aud, 0) = 0) / count(*), 1) end from ic),
    'ordersPerDay',   (select round(per_day, 1) from rate),
    -- Sum of the bands' own monthly figures, not a blended average x volume.
    'projMonthly',    (select extra_monthly from band_agg),
    'marginMonthly',  (select margin_monthly from band_agg),
    'firstSeenAt',    (select min(freight_matched_at) from ic),
    'firstOrderAt',   (select min(order_date) from ic),
    'adherence', jsonb_build_object(
      'orders',      (select count(*) from adh),
      'labelled',    (select count(*) from adh_lab),
      'segment',     (select count(*) from adh_lab where is_seg),
      'pct',         (select case when count(*) = 0 then null
                      else round(100.0 * count(*) filter (where is_seg) / count(*), 1) end from adh_lab),
      'coveragePct', (select case when count(*) = 0 then null
                      else round(100.0 * count(*) filter (where labelled) / count(*), 1) end from adh)
    )
  ) as j
),
bands as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', band_key, 'label', band_label, 'chargedUsd', band_charged_usd,
    'orders', n, 'labelled', nl, 'segment', ni,
    'baseline', baseline, 'baselineIsBand', is_band,
    'chargedAvg', charged_avg, 'costAvg', cost_avg,
    'extraPerOrder', extra, 'marginPerOrder', margin,
    'extraMonthly', extra_monthly, 'marginMonthly', margin_monthly
  ) order by sort_order), '[]'::jsonb) as j
  from band_rows
),
services as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', code, 'name', nm, 'orders', n, 'pct', pct, 'costAvg', c, 'isSegment', is_seg
  ) order by n desc), '[]'::jsonb) as j
  from (
    select coalesce(ss_service_code, '(not recorded)') as code,
           max(ss_service_name)                       as nm,
           bool_or(is_seg)                            as is_seg,
           count(*)                                   as n,
           round(100.0 * count(*) / nullif((select count(*) from adh_lab), 0), 1) as pct,
           round(avg(freight_cost_aud), 2)            as c
    from adh_lab group by 1
  ) t
),
daily as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', day, 'orders', n, 'labelled', nl, 'segment', ni, 'segmentPct', pct,
    'chargedAvg', ca, 'costAvg', ia, 'extraPerOrder', ex
  ) order by day desc), '[]'::jsonb) as j
  from (
    select day,
      count(*)                                            as n,
      count(*) filter (where labelled)                    as nl,
      count(*) filter (where is_seg)                      as ni,
      case when count(*) filter (where labelled) = 0 then null
           else round(100.0 * count(*) filter (where is_seg) / count(*) filter (where labelled), 0) end as pct,
      round(avg(coalesce(charged_shipping_aud, 0)) filter (where is_seg), 2) as ca,
      round(avg(freight_cost_aud) filter (where is_seg), 2)                  as ia,
      round(avg(freight_cost_aud - baseline) filter (where is_seg), 2)       as ex
    from base where since_rule group by day
  ) t
),
ledger as (
  select coalesce(jsonb_agg(r order by day desc, order_name desc), '[]'::jsonb) as j
  from (
    select day, order_name, jsonb_build_object(
      'order', order_name, 'date', day,
      'service', ss_service_code, 'serviceName', ss_service_name,
      'isSegment', is_seg, 'labelled', labelled,
      'band', band_label,
      'charged',  round(coalesce(charged_shipping_aud, 0), 2),
      'freight',  round(freight_cost_aud, 2),
      'baseline', round(baseline, 2),
      'extra',    case when is_seg then round(freight_cost_aud - baseline, 2) end,
      'margin',   case when labelled then round(coalesce(charged_shipping_aud, 0) - freight_cost_aud, 2) end,
      'tracking', tracking_number, 'carrier', ss_carrier,
      'freightChecked', freight_checked_at is not null
    ) as r
    from base where since_rule
    order by day desc, order_name desc
    limit greatest(coalesce(p_ledger_limit, 300), 1)
  ) l
)
select jsonb_build_object(
  'segment', (select jsonb_build_object(
      'code', code, 'name', name, 'country', country_code,
      'serviceCode', service_code, 'ruleFrom', rule_from, 'note', note,
      'baseline', jsonb_build_object(
        'costAud', baseline_cost_aud, 'medianAud', baseline_median_aud,
        'chargedAud', baseline_charged_aud, 'orders', baseline_orders,
        'from', baseline_from, 'to', baseline_to, 'note', baseline_note)
    ) from seg),
  'kpis',        (select j from kpis),
  'bands',       (select j from bands),
  'services',    (select j from services),
  'daily',       (select j from daily),
  'ledger',      (select j from ledger),
  'ledgerTotal', (select count(*) from base where since_rule),
  'markets', (select coalesce(jsonb_agg(jsonb_build_object(
                'code', country_code, 'name', name,
                'chargesDuties', charges_duties, 'inAllMarkets', in_all_markets,
                'dutiesIncludedFrom', duties_included_from, 'showsMer', shows_mer)
              order by in_all_markets desc, country_code), '[]'::jsonb)
             from ddp_markets where active),
  'segments', (select coalesce(jsonb_agg(jsonb_build_object(
                 'code', code, 'name', name, 'country', country_code,
                 'serviceCode', service_code, 'ruleFrom', rule_from)
               order by code), '[]'::jsonb)
              from ddp_service_segments where active),
  'window', jsonb_build_object('from', p_from, 'to', p_to)
);
$function$;

revoke all on function public.ddp_service_segment_dashboard(text, date, date, integer) from public, anon;
grant execute on function public.ddp_service_segment_dashboard(text, date, date, integer) to authenticated, service_role;
