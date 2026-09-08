-- =============================================================================
-- DDP Markets — the USA joins as a market that ABSORBS duties and taxes
-- =============================================================================
-- Mario, 2026-09-07: "la misma logica pero para USA solo, quiero comprobar que
-- todo este bien con ese mercado, teniendo en cuenta que nosotros absorbemos
-- todos los duties y taxes, no se le cobran al cliente." Then, on the two
-- design questions: USA does NOT enter "All markets", and USA gets NO MER here.
--
-- WHY THIS IS NOT "ONE MORE ROW". Three facts, all measured on 2026-09-07 over
-- orders since 2026-08-01:
--
--   1. VOLUME. 3,217 US orders against 81 Canadian and 41 German. Forty times
--      Canada. Folded into "All markets" it would BE "All markets" (97%), and
--      the European DDP experiment would vanish inside it. So it is excluded
--      from the aggregate and only appears when selected (in_all_markets).
--
--   2. THE CHECKOUT TAX IS NOT IMPORT TAX. 28% of US orders carry tax at
--      checkout (US$4,842) - that is US state SALES TAX, collected because of
--      nexus and remitted to the states. It is a pass-through, not a recovery
--      of anything ZONOS bills. In DE/CA the checkout tax IS the import VAT/GST
--      the customer pays for DDP (80%+ of orders). Same column in Shopify,
--      opposite meaning. If the reconciliation counted the US column as
--      "charged to the customer" it would invent recovery that never happened.
--
--   3. THE GAP IS POLICY, NOT ERROR. Dolo pays every dollar of US duty and tax
--      on purpose. The tab's wording ("checkout charges LESS than ZONOS bills -
--      undercharging") describes a calibration fault, which is the wrong
--      reading for a deliberate absorption. The same number needs different
--      words, and the RPC has to tell the tab which case it is in.
--
-- THE TWO FLAGS
--   charges_duties   does the checkout bill duties/import taxes to the customer?
--                    false = the market absorbs them by policy. For such a
--                    market, "charged" is shipping only: its duties/taxes
--                    columns are zeroed in every charged_* aggregate, and what
--                    Shopify recorded as tax is surfaced separately as
--                    salesTax (a pass-through, never part of the reconciliation).
--   in_all_markets   is the market counted when no country is selected?
--                    false = visible only through its own chip.
--
-- LEDGER PAGING. The ledger used to return every row; at US volume that is
-- thousands of objects per call. p_ledger_limit (default 300) caps the array
-- and ledgerTotal says how many there are, so the tab can offer "load more".
-- The signature changes, so the old 3-argument function is DROPPED first:
-- create-or-replace with a different argument list would have created an
-- OVERLOAD beside it, and PostgREST would then have had two candidates for the
-- same named-parameter call. The new default keeps 3-argument callers working.
--
-- NO MER FOR THE USA. Its ad_region stays null, so the regions block yields no
-- row for it. The US already has its MER in Advertising and E-commerce; a third
-- one on a different formula (merchandise since first ad day / spend) would
-- be a third number with the same name for the same market.
--
-- FREIGHT AT THIS VOLUME is the sync's problem, not this file's: see
-- supabase/functions/ddp-sync/index.ts (bulk walk + time budget), same day.
--
-- VERIFIED after apply: "All markets" (p_country null) returns DE/DK/SE/CA and
-- no US; p_country='US' returns US only with chargedDuties/chargedTaxes 0 in
-- charged_total, salesTax populated, adRegions empty; ledgerTotal >= ledger.

alter table ddp_markets add column if not exists charges_duties boolean not null default true;
alter table ddp_markets add column if not exists in_all_markets boolean not null default true;

comment on column ddp_markets.charges_duties is
  'true: the checkout bills duties/import taxes to the customer (DDP as sold). '
  'false: Dolo absorbs them by policy - charged_* excludes duties and taxes for this market, '
  'and whatever Shopify recorded as tax is reported separately as salesTax (a pass-through).';
comment on column ddp_markets.in_all_markets is
  'false: excluded from the "All markets" aggregate; visible only through its own filter chip. '
  'Used for the USA, whose volume would otherwise swallow every other market.';

insert into ddp_markets
  (country_code, name, zonos_expected, active, ad_region, ad_campaign_like, charges_duties, in_all_markets, note)
values
  ('US', 'United States', true, true, null, null, false, false,
   'Added 2026-09-07. Dolo absorbs all duties and taxes by policy - nothing is charged to the customer. '
   'Outside the All-markets total (40x the next market by volume). No MER here: it lives in Advertising / E-commerce. '
   'Checkout tax on US orders is state sales tax (pass-through), not import tax.')
on conflict (country_code) do update set
  name = excluded.name,
  zonos_expected = excluded.zonos_expected,
  active = excluded.active,
  ad_region = excluded.ad_region,
  ad_campaign_like = excluded.ad_campaign_like,
  charges_duties = excluded.charges_duties,
  in_all_markets = excluded.in_all_markets,
  note = excluded.note,
  updated_at = now();

drop function if exists ddp_markets_dashboard(date, date, text);

create or replace function ddp_markets_dashboard(
  p_from date, p_to date, p_country text default null, p_ledger_limit int default 300)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
with mk as (
  -- The one list. Everything below filters through it.
  select country_code, name, zonos_expected, ad_region, ad_campaign_like,
         charges_duties, in_all_markets
  from ddp_markets where active
),
-- The markets in VIEW: a chosen country, or every market that belongs in the
-- aggregate. This is the rule the USA is excluded by.
mv as (
  select * from mk
  where (p_country is not null and country_code = p_country)
     or (p_country is null and in_all_markets)
),
base as (
  select s.*,
    (s.order_date at time zone 'Australia/Brisbane')::date as day,
    mv.zonos_expected,
    mv.charges_duties,
    -- Policy-aware "charged": for a market that absorbs duties and taxes, only
    -- the shipping line was ever a charge to the customer. Whatever Shopify put
    -- in the tax column there is sales tax, kept apart as sales_tax.
    case when mv.charges_duties then coalesce(s.charged_duties_aud,0) else 0 end as eff_duties,
    case when mv.charges_duties then coalesce(s.charged_taxes_aud,0)  else 0 end as eff_taxes,
    case when mv.charges_duties then 0 else coalesce(s.charged_taxes_aud,0) end as sales_tax,
    coalesce(s.charged_shipping_aud,0)
      + case when mv.charges_duties then coalesce(s.charged_duties_aud,0) + coalesce(s.charged_taxes_aud,0) else 0 end
      as charged_total,
    coalesce(s.freight_cost_aud,0) + coalesce(s.zonos_duty_aud,0) + coalesce(s.zonos_tax_aud,0) + coalesce(s.zonos_fee_aud,0) as paid_total,
    -- An order is done when the label cost is in AND either ZONOS has billed it
    -- or this market does not bill through ZONOS at all.
    (s.freight_cost_aud is not null and (s.zonos_matched_at is not null or not mv.zonos_expected)) as matched
  from ddp_shipments s
  join mv on mv.country_code = s.country_code
  where (s.order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
),
m as (select * from base where matched),
-- One row per advertising region: the markets it covers and the campaigns that
-- pay for it. Regions are independent - a Canadian dollar never lands in the
-- European ratio and vice versa. A market with ad_region null (the USA) has no
-- row here and therefore no MER on this tab.
regions as (
  select ad_region as region,
         min(ad_campaign_like) as campaign_like,
         jsonb_agg(country_code order by country_code) as markets
  from mk
  where ad_region is not null
    and (p_country is null
         or ad_region = (select ad_region from ddp_markets where country_code = p_country))
  group by ad_region
),
region_spend as (
  select r.region, r.markets,
         round(coalesce(sum(case when mc.currency = 'USD'
                                 then mc.spend * coalesce(fx.rate, 1.54)
                                 else mc.spend end), 0)) as spend,
         count(distinct mc.campaign_id) filter (where mc.spend > 0) as campaigns,
         min(mc.date) filter (where mc.spend > 0) as first_day,
         count(distinct mc.date) filter (where mc.spend > 0) as days_with_spend
  from regions r
  left join meta_ads_campaign_daily mc
    on mc.campaign_name ilike r.campaign_like
   and mc.date between p_from and p_to
  left join currency_exchange_rates fx
    on fx.year = extract(year from mc.date) and fx.month = extract(month from mc.date)
  group by r.region, r.markets
),
region_mer as (
  select rs.*,
    (select round(coalesce(sum(s.subtotal_aud), 0))
     from ddp_shipments s
     where rs.first_day is not null
       and (s.order_date at time zone 'Australia/Brisbane')::date
           between greatest(p_from, rs.first_day) and p_to
       and s.country_code in (select country_code from mk where ad_region = rs.region)
    ) as revenue_since_ads
  from region_spend rs
),
ads as (select coalesce(sum(spend), 0) as spend from region_spend),
kpis as (
  select jsonb_build_object(
    'orders', (select count(*) from base),
    'matchedOrders', (select count(*) from m),
    'byCountry', (select coalesce(jsonb_object_agg(country_code, n), '{}'::jsonb)
                  from (select country_code, count(*) as n from base group by 1) c),
    'revenue', (select round(coalesce(sum(subtotal_aud),0)) from base),
    'adSpend', (select spend from ads),
    'adRegions', (select coalesce(jsonb_agg(jsonb_build_object(
        'region', region,
        'markets', markets,
        'spend', spend,
        'campaigns', campaigns,
        'firstDay', first_day,
        'daysWithSpend', days_with_spend,
        'revenueSinceAds', coalesce(revenue_since_ads, 0),
        'mer', case when spend > 0 and coalesce(revenue_since_ads,0) >= 0
                    then round(coalesce(revenue_since_ads,0)::numeric / spend, 2) end
      ) order by spend desc), '[]'::jsonb) from region_mer),
    -- Whether the view is a market that absorbs duties/taxes. Null when the
    -- view mixes policies (never today: the aggregate is DDP-charging only).
    'chargesDuties', (select case when count(distinct charges_duties) = 1 then bool_and(charges_duties) end from mv),
    'chargedTotal', (select round(coalesce(sum(charged_total),0)) from base),
    'chargedShipping', (select round(coalesce(sum(charged_shipping_aud),0)) from base),
    'chargedDuties', (select round(coalesce(sum(eff_duties),0)) from base),
    'chargedTaxes', (select round(coalesce(sum(eff_taxes),0)) from base),
    -- Sales tax collected at checkout in absorbing markets: reported, never
    -- reconciled. It is remitted, not kept, and it is not import tax.
    'salesTax', (select round(coalesce(sum(sales_tax),0)) from base),
    'paidTotal', (select round(coalesce(sum(paid_total),0)) from base),
    'paidFreight', (select round(coalesce(sum(freight_cost_aud),0)) from base),
    'paidZonosDT', (select round(coalesce(sum(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)),0)) from base),
    'paidZonosFees', (select round(coalesce(sum(zonos_fee_aud),0)) from base),
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
  -- where a ZONOS bill can exist. For an absorbing market the charged side of
  -- duties/taxes is 0 by construction - the tab words that as policy.
  select jsonb_build_array(
    (select jsonb_build_object('key','shipping',
      'charged', round(coalesce(sum(charged_shipping_aud),0)),
      'paid',    round(coalesce(sum(freight_cost_aud),0)),
      'gap',     round(coalesce(sum(coalesce(charged_shipping_aud,0) - coalesce(freight_cost_aud,0)),0)),
      'perOrder', round(coalesce(avg(coalesce(charged_shipping_aud,0) - coalesce(freight_cost_aud,0)),0), 2),
      'orders', count(*)) from m),
    (select jsonb_build_object('key','duties_taxes',
      'charged', round(coalesce(sum(eff_duties + eff_taxes),0)),
      'paid',    round(coalesce(sum(coalesce(zonos_duty_aud,0) + coalesce(zonos_tax_aud,0)),0)),
      'gap',     round(coalesce(sum(eff_duties + eff_taxes
                       - coalesce(zonos_duty_aud,0) - coalesce(zonos_tax_aud,0)),0)),
      'perOrder', round(coalesce(avg(eff_duties + eff_taxes
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
    'recoveryPct', case when p = 0 then null else round(100.0 * c / p, 1) end,
    'chargesDuties', cd
  ) order by n desc), '[]'::jsonb) as j
  from (
    select b.country_code,
      bool_and(b.charges_duties) as cd,
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
  select coalesce(jsonb_agg(row order by day desc, order_name desc), '[]'::jsonb) as j
  from (
    select day, order_name, jsonb_build_object(
      'order', order_name, 'date', day, 'country', country_code,
      'chargedShipping', round(coalesce(charged_shipping_aud,0),2),
      'chargedDuties', round(eff_duties,2),
      'chargedTaxes', round(eff_taxes,2),
      'salesTax', round(sales_tax,2),
      'chargedTotal', round(charged_total,2),
      'freight', round(freight_cost_aud,2),
      'zonosDT', case when zonos_matched_at is null then null
                 else round(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0),2) end,
      'zonosFees', case when zonos_matched_at is null then null else round(coalesce(zonos_fee_aud,0),2) end,
      'zonosExpected', zonos_expected,
      'chargesDuties', charges_duties,
      'paidTotal', case when matched then round(paid_total,2) else null end,
      'net', case when matched then round(charged_total - paid_total,2) else null end,
      'tracking', tracking_number, 'carrier', ss_carrier, 'matched', matched
    ) as row
    from base
    order by day desc, order_name desc
    limit greatest(coalesce(p_ledger_limit, 300), 1)
  ) l
),
exceptions as (
  select jsonb_build_object(
    'awaitingZonos', (select coalesce(jsonb_agg(order_name order by day desc), '[]'::jsonb)
                      from (select order_name, day from base
                            where zonos_matched_at is null and zonos_expected
                            order by day desc limit 200) x),
    'awaitingZonosTotal', (select count(*) from base where zonos_matched_at is null and zonos_expected),
    'awaitingFreight', (select coalesce(jsonb_agg(order_name order by day desc), '[]'::jsonb)
                        from (select order_name, day from base
                              where freight_cost_aud is null
                              order by day desc limit 200) x),
    'awaitingFreightTotal', (select count(*) from base where freight_cost_aud is null),
    'zonosUnmatched', (select coalesce(jsonb_agg(jsonb_build_object(
                         'tracking', tracking_number, 'country', country_code,
                         'amount', round(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)+coalesce(zonos_fee_aud,0),2))
                         order by zonos_created_at desc), '[]'::jsonb)
                       from ddp_zonos_unmatched
                       where (zonos_created_at at time zone 'Australia/Brisbane')::date between p_from and p_to
                         and country_code in (select country_code from mv))
  ) as j
)
select jsonb_build_object(
  'kpis', (select j from kpis),
  'components', (select j from components),
  'weekly', (select j from weekly),
  'countries', (select j from countries),
  'ledger', (select j from ledger),
  'ledgerTotal', (select count(*) from base),
  'exceptions', (select j from exceptions),
  -- The live market list with its policies, so the tab holds no copy of any of
  -- it: which chips exist, which sit outside "All", which absorb, which have
  -- a MER here.
  'markets', (select coalesce(jsonb_agg(jsonb_build_object(
                'code', country_code, 'name', name,
                'chargesDuties', charges_duties,
                'inAllMarkets', in_all_markets,
                'adRegion', ad_region)
              order by in_all_markets desc, country_code), '[]'::jsonb) from mk),
  'window', jsonb_build_object('from', p_from, 'to', p_to)
);
$$;
