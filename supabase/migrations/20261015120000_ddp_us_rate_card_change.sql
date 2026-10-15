-- =============================================================================
-- United States - the shipping rate card becomes data, with the date it
-- changed, and the IC13 yardstick stops depending on it.
--
-- Mario, 15-Oct-2026: the US rate card is now US$15 flat under US$130 and free
-- from US$130, replacing US$20 under US$46 / US$10 to US$99.99 / free from
-- US$100. Same card in both Shopify shipping profiles (General and PESADO
-- 58.5). The 3PL USA zone keeps the old card but is not live, so it is not
-- modelled here.
--
-- The cutover is MEASURED from the orders, not assumed, the same way the IC13
-- rule and Canada's duties change were:
--     PSD#79715  12:16:39 Brisbane  US$10   (last order on the old card)
--     PSD#79718  12:28:54 Brisbane  US$15   (first order on the new card)
-- so 12:20 sits inside the gap.
--
-- WHAT WOULD HAVE BROKEN. The IC13 view put each order in a band by WHAT IT
-- WAS CHARGED: US$0 free, US$10, US$20, anything else "live quote". A US$15
-- order falls into "live quote", whose before-cost is A$28.49 - the ECM8
-- express those customers used to buy - so IC13 at A$21.84 reads A$6.65
-- CHEAPER and the headline "extra actually spent" starts falling with every
-- new order.
--
-- THE FIX. Two different things had been read off one number:
--   * the before-cost is a property of the PARCEL - a one-item box and a heavy
--     multi-item one never cost the same - so the band that picks it is now
--     the CART SIZE (USD), on the boundaries both cards use: 46, 100, 130.
--     While the charge tracked the cart size it was a fair proxy; one flat
--     rate under US$130 ended that.
--   * the charge identifies which CARD the order was under, and the live
--     quote: anything that is not a card amount, or the sum of two (a cart
--     split across two shipping profiles is charged by both - 5 orders since
--     August), came from the live carrier quote.
-- Splitting the old "free" band in two is worth it on its own: carts of
-- US$100-129.99 cost A$15.55 a label, carts of US$130+ A$24.46; averaged they
-- were A$19.93 and wrong for both.
--
-- The before-costs are re-frozen once, here, on the same evidence as before -
-- standard (non-IC13) Australia Post labels on US orders placed between the
-- 21-Sep-2026 Australia Post rate change and the moment the rule started - now
-- grouped by cart size. The superseded rows (std20/std10/free/live) are
-- removed; their values remain in migration 20261014140000.
-- =============================================================================

-- ── 1. rate cards ────────────────────────────────────────────────────────────
create table if not exists ddp_rate_cards (
  country_code   text not null references ddp_markets(country_code),
  card_key       text not null,
  effective_from timestamptz not null,
  label          text not null,
  -- USD charged per cart-size band under this card. Keys are the band_key of
  -- ddp_segment_baselines, so a band and its price can never drift apart.
  band_charges   jsonb not null,
  note           text,
  updated_at     timestamptz not null default now(),
  primary key (country_code, card_key)
);
alter table ddp_rate_cards enable row level security;
drop policy if exists "ddp_rate_cards read" on ddp_rate_cards;
drop policy if exists "ddp_rate_cards service" on ddp_rate_cards;
create policy "ddp_rate_cards read" on ddp_rate_cards
  for select to authenticated using (true);
create policy "ddp_rate_cards service" on ddp_rate_cards
  for all to service_role using (true) with check (true);

insert into ddp_rate_cards (country_code, card_key, effective_from, label, band_charges, note) values
  ('US', 'us-2026-08', timestamptz '2026-08-01 00:00:00+10',
   'US$20 under US$46 · US$10 to US$99.99 · free from US$100',
   '{"cart_lt46": 20, "cart_46_100": 10, "cart_100_130": 0, "cart_130": 0}',
   'The card in force when the DDP tab opened. Standard service, 10-15 days.'),
  ('US', 'us-2026-10-15', timestamptz '2026-10-15 12:20:00+10',
   'US$15 flat · free from US$130',
   '{"cart_lt46": 15, "cart_46_100": 15, "cart_100_130": 15, "cart_130": 0}',
   'Express 5-6 days (IC13). Measured cutover: last US$10 order 12:16:39, first US$15 order 12:28:54 Brisbane, 15-Oct-2026.')
on conflict (country_code, card_key) do nothing;

-- ── 2. before-costs by cart size ────────────────────────────────────────────
delete from ddp_segment_baselines
where segment_code = 'US-IC13'
  and band_key in ('std20', 'std10', 'free', 'live',
                   'cart_lt46', 'cart_46_100', 'cart_100_130', 'cart_130');

insert into ddp_segment_baselines (
  segment_code, band_key, band_label, charged_usd, sort_order,
  baseline_cost_aud, baseline_median_aud, baseline_orders,
  baseline_from, baseline_to, note)
select 'US-IC13', b.band_key, b.band_label, null, b.sort_order,
       round(avg(l.f)::numeric, 2),
       round(percentile_cont(0.5) within group (order by l.f::float8)::numeric, 2),
       count(*)::int,
       date '2026-09-21', date '2026-10-14',
       b.note
from (values
  ('cart_lt46',    'Cart under US$46',        1, 'Lightest parcels. Thin: about twenty labels in the window.'),
  ('cart_46_100',  'Cart US$46 – 99.99',      2, 'The hero basket - one shower screen. Most US orders.'),
  ('cart_100_130', 'Cart US$100 – 129.99',    3, 'Free under the old card, US$15 under the new one.'),
  ('cart_130',     'Cart US$130+',            4, 'Free under both cards. Heaviest parcels.'),
  ('live',         'Live quote',              5, 'Customers who chose the carrier-calculated quote. Before the rule they got the service they picked - IC13 itself for about half of them, ECM8 for the rest - so this before-cost averages ALL their labels, IC13 included.')
) as b(band_key, band_label, sort_order, note)
join lateral (
  select s.freight_cost_aud as f
  from ddp_shipments s
  cross join lateral (
    select round((s.subtotal_aud / nullif(s.fx_rate, 0))::numeric, 2) as cart_usd,
           round(coalesce(s.charged_shipping_native, 0)::numeric, 2)   as paid_usd
  ) cu
  where s.country_code = 'US'
    and s.ss_carrier = 'Australia Post'
    and s.freight_cost_aud is not null
    -- Card orders never got IC13 before the rule, so their before-cost is the
    -- standard label. Live-quote customers CHOSE their service, and 27 of 58
    -- chose IC13 itself: excluding those would make IC13 look cheaper than
    -- what they were already buying.
    and (b.band_key = 'live' or coalesce(s.ss_service_code, 'x') <> 'IC13')
    and s.order_date >= timestamptz '2026-09-21 00:00:00+10'
    and s.order_date <  (select rule_from from ddp_service_segments where code = 'US-IC13')
    and case
          when cu.paid_usd not in (0, 10, 15, 20, 25, 30, 35, 40) then 'live'
          when cu.cart_usd < 46  then 'cart_lt46'
          when cu.cart_usd < 100 then 'cart_46_100'
          when cu.cart_usd < 130 then 'cart_100_130'
          else 'cart_130'
        end = b.band_key
) l on true
group by b.band_key, b.band_label, b.sort_order, b.note
on conflict (segment_code, band_key) do nothing;

-- ── 3. the view's query ─────────────────────────────────────────────────────
create or replace function public.ddp_service_segment_dashboard(
  p_code text, p_from date, p_to date, p_ledger_limit integer default 300
) returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
-- ── before / after the rate card change ─────────────────────────────────────
-- Equal windows either side of the cutover, as long as the time since it and
-- capped at 28 days, independent of the date range: same design as Canada's
-- duties block. Customer-side rows count every order. Cost rows count only
-- card orders with an IC13 label, which pins the "before" side to the hours
-- between the IC13 rule and the card change - the only time IC13 ran on the
-- old prices.
rc_cut as (
  select cur.effective_from as cut, cur.label as label_now, prev.label as label_before,
         least(greatest(now() - cur.effective_from, interval '0'), interval '28 days') as span
  from cur join prev on true
),
rc_orders as (
  select case when s.order_date >= r.cut then 'after' else 'before' end as side,
         round((s.subtotal_aud / nullif(s.fx_rate, 0))::numeric, 2)     as cart_usd,
         round(coalesce(s.charged_shipping_native, 0)::numeric, 2)       as paid_usd,
         coalesce(s.charged_shipping_aud, 0)                             as paid_aud,
         s.freight_cost_aud,
         coalesce(s.ss_service_code = g.service_code, false)            as is_seg
  from ddp_shipments s
  join seg g on g.country_code = s.country_code
  cross join rc_cut r
  where s.order_date >= r.cut - r.span and s.order_date < r.cut + r.span
),
rc_agg as (
  select side,
    count(*) as n,
    round(avg(paid_aud) filter (where card), 2)                                  as paid_per_order,
    round(100.0 * count(*) filter (where card and paid_usd = 0)
          / nullif(count(*) filter (where card), 0), 1)                          as free_pct,
    round(percentile_cont(0.5) within group (order by cart_usd)::numeric, 2)     as median_cart_usd,
    round(100.0 * count(*) filter (where cart_usd >= 100 and cart_usd < 130) / nullif(count(*), 0), 1) as share_100_130,
    round(100.0 * count(*) filter (where cart_usd >= 130 and cart_usd < 160) / nullif(count(*), 0), 1) as share_130_160,
    count(*) filter (where card and is_seg and freight_cost_aud is not null)     as n_lab,
    round(avg(freight_cost_aud) filter (where card and is_seg and freight_cost_aud is not null), 2) as label_per_order,
    round(avg(paid_aud - freight_cost_aud) filter (where card and is_seg and freight_cost_aud is not null), 2) as gap_per_order
  from (select o.*, o.paid_usd in (select amt from card_sums) as card from rc_orders o) x
  group by side
),
-- Meta spend delivered in the market, per FULL day: equal day counts either
-- side, today excluded because its spend is still coming in. Shown so a move in
-- orders per day is not blamed on the price when the ads moved - the lesson
-- from Canada, where spend tripled across the change.
rc_days as (
  select least(greatest(((now() at time zone 'Australia/Brisbane')::date - 1)
                        - (r.cut at time zone 'Australia/Brisbane')::date + 1, 0), 28) as n,
         (r.cut at time zone 'Australia/Brisbane')::date as after_from
  from rc_cut r
),
rc_spend as (
  select
    round(sum(sp.spend_aud) filter (where sp.date >= d.after_from) / nullif(d.n, 0)) as after_per_day,
    round(sum(sp.spend_aud) filter (where sp.date <  d.after_from) / nullif(d.n, 0)) as before_per_day
  from rc_days d
  left join lateral (
    select c.date,
           case when c.currency = 'USD' then c.spend * coalesce(fx.rate, 1.54) else c.spend end as spend_aud
    from meta_ads_country_daily c
    left join currency_exchange_rates fx
      on fx.year = extract(year from c.date) and fx.month = extract(month from c.date)
    where c.country = (select country_code from seg)
      and d.n > 0
      and c.date >= d.after_from - d.n
      and c.date <= d.after_from + d.n - 1
  ) sp on true
  group by d.n, d.after_from
),
rate_change as (
  select jsonb_build_object(
    'cutAt', r.cut, 'labelBefore', r.label_before, 'labelNow', r.label_now,
    'windowHours', round((extract(epoch from r.span) / 3600.0)::numeric, 1),
    'spendDays', d.n,
    'before', (select jsonb_build_object(
        'orders', a.n,
        'ordersPerDay', case when r.span > interval '0'
                             then round((a.n / (extract(epoch from r.span) / 86400.0))::numeric, 1) end,
        'paidPerOrder', a.paid_per_order, 'freePct', a.free_pct,
        'medianCartUsd', a.median_cart_usd,
        'share100to130', a.share_100_130, 'share130to160', a.share_130_160,
        'labelled', a.n_lab, 'labelPerOrder', a.label_per_order, 'gapPerOrder', a.gap_per_order,
        'spendPerDay', (select before_per_day from rc_spend))
      from rc_agg a where a.side = 'before'),
    'after', (select jsonb_build_object(
        'orders', a.n,
        'ordersPerDay', case when r.span > interval '0'
                             then round((a.n / (extract(epoch from r.span) / 86400.0))::numeric, 1) end,
        'paidPerOrder', a.paid_per_order, 'freePct', a.free_pct,
        'medianCartUsd', a.median_cart_usd,
        'share100to130', a.share_100_130, 'share130to160', a.share_130_160,
        'labelled', a.n_lab, 'labelPerOrder', a.label_per_order, 'gapPerOrder', a.gap_per_order,
        'spendPerDay', (select after_per_day from rc_spend))
      from rc_agg a where a.side = 'after')
  ) as j
  from rc_cut r cross join rc_days d
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
  'rateChange',  (select j from rate_change),
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
$function$;

revoke all on function public.ddp_service_segment_dashboard(text, date, date, integer) from public, anon;
grant execute on function public.ddp_service_segment_dashboard(text, date, date, integer) to authenticated, service_role;
