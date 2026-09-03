-- =============================================================================
-- DDP Markets — each advertising region gets its own spend and its own MER
-- =============================================================================
-- Mario, 2026-09-03: "canada tiene advertisement solo para ella, no esta en el
-- mismo paquete que los de Europe y por lo tanto su MER deberia ser individual."
--
-- He is right, and yesterday's migration only got half of it. It spotted that
-- Canadian revenue must not be divided by European spend, and solved that by
-- REMOVING Canada from the ratio (ad_region set to null). That stopped the lie
-- but lost the number: Canada advertises, so Canada has a MER — it just is not
-- the European one. One blended figure was never the answer; one figure PER
-- REGION is.
--
-- WHAT CHANGES
--   * ad_campaign_like: the campaign-name pattern that pays for a region, held
--     as data next to the market. Europe's campaigns are 'Europe HD (Germany,
--     Denmark, Switzerland)' and 'Europe - All Tools (...)'; Canada's is
--     'CANADA Breville HD Sales Campaign - Video'. Stored explicitly rather
--     than derived from the region name: a renamed campaign must break loudly
--     at a value someone can see, not silently through a clever concatenation.
--
--     DO NOT READ THE MARKET LIST OFF THE CAMPAIGN NAME. That title is stale:
--     it still says Switzerland, which is not even a live market, and omits
--     Sweden, which the same campaign does pay for (Mario, 2026-09-03). Which
--     markets a campaign covers is ddp_markets.ad_region and nothing else.
--   * CA moves from ad_region null to 'canada'.
--   * The single `ads` CTE becomes one row per region, and the payload carries
--     `adRegions`: spend, campaigns, first ad day, revenue since that day, and
--     that region's own MER. `adSpend` is the total across the regions SHOWN.
--   * The country filter now reaches the ad block. It did not in the first cut
--     of this migration, and Mario caught it immediately: "el Ad spend es el
--     mismo para todos los mercados, no cambia para canada." Picking a market
--     now leaves that market's region alone. It still cannot split a region in
--     two — one campaign pays for Germany and Denmark jointly — but showing
--     Europe's spend while Canada is selected was simply wrong.
--
-- The MER rule is unchanged and now applies per region: revenue counts only
-- from the region's FIRST AD DAY, because dividing a whole month of revenue by
-- five days of spend would flatter the ads absurdly. It also still ignores
-- p_country — a campaign that targets Germany and Denmark together cannot be
-- split between them — but with regions separated, filtering to Canada now
-- shows Canada's own ratio instead of Europe's.
--
-- A market with no campaign keeps ad_region null and therefore has no MER at
-- all — the honest state, not a gap to fill. None is in that position today:
-- Europe covers DE, DK and SE, and Canada covers CA.
--
-- CURRENCY: the Europe campaigns bill in AUD and the Canadian one in USD, so
-- the per-row USD conversion in the spend sum is load-bearing here, not
-- decoration. Canada's campaign started 2026-09-02 with US$65 on its first day.
--
-- VERIFIED after apply: two regions returned, europe over DE+DK+SE and canada
-- over CA, each with its own first day and ratio; adSpend equals the sum of the
-- regions SHOWN, and picking any of the three European markets returns the one
-- European region whole.

alter table ddp_markets add column if not exists ad_campaign_like text;

comment on column ddp_markets.ad_campaign_like is
  'ILIKE pattern matching the Meta campaigns that pay for this market''s region. '
  'Markets sharing an ad_region must share this value. Null when nothing advertises the market.';

update ddp_markets set ad_region = 'europe', ad_campaign_like = 'europe%'
  where country_code in ('DE', 'DK', 'CH');
update ddp_markets set ad_region = 'canada', ad_campaign_like = 'canada%',
  note = 'Added 2026-09-02 — enabled in ZONOS. Advertises under its own CANADA campaign (USD), so it carries its own MER, separate from Europe''s.'
  where country_code = 'CA';
-- Sweden rides the same European campaign (Mario, 2026-09-03: "Europe HD
-- deberia ser Germany, sweden y Denmark, esos tres estan atados a la misma
-- campana"). Its revenue therefore belongs in Europe's ratio, not outside it.
update ddp_markets set ad_region = 'europe', ad_campaign_like = 'europe%',
  note = 'Added 2026-09-01; started charging duties and tax the same week. Advertised by the shared Europe campaign, together with Germany and Denmark.'
  where country_code = 'SE';

create or replace function ddp_markets_dashboard(p_from date, p_to date, p_country text default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
with mk as (
  -- The one list. Everything below filters through it.
  select country_code, name, zonos_expected, ad_region, ad_campaign_like
  from ddp_markets where active
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
-- One row per advertising region: the markets it covers and the campaigns that
-- pay for it. Regions are independent — a Canadian dollar never lands in the
-- European ratio and vice versa.
regions as (
  -- The country filter DOES reach this block. Selecting Canada must leave only
  -- Canada's region and its spend; selecting Germany leaves Europe's. What it
  -- cannot do is narrow a region's INSIDE: the European campaigns name Germany
  -- and Denmark together, so their spend and their ratio stay DE+DK whichever
  -- of the two is selected. Filter the region, never split it.
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
         -- Days that ACTUALLY carry spend, not the calendar distance from the
         -- first ad day. Mario, 2026-09-03: the card said Canada was "2 days
         -- in" on its second calendar day, when Meta had reported spend for
         -- exactly one — the 3-Sep row had not landed yet. Counting the window
         -- also lies about a campaign that pauses. Count the rows.
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
    -- Total across regions, so the headline number is still one figure.
    'adSpend', (select spend from ads),
    -- The detail that makes it readable: one entry per region, each with the
    -- markets it pays for and its OWN ratio. Never blend them.
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
