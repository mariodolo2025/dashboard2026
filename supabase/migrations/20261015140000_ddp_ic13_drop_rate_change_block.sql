-- =============================================================================
-- IC13 - the "Rate card change" before/after block is removed.
--
-- Mario, 15-Oct-2026, looking at it live: "no tiene ningun sentido, es
-- informacion que no aporta nada". Checked row by row, and it held:
--   * shipping paid per order, share shipped free and carts US$100-129.99
--     restate the rate card itself (US$10 -> US$15, free from US$130) - they
--     are its definition, not something measured;
--   * the gap per order under the new card and the IC13 label are already in
--     "By cart size" (Gap / order now);
--   * median cart is the hero product either side and does not move;
--   * the one real question - did the price cost orders - needs days, and two
--     averages over a few hours each is the wrong instrument for it. It is
--     read in E-commerce (US), where daily orders and Meta spend already sit
--     side by side and the 15-Oct change shows as a break in the line.
-- ddp_rate_cards stays: it drives the cart-size bands' prices, the live-quote
-- detection and the card shown in the header.
-- Edited from the LIVE function body.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ddp_service_segment_dashboard(p_code text, p_from date, p_to date, p_ledger_limit integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with seg as (
  select * from ddp_service_segments where code = p_code and active
),
-- The market's rate cards in order, each with the moment the next one took over.
cards as (
  select rc.*,
         lead(rc.effective_from) over (order by rc.effective_from) as effective_to,
         lag(rc.card_key)        over (order by rc.effective_from) as prev_key
  from ddp_rate_cards rc
  join seg g on g.country_code = rc.country_code
),
cur  as (select * from cards where effective_from <= now() order by effective_from desc limit 1),
prev as (select c.* from cards c join cur on c.card_key = cur.prev_key),
-- Every amount any card charges, and the sum of any two of them: a cart that
-- spans two Shopify shipping profiles is charged by both. Any other amount
-- came from the live carrier quote. Read off the cards, so a new card brings
-- its own amounts with it.
card_amounts as (
  select distinct e.v::numeric as amt
  from cards, jsonb_each_text(cards.band_charges) as e(k, v)
),
card_sums as (
  select amt from card_amounts
  union
  select a.amt + b.amt from card_amounts a cross join card_amounts b
),
base as (
  select s.*,
         (s.order_date at time zone 'Australia/Brisbane')::date      as day,
         -- A label of the service on an order placed SINCE THE RULE. Before it,
         -- an IC13 label was the customer's own choice (the live quote), not
         -- the rule's cost - and the ledger lists orders since the rule only,
         -- so counting them in the headline left a total the ledger could not
         -- add up to (found by an independent recount: PSD#79349, PSD#79361).
         (coalesce(s.ss_service_code = g.service_code, false)
          and s.order_date >= g.rule_from)                           as is_seg,
         (s.freight_cost_aud is not null)                            as labelled,
         (s.order_date >= g.rule_from)                               as since_rule,
         cu.cart_usd, cu.paid_usd,
         bk.band_key,
         coalesce(bb.band_label, 'Other')                            as band_label,
         coalesce(bb.sort_order, 99)                                 as band_sort,
         -- The band's own frozen before-cost; the segment-wide mean only when a
         -- band has no row, so a gap in the table reads coarser, never blank.
         coalesce(bb.baseline_cost_aud, g.baseline_cost_aud)          as baseline,
         (bb.baseline_cost_aud is not null)                           as baseline_is_band,
         cd.card_key,
         cd.label                                                    as card_label
  from ddp_shipments s
  join seg g on g.country_code = s.country_code
  cross join lateral (
    select round((s.subtotal_aud / nullif(s.fx_rate, 0))::numeric, 2) as cart_usd,
           round(coalesce(s.charged_shipping_native, 0)::numeric, 2)   as paid_usd
  ) cu
  cross join lateral (
    select case
      when cu.paid_usd not in (select amt from card_sums) then 'live'
      when cu.cart_usd is null then 'unknown'
      when cu.cart_usd < 46  then 'cart_lt46'
      when cu.cart_usd < 100 then 'cart_46_100'
      when cu.cart_usd < 130 then 'cart_100_130'
      else 'cart_130' end as band_key
  ) bk
  left join ddp_segment_baselines bb
    on bb.segment_code = g.code and bb.band_key = bk.band_key
  left join cards cd
    on s.order_date >= cd.effective_from
   and (cd.effective_to is null or s.order_date < cd.effective_to)
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
band_rows as (
    select band_key, max(band_label) as band_label, max(band_sort) as sort_order,
      round(max(baseline), 2)        as baseline,
      bool_or(baseline_is_band)      as is_band,
      count(*)                       as n,
      count(*) filter (where labelled) as nl,
      count(*) filter (where is_seg)   as ni,
      round(avg(coalesce(charged_shipping_aud, 0)), 2)                 as charged_avg,
      round(avg(freight_cost_aud) filter (where is_seg), 2)            as cost_avg,
      round(avg(freight_cost_aud - baseline) filter (where is_seg), 2) as extra,
      round(sum(freight_cost_aud - baseline) filter (where is_seg), 2) as extra_so_far,
      round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud) filter (where is_seg), 2) as margin,
      -- The gap under the card IN FORCE only. Averaging across the change would
      -- blend two prices into a number neither of them produced.
      count(*) filter (where is_seg and card_key = (select card_key from cur)) as n_now,
      round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud)
            filter (where is_seg and card_key = (select card_key from cur)), 2) as gap_now,
      round(avg(freight_cost_aud - baseline) filter (where is_seg)
            * count(*) * 30.44
            / greatest((p_to - p_from) + 1, 1))                        as extra_monthly,
      round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud) filter (where is_seg)
            * count(*) * 30.44
            / greatest((p_to - p_from) + 1, 1))                        as margin_monthly
    from base group by band_key
),
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
    'extraPerOrder',  (select extra_per_order from band_agg),
    'extraPerOrderRaw', (select round(avg(freight_cost_aud - baseline), 2) from ic),
    'bandsCoveredPct', (select covered_pct from band_agg),
    'extraTotal',     (select round(sum(freight_cost_aud - baseline), 2) from ic),
    'beforeTotal',    (select round(sum(baseline), 2) from ic),
    'chargedTotal',   (select round(sum(coalesce(charged_shipping_aud, 0)), 2) from ic),
    'costAvg',        (select round(avg(freight_cost_aud), 2) from ic),
    'costTotal',      (select round(sum(freight_cost_aud), 2) from ic),
    'costMedian',     (select round(percentile_cont(0.5) within group (order by freight_cost_aud::float8)::numeric, 2) from ic),
    'chargedAvg',     (select round(avg(coalesce(charged_shipping_aud, 0)), 2) from ic),
    'marginPerOrder', (select margin_per_order from band_agg),
    'marginPerOrderRaw', (select round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud), 2) from ic),
    'marginTotal',    (select round(sum(coalesce(charged_shipping_aud, 0) - freight_cost_aud), 2) from ic),
    'freeShipOrders', (select count(*) from ic where coalesce(charged_shipping_aud, 0) = 0),
    'freeShipPct',    (select case when count(*) = 0 then null
                       else round(100.0 * count(*) filter (where coalesce(charged_shipping_aud, 0) = 0) / count(*), 1) end from ic),
    'ordersPerDay',   (select round(per_day, 1) from rate),
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
    'key', band_key, 'label', band_label,
    -- What this cart size is charged under the card in force and the one before.
    'paysNowUsd',    (select (band_charges ->> band_key)::numeric from cur),
    'paysBeforeUsd', (select (band_charges ->> band_key)::numeric from prev),
    'orders', n, 'labelled', nl, 'segment', ni,
    'baseline', baseline, 'baselineIsBand', is_band,
    'chargedAvg', charged_avg, 'costAvg', cost_avg,
    'extraSoFar', extra_so_far,
    'extraPerOrder', extra, 'marginPerOrder', margin,
    'labelsNow', n_now, 'gapNow', gap_now,
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
label_series as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'order', order_name,
    'extra', round(freight_cost_aud - baseline, 2),
    'cost',  round(freight_cost_aud, 2),
    'band',  band_label,
    'service', ss_service_code
  ) order by order_date), '[]'::jsonb) as j
  from (select * from base where labelled and since_rule order by order_date desc limit 60) t
),
ledger as (
  select coalesce(jsonb_agg(r order by order_date desc), '[]'::jsonb) as j
  from (
    select order_date, jsonb_build_object(
      'order', order_name, 'date', day,
      'subtotal',   round(subtotal_aud, 2),
      -- In USD, the currency the customer saw and the one the rate card's
      -- boundaries are written in.
      'cartUsd',    cart_usd,
      'chargedUsd', round(charged_shipping_native, 2),
      'card',       card_label,
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
    order by order_date desc
    limit greatest(coalesce(p_ledger_limit, 300), 1)
  ) l
)
select jsonb_build_object(
  'segment', (select jsonb_build_object(
      'code', code, 'name', name, 'country', country_code,
      'serviceCode', service_code, 'ruleFrom', rule_from, 'note', note,
      'rateCard', (select jsonb_build_object('label', label, 'from', effective_from) from cur),
      'baseline', jsonb_build_object(
        'costAud', baseline_cost_aud, 'medianAud', baseline_median_aud,
        'chargedAud', baseline_charged_aud, 'orders', baseline_orders,
        'from', baseline_from, 'to', baseline_to, 'note', baseline_note)
    ) from seg),
  'kpis',        (select j from kpis),
  'bands',       (select j from bands),
  'services',    (select j from services),
  'labelSeries', (select j from label_series),
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
$function$
;

revoke all on function public.ddp_service_segment_dashboard(text, date, date, integer) from public, anon;
grant execute on function public.ddp_service_segment_dashboard(text, date, date, integer) to authenticated, service_role;
