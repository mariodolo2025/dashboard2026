-- =============================================================================
-- 2026-08-17 · ecommerce_dashboard: a USD companion for every AUD money figure
-- =============================================================================
-- Applied 2026-08-17 as `ecommerce_dashboard_usd_companions`, recorded in
-- supabase_migrations.schema_migrations as version 20260816215337.
-- NOTE: the Supabase MCP server answered 503 to every call for the whole
-- session, so this went through the Management API /database/query endpoint
-- with the repo's own .env.local credentials, followed by the same
-- schema_migrations insert apply_migration performs. Nothing else differs.
-- Supersedes the body in 20260804030000_ecommerce_trend_granularity.sql; the
-- statement_timeout raised in 20260816202800 is preserved here (50s).
--
-- WHY
--   Mario: "en esta tab faltan los valores en usd entre paréntesis, como
--   hicimos en otros lados". The house convention is already shipped twice —
--   B2CSalesPanel's <Usd> and AdvertisingTab's copy of it: every AUD amount
--   renders as $1,234 with a small (US$867) beside it. The UI must never do
--   that division itself, so the RPC has to return both sides.
--
-- THE CONVERSION RULE (identical to advertising_dashboard, 2026-08-10)
--   USD is built PER CONTRIBUTING ROW and only then summed. An already-summed
--   AUD total is never divided by a single rate, so a window spanning two
--   months comes back at a revenue-weighted blend instead of one month's rate.
--   The rate is currency_exchange_rates by the (year, month) of the ROW's own
--   date, with the latest-known rate as fallback — never a literal.
--   Where a row is natively USD the native amount is used as-is; it is never
--   converted back.
--
--   Applied source by source:
--
--   1. shopify_sales_by_variant (a VIEW over shopify_sales_lines, see
--      20260710020000). Its money columns are built as:
--        net_aud       = AUD lines: net_native · other lines: net_usd × rate
--        gross/discounts/returns/taxes/shipping_aud = *_usd × rate  (every row)
--      so dividing a view row by THAT ROW's month rate is exact on both
--      branches: the non-AUD part returns the very net_usd/gross_usd base it
--      was multiplied from (same rate, no round trip), and the AUD-native part
--      is a genuine conversion of money that was never in USD. The view groups
--      by (order_date, sku, country), so a row never straddles two months.
--      Implementation: the `sh` CTE carries ONE extra column, fx = that row's
--      month rate; every downstream sum divides by it. No new scan.
--
--   2. meta_ads_daily (`mt`, `mtp`): mixed-currency accounts. USD rows use the
--      native spend / conversion_value as-is (they are the base spend_aud was
--      multiplied from); AUD rows divide by the row's month rate. The rate join
--      was already there for the AUD side — the USD side rides it.
--
--   3. ecommerce_meta_daily_ads (the per-creative table): same two branches,
--      keyed on account instead of a currency column — act_191914388901521 is
--      the AUD account (divide), act_1619162111994178 bills USD (as-is). Both
--      new columns ride the fx join the AUD multiplier `k` already uses.
--
--   FALLBACK CAVEAT (inherited, immaterial today): the VIEW falls back to the
--   literal 1.54 when a month has no rate row, while these USD figures fall
--   back to fxlast. Every month in range has a rate loaded (26 rows, 2024-07
--   through 2026-08, no gaps, no duplicates), so the two cannot diverge today.
--
-- WHAT IS A MONEY FIGURE (and therefore gets a twin)
--   kpis: gross, discounts, returns, revenue, shipping, taxes, aov, spend,
--         conv, cpo, cpc, cpm, contributionMargin.
--   NOT money — no twin: orders, units, impressions, clicks (counts); upo,
--         mer, poas, purchaseRoas (ratios); ctr, returnRate, discountRate
--         (percentages).
--   prior: revenue, spend, conv, aov.        bridge: all six.
--   market.{usa,australia}: revenue, spend (orders/roas/share are not money).
--   trend[]: revenue, spend, conv.           geo[]: revenue.
--   family[]: revenue, aovUnit.              products[]: revenue.
--   ads[]: spend, value, cpp (roas/ctr are ratios; the rest are counts).
--   funnel is five event counts and adsCoverage is dates — neither gets one.
--
--   Naming: the AUD key name with Usd appended (revenue -> revenueUsd),
--   matching the advertising contract. Purely additive: not one existing key
--   was removed, renamed, or recomputed.
--
-- PERFORMANCE (the hard constraint — this RPC has a timeout history, see
--   docs/HANDOVER-2026-08-05-TIMEOUT.md). All the USD arithmetic rides CTEs
--   that were already being scanned. The only structural addition is one hash
--   join of `sh` (and of the prior-window `shp`) against currency_exchange_rates
--   — 26 rows, 48 kB, built once. Measured with
--   `explain (analyze, timing off)`, same session, minutes apart:
--     2026-07-01..07-31 'all' day
--       before  189 / 186 / 205 ms                 (min 186)
--       after   201 / 200 / 208 / 211 / 219 / 257 ms  (min 200)   -> +7.7%
--     2025-07-01..2026-08-17 'all' day
--       before  2494 (cold) / 1406 / 1357 ms       (min warm 1357)
--       after   2346 / 2533 (cold) / 1477 / 1445 / 1450 / 1461 / 1459 ms
--                                                  (min warm 1445) -> +6.5%
--     One 767 ms outlier on the short window was discarded: this instance runs
--     a sync orchestrator 3x/day and consecutive runs swing that far on their
--     own (see the 2494 vs 1357 spread in the BEFORE column).
--   Both inside the ~15% budget, and the shape of the plan did not change.
--
-- VERIFIED AFTER APPLYING
--   a. Frozen window 2026-07-01..2026-07-31, 'all', 0.45, 'day': the whole
--      jsonb captured before and after, the new *Usd keys stripped from the
--      after, then compared key by key (kpis, prior, bridge, funnel, market,
--      params, 31 trend buckets, geo, family, products, 25 ads).
--      ZERO differences — every pre-existing number is byte-identical.
--   b. Implied rate (AUD / USD) — the proof the conversion is per row and not
--      one rate applied to a total:
--        2026-07-01..07-31  1.44100  = the Jul-2026 rate exactly (1.4410)
--        2026-08-01..08-31  1.42490  = the Aug-2026 rate exactly (1.4249)
--        2026-07-01..08-31  1.43481  = strictly BETWEEN the two, the
--                                      revenue-weighted blend. A naive
--                                      implementation returns one of them.
--      Same test on the other two independent sources over Jul+Aug:
--        spend (meta_ads_daily) 1.43551 · gross (the view) 1.43482 — each
--        blended by its own weights, all three between 1.4249 and 1.4410.
--   c. Cross-checks against the raw sources, frozen window:
--        revenueUsd 311,382 vs sum over shopify_sales_lines of
--          (AUD ? net_native/rate : net_usd) = 311,381.86  (5,616 lines)
--        spendUsd 132,670 vs advertising_dashboard's proven
--          channels[meta].spendUsd for 2026-07 = 132,669.74 — a different RPC
--          reading a different table (ad_spend_unified), same answer
--        market.usa.spendUsd 72,884 vs the 72,883.58 that migration recorded
--          as the natively-USD share. The US account is not converted back.
--
-- Access posture unchanged (create or replace preserves the ACL): PUBLIC,
-- anon, authenticated, service_role, postgres keep EXECUTE — this RPC has
-- always been readable by the anon dashboard, unlike advertising_dashboard.
-- search_path hardened from 'public' to 'public', 'pg_temp': unlisted, pg_temp
-- is implicitly searched FIRST, so naming it last is strictly safer and cannot
-- change how a public object resolves. TWO quoted elements, never the single
-- 'public, pg_temp' string, which silently breaks resolution.
--
-- Contract: src/components/EcommerceTab.tsx (its local `Dash` interface) is
-- updated in the same commit.
-- =============================================================================

create or replace function public.ecommerce_dashboard(
  p_from date,
  p_to date,
  p_market text default 'all'::text,
  p_margin numeric default 0.45,
  p_granularity text default 'month'::text)
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '50s'
as $function$
with
fxlast as (select rate from currency_exchange_rates order by year desc, month desc limit 1),
-- fx = the row's OWN month rate (fxlast as fallback). One extra column, so every
-- downstream aggregate can build USD per row instead of dividing a total.
sh as materialized (
  select v.order_date, v.net_aud, v.gross_aud, v.discounts_aud, v.returns_aud, v.shipping_aud, v.taxes_aud, v.quantity, v.sku, v.product_title,
         case when v.country='US' then 'usa' when v.country='AU' then 'australia' else 'other' end mk,
         coalesce(nullif(btrim(v.country),''),'??') country,
         coalesce(r.rate,(select rate from fxlast)) fx
  from shopify_sales_by_variant v
  left join currency_exchange_rates r on r.year=extract(year from v.order_date)::int and r.month=extract(month from v.order_date)::int
  where v.order_date between p_from and p_to),
shl as materialized (
  select order_id, order_date, case when country='US' then 'usa' when country='AU' then 'australia' else 'other' end mk
  from shopify_sales_lines where order_date between p_from and p_to),
mt as materialized (
  select m.date, m.impressions, m.clicks, m.view_content, m.add_to_cart, m.initiate_checkout, m.purchases,
         case when m.account_id='act_1619162111994178' then 'usa' when m.account_id='act_191914388901521' then 'australia' else 'other' end mk,
         case when m.currency='USD' then m.spend*coalesce(r.rate,(select rate from fxlast)) else m.spend end spend_aud,
         case when m.currency='USD' then m.conversion_value*coalesce(r.rate,(select rate from fxlast)) else m.conversion_value end conv_aud,
         -- USD twin: the US account bills USD, so its native figure is used as-is
         -- (it is exactly what spend_aud was multiplied from); the AUD account divides.
         case when m.currency='USD' then m.spend else m.spend/coalesce(r.rate,(select rate from fxlast)) end spend_usd,
         case when m.currency='USD' then m.conversion_value else m.conversion_value/coalesce(r.rate,(select rate from fxlast)) end conv_usd
  from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
  where m.date between p_from and p_to),
-- prior window (already market-filtered — only totals needed)
shp as (select coalesce(sum(v.net_aud),0) net,
               coalesce(sum(v.net_aud/coalesce(r.rate,(select rate from fxlast))),0) net_usd
        from shopify_sales_by_variant v
        left join currency_exchange_rates r on r.year=extract(year from v.order_date)::int and r.month=extract(month from v.order_date)::int
        where v.order_date between (p_from-((p_to-p_from)+1)) and (p_from-1)
          and (p_market='all' or (p_market='usa' and v.country='US') or (p_market='australia' and v.country='AU'))),
shlp as (select count(distinct order_id) ord from shopify_sales_lines
         where order_date between (p_from-((p_to-p_from)+1)) and (p_from-1)
           and (p_market='all' or (p_market='usa' and country='US') or (p_market='australia' and country='AU'))),
mtp as (select coalesce(sum(case when m.currency='USD' then m.spend*coalesce(r.rate,(select rate from fxlast)) else m.spend end),0) spend,
               coalesce(sum(case when m.currency='USD' then m.conversion_value*coalesce(r.rate,(select rate from fxlast)) else m.conversion_value end),0) conv,
               coalesce(sum(case when m.currency='USD' then m.spend else m.spend/coalesce(r.rate,(select rate from fxlast)) end),0) spend_usd,
               coalesce(sum(case when m.currency='USD' then m.conversion_value else m.conversion_value/coalesce(r.rate,(select rate from fxlast)) end),0) conv_usd
        from meta_ads_daily m left join currency_exchange_rates r on r.year=extract(year from m.date)::int and r.month=extract(month from m.date)::int
        where m.date between (p_from-((p_to-p_from)+1)) and (p_from-1)
          and (p_market='all' or (p_market='usa' and m.account_id='act_1619162111994178') or (p_market='australia' and m.account_id='act_191914388901521'))),
-- single-pass aggregates (main = selected market via FILTER; us/au split alongside)
a_sh as (select
   coalesce(sum(net_aud) filter (where p_market='all' or mk=p_market),0) net,
   coalesce(sum(gross_aud) filter (where p_market='all' or mk=p_market),0) gross,
   coalesce(sum(discounts_aud) filter (where p_market='all' or mk=p_market),0) disc,
   coalesce(sum(returns_aud) filter (where p_market='all' or mk=p_market),0) ret,
   coalesce(sum(shipping_aud) filter (where p_market='all' or mk=p_market),0) ship,
   coalesce(sum(taxes_aud) filter (where p_market='all' or mk=p_market),0) tax,
   coalesce(sum(quantity) filter (where p_market='all' or mk=p_market),0) units,
   coalesce(sum(net_aud) filter (where mk='usa'),0) us_net,
   coalesce(sum(net_aud) filter (where mk='australia'),0) au_net,
   -- USD twins: per row (÷ that row's fx), then summed.
   coalesce(sum(net_aud/fx) filter (where p_market='all' or mk=p_market),0) net_usd,
   coalesce(sum(gross_aud/fx) filter (where p_market='all' or mk=p_market),0) gross_usd,
   coalesce(sum(discounts_aud/fx) filter (where p_market='all' or mk=p_market),0) disc_usd,
   coalesce(sum(returns_aud/fx) filter (where p_market='all' or mk=p_market),0) ret_usd,
   coalesce(sum(shipping_aud/fx) filter (where p_market='all' or mk=p_market),0) ship_usd,
   coalesce(sum(taxes_aud/fx) filter (where p_market='all' or mk=p_market),0) tax_usd,
   coalesce(sum(net_aud/fx) filter (where mk='usa'),0) us_net_usd,
   coalesce(sum(net_aud/fx) filter (where mk='australia'),0) au_net_usd
  from sh),
a_shl as (select
   count(distinct order_id) filter (where p_market='all' or mk=p_market) ord,
   count(distinct order_id) filter (where mk='usa') us_ord,
   count(distinct order_id) filter (where mk='australia') au_ord
  from shl),
a_mt as (select
   coalesce(sum(spend_aud) filter (where p_market='all' or mk=p_market),0) spend,
   coalesce(sum(conv_aud) filter (where p_market='all' or mk=p_market),0) conv,
   coalesce(sum(impressions) filter (where p_market='all' or mk=p_market),0) impr,
   coalesce(sum(clicks) filter (where p_market='all' or mk=p_market),0) clicks,
   coalesce(sum(view_content) filter (where p_market='all' or mk=p_market),0) vc,
   coalesce(sum(add_to_cart) filter (where p_market='all' or mk=p_market),0) atc,
   coalesce(sum(initiate_checkout) filter (where p_market='all' or mk=p_market),0) ic,
   coalesce(sum(purchases) filter (where p_market='all' or mk=p_market),0) purch,
   coalesce(sum(spend_aud) filter (where mk='usa'),0) us_spend,
   coalesce(sum(conv_aud) filter (where mk='usa'),0) us_conv,
   coalesce(sum(spend_aud) filter (where mk='australia'),0) au_spend,
   coalesce(sum(conv_aud) filter (where mk='australia'),0) au_conv,
   coalesce(sum(spend_usd) filter (where p_market='all' or mk=p_market),0) spend_usd,
   coalesce(sum(conv_usd) filter (where p_market='all' or mk=p_market),0) conv_usd,
   coalesce(sum(spend_usd) filter (where mk='usa'),0) us_spend_usd,
   coalesce(sum(spend_usd) filter (where mk='australia'),0) au_spend_usd
  from mt),
g as (select case lower(coalesce(p_granularity,'month'))
                when 'day' then 'day' when 'week' then 'week' else 'month' end as unit,
              case lower(coalesce(p_granularity,'month'))
                when 'day' then interval '1 day' when 'week' then interval '1 week'
                else interval '1 month' end as step),
trend as (
  select coalesce(jsonb_agg(jsonb_build_object(
      -- Full date, formatted client-side. 'YYYY-MM' cannot label a day or week.
      'bucket',to_char(d,'YYYY-MM-DD'),
      'ym',to_char(d,'YYYY-MM'),
      'revenue',round(coalesce(sr.rev,0)),'spend',round(coalesce(mr.spend,0)),
      'conv',round(coalesce(mr.conv,0)),'orders',coalesce(so.ord,0),
      'mer',case when coalesce(mr.spend,0)>0 then round(sr.rev/mr.spend,2) else null end,
      'revenueUsd',round(coalesce(sr.rev_usd,0)),'spendUsd',round(coalesce(mr.spend_usd,0)),
      'convUsd',round(coalesce(mr.conv_usd,0))) order by d),'[]'::jsonb) j
  from g, generate_series(date_trunc(g.unit,p_from::timestamp), date_trunc(g.unit,p_to::timestamp), g.step) d
  left join (select date_trunc((select unit from g),order_date) mo, sum(net_aud) filter (where p_market='all' or mk=p_market) rev, sum(net_aud/fx) filter (where p_market='all' or mk=p_market) rev_usd from sh group by 1) sr on sr.mo=d
  left join (select date_trunc((select unit from g),order_date) mo, count(distinct order_id) filter (where p_market='all' or mk=p_market) ord from shl group by 1) so on so.mo=d
  left join (select date_trunc((select unit from g),date) mo, sum(spend_aud) filter (where p_market='all' or mk=p_market) spend, sum(conv_aud) filter (where p_market='all' or mk=p_market) conv, sum(spend_usd) filter (where p_market='all' or mk=p_market) spend_usd, sum(conv_usd) filter (where p_market='all' or mk=p_market) conv_usd from mt group by 1) mr on mr.mo=d),
geo as (select coalesce(jsonb_agg(jsonb_build_object('country',country,'revenue',rev,'units',units,'revenueUsd',rev_usd) order by rev desc),'[]'::jsonb) j from (
   select country, round(sum(net_aud)) rev, round(sum(quantity)) units, round(sum(net_aud/fx)) rev_usd from sh
   where p_market='all' or mk=p_market group by country order by sum(net_aud) desc nulls last limit 10) q),
family as (select coalesce(jsonb_agg(jsonb_build_object('family',fam,'revenue',rev,'units',units,'pct',pct,'aovUnit',aovu,'revenueUsd',rev_usd,'aovUnitUsd',aovu_usd) order by rev desc),'[]'::jsonb) j from (
   select fam, round(sum(net_aud)) rev, round(sum(quantity)) units,
     round(100*sum(net_aud)/nullif((select net from a_sh),0),1) pct,
     round(sum(net_aud)/nullif(sum(quantity),0),2) aovu,
     round(sum(net_aud/fx)) rev_usd,
     round(sum(net_aud/fx)/nullif(sum(quantity),0),2) aovu_usd
   from (select case
       when sku ilike 'PSD-HD%' then 'Shower Screens'
       when sku ilike 'PSD-HE%' or sku ilike 'EP-BR%' then 'Filter Baskets'
       when sku ilike 'PF%' then 'Portafilters'
       when sku ilike 'EXT%' or sku ilike 'PRE%' then 'Bundles'
       when sku ilike 'PSD-puck%' then 'Puck Screens'
       when sku ilike '%distribut%' or sku ilike '%tamp%' or sku ilike '%ring%' or sku ilike '%crusher%' then 'Distribution & Prep'
       else 'Accessories' end fam, net_aud, quantity, fx
     from sh where p_market='all' or mk=p_market) c group by fam) q),
products as (select coalesce(jsonb_agg(jsonb_build_object('title',title,'revenue',rev,'units',units,'revenueUsd',rev_usd) order by rev desc),'[]'::jsonb) j from (
   select max(product_title) title, round(sum(net_aud)) rev, round(sum(quantity)) units, round(sum(net_aud/fx)) rev_usd from sh
   where product_title is not null and (p_market='all' or mk=p_market)
   group by btrim(product_title) order by sum(net_aud) desc limit 8) q)
select jsonb_build_object(
  'params', jsonb_build_object('from',p_from,'to',p_to,'market',p_market,'margin',p_margin,'granularity',(select unit from g)),
  'kpis', jsonb_build_object(
    'gross',round(a_sh.gross),'discounts',round(a_sh.disc),'returns',round(a_sh.ret),'revenue',round(a_sh.net),
    'shipping',round(a_sh.ship),'taxes',round(a_sh.tax),'units',round(a_sh.units),'orders',a_shl.ord,
    'aov', case when a_shl.ord>0 then round(a_sh.net/a_shl.ord,2) else 0 end,
    'upo', case when a_shl.ord>0 then round(a_sh.units/a_shl.ord,2) else 0 end,
    'spend',round(a_mt.spend),'conv',round(a_mt.conv),
    'mer', case when a_mt.spend>0 then round(a_sh.net/a_mt.spend,2) else null end,
    'purchaseRoas', case when a_mt.spend>0 then round(a_mt.conv/a_mt.spend,2) else null end,
    'cpo', case when a_shl.ord>0 then round(a_mt.spend/a_shl.ord,2) else null end,
    'poas', case when a_mt.spend>0 then round(a_sh.net*p_margin/a_mt.spend,2) else null end,
    'contributionMargin', round(a_sh.net*p_margin),
    'ctr', case when a_mt.impr>0 then round(100*a_mt.clicks/a_mt.impr,2) else 0 end,
    'cpc', case when a_mt.clicks>0 then round(a_mt.spend/a_mt.clicks,2) else 0 end,
    'cpm', case when a_mt.impr>0 then round(a_mt.spend/a_mt.impr*1000,2) else 0 end,
    'impressions',round(a_mt.impr),'clicks',round(a_mt.clicks),
    'returnRate', case when a_sh.gross>0 then round(100*a_sh.ret/a_sh.gross,2) else 0 end,
    'discountRate', case when a_sh.gross>0 then round(100*a_sh.disc/a_sh.gross,2) else 0 end,
    -- USD companions. Counts, ratios and percentages above have none by design.
    'grossUsd',round(a_sh.gross_usd),'discountsUsd',round(a_sh.disc_usd),'returnsUsd',round(a_sh.ret_usd),
    'revenueUsd',round(a_sh.net_usd),'shippingUsd',round(a_sh.ship_usd),'taxesUsd',round(a_sh.tax_usd),
    'aovUsd', case when a_shl.ord>0 then round(a_sh.net_usd/a_shl.ord,2) else 0 end,
    'spendUsd',round(a_mt.spend_usd),'convUsd',round(a_mt.conv_usd),
    'cpoUsd', case when a_shl.ord>0 then round(a_mt.spend_usd/a_shl.ord,2) else null end,
    'contributionMarginUsd', round(a_sh.net_usd*p_margin),
    'cpcUsd', case when a_mt.clicks>0 then round(a_mt.spend_usd/a_mt.clicks,2) else 0 end,
    'cpmUsd', case when a_mt.impr>0 then round(a_mt.spend_usd/a_mt.impr*1000,2) else 0 end),
  'prior', jsonb_build_object('revenue',round(shp.net),'orders',shlp.ord,'spend',round(mtp.spend),'conv',round(mtp.conv),
    'mer', case when mtp.spend>0 then round(shp.net/mtp.spend,2) else null end,
    'aov', case when shlp.ord>0 then round(shp.net/shlp.ord,2) else null end,
    'purchaseRoas', case when mtp.spend>0 then round(mtp.conv/mtp.spend,2) else null end,
    'hasPrior', ((p_from-((p_to-p_from)+1)) >= date '2024-07-01'),
    'revenueUsd',round(shp.net_usd),'spendUsd',round(mtp.spend_usd),'convUsd',round(mtp.conv_usd),
    'aovUsd', case when shlp.ord>0 then round(shp.net_usd/shlp.ord,2) else null end),
  'bridge', jsonb_build_object('gross',round(a_sh.gross),'discounts',round(a_sh.disc),'returns',round(a_sh.ret),'net',round(a_sh.net),'shipping',round(a_sh.ship),'taxes',round(a_sh.tax),
    'grossUsd',round(a_sh.gross_usd),'discountsUsd',round(a_sh.disc_usd),'returnsUsd',round(a_sh.ret_usd),'netUsd',round(a_sh.net_usd),'shippingUsd',round(a_sh.ship_usd),'taxesUsd',round(a_sh.tax_usd)),
  'funnel', jsonb_build_object('impressions',round(a_mt.impr),'clicks',round(a_mt.clicks),'viewContent',round(a_mt.vc),'addToCart',round(a_mt.atc),'initiateCheckout',round(a_mt.ic),'purchases',round(a_mt.purch)),
  'market', jsonb_build_object(
    'usa', jsonb_build_object('revenue',round(a_sh.us_net),'orders',a_shl.us_ord,'spend',round(a_mt.us_spend),'roas',case when a_mt.us_spend>0 then round(a_mt.us_conv/a_mt.us_spend,2) else null end,'share',case when (a_sh.us_net+a_sh.au_net)>0 then round(100*a_sh.us_net/(a_sh.us_net+a_sh.au_net)) else 0 end,'revenueUsd',round(a_sh.us_net_usd),'spendUsd',round(a_mt.us_spend_usd)),
    'australia', jsonb_build_object('revenue',round(a_sh.au_net),'orders',a_shl.au_ord,'spend',round(a_mt.au_spend),'roas',case when a_mt.au_spend>0 then round(a_mt.au_conv/a_mt.au_spend,2) else null end,'share',case when (a_sh.us_net+a_sh.au_net)>0 then round(100*a_sh.au_net/(a_sh.us_net+a_sh.au_net)) else 0 end,'revenueUsd',round(a_sh.au_net_usd),'spendUsd',round(a_mt.au_spend_usd))),
  'trend', trend.j, 'geo', geo.j, 'family', family.j, 'products', products.j,
  'adsCoverage', jsonb_build_object(
      'from', (select min(date) from ecommerce_meta_daily_ads),
      'to',   (select max(date) from ecommerce_meta_daily_ads),
      'daysInRange', (select count(distinct date) from ecommerce_meta_daily_ads
                      where date between p_from and p_to)),
  'ads', (select coalesce(jsonb_agg(jsonb_build_object(
      'ad', q.an, 'campaign', q.cp, 'firstSeen', q.fs,
      'spend', round(q.sp), 'impressions', q.im, 'clicks', q.cl,
      'purchases', q.pu, 'value', round(q.va),
      'roas', case when q.sp > 0 then round(q.va / q.sp, 2) end,
      'ctr',  case when q.im > 0 then round(100.0 * q.cl / q.im, 2) end,
      'cpp',  case when q.pu > 0 then round(q.sp / q.pu, 2) end,
      'spendUsd', round(q.sp_usd), 'valueUsd', round(q.va_usd),
      'cppUsd', case when q.pu > 0 then round(q.sp_usd / q.pu, 2) end)
      order by q.sp desc), '[]'::jsonb)
    from (
      select y.ad_name an, y.campaign_name cp, min(g.first_ever) fs,
             sum(y.spend * y.k) sp, sum(y.impressions) im, sum(y.clicks) cl,
             sum(y.purchases) pu, sum(y.purchase_value * y.k) va,
             sum(y.spend_usd) sp_usd, sum(y.purchase_value_usd) va_usd
      from (
        select d.date, d.ad_name, d.campaign_name, d.spend, d.impressions,
               d.clicks, d.purchases, d.purchase_value,
               case when d.account_id = 'act_191914388901521' then 1
                    else coalesce(fx.rate, (select rate from fxlast)) end k,
               -- USD twin, same two branches as k: the AUD account divides by the
               -- row's month rate, the USD account keeps its native amount.
               case when d.account_id = 'act_191914388901521'
                    then d.spend / coalesce(fx.rate, (select rate from fxlast))
                    else d.spend end spend_usd,
               case when d.account_id = 'act_191914388901521'
                    then d.purchase_value / coalesce(fx.rate, (select rate from fxlast))
                    else d.purchase_value end purchase_value_usd
        from ecommerce_meta_daily_ads d
        left join currency_exchange_rates fx
               on fx.year = extract(year from d.date)::int
              and fx.month = extract(month from d.date)::int
        where d.date between p_from and p_to
          and (p_market = 'all'
               or (p_market = 'usa'       and d.account_id = 'act_1619162111994178')
               or (p_market = 'australia' and d.account_id = 'act_191914388901521'))
      ) y
      -- First day this creative ever spent, across the whole table rather than
      -- the selected window.
      left join (select ad_name, campaign_name, min(date) first_ever
                 from ecommerce_meta_daily_ads group by 1, 2) g
             on g.ad_name = y.ad_name
            and g.campaign_name is not distinct from y.campaign_name
      group by y.ad_name, y.campaign_name
      having sum(y.spend * y.k) > 0
      order by 4 desc
      limit 25) q))
from a_sh, a_shl, a_mt, shp, shlp, mtp, trend, geo, family, products;
$function$;
