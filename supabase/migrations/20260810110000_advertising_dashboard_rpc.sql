-- =============================================================================
-- Advertising Bloque 3 — advertising_dashboard(p_from, p_to) RPC
-- =============================================================================
-- Applied: 2026-08-10 via MCP apply_migration, name `advertising_dashboard_rpc`
--   (applied twice: first version read advertising_order_channels directly and
--   cost ~7.9s ANY window — the view's inner CTE is referenced 3x, so Postgres
--   materializes ALL ~138k moments and runs advertising_bucket on every one,
--   no predicate pushdown. Final version below inlines the view's IDENTICAL
--   per-order logic with the window filter applied BEFORE classifying:
--   equivalence proven 634/634 orders, 0 mismatches on
--   last_bucket/first_bucket/last_campaign/first_campaign. The view stays
--   untouched as the shared object for acceptance/ad-hoc queries.)
--
-- Plan:     docs/PLAN-ADVERTISING-04-MOTOR.md — Task 2
-- Spec:     docs/DESIGN-ADVERTISING-TAB.md §4 Bloque 3, §2 principios
-- Contract: src/components/advertising/mockData.ts (AdvertisingMock) — the RPC
--           returns EXACTLY that shape, key by key. Tab wiring = Plan 5.
--
-- Acceptance battery (2026-08-10, window 2026-08-06 → current_date unless noted):
--   a. Contract keys — exact match, no extras/missing:
--      top [blended, channels, from, googleBuckets, merSeries, to];
--      blended 10 keys; merSeries [d, mer, revenueAud, spendAud];
--      channels 7 keys, [0]=meta [1]=google always; campaigns 5 keys
--      (+ optional note, present only on google shopping); googleBuckets
--      [bucket, orders, revenueAud] + optional note.
--   b. Conservation — sum of ALL last-click bucket revenues == window total
--      from the same per-order source: 66,684.90 == 66,684.90 (diff 0.00,
--      634 orders). 12-month window: 6,120,131.49 == 6,120,131.49 (diff 0.00).
--   c. merSeries length == days in window (4 == 4; 12-month 366 == 366).
--      Google rule: google_active_from null today → meta-only MER on every day
--      with meta spend loaded, spend/mer null on days without (null never 0).
--      Other side exercised with a simulated google_active_from = 2026-08-08:
--      days before → meta-only; days on/after without google row → null. PASS.
--   d. blended.revenueAud == E-commerce figure (shopify_sales_by_variant
--      net_aud): 66,684.90 both. PASS.
--   e. Runtime (explain analyze): ('2026-08-06', current_date) 80ms;
--      true 30-day window 1.23s (< 2s target, PASS);
--      12-month ('2025-08-01','2026-08-01') 15.1s — slow but under the 25s
--      timeout; the tab defaults to short windows, noted, not optimized (the
--      cost is ~59k orders x ~135k moment classifications + per-order revenue;
--      rollups are the known pattern if it ever matters).
--   f. ShopifyQL cross-check: utm dimensions NOT supported (`GROUP BY
--      utm_campaign` → Column Not Found). Referrer grouping works but measures
--      a different model (referrer-based, tax-inclusive, USD presentment) —
--      NOT numerically comparable to our buckets. The Analytics reconciliation
--      (Total sales by referrer / Sales attributed to marketing, ±2%) runs
--      manually with Mario as the Plan 5 checkpoint. One hard cross-check
--      landed: Shopify counts exactly 634 orders for 2026-08-06→09 — same as
--      our attribution universe for that window.
--   Real-figures sample (2026-08-06 → 2026-08-09): blended spend 23,650.02 /
--   revenue 66,684.90 / MER 2.82 / claimed 52,548.72 / doubleCount 1.50 /
--   overlap 12 / CAC 42.69 / newCustomers 554 / unclassified 27 / noJourney 36.
--   Meta storeLast 28,345.55 vs claimed 52,548.72; google-brand 46 orders
--   5,462.19 · nonbrand 6 · shopping-proxy 9 · organic 113.
--
-- Access posture: authenticated + service_role only; PUBLIC and anon revoked
-- (the definer RPC is the gate over ad-spend data — agujero real 2026-08-09,
-- spec §8). Note: web_upgrade_performance still carries the default PUBLIC
-- execute grant (anon CAN call it today); mirrored the spec rule, not that ACL.
-- =============================================================================

create or replace function public.advertising_dashboard(p_from date, p_to date)
returns jsonb
language sql
stable security definer
set search_path to 'public'
set statement_timeout to '25s'
set work_mem to '16MB'
as $function$
with fxlast as (
  -- latest-known monthly rate — never a literal
  select rate from currency_exchange_rates order by year desc, month desc limit 1
),
gaf as (
  -- google_active_from: first day with any Google row ever loaded; null = not started
  select min(date) d from google_ads_daily
),
win_orders as (
  select order_id, order_date, customer_order_index
  from shopify_order_attribution
  where order_date between p_from and p_to
),
m as (
  -- one bucket computation per moment, window-filtered BEFORE classifying
  -- (exactly advertising_order_channels' logic, date-filter pushed down)
  select mo.order_id, mo.seq, mo.utm_campaign,
         advertising_bucket(mo.utm_source, mo.utm_medium, mo.utm_campaign,
                            mo.referrer, w.order_date) bucket
  from shopify_order_journey_moments mo
  join win_orders w using (order_id)
),
last_nd as (
  -- last NON-DIRECT moment (paridad Shopify Analytics)
  select distinct on (order_id) order_id, bucket, utm_campaign
  from m where bucket <> 'direct'
  order by order_id, seq desc
),
first_v as (
  select distinct on (order_id) order_id, bucket, utm_campaign
  from m order by order_id, seq asc
),
any_moment as (
  select order_id from m group by order_id
),
oc as (
  select w.order_id,
         case when am.order_id is null then 'sin-journey'
              else coalesce(ln.bucket, 'direct') end last_bucket,
         ln.utm_campaign last_campaign,
         case when am.order_id is null then 'sin-journey'
              else fv.bucket end first_bucket,
         fv.utm_campaign first_campaign,
         w.customer_order_index
  from win_orders w
  left join any_moment am on am.order_id = w.order_id
  left join last_nd ln on ln.order_id = w.order_id
  left join first_v fv on fv.order_id = w.order_id
),
orders_rev as (
  -- per-order net AUD over the window (native AUD exact; USD x monthly rate, fxlast fallback)
  select l.order_id,
         sum(case when l.currency = 'AUD' then l.net_native
                  else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) rev
  from shopify_sales_lines l
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int
   and r.month = extract(month from l.order_date)::int
  where l.order_date between p_from and p_to
  group by l.order_id
),
ord as (
  -- attribution universe: every order with revenue and/or journey in the window.
  -- Sales orders absent from attribution entirely count as 'sin-journey' (capture gap).
  select coalesce(o.last_bucket, 'sin-journey') last_bucket,
         o.last_campaign,
         coalesce(o.first_bucket, 'sin-journey') first_bucket,
         o.first_campaign,
         o.customer_order_index,
         coalesce(r.rev, 0) rev
  from oc o full join orders_rev r using (order_id)
),
bucket_last as (select last_bucket b, count(*) n, sum(rev) rev from ord group by 1),
bucket_first as (select first_bucket b, sum(rev) rev from ord group by 1),
spend_daily as (
  select date,
         sum(spend_aud) filter (where platform = 'meta') meta_s,
         sum(spend_aud) filter (where platform = 'google') goog_s
  from ad_spend_unified
  where date between p_from and p_to
  group by date
),
rev_daily as (
  select order_date d, sum(net_aud) rev
  from shopify_sales_by_variant
  where order_date between p_from and p_to
  group by order_date
),
mer_days as (
  -- spend rule (locked): meta missing -> null; day >= google_active_from without a
  -- loaded google spend row -> null; otherwise meta (+ google when loaded).
  -- google_active_from null (Google not started) -> meta-only MER. Null never 0.
  select days.d,
         coalesce(rd.rev, 0) rev,
         case
           when sd.meta_s is null then null
           when (select d from gaf) is not null and days.d >= (select d from gaf)
                and sd.goog_s is null then null
           else sd.meta_s + coalesce(sd.goog_s, 0)
         end spend
  from (select generate_series(p_from, p_to, interval '1 day')::date d) days
  left join spend_daily sd on sd.date = days.d
  left join rev_daily rd on rd.d = days.d
),
meta_c as (
  -- Meta campaign spend/claims in NATIVE currency per row: convert USD only (no double conversion)
  select m2.campaign_id,
         (array_agg(m2.campaign_name order by m2.date desc)
            filter (where m2.campaign_name is not null))[1] campaign_name,
         sum(case when m2.currency = 'AUD' then m2.spend
                  else m2.spend * coalesce(r.rate, (select rate from fxlast)) end) spend_aud,
         sum(case when m2.currency = 'AUD' then m2.claimed_value
                  else m2.claimed_value * coalesce(r.rate, (select rate from fxlast)) end) claimed_aud
  from meta_ads_campaign_daily m2
  left join currency_exchange_rates r
    on r.year = extract(year from m2.date)::int
   and r.month = extract(month from m2.date)::int
  where m2.date between p_from and p_to
  group by m2.campaign_id
),
meta_store_last as (
  select coalesce(last_campaign, '(sin campaña)') cid, sum(rev) rev
  from ord where last_bucket = 'meta-paid' group by 1
),
meta_store_first as (
  select coalesce(first_campaign, '(sin campaña)') cid, sum(rev) rev
  from ord where first_bucket = 'meta-paid' group by 1
),
meta_keys as (
  -- campaign present in the window: platform spend/claims OR store-recognised revenue
  select campaign_id cid from meta_c
  union select cid from meta_store_last
  union select cid from meta_store_first
),
meta_campaigns as (
  -- display = campaign_name (latest known); store side joins utm campaign_id::text.
  -- Unmatched store keys (e.g. the {{campaign_name}} literal tramo) fall back to the raw key.
  select coalesce(mc.campaign_name, k.cid) display,
         coalesce(mc.spend_aud, 0) spend,
         coalesce(mc.claimed_aud, 0) claimed,
         coalesce(sl.rev, 0) s_last,
         coalesce(sf.rev, 0) s_first
  from meta_keys k
  left join meta_c mc on mc.campaign_id = k.cid
  left join meta_store_last sl on sl.cid = k.cid
  left join meta_store_first sf on sf.cid = k.cid
  order by coalesce(mc.spend_aud, 0) desc, coalesce(sl.rev, 0) desc
  limit 15
),
g as (
  select campaign, sum(spend_aud) spend, sum(claimed_value_aud) claimed
  from google_ads_daily
  where date between p_from and p_to
  group by campaign
),
goog_campaigns as (
  -- exactly the closed enum, mapped to its bucket; rows present even with no data
  select v.campaign, v.note, v.sort_ord,
         coalesce(g.spend, 0) spend,
         coalesce(g.claimed, 0) claimed,
         coalesce(bl.rev, 0) s_last,
         coalesce(bf.rev, 0) s_first
  from (values
    ('brand-search', 'google-brand', null::text, 1),
    ('non-brand', 'google-nonbrand', null, 2),
    ('shopping', 'google-shopping-proxy',
     'proxy product_sync/sag_organic — mezcla free listings hasta el tagueo limpio', 3)
  ) v(campaign, bucket, note, sort_ord)
  left join g on g.campaign = v.campaign
  left join bucket_last bl on bl.b = v.bucket
  left join bucket_first bf on bf.b = v.bucket
),
overlap as (
  -- moment-based (handover): journeys touched by BOTH paid platforms anywhere.
  -- Reuses m: one bucket computation for the whole engine.
  select count(*) n from (
    select order_id from m
    group by order_id
    having bool_or(bucket = 'meta-paid')
       and bool_or(bucket in ('google-brand','google-nonbrand','google-shopping-proxy','google-paid-other'))
  ) o
),
totals as (
  select
    (select coalesce(sum(spend_aud), 0) from ad_spend_unified where date between p_from and p_to) spend,
    (select coalesce(sum(net_aud), 0) from shopify_sales_by_variant where order_date between p_from and p_to) revenue,
    (select coalesce(sum(claimed_aud), 0) from meta_c)
      + (select coalesce(sum(claimed), 0) from g) claimed,
    (select coalesce(sum(rev), 0) from bucket_last
      where b in ('meta-paid','google-brand','google-nonbrand','google-paid-other','google-shopping-proxy')) paid_last_rev,
    (select count(*) from ord where customer_order_index = 1) new_orders,
    (select count(*) from ord where last_bucket in ('other-tagged','google-paid-other','referral-other')) unclassified,
    (select count(*) from ord where last_bucket = 'sin-journey') nojourney,
    (select n from overlap) overlap_n
)
select jsonb_build_object(
  'from', to_char(p_from, 'YYYY-MM-DD'),
  'to', to_char(p_to, 'YYYY-MM-DD'),
  'blended', (select jsonb_build_object(
    'spendAud', round(spend, 2),
    'revenueAud', round(revenue, 2),
    'mer', round(revenue / nullif(spend, 0), 2),
    'claimedTotalAud', round(claimed, 2),
    'doubleCountRatio', round(claimed / nullif(paid_last_rev, 0), 2),
    'overlapOrders', overlap_n,
    'cacBlended', round(spend / nullif(new_orders, 0), 2),
    'newCustomerOrders', new_orders,
    'unclassifiedOrders', unclassified,
    'noJourneyOrders', nojourney
  ) from totals),
  'merSeries', (select coalesce(jsonb_agg(jsonb_build_object(
    'd', to_char(d, 'YYYY-MM-DD'),
    'revenueAud', round(rev, 2),
    'spendAud', round(spend, 2),
    'mer', round(rev / nullif(spend, 0), 2)
  ) order by d), '[]'::jsonb) from mer_days),
  'channels', jsonb_build_array(
    (select jsonb_build_object(
      'key', 'meta',
      'label', 'Meta',
      'spendAud', round((select coalesce(sum(spend_aud), 0) from ad_spend_unified
                          where platform = 'meta' and date between p_from and p_to), 2),
      'claimedAud', round((select coalesce(sum(claimed_aud), 0) from meta_c), 2),
      'storeLastAud', round(coalesce((select rev from bucket_last where b = 'meta-paid'), 0), 2),
      'storeFirstAud', round(coalesce((select rev from bucket_first where b = 'meta-paid'), 0), 2),
      'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
          'campaign', display,
          'spendAud', round(spend, 2),
          'claimedValueAud', round(claimed, 2),
          'storeLastClickAud', round(s_last, 2),
          'storeFirstClickAud', round(s_first, 2)
        ) order by spend desc, s_last desc), '[]'::jsonb) from meta_campaigns)
    )),
    (select jsonb_build_object(
      'key', 'google',
      'label', 'Google',
      'spendAud', round((select coalesce(sum(spend_aud), 0) from ad_spend_unified
                          where platform = 'google' and date between p_from and p_to), 2),
      'claimedAud', round((select coalesce(sum(claimed), 0) from g), 2),
      'storeLastAud', round((select coalesce(sum(rev), 0) from bucket_last
                              where b in ('google-brand','google-nonbrand','google-shopping-proxy')), 2),
      'storeFirstAud', round((select coalesce(sum(rev), 0) from bucket_first
                               where b in ('google-brand','google-nonbrand','google-shopping-proxy')), 2),
      'campaigns', (select coalesce(jsonb_agg((jsonb_build_object(
          'campaign', campaign,
          'spendAud', round(spend, 2),
          'claimedValueAud', round(claimed, 2),
          'storeLastClickAud', round(s_last, 2),
          'storeFirstClickAud', round(s_first, 2)
        ) || case when note is not null then jsonb_build_object('note', note) else '{}'::jsonb end
        ) order by sort_ord), '[]'::jsonb) from goog_campaigns)
    ))
  ),
  'googleBuckets', (select coalesce(jsonb_agg((jsonb_build_object(
      'bucket', v.bucket,
      'orders', coalesce(bl.n, 0),
      'revenueAud', round(coalesce(bl.rev, 0), 2)
    ) || case when v.note is not null then jsonb_build_object('note', v.note) else '{}'::jsonb end
    ) order by v.sort_ord), '[]'::jsonb)
    from (values
      ('google-brand', 1, null::text),
      ('google-nonbrand', 2, null),
      ('google-shopping-proxy', 3, 'incluye free listings'),
      ('google-organic', 4, 'baseline bucket google total jul-2026: ~AUD 3,0k/día (pago sin tag + orgánico, convertido de USD)'),
      ('google-mixto-pre', 5, 'solo con p_from < 2026-08-06: referrer google pre-gate sin desglose — pago sin tag + orgánico mezclados (date-gate del handover)')
    ) v(bucket, sort_ord, note)
    left join bucket_last bl on bl.b = v.bucket
    where v.bucket <> 'google-mixto-pre' or p_from < date '2026-08-06')
)
$function$;

-- Access posture: the definer RPC is the gate over ad-spend data; the anon key
-- must not read spend (agujero real 2026-08-09, spec §8).
revoke all on function public.advertising_dashboard(date, date) from public;
revoke all on function public.advertising_dashboard(date, date) from anon;
grant execute on function public.advertising_dashboard(date, date) to authenticated, service_role;
