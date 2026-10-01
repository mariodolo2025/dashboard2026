-- =============================================================================
-- DDP Markets — each market's ad spend is what Meta delivered IN it
-- =============================================================================
-- Mario, 2026-10-01: "en ddp markets, no estas cargando info de ad spend para
-- UK, y tampoco estoy seguro si lo que estas poniendo como ad spend de canada
-- esta bien". Approved 2026-10-02: "ok, hazlo".
--
-- Until now a market's spend was guessed from the campaign NAME, per
-- advertising region (ad_region / ad_campaign_like: 'europe%' paid for
-- DE+DK+SE jointly, 'canada%' for CA). Meta's own delivery-country breakdown,
-- now synced into meta_ads_country_daily, says where the money went. For
-- 22-Aug -> 1-Oct-2026:
--   * GB A$10,507 — 60% of the Europe campaigns' A$17,651. The UK had no
--     ad_region, so the tab showed it with no spend while DE/DK/SE carried it.
--     GB's first ad day is 17-Sep-2026, the day its VAT moved into the price.
--   * DE A$3,326, DK A$2,914, SE A$676, CH A$228 (CH is not a live market).
--   * CA US$21,388, all from the CANADA campaigns: the old figure was right.
--
-- WHAT CHANGES
--   * The region block goes. Each market in view gets its own row: spend
--     delivered in it, campaigns, first ad day, days with spend, revenue since
--     that day, and its own MER. `adRegions` becomes `adMarkets`; `adSpend` is
--     still the total of the rows shown.
--   * ddp_markets.shows_mer replaces ad_region / ad_campaign_like (dropped):
--     the only thing left to say per market is whether this tab shows its MER.
--     False for the USA only — its MER lives in Advertising / E-commerce.
--   * Picking a market now shows exactly that market's spend. Before, picking
--     Germany showed all of Europe's.
--
-- Rest of the function unchanged.

alter table ddp_markets add column if not exists shows_mer boolean not null default true;
update ddp_markets set shows_mer = false where country_code = 'US';
comment on column ddp_markets.shows_mer is
  'Whether DDP Markets shows this market''s ad spend and MER. Spend comes from meta_ads_country_daily (delivery country). False for the USA: its MER lives in Advertising / E-commerce.';

CREATE OR REPLACE FUNCTION public.ddp_markets_dashboard(p_from date, p_to date, p_country text DEFAULT NULL::text, p_ledger_limit integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
with mk as (
  -- The one list. Everything below filters through it.
  select country_code, name, zonos_expected, shows_mer,
         charges_duties, in_all_markets, duties_included_from
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
    pol.cd as charges_duties,
    -- Policy-aware "charged": for a market that absorbs duties and taxes, only
    -- the shipping line was ever a charge to the customer. Whatever Shopify put
    -- in the tax column there is sales tax, kept apart as sales_tax.
    case when pol.cd then coalesce(s.charged_duties_aud,0) else 0 end as eff_duties,
    case when pol.cd then coalesce(s.charged_taxes_aud,0)  else 0 end as eff_taxes,
    case when pol.cd then 0 else coalesce(s.charged_taxes_aud,0) end as sales_tax,
    coalesce(s.charged_shipping_aud,0)
      + case when pol.cd then coalesce(s.charged_duties_aud,0) + coalesce(s.charged_taxes_aud,0) else 0 end
      as charged_total,
    coalesce(s.freight_cost_aud,0) + coalesce(s.zonos_duty_aud,0) + coalesce(s.zonos_tax_aud,0) + coalesce(s.zonos_fee_aud,0) as paid_total,
    -- An order is done when the label cost is in AND either ZONOS has billed it
    -- or this market does not bill through ZONOS at all.
    (s.freight_cost_aud is not null and (s.zonos_matched_at is not null or not mv.zonos_expected)) as matched
  from ddp_shipments s
  join mv on mv.country_code = s.country_code
  -- The policy as it stood WHEN THE ORDER WAS PLACED. A market can change it
  -- on a date (Canada moved duties into the price on 11-Sep-2026): orders from
  -- duties_included_from on charge nothing at checkout, orders before keep the
  -- market's charges_duties. Restating history with the new flag would be false.
  cross join lateral (
    select (mv.charges_duties
            and (mv.duties_included_from is null or s.order_date < mv.duties_included_from)) as cd
  ) pol
  where (s.order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
),
m as (select * from base where matched),
-- ── Ad spend: what Meta DELIVERED in each market ──────────────────────────
-- From meta_ads_country_daily (insights breakdowns=country), not from the
-- campaign name. Each market gets the spend Meta delivered inside it, from any
-- campaign, USD rows at the house monthly rate. A market with shows_mer false
-- (the USA, whose MER lives in Advertising / E-commerce) has no row here.
ad_rows as (
  select c.country, c.date, c.campaign_id,
         case when c.currency = 'USD' then c.spend * coalesce(fx.rate, 1.54)
              else c.spend end as spend_aud
  from meta_ads_country_daily c
  left join currency_exchange_rates fx
    on fx.year = extract(year from c.date) and fx.month = extract(month from c.date)
  where c.date between p_from and p_to
    and c.spend > 0
    and c.country in (select country_code from mv where shows_mer)
),
market_spend as (
  select mv.country_code as code, mv.name,
         round(coalesce(sum(a.spend_aud), 0)) as spend,
         count(distinct a.campaign_id) as campaigns,
         min(a.date) as first_day,
         count(distinct a.date) as days_with_spend
  from mv
  left join ad_rows a on a.country = mv.country_code
  where mv.shows_mer
  group by mv.country_code, mv.name
),
-- MER per market: ITS merchandise revenue since ITS first ad day in the
-- window, over ITS spend. Revenue before the first ad day is left out, or a
-- month of sales over a few days of spend would flatter the ads.
market_mer as (
  select ms.*,
    (select round(coalesce(sum(s.subtotal_aud), 0))
     from ddp_shipments s
     where ms.first_day is not null
       and s.country_code = ms.code
       and (s.order_date at time zone 'Australia/Brisbane')::date
           between greatest(p_from, ms.first_day) and p_to
    ) as revenue_since_ads
  from market_spend ms
),
ads as (select coalesce(sum(spend), 0) as spend from market_spend),
kpis as (
  select jsonb_build_object(
    'orders', (select count(*) from base),
    'matchedOrders', (select count(*) from m),
    'byCountry', (select coalesce(jsonb_object_agg(country_code, n), '{}'::jsonb)
                  from (select country_code, count(*) as n from base group by 1) c),
    'revenue', (select round(coalesce(sum(subtotal_aud),0)) from base),
    'adSpend', (select spend from ads),
    'adMarkets', (select coalesce(jsonb_agg(jsonb_build_object(
        'code', code,
        'name', name,
        'spend', spend,
        'campaigns', campaigns,
        'firstDay', first_day,
        'daysWithSpend', days_with_spend,
        'revenueSinceAds', coalesce(revenue_since_ads, 0),
        'mer', case when spend > 0 and coalesce(revenue_since_ads,0) >= 0
                    then round(coalesce(revenue_since_ads,0)::numeric / spend, 2) end
      ) order by spend desc), '[]'::jsonb) from market_mer),
    -- Whether the view is a market that absorbs duties/taxes. Null when the
    -- view mixes policies (e.g. a Canada window spanning its 11-Sep cutover).
    -- Read from the ORDERS, since a market's policy can change on a date.
    'chargesDuties', (select case
                when exists (select 1 from base)
                  then (select case when count(distinct charges_duties) = 1 then bool_and(charges_duties) end from base)
                else (select case when count(distinct charges_duties) = 1 then bool_and(charges_duties) end from mv)
              end),
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
      case when count(distinct b.charges_duties) = 1 then bool_and(b.charges_duties) end as cd,
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
      'tracking', tracking_number, 'carrier', ss_carrier, 'matched', matched,
      'freightChecked', freight_checked_at is not null
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
),
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
select jsonb_build_object(
  'kpis', (select j from kpis),
  -- Null unless one market with a dated policy change is selected.
  'policyChange', (select j from policy_change),
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
                'dutiesIncludedFrom', duties_included_from,
                'showsMer', shows_mer)
              order by in_all_markets desc, country_code), '[]'::jsonb) from mk),
  'window', jsonb_build_object('from', p_from, 'to', p_to)
);
$function$;

alter table ddp_markets drop column if exists ad_campaign_like;
alter table ddp_markets drop column if exists ad_region;
