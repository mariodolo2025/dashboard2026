-- =============================================================================
-- DDP Markets — which markets exist becomes DATA, and Switzerland goes dark
-- =============================================================================
-- Mario, 2026-09-02: "Switzerland habia sido un error, no deberia estar aqui
-- porque todavia no esta habilitado ese mercado en zonos. Y deberiamos meter a
-- Canada, que si esta habilitado para Zonos." And on how: "no necesito que
-- borres, solo que no se vea en el dash."
--
-- WHY A TABLE INSTEAD OF EDITING A LIST
-- Hiding a market cannot be done in the sync alone: ddp_markets_dashboard
-- derives its countries from whatever sits in ddp_shipments, so the 16 Swiss
-- rows would keep showing however the sync is configured. The rows stay (his
-- call, and they are real history) — the dashboard stops counting them.
--
-- That needs the RPC to know which markets are live, and the sync already knew
-- it in a hardcoded Set, and the tab knew it in a third place. Three copies of
-- one fact is what produced the Swiss bug in the first place: 'CH' was written
-- into the SQL as a permanent exception ("ships without ZONOS by design") when
-- the truth was only that ZONOS was not enabled there yet. So the list becomes
-- one row per market, read by all three.
--
-- WHAT SWITZERLAND WAS COSTING. Its orders counted as reconciled through that
-- exception, without a single ZONOS bill ever arriving:
--   with CH     25 matched orders, recovery 97.8%
--   without CH  13 matched orders, recovery 93.6%
-- The headline was 4.2 points optimistic, built on 12 orders that were never
-- actually reconciled against anything.
--
-- zonos_expected REPLACES the hardcoded (country_code <> 'CH'). It now means
-- what it says — this market bills through ZONOS, so an order without a ZONOS
-- record is incomplete. No market is named in the function any more.
--
-- FOUR READS OF ddp_shipments HAD TO CHANGE, not one. `base` is the obvious
-- gate, but 'mer' and 'revenueSinceAds' query ddp_shipments DIRECTLY (they are
-- deliberately EU-wide and ignore p_country), so they would have kept counting
-- Swiss revenue against European ad spend. 'zonosUnmatched' reads its own
-- table and needed the same restriction.
--
-- New output key `markets`: the active list with its names, so the tab's filter
-- chips stop carrying a fourth copy of the same fact.
--
-- VERIFIED after apply: countries returns DE / DK / SE / CA and no CH; the
-- Swiss rows are untouched in ddp_shipments.

create table if not exists ddp_markets (
  country_code   text primary key,
  name           text not null,
  -- true: ZONOS bills duties/taxes here, so an order without a ZONOS record is
  -- still open. false: the market ships without ZONOS and freight alone
  -- completes it. NEVER set false just because ZONOS has not been switched on —
  -- that was the Swiss mistake; an unavailable market is `active = false`.
  zonos_expected boolean not null default true,
  active         boolean not null default true,
  -- Which ad campaigns pay for this market, or null when none do. The tab's
  -- MER divides merchandise revenue by the spend of the campaigns named
  -- 'Europe%', so ONLY markets those campaigns target may sit in the numerator.
  -- They are named after their targets - "Europe HD (Germany, Denmark,
  -- Switzerland)" - and there is a separate CANADA campaign, so Canada and
  -- Sweden are out: crediting their revenue to European spend would invent a
  -- return that campaign never produced.
  ad_region      text,
  note           text,
  updated_at     timestamptz not null default now()
);

alter table ddp_markets enable row level security;
drop policy if exists "ddp_markets read" on ddp_markets;
create policy "ddp_markets read" on ddp_markets for select to authenticated using (true);
drop policy if exists "ddp_markets service" on ddp_markets;
create policy "ddp_markets service" on ddp_markets for all to service_role using (true) with check (true);

alter table ddp_markets add column if not exists ad_region text;

insert into ddp_markets (country_code, name, zonos_expected, active, ad_region, note) values
  ('DE', 'Germany',     true, true,  'europe', null),
  ('DK', 'Denmark',     true, true,  'europe', null),
  ('SE', 'Sweden',      true, true,  null,     'Added 2026-09-01; started charging duties and tax the same week. No ad campaign targets it, so it stays out of the MER.'),
  ('CA', 'Canada',      true, true,  null,     'Added 2026-09-02 — enabled in ZONOS. Its ads run under a separate CANADA campaign, not the Europe ones, so it is out of this tab''s MER until that spend is wired in.'),
  ('CH', 'Switzerland', true, false, 'europe', 'Hidden 2026-09-02: ZONOS is not enabled for Switzerland. It was carried as a DDP market by mistake and its orders counted as reconciled with no ZONOS bill. The 16 rows stay in ddp_shipments as history.')
on conflict (country_code) do update set
  name = excluded.name,
  zonos_expected = excluded.zonos_expected,
  active = excluded.active,
  ad_region = excluded.ad_region,
  note = excluded.note,
  updated_at = now();

create or replace function ddp_markets_dashboard(p_from date, p_to date, p_country text default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
with mk as (
  -- The one list. Everything below filters through it.
  select country_code, name, zonos_expected, ad_region from ddp_markets where active
),
base as (
  select s.*,
    (s.order_date at time zone 'Australia/Brisbane')::date as day,
    mk.zonos_expected,
    coalesce(s.charged_shipping_aud,0) + coalesce(s.charged_duties_aud,0) + coalesce(s.charged_taxes_aud,0) as charged_total,
    coalesce(s.freight_cost_aud,0) + coalesce(s.zonos_duty_aud,0) + coalesce(s.zonos_tax_aud,0) + coalesce(s.zonos_fee_aud,0) as paid_total,
    -- An order is done when the label cost is in AND either ZONOS has billed it
    -- or this market does not bill through ZONOS at all.
    (s.freight_cost_aud is not null and (s.zonos_matched_at is not null or not mk.zonos_expected)) as matched
  from ddp_shipments s
  join mk on mk.country_code = s.country_code
  where (s.order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
    and (p_country is null or s.country_code = p_country)
),
m as (select * from base where matched),
ads as (
  select
    round(coalesce(sum(case when mc.currency = 'USD' then mc.spend * coalesce(fx.rate, 1.54) else mc.spend end),0)) as spend,
    count(distinct mc.campaign_id) filter (where mc.spend > 0) as campaigns,
    min(mc.date) filter (where mc.spend > 0) as first_day
  from meta_ads_campaign_daily mc
  left join currency_exchange_rates fx
    on fx.year = extract(year from mc.date) and fx.month = extract(month from mc.date)
  where mc.campaign_name ilike 'europe%'
    and mc.date between p_from and p_to
),
kpis as (
  select jsonb_build_object(
    'orders', (select count(*) from base),
    'matchedOrders', (select count(*) from m),
    'byCountry', (select coalesce(jsonb_object_agg(country_code, n), '{}'::jsonb)
                  from (select country_code, count(*) as n from base group by 1) c),
    'revenue', (select round(coalesce(sum(subtotal_aud),0)) from base),
    'adSpend', (select spend from ads),
    'adCampaigns', (select campaigns from ads),
    'adFirstDay', (select first_day from ads),
    -- MER over the days the campaigns actually ran: dividing a whole month of
    -- revenue by five days of spend would flatter the ads absurdly.
    -- MER is ALWAYS EU-wide (Mario, 31-Aug): the campaigns target their markets
    -- together, so filtered revenue over multi-country spend is meaningless —
    -- it reads straight from ddp_shipments, ignoring p_country.
    -- The numerator is the markets those campaigns actually target
    -- (ad_region = 'europe'), NOT every active market. Canada is a live DDP
    -- market with its own separate CANADA campaign, and Sweden has none at all;
    -- putting either over European spend would manufacture a return.
    'mer', (select case when coalesce(a.spend,0) = 0 then null
            else round((select coalesce(sum(subtotal_aud),0) from ddp_shipments
                        where (order_date at time zone 'Australia/Brisbane')::date between greatest(p_from, a.first_day) and p_to
                          and country_code in (select country_code from mk where ad_region = 'europe')) / a.spend, 2) end from ads a),
    'revenueSinceAds', (select round(coalesce(sum(s.subtotal_aud),0)) from ddp_shipments s, ads a
        where (s.order_date at time zone 'Australia/Brisbane')::date between greatest(p_from, a.first_day) and p_to
          and s.country_code in (select country_code from mk where ad_region = 'europe')),
    -- Named so the card can say whose revenue is in that ratio.
    'merMarkets', (select coalesce(jsonb_agg(country_code order by country_code), '[]'::jsonb)
                   from mk where ad_region = 'europe'),
    'chargedTotal', (select round(coalesce(sum(charged_total),0)) from base),
    'chargedShipping', (select round(coalesce(sum(charged_shipping_aud),0)) from base),
    'chargedDuties', (select round(coalesce(sum(charged_duties_aud),0)) from base),
    'chargedTaxes', (select round(coalesce(sum(charged_taxes_aud),0)) from base),
    'paidTotal', (select round(coalesce(sum(paid_total),0)) from base),
    'paidFreight', (select round(coalesce(sum(freight_cost_aud),0)) from base),
    'paidZonosDT', (select round(coalesce(sum(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)),0)) from base),
    'paidZonosFees', (select round(coalesce(sum(zonos_fee_aud),0)) from base),
    -- The reconciliation headline pair (Mario, 1-Sep): charged and paid over
    -- the SAME matched universe, so the two big figures are subtractable and
    -- equal netAbsorbed by construction. The all-orders totals stay alongside.
    'chargedMatched', (select round(coalesce(sum(charged_total),0)) from m),
    'paidMatched', (select round(coalesce(sum(paid_total),0)) from m),
    'netAbsorbed', (select round(coalesce(sum(charged_total - paid_total),0)) from m),
    'netPerOrder', (select round(coalesce(avg(charged_total - paid_total),0), 2) from m),
    'recoveryPct', (select case when coalesce(sum(paid_total),0) = 0 then null
                    else round(100.0 * sum(charged_total) / sum(paid_total), 1) end from m)
  ) as j
),
components as (
  -- shipping compares over every matched order; duties/taxes and fees only
  -- where a ZONOS bill can exist.
  select jsonb_build_array(
    (select jsonb_build_object('key','shipping',
      'charged', round(coalesce(sum(charged_shipping_aud),0)),
      'paid',    round(coalesce(sum(freight_cost_aud),0)),
      'gap',     round(coalesce(sum(coalesce(charged_shipping_aud,0) - coalesce(freight_cost_aud,0)),0)),
      'perOrder', round(coalesce(avg(coalesce(charged_shipping_aud,0) - coalesce(freight_cost_aud,0)),0), 2),
      'orders', count(*)) from m),
    (select jsonb_build_object('key','duties_taxes',
      'charged', round(coalesce(sum(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)),0)),
      'paid',    round(coalesce(sum(coalesce(zonos_duty_aud,0) + coalesce(zonos_tax_aud,0)),0)),
      'gap',     round(coalesce(sum(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)
                       - coalesce(zonos_duty_aud,0) - coalesce(zonos_tax_aud,0)),0)),
      'perOrder', round(coalesce(avg(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)
                       - coalesce(zonos_duty_aud,0) - coalesce(zonos_tax_aud,0)),0), 2),
      'orders', count(*)) from m where zonos_expected),
    (select jsonb_build_object('key','fees',
      'charged', 0,
      'paid',    round(coalesce(sum(zonos_fee_aud),0)),
      'gap',     round(-coalesce(sum(zonos_fee_aud),0)),
      'perOrder', round(-coalesce(avg(coalesce(zonos_fee_aud,0)),0), 2),
      'orders', count(*)) from m where zonos_expected)
  ) as j
),
weekly as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'weekStart', w, 'charged', c, 'paid', p, 'orders', n) order by w), '[]'::jsonb) as j
  from (
    -- store weeks (Monday start) with the first label clamped to the window:
    -- a week that begins before p_from must not print a date outside the range
    select greatest(date_trunc('week', day)::date, p_from) as w,
           round(sum(charged_total)) as c, round(sum(paid_total)) as p, count(*) as n
    from m group by 1
  ) t
),
countries as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', country_code, 'orders', n, 'matchedOrders', nm, 'revenue', rev,
    'charged', c, 'paid', p, 'net', net,
    'netPerOrder', case when nm = 0 then null else round(net_raw / nm, 2) end,
    'recoveryPct', case when p = 0 then null else round(100.0 * c / p, 1) end
  ) order by n desc), '[]'::jsonb) as j
  from (
    select b.country_code,
      count(*) as n,
      count(*) filter (where b.matched) as nm,
      round(coalesce(sum(b.subtotal_aud),0)) as rev,
      round(coalesce(sum(b.charged_total) filter (where b.matched),0)) as c,
      round(coalesce(sum(b.paid_total) filter (where b.matched),0)) as p,
      round(coalesce(sum(b.charged_total - b.paid_total) filter (where b.matched),0)) as net,
      coalesce(sum(b.charged_total - b.paid_total) filter (where b.matched),0) as net_raw
    from base b group by 1
  ) t
),
ledger as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'order', order_name, 'date', day, 'country', country_code,
    'chargedShipping', round(coalesce(charged_shipping_aud,0),2),
    'chargedDuties', round(coalesce(charged_duties_aud,0),2),
    'chargedTaxes', round(coalesce(charged_taxes_aud,0),2),
    'chargedTotal', round(charged_total,2),
    'freight', round(freight_cost_aud,2),
    'zonosDT', case when zonos_matched_at is null then null
               else round(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0),2) end,
    'zonosFees', case when zonos_matched_at is null then null else round(coalesce(zonos_fee_aud,0),2) end,
    'zonosExpected', zonos_expected,
    'paidTotal', case when matched then round(paid_total,2) else null end,
    'net', case when matched then round(charged_total - paid_total,2) else null end,
    'tracking', tracking_number, 'carrier', ss_carrier, 'matched', matched
  ) order by day desc, order_name desc), '[]'::jsonb) as j
  from base
),
exceptions as (
  select jsonb_build_object(
    'awaitingZonos', (select coalesce(jsonb_agg(order_name order by day desc), '[]'::jsonb)
                      from base where zonos_matched_at is null and zonos_expected),
    'awaitingFreight', (select coalesce(jsonb_agg(order_name order by day desc), '[]'::jsonb)
                        from base where freight_cost_aud is null),
    'zonosUnmatched', (select coalesce(jsonb_agg(jsonb_build_object(
                         'tracking', tracking_number, 'country', country_code,
                         'amount', round(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)+coalesce(zonos_fee_aud,0),2))
                         order by zonos_created_at desc), '[]'::jsonb)
                       from ddp_zonos_unmatched
                       where (zonos_created_at at time zone 'Australia/Brisbane')::date between p_from and p_to
                         and country_code in (select country_code from mk)
                         and (p_country is null or country_code = p_country))
  ) as j
)
select jsonb_build_object(
  'kpis', (select j from kpis),
  'components', (select j from components),
  'weekly', (select j from weekly),
  'countries', (select j from countries),
  'ledger', (select j from ledger),
  'exceptions', (select j from exceptions),
  -- The live market list, so the tab's filter chips read it instead of holding
  -- their own copy.
  'markets', (select coalesce(jsonb_agg(jsonb_build_object('code', country_code, 'name', name)
                     order by country_code), '[]'::jsonb) from mk),
  'window', jsonb_build_object('from', p_from, 'to', p_to)
);
$$;
