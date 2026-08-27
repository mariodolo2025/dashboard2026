-- =============================================================================
-- EU ad spend joins the DDP dashboard. The Meta campaigns driving these
-- markets are the ones named "Europe …" (both live ones target Germany,
-- Denmark and Switzerland TOGETHER, so the spend cannot be split per
-- country). AUD; any USD row converts at the house monthly rate. Also ships
-- MER (window revenue ÷ window EU spend) so the tile can say whether the
-- spend is paying for itself without the reader doing division.
-- =============================================================================
create or replace function ddp_markets_dashboard(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
with base as (
  select *,
    (order_date at time zone 'Australia/Brisbane')::date as day,
    (country_code <> 'CH') as zonos_expected,
    coalesce(charged_shipping_aud,0) + coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0) as charged_total,
    coalesce(freight_cost_aud,0) + coalesce(zonos_duty_aud,0) + coalesce(zonos_tax_aud,0) + coalesce(zonos_fee_aud,0) as paid_total,
    (freight_cost_aud is not null and (zonos_matched_at is not null or country_code = 'CH')) as matched
  from ddp_shipments
  where (order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
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
    'mer', (select case when coalesce(a.spend,0) = 0 then null
            else round((select coalesce(sum(subtotal_aud),0) from base where day >= a.first_day) / a.spend, 2) end from ads a),
    'revenueSinceAds', (select round(coalesce(sum(b.subtotal_aud),0)) from base b, ads a where b.day >= a.first_day),
    'chargedTotal', (select round(coalesce(sum(charged_total),0)) from base),
    'chargedShipping', (select round(coalesce(sum(charged_shipping_aud),0)) from base),
    'chargedDuties', (select round(coalesce(sum(charged_duties_aud),0)) from base),
    'chargedTaxes', (select round(coalesce(sum(charged_taxes_aud),0)) from base),
    'paidTotal', (select round(coalesce(sum(paid_total),0)) from base),
    'paidFreight', (select round(coalesce(sum(freight_cost_aud),0)) from base),
    'paidZonosDT', (select round(coalesce(sum(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)),0)) from base),
    'paidZonosFees', (select round(coalesce(sum(zonos_fee_aud),0)) from base),
    'netAbsorbed', (select round(coalesce(sum(charged_total - paid_total),0)) from m),
    'netPerOrder', (select round(coalesce(avg(charged_total - paid_total),0), 2) from m),
    'recoveryPct', (select case when coalesce(sum(paid_total),0) = 0 then null
                    else round(100.0 * sum(charged_total) / sum(paid_total), 1) end from m)
  ) as j
),
components as (
  -- shipping compares over every matched order; duties/taxes and fees only
  -- where a ZONOS bill can exist (CH is out by design).
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
    select date_trunc('week', day)::date as w,
           round(sum(charged_total)) as c, round(sum(paid_total)) as p, count(*) as n
    from m group by 1
  ) t
),
countries as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', country_code, 'orders', n, 'matchedOrders', nm, 'revenue', rev,
    'charged', c, 'paid', p, 'net', net,
    'netPerOrder', case when nm = 0 then null else round(net::numeric / nm, 2) end,
    'recoveryPct', case when p = 0 then null else round(100.0 * c / p, 1) end
  ) order by n desc), '[]'::jsonb) as j
  from (
    select b.country_code,
      count(*) as n,
      count(*) filter (where b.matched) as nm,
      round(coalesce(sum(b.subtotal_aud),0)) as rev,
      round(coalesce(sum(b.charged_total) filter (where b.matched),0)) as c,
      round(coalesce(sum(b.paid_total) filter (where b.matched),0)) as p,
      round(coalesce(sum(b.charged_total - b.paid_total) filter (where b.matched),0)) as net
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
                       where (zonos_created_at at time zone 'Australia/Brisbane')::date between p_from and p_to)
  ) as j
)
select jsonb_build_object(
  'kpis', (select j from kpis),
  'components', (select j from components),
  'weekly', (select j from weekly),
  'countries', (select j from countries),
  'ledger', (select j from ledger),
  'exceptions', (select j from exceptions),
  'window', jsonb_build_object('from', p_from, 'to', p_to)
);
$$;
