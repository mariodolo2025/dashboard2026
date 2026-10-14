-- =============================================================================
-- United States · IC13 — the express rule, and what it costs.
--
-- Mario, 14-Oct-2026: a Starshipit rule now ships EVERY United States order on
-- IC13 (Australia Post Express, 5-6 days), whatever the customer paid, because
-- the US parcel rules change around 25-Oct and IC13 is not caught by them for
-- now. The express label costs about A$10-11 more than the standard one. This
-- migration is what lets the dashboard say how much that is.
--
-- The blocker it removes: ddp_shipments stored the CARRIER ("Australia Post")
-- and nothing else, so an IC13 express label and a standard one were the same
-- row. There was no way to tell them apart, in the database or on screen.
--
-- Three pieces:
--   1. ss_service_code / ss_service_name on ddp_shipments — the service that
--      was actually on the label, as Starshipit reports it ("IC13").
--   2. ddp_service_segments — a slice of ONE market by that service, carried as
--      DATA for the same reason the market list is (ddp_markets): a country or
--      a service written into SQL, into the sync and into the tab is three
--      copies, and three copies is how Switzerland ran a week as a DDP market.
--      It also holds the FROZEN baseline, see below.
--   3. ddp_service_segment_dashboard — the view's one query.
--
-- Why a segment and not a new market: ddp_markets is keyed by country_code and
-- every one of these orders is 'US'. A second US row is impossible and would be
-- wrong anyway — it is the same market, read through the service on the label.
--
-- THE FROZEN BASELINE. The extra cost is the IC13 label against what a label
-- cost before the rule: Australia Post labels on US orders, 17-Aug → 11-Oct
-- 2026, the window Mario approved. It is computed here, once, and stored. It is
-- never recomputed: a baseline that moves with the mix of orders would make the
-- extra cost drift for reasons nobody chose, and the whole point is a yardstick
-- that stays still. The two UPS labels in that window (A$66 each, booked
-- outside the normal flow) are excluded — IC13 replaces the Australia Post
-- standard service, not a UPS booking, and two outliers at five times the price
-- would raise the baseline and UNDERSTATE the cost of the rule.
-- =============================================================================

-- ── 1. the service on the label ──────────────────────────────────────────────
alter table ddp_shipments add column if not exists ss_service_code text;
alter table ddp_shipments add column if not exists ss_service_name text;
comment on column ddp_shipments.ss_service_code is
  'Carrier service on the label as Starshipit reports it (carrier_service_code), e.g. IC13 = Australia Post Express. Null on orders labelled before 14-Oct-2026, when the sync started capturing it.';

create index if not exists ddp_shipments_service_idx
  on ddp_shipments (country_code, ss_service_code)
  where ss_service_code is not null;

-- ── 2. the segment, with its frozen baseline ────────────────────────────────
create table if not exists ddp_service_segments (
  code                 text primary key,
  country_code         text not null references ddp_markets(country_code),
  name                 text not null,
  service_code         text not null,
  active               boolean not null default true,
  -- When the rule was switched on. Orders placed from here on are the ones the
  -- rule was meant to catch, so adherence is counted over them. Money is NOT:
  -- a backlog order placed earlier and labelled under the rule costs the extra
  -- just the same, and is counted wherever its label is IC13.
  rule_from            timestamptz not null,
  baseline_from        date not null,
  baseline_to          date not null,
  baseline_cost_aud    numeric not null,
  baseline_median_aud  numeric,
  baseline_charged_aud numeric,
  baseline_orders      integer,
  baseline_note        text,
  note                 text,
  updated_at           timestamptz not null default now()
);
-- RLS in the same breath as the table: CREATE TABLE is born public, which is
-- exactly the mail Supabase sent on 3-Oct-2026.
alter table ddp_service_segments enable row level security;
drop policy if exists "ddp_service_segments read" on ddp_service_segments;
drop policy if exists "ddp_service_segments service" on ddp_service_segments;
create policy "ddp_service_segments read" on ddp_service_segments
  for select to authenticated using (true);
create policy "ddp_service_segments service" on ddp_service_segments
  for all to service_role using (true) with check (true);

insert into ddp_service_segments (
  code, country_code, name, service_code, rule_from,
  baseline_from, baseline_to,
  baseline_cost_aud, baseline_median_aud, baseline_charged_aud, baseline_orders,
  baseline_note, note)
select
  'US-IC13', 'US', 'United States · IC13', 'IC13',
  timestamptz '2026-10-14 00:00:00+10',
  date '2026-08-17', date '2026-10-11',
  round(avg(freight_cost_aud)::numeric, 2),
  round(percentile_cont(0.5) within group (order by freight_cost_aud::float8)::numeric, 2),
  round(avg(coalesce(charged_shipping_aud, 0))::numeric, 2),
  count(*)::int,
  'Mean label cost of the Australia Post labels on US orders placed 17-Aug to 11-Oct 2026 — the window Mario approved on 14-Oct. Frozen: never recomputed. Two UPS labels in the window (A$66 each) excluded.',
  'Starshipit rule from 14-Oct-2026: every US order ships IC13 (Australia Post Express, 5-6 days) whatever the customer paid, because the US parcel rules change around 25-Oct and IC13 is outside them for now.'
from ddp_shipments
where country_code = 'US'
  and (order_date at time zone 'Australia/Brisbane')::date between date '2026-08-17' and date '2026-10-11'
  and freight_cost_aud is not null
  and ss_carrier = 'Australia Post'
on conflict (code) do nothing;

-- ── 3. the view's one query ─────────────────────────────────────────────────
-- Two universes, on purpose, because they answer different questions:
--   MONEY     — every order in the window whose label carries the segment's
--               service. Includes backlog orders placed before the rule and
--               labelled under it: they cost the extra just the same.
--   ADHERENCE — orders placed from rule_from on. Those are the ones the rule
--               was meant to catch, and the share that actually got the service
--               is read off the LABEL, never off the rule. An order that slips
--               through on the standard service is money not spent and a parcel
--               outside the new US rules; both are worth seeing.
-- A third number decides whether either is readable: coverage, the share of
-- those orders whose label has reached us at all. Labels lag.
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
         g.baseline_cost_aud                                         as baseline
  from ddp_shipments s
  join seg g on g.country_code = s.country_code
  where (s.order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
),
ic      as (select * from base where is_seg and labelled),
adh     as (select * from base where since_rule),
adh_lab as (select * from adh where labelled),
-- Orders a month, measured over the last 28 whole store days, so the monthly
-- projection is a rate this market really runs at and not whatever the selected
-- window happens to contain.
rate as (
  select count(*)::numeric / 28.0 as per_day
  from ddp_shipments s
  join seg g on g.country_code = s.country_code
  where (s.order_date at time zone 'Australia/Brisbane')::date
        between ((now() at time zone 'Australia/Brisbane')::date - 28)
            and ((now() at time zone 'Australia/Brisbane')::date - 1)
),
kpis as (
  select jsonb_build_object(
    'segOrders',      (select count(*) from ic),
    'extraPerOrder',  (select round(avg(freight_cost_aud - baseline), 2) from ic),
    'extraTotal',     (select round(sum(freight_cost_aud - baseline)) from ic),
    'costAvg',        (select round(avg(freight_cost_aud), 2) from ic),
    'costMedian',     (select round(percentile_cont(0.5) within group (order by freight_cost_aud::float8)::numeric, 2) from ic),
    'chargedAvg',     (select round(avg(coalesce(charged_shipping_aud, 0)), 2) from ic),
    'marginPerOrder', (select round(avg(coalesce(charged_shipping_aud, 0) - freight_cost_aud), 2) from ic),
    'marginTotal',    (select round(sum(coalesce(charged_shipping_aud, 0) - freight_cost_aud)) from ic),
    'freeShipOrders', (select count(*) from ic where coalesce(charged_shipping_aud, 0) = 0),
    'freeShipPct',    (select case when count(*) = 0 then null
                       else round(100.0 * count(*) filter (where coalesce(charged_shipping_aud, 0) = 0) / count(*), 1) end from ic),
    'ordersPerDay',   (select round(per_day, 1) from rate),
    -- Extra per order at the market's own monthly order rate. Null until a
    -- label exists: a projection off no labels is a made-up number.
    'projMonthly',    (select case when (select count(*) from ic) = 0 then null
                       else round((select avg(freight_cost_aud - baseline) from ic)
                                  * (select per_day from rate) * 30.44) end),
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

-- ── 4. the chip list the main RPC hands the tab ─────────────────────────────
-- Anchored patch of the DEPLOYED body, not a rewrite from the repo file: this
-- function is edited from several sessions and rebuilding it from a stale copy
-- silently reverted another session's work once already (31-Aug). One key is
-- added so the tab can draw the segment chip without holding a list of its own.
do $mig$
declare
  src text;
  anchor text := E'  ''window'', jsonb_build_object(''from'', p_from, ''to'', p_to)\n);';
  repl text := E'  ''segments'', (select coalesce(jsonb_agg(jsonb_build_object(\n'
    || E'                 ''code'', code, ''name'', name, ''country'', country_code,\n'
    || E'                 ''serviceCode'', service_code, ''ruleFrom'', rule_from)\n'
    || E'               order by code), ''[]''::jsonb)\n'
    || E'              from ddp_service_segments where active),\n'
    || E'  ''window'', jsonb_build_object(''from'', p_from, ''to'', p_to)\n);';
  hits int;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'ddp_markets_dashboard';
  if src is null then raise exception 'ddp_markets_dashboard not found'; end if;
  if position('ddp_service_segments' in src) > 0 then
    raise notice 'ddp_markets_dashboard already carries segments - nothing to do';
    return;
  end if;
  hits := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception 'anchor found % times, expected exactly 1', hits;
  end if;
  execute replace(src, anchor, repl);
end
$mig$;
