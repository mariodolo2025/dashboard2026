-- =============================================================================
-- DDP Markets — a market's duties policy can change on a date (Canada, 11-Sep)
-- =============================================================================
-- Mario, 2026-09-14: "a partir del viernes 11/9 por la tarde, los envios a
-- canada ya tienen duties and taxes included en el precio, por lo tanto quiero
-- que al seleccionar Canada me de esta info para poder tener punto de
-- comparacion con lo anterior."
--
-- THE CUTOVER, READ OFF THE ORDERS (not assumed from "por la tarde"):
--   last order with tax charged at checkout  PSD#70959  11-Sep 07:28 Brisbane
--   first order with neither duties nor tax  PSD#71022  11-Sep 13:27 Brisbane
-- Every Canadian order before the pair charges tax; every one after charges
-- none, and there are no orders in between - so any moment in that gap splits
-- the orders identically. 13:00 Brisbane (03:00 UTC) is used.
--
-- WHAT CHANGED WITH IT: the price. The typical one-product order went from a
-- A$73.82 subtotal + A$12.22 tax at checkout to A$88.55 with no tax - +20% on
-- the shelf, slightly more than the tax it replaces.
--
-- WHY A DATE AND NOT FLIPPING charges_duties. Flipping the flag would restate
-- every Canadian order since August as "absorbed", which they were not. And
-- even per order, the naive reading is a trap: after the cutover "charged at
-- checkout" is shipping only, so recovery would collapse on paper while the
-- customer is paying MORE in total - the duties money now travels inside the
-- subtotal, which the reconciliation never looks at. So:
--
--   * duties_included_from   when set, orders placed on/after it are treated
--                            as not charging duties/taxes at checkout; orders
--                            before keep the market's charges_duties. Each
--                            order carries the policy of its own date.
--   * policyChange (payload) only when one market with such a date is
--                            selected: two windows of EQUAL LENGTH either side
--                            of the cutover - as long as the time elapsed since
--                            it, capped by the history available before it - so
--                            they grow together daily and volumes are
--                            comparable. Independent of the tab's date range.
--                            Per side: orders/day, median subtotal (single
--                            product orders dominate, so the median shows the
--                            price change that the mean hides under big
--                            baskets), duties+taxes at checkout per order and
--                            as % of subtotal, what the customer pays in total
--                            per order, and what ZONOS bills in duties+taxes as
--                            % of subtotal - with its coverage, because ZONOS
--                            bills Canada about a week after shipping.
--
-- The question the block exists to answer: does the ~20% price increase cover
-- what ZONOS bills? On 2026-09-14 the cost side is blind (0 of 61 post-cutover
-- orders billed by ZONOS); the block says so instead of printing a zero.
--
-- PATCH, NOT REWRITE. Applied through pg_get_functiondef + anchored replaces,
-- each asserted to match its exact expected count (the project's pattern, see
-- 20260828090000 / 20260907100000), so everything else in the body stays
-- byte-identical. A second run returns early on the policyChange marker.
--
-- VERIFIED after apply: see the commit body.

alter table ddp_markets add column if not exists duties_included_from timestamptz;

comment on column ddp_markets.duties_included_from is
  'When set, orders placed on or after this moment do not charge duties/taxes at checkout '
  '(they are included in the price), whatever charges_duties says. Orders before it keep '
  'charges_duties. Drives the Before/After comparison when this market is selected.';

update ddp_markets set
  duties_included_from = timestamptz '2026-09-11 03:00:00+00',
  note = 'Added 2026-09-02, enabled in ZONOS. Duties and taxes charged at checkout until 11-Sep-2026 ~13:00 Brisbane; '
         'from then on INCLUDED in the price (CAD prices up ~20%). Own CANADA campaign (USD), own MER.',
  updated_at = now()
where country_code = 'CA';

do $mig$
declare
  src      text;
  i        int;
  n        int;
  anchors  text[] := array[
    -- 1 carry the date through the market list
    $a$charges_duties, in_all_markets$a$,
    -- 2 the order's own policy as the output column
    $a$mv.charges_duties,$a$,
    -- 3 every policy branch inside base
    $a$case when mv.charges_duties then$a$,
    -- 4 where that policy is computed, once per order
    $a$join mv on mv.country_code = s.country_code$a$,
    -- 5 the view's policy comes from its orders, not the market flag
    $a$(select case when count(distinct charges_duties) = 1 then bool_and(charges_duties) end from mv)$a$,
    $a$-- view mixes policies (never today: the aggregate is DDP-charging only).$a$,
    -- 6 a country's policy is null when its orders mix
    $a$bool_and(b.charges_duties) as cd$a$,
    -- 7 the market list tells the tab about the date
    $a$'inAllMarkets', in_all_markets,$a$,
    -- 8 the comparison CTEs, between the last CTE and the final select
    E')\nselect jsonb_build_object(',
    -- 9 ... and its output key
    $a$'kpis', (select j from kpis),$a$
  ];
  expected int[] := array[1, 1, 4, 1, 1, 1, 1, 1, 1, 1];
  repls    text[] := array[
    $a$charges_duties, in_all_markets, duties_included_from$a$,

    $a$pol.cd as charges_duties,$a$,

    $a$case when pol.cd then$a$,

    $a$join mv on mv.country_code = s.country_code
  -- The policy as it stood WHEN THE ORDER WAS PLACED. A market can change it
  -- on a date (Canada moved duties into the price on 11-Sep-2026): orders from
  -- duties_included_from on charge nothing at checkout, orders before keep the
  -- market's charges_duties. Restating history with the new flag would be false.
  cross join lateral (
    select (mv.charges_duties
            and (mv.duties_included_from is null or s.order_date < mv.duties_included_from)) as cd
  ) pol$a$,

    $a$(select case
                when exists (select 1 from base)
                  then (select case when count(distinct charges_duties) = 1 then bool_and(charges_duties) end from base)
                else (select case when count(distinct charges_duties) = 1 then bool_and(charges_duties) end from mv)
              end)$a$,

    $a$-- view mixes policies (e.g. a Canada window spanning its 11-Sep cutover).
    -- Read from the ORDERS, since a market's policy can change on a date.$a$,

    $a$case when count(distinct b.charges_duties) = 1 then bool_and(b.charges_duties) end as cd$a$,

    $a$'inAllMarkets', in_all_markets,
                'dutiesIncludedFrom', duties_included_from,$a$,

    $a$),
-- ── Before / after a policy change (only with one such market selected) ─────
-- Two windows of equal length either side of the cutover: as long as the time
-- since it, capped by the history before it. Independent of p_from/p_to - the
-- point is a like-for-like comparison, and a range ending before the cutover
-- would leave one side empty.
pm as (
  select country_code, duties_included_from as cut
  from mk
  where p_country is not null and country_code = p_country
    and duties_included_from is not null
),
pw as (
  select pm.country_code, pm.cut,
         least(greatest(x.last_at - pm.cut, interval '0'),
               greatest(pm.cut - x.first_at, interval '0')) as span
  from pm
  cross join lateral (
    select max(order_date) as last_at, min(order_date) as first_at
    from ddp_shipments s where s.country_code = pm.country_code
  ) x
),
po as (
  select case when s.order_date >= pw.cut then 'after' else 'before' end as side, s.*
  from ddp_shipments s
  join pw on s.country_code = pw.country_code
  where s.order_date >= pw.cut - pw.span
    and s.order_date <= pw.cut + pw.span
),
pa as (
  select side,
    count(*) as n,
    percentile_cont(0.5) within group (order by subtotal_aud::float8) as med_subtotal,
    avg(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)) as checkout_dt,
    sum(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)) as checkout_dt_sum,
    sum(subtotal_aud) as subtotal_sum,
    avg(coalesce(subtotal_aud,0) + coalesce(charged_shipping_aud,0)
        + coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)) as customer_total,
    count(zonos_matched_at) as n_zonos,
    sum(coalesce(zonos_duty_aud,0) + coalesce(zonos_tax_aud,0)) filter (where zonos_matched_at is not null) as zonos_dt,
    sum(subtotal_aud) filter (where zonos_matched_at is not null) as zonos_subtotal,
    avg(zonos_fee_aud) filter (where zonos_matched_at is not null) as zonos_fee
  from po group by side
),
policy_change as (
  select jsonb_build_object(
    'country', pw.country_code,
    'cutAt', pw.cut,
    'windowDays', round((extract(epoch from pw.span) / 86400.0)::numeric, 1),
    'before', (select jsonb_build_object(
        'from', pw.cut - pw.span, 'to', pw.cut,
        'orders', n,
        'ordersPerDay', case when pw.span > interval '0'
                             then round((n / (extract(epoch from pw.span) / 86400.0))::numeric, 1) end,
        'medianSubtotal', round(med_subtotal::numeric, 2),
        'checkoutDutiesTaxes', round(checkout_dt, 2),
        'checkoutDutiesTaxesPct', case when subtotal_sum > 0 then round(100.0 * checkout_dt_sum / subtotal_sum, 1) end,
        'customerPaysTotal', round(customer_total, 2),
        'zonosOrders', n_zonos,
        'zonosDutiesTaxesPct', case when zonos_subtotal > 0 then round(100.0 * zonos_dt / zonos_subtotal, 1) end,
        'zonosFeePerOrder', round(zonos_fee, 2))
      from pa where side = 'before'),
    'after', (select jsonb_build_object(
        'from', pw.cut, 'to', pw.cut + pw.span,
        'orders', n,
        'ordersPerDay', case when pw.span > interval '0'
                             then round((n / (extract(epoch from pw.span) / 86400.0))::numeric, 1) end,
        'medianSubtotal', round(med_subtotal::numeric, 2),
        'checkoutDutiesTaxes', round(checkout_dt, 2),
        'checkoutDutiesTaxesPct', case when subtotal_sum > 0 then round(100.0 * checkout_dt_sum / subtotal_sum, 1) end,
        'customerPaysTotal', round(customer_total, 2),
        'zonosOrders', n_zonos,
        'zonosDutiesTaxesPct', case when zonos_subtotal > 0 then round(100.0 * zonos_dt / zonos_subtotal, 1) end,
        'zonosFeePerOrder', round(zonos_fee, 2))
      from pa where side = 'after')
  ) as j
  from pw
)
select jsonb_build_object($a$,

    $a$'kpis', (select j from kpis),
  -- Null unless one market with a dated policy change is selected.
  'policyChange', (select j from policy_change),$a$
  ];
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'ddp_markets_dashboard';
  if src is null then raise exception 'ddp_markets_dashboard not found'; end if;
  if position('policyChange' in src) > 0 then
    raise notice 'policyChange already present - nothing to do';
    return;
  end if;

  for i in 1 .. array_length(anchors, 1) loop
    n := (length(src) - length(replace(src, anchors[i], ''))) / length(anchors[i]);
    if n <> expected[i] then
      raise exception 'anchor % matched % times, expected %: %', i, n, expected[i], left(anchors[i], 60);
    end if;
    src := replace(src, anchors[i], repls[i]);
  end loop;

  execute src;
end
$mig$;
