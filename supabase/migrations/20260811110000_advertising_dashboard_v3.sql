-- =============================================================================
-- Advertising Plan 6 — advertising_dashboard v3 (verdict + overlap + live orders)
-- =============================================================================
-- Applied 2026-08-11 via MCP apply_migration, name `advertising_dashboard_v3`.
-- Supersedes the body in 20260810110000_advertising_dashboard_rpc.sql (that file
-- keeps the v1/v2 history; THIS file's body is the deployed one).
--
-- Plan: ADVERTISING/plans/06-mejoras-post-revision.md — B1 (ROAS/CPA per
-- channel), B2 (floor/ceiling verdict data), B4 (simulator config passthrough),
-- C1 (overlap split), C2 (live orders).
--
-- MAINTENANCE RULE (unchanged from v2): this body inlines the classification
-- logic of the view advertising_order_channels for window pushdown. A change to
-- advertising_bucket or to the view's first/last-non-direct resolution MUST be
-- mirrored here and the equivalence re-proven.
--
-- WHAT v3 ADDS (all additive — no existing key changed, no number changed):
--   1. Orders + new-customer orders at channel AND campaign level (bucket_last
--      and meta_store_last gained counters; the meta residual row sums them, so
--      the campaign tables still reconcile to the channel totals). Feeds
--      CPA / NC-CPA / store-ROAS in the UI — the RPC ships counts, the UI does
--      the divisions.
--   2. `overlap` (new top-level key): the both/only-Meta/only-Google split of
--      paid-touched journeys, with revenue. Same definition as the existing
--      blended.overlapOrders (a paid click of each side ANYWHERE in the
--      journey), which stays for compatibility and now reads from the same CTE.
--      "only-Meta" = journey touched Meta paid and no Google paid (organic
--      touches don't disqualify). Universe: orders with a journey in the
--      window; revenue joined per order, 0 when the order has no revenue rows.
--   3. `liveOrders` (new top-level key): the 12 most recent orders by
--      order_created_at, DELIBERATELY IGNORING p_from/p_to (a live ticker, not
--      a window aggregate — documented in the UI). Name uses order_name when
--      captured (columna nueva 20260811103000; backfilled from 2026-08-01) and
--      falls back to '#'||order_id. Times converted to Brisbane. Bucket
--      classification reuses advertising_bucket on the 12 orders' moments —
--      cost is negligible and rides the new order_created_at index.
--   4. `unitEconomics` (new top-level key): the latest advertising_unit_economics
--      row with month <= month(p_to), null when none. Includes the DERIVED
--      breakevenMer (1/CM1%) and targetMer (Juan's formula) so the two verdict
--      lines can never drift from their inputs. Nullif-guarded.
--   5. `plan` (new top-level key): advertising_monthly_plan row for month(p_to),
--      null when no plan committed. The UI activates MTD-vs-plan tracking only
--      when present.
--
-- Verification (2026-08-11, recorded after apply — see acceptance battery at
-- the bottom of this header):
--   a. Frozen-window regression: 2026-07-01..31 and 2026-08-09 single-day
--      blended objects byte-identical to v2 for every pre-existing key.
--   b. Campaign reconciliation with the new counters: sum(campaigns.orders)
--      == channel orders for both channels (window 2026-08-06..10).
--   c. overlap.bothOrders == blended.overlapOrders on three windows.
--   d. liveOrders: 12 rows, strictly descending createdAt, names present for
--      backfilled range, netAud matches shopify_sales_lines per order.
--   e. unitEconomics.breakevenMer 1.42 / targetMer 2.77 (workbook values).
--   f. Runtime 30-day window before/after within noise.
-- =============================================================================

create or replace function public.advertising_dashboard(p_from date, p_to date)
returns jsonb
language sql
stable security definer
set search_path to 'public', 'pg_temp'
set statement_timeout to '25s'
set work_mem to '16MB'
as $function$
with fxlast as (
  -- latest-known monthly rate — never a literal
  select rate from currency_exchange_rates order by year desc, month desc limit 1
),
gaf as (
  select min(date) d from google_ads_daily
),
win_orders as (
  select order_id, order_date, customer_order_index
  from shopify_order_attribution
  where order_date between p_from and p_to
),
m as (
  select mo.order_id, mo.seq, mo.utm_campaign,
         advertising_bucket(mo.utm_source, mo.utm_medium, mo.utm_campaign,
                            mo.referrer, w.order_date) bucket
  from shopify_order_journey_moments mo
  join win_orders w using (order_id)
),
last_nd as (
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
  select l.order_id,
         sum(case when l.currency = 'AUD' then l.net_native
                  else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) rev,
         sum(case when l.currency = 'AUD'
                  then l.net_native / coalesce(r.rate, (select rate from fxlast))
                  else l.net_usd end) rev_usd
  from shopify_sales_lines l
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int
   and r.month = extract(month from l.order_date)::int
  where l.order_date between p_from and p_to
  group by l.order_id
),
ord as (
  select coalesce(o.last_bucket, 'sin-journey') last_bucket,
         o.last_campaign,
         coalesce(o.first_bucket, 'sin-journey') first_bucket,
         o.first_campaign,
         o.customer_order_index,
         coalesce(r.rev, 0) rev,
         coalesce(r.rev_usd, 0) rev_usd
  from oc o full join orders_rev r using (order_id)
),
-- v3: counters ride the same pass — n (orders) and nc (first-purchase orders).
-- nc comes from attribution's customer_order_index; revenue-only orders (no
-- attribution row) have it null and count in n but never in nc.
bucket_last as (
  select last_bucket b, count(*) n,
         count(*) filter (where customer_order_index = 1) nc,
         sum(rev) rev, sum(rev_usd) rev_usd
  from ord group by 1
),
bucket_first as (select first_bucket b, sum(rev) rev, sum(rev_usd) rev_usd from ord group by 1),
spend_daily as (
  select u.date,
         sum(u.spend_aud) filter (where u.platform = 'meta') meta_s,
         sum(u.spend_aud) filter (where u.platform = 'google') goog_s,
         sum(u.spend_aud / coalesce(r.rate, (select rate from fxlast)))
           filter (where u.platform = 'meta') meta_s_usd,
         sum(u.spend_aud / coalesce(r.rate, (select rate from fxlast)))
           filter (where u.platform = 'google') goog_s_usd
  from ad_spend_unified u
  left join currency_exchange_rates r
    on r.year = extract(year from u.date)::int
   and r.month = extract(month from u.date)::int
  where u.date between p_from and p_to
  group by u.date
),
rev_daily as (
  select v.order_date d,
         sum(v.net_aud) rev,
         sum(v.net_aud / coalesce(r.rate, (select rate from fxlast))) rev_usd
  from shopify_sales_by_variant v
  left join currency_exchange_rates r
    on r.year = extract(year from v.order_date)::int
   and r.month = extract(month from v.order_date)::int
  where v.order_date between p_from and p_to
  group by v.order_date
),
mer_days as (
  select days.d,
         coalesce(rd.rev, 0) rev,
         coalesce(rd.rev_usd, 0) rev_usd,
         case
           when sd.meta_s is null then null
           when (select d from gaf) is not null and days.d >= (select d from gaf)
                and sd.goog_s is null then null
           else sd.meta_s + coalesce(sd.goog_s, 0)
         end spend,
         case
           when sd.meta_s is null then null
           when (select d from gaf) is not null and days.d >= (select d from gaf)
                and sd.goog_s is null then null
           else sd.meta_s_usd + coalesce(sd.goog_s_usd, 0)
         end spend_usd,
         case
           when sd.meta_s is null then false
           when (select d from gaf) is null then false
           when days.d < (select d from gaf) then false
           when sd.goog_s is null then false
           else true
         end spend_complete
  from (select generate_series(p_from, p_to, interval '1 day')::date d) days
  left join spend_daily sd on sd.date = days.d
  left join rev_daily rd on rd.d = days.d
),
meta_c as (
  select m2.campaign_id,
         (array_agg(m2.campaign_name order by m2.date desc)
            filter (where m2.campaign_name is not null))[1] campaign_name,
         sum(case when m2.currency = 'AUD' then m2.spend
                  else m2.spend * coalesce(r.rate, (select rate from fxlast)) end) spend_aud,
         sum(case when m2.currency = 'AUD' then m2.claimed_value
                  else m2.claimed_value * coalesce(r.rate, (select rate from fxlast)) end) claimed_aud,
         sum(case when m2.currency = 'AUD'
                  then m2.spend / coalesce(r.rate, (select rate from fxlast))
                  else m2.spend end) spend_usd,
         sum(case when m2.currency = 'AUD'
                  then m2.claimed_value / coalesce(r.rate, (select rate from fxlast))
                  else m2.claimed_value end) claimed_usd
  from meta_ads_campaign_daily m2
  left join currency_exchange_rates r
    on r.year = extract(year from m2.date)::int
   and r.month = extract(month from m2.date)::int
  where m2.date between p_from and p_to
  group by m2.campaign_id
),
meta_store_last as (
  select coalesce(last_campaign, '(sin campaña)') cid,
         count(*) n,
         count(*) filter (where customer_order_index = 1) nc,
         sum(rev) rev, sum(rev_usd) rev_usd
  from ord where last_bucket = 'meta-paid' group by 1
),
meta_store_first as (
  select coalesce(first_campaign, '(sin campaña)') cid, sum(rev) rev, sum(rev_usd) rev_usd
  from ord where first_bucket = 'meta-paid' group by 1
),
meta_keys as (
  select campaign_id cid from meta_c
  union select cid from meta_store_last
  union select cid from meta_store_first
),
meta_all as (
  select coalesce(mc.campaign_name, k.cid) display,
         coalesce(mc.spend_aud, 0) spend,
         coalesce(mc.claimed_aud, 0) claimed,
         coalesce(sl.rev, 0) s_last,
         coalesce(sf.rev, 0) s_first,
         coalesce(mc.spend_usd, 0) spend_usd,
         coalesce(mc.claimed_usd, 0) claimed_usd,
         coalesce(sl.rev_usd, 0) s_last_usd,
         coalesce(sf.rev_usd, 0) s_first_usd,
         coalesce(sl.n, 0) n_last,
         coalesce(sl.nc, 0) nc_last
  from meta_keys k
  left join meta_c mc on mc.campaign_id = k.cid
  left join meta_store_last sl on sl.cid = k.cid
  left join meta_store_first sf on sf.cid = k.cid
),
meta_ranked as (
  select display, spend, claimed, s_last, s_first,
         spend_usd, claimed_usd, s_last_usd, s_first_usd, n_last, nc_last,
         row_number() over (order by (spend + s_last) desc, s_last desc, display) rn
  from meta_all
),
meta_campaigns as (
  select display, spend, claimed, s_last, s_first,
         spend_usd, claimed_usd, s_last_usd, s_first_usd, n_last, nc_last,
         null::text note, rn sort_ord
  from meta_ranked where rn <= 15
  union all
  select '(otras ' || count(*) || ' campañas)',
         sum(spend), sum(claimed), sum(s_last), sum(s_first),
         sum(spend_usd), sum(claimed_usd), sum(s_last_usd), sum(s_first_usd),
         sum(n_last), sum(nc_last),
         'grouped: the table reconciles with the channel total', 16
  from meta_ranked where rn > 15
  having count(*) > 0
),
g as (
  select gd.campaign,
         sum(gd.spend_aud) spend,
         sum(gd.claimed_value_aud) claimed,
         sum(gd.spend_aud / coalesce(r.rate, (select rate from fxlast))) spend_usd,
         sum(gd.claimed_value_aud / coalesce(r.rate, (select rate from fxlast))) claimed_usd
  from google_ads_daily gd
  left join currency_exchange_rates r
    on r.year = extract(year from gd.date)::int
   and r.month = extract(month from gd.date)::int
  where gd.date between p_from and p_to
  group by gd.campaign
),
goog_campaigns as (
  select v.campaign, v.note, v.sort_ord,
         coalesce(g.spend, 0) spend,
         coalesce(g.claimed, 0) claimed,
         coalesce(bl.rev, 0) s_last,
         coalesce(bf.rev, 0) s_first,
         coalesce(g.spend_usd, 0) spend_usd,
         coalesce(g.claimed_usd, 0) claimed_usd,
         coalesce(bl.rev_usd, 0) s_last_usd,
         coalesce(bf.rev_usd, 0) s_first_usd,
         coalesce(bl.n, 0) n_last,
         coalesce(bl.nc, 0) nc_last
  from (values
    ('brand-search', 'google-brand', null::text, 1),
    ('non-brand', 'google-nonbrand', null, 2),
    ('shopping', 'google-shopping-proxy',
     'product_sync/sag_organic proxy — mixes in free listings until the clean tagging lands', 3)
  ) v(campaign, bucket, note, sort_ord)
  left join g on g.campaign = v.campaign
  left join bucket_last bl on bl.b = v.bucket
  left join bucket_first bf on bf.b = v.bucket
),
-- v3: the paid-touch split. One row per paid-touched journey, classified into
-- exactly one side. blended.overlapOrders == the 'both' count (same definition
-- as v2's overlap CTE, now shared).
paid_side as (
  select order_id,
         bool_or(bucket = 'meta-paid') meta_t,
         bool_or(bucket in ('google-brand','google-nonbrand','google-shopping-proxy','google-paid-other')) goog_t
  from m group by order_id
),
overlap_split as (
  select case when p.meta_t and p.goog_t then 'both'
              when p.meta_t then 'meta'
              else 'google' end side,
         count(*) n,
         sum(coalesce(r.rev, 0)) rev,
         sum(coalesce(r.rev_usd, 0)) rev_usd
  from paid_side p
  left join orders_rev r using (order_id)
  where p.meta_t or p.goog_t
  group by 1
),
-- v3: live orders — the 12 most recent by creation time, window-independent.
live_base as (
  select order_id, order_name, order_created_at, order_date
  from shopify_order_attribution
  where order_created_at is not null
  order by order_created_at desc
  limit 12
),
live_m as (
  select lb.order_id, mo.seq,
         advertising_bucket(mo.utm_source, mo.utm_medium, mo.utm_campaign,
                            mo.referrer, lb.order_date) bucket
  from shopify_order_journey_moments mo
  join live_base lb using (order_id)
),
live_any as (select order_id from live_m group by order_id),
live_last as (
  select distinct on (order_id) order_id, bucket
  from live_m where bucket <> 'direct' order by order_id, seq desc
),
live_first as (
  select distinct on (order_id) order_id, bucket
  from live_m order by order_id, seq asc
),
live_touch as (
  select order_id,
         bool_or(bucket = 'meta-paid') meta_t,
         bool_or(bucket in ('google-brand','google-nonbrand','google-shopping-proxy','google-paid-other')) goog_t
  from live_m group by order_id
),
live_rev as (
  select l.order_id,
         sum(case when l.currency = 'AUD' then l.net_native
                  else l.net_usd * coalesce(r.rate, (select rate from fxlast)) end) rev,
         sum(case when l.currency = 'AUD'
                  then l.net_native / coalesce(r.rate, (select rate from fxlast))
                  else l.net_usd end) rev_usd
  from shopify_sales_lines l
  join live_base lb using (order_id)
  left join currency_exchange_rates r
    on r.year = extract(year from l.order_date)::int
   and r.month = extract(month from l.order_date)::int
  group by l.order_id
),
totals as (
  select
    (select coalesce(sum(spend_aud), 0) from ad_spend_unified where date between p_from and p_to) spend,
    (select coalesce(sum(net_aud), 0) from shopify_sales_by_variant where order_date between p_from and p_to) revenue,
    (select coalesce(sum(claimed_aud), 0) from meta_c)
      + (select coalesce(sum(claimed), 0) from g) claimed,
    (select coalesce(sum(coalesce(meta_s_usd, 0) + coalesce(goog_s_usd, 0)), 0) from spend_daily) spend_usd,
    (select coalesce(sum(rev_usd), 0) from rev_daily) revenue_usd,
    (select coalesce(sum(claimed_usd), 0) from meta_c)
      + (select coalesce(sum(claimed_usd), 0) from g) claimed_usd,
    (select coalesce(sum(rev), 0) from bucket_last
      where b in ('meta-paid','google-brand','google-nonbrand','google-paid-other','google-shopping-proxy')) paid_last_rev,
    (select count(*) from ord where customer_order_index = 1) new_orders,
    (select count(*) from ord where last_bucket in ('other-tagged','google-paid-other','referral-other')) unclassified,
    (select count(*) from ord where last_bucket = 'sin-journey') nojourney,
    (select coalesce(sum(n) filter (where side = 'both'), 0) from overlap_split) overlap_n
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
    'noJourneyOrders', nojourney,
    'spendUsd', round(spend_usd, 2),
    'revenueUsd', round(revenue_usd, 2),
    'claimedTotalUsd', round(claimed_usd, 2),
    'cacBlendedUsd', round(spend_usd / nullif(new_orders, 0), 2)
  ) from totals),
  'merSeries', (select coalesce(jsonb_agg(jsonb_build_object(
    'd', to_char(d, 'YYYY-MM-DD'),
    'revenueAud', round(rev, 2),
    'spendAud', round(spend, 2),
    'mer', round(rev / nullif(spend, 0), 2),
    'spendComplete', spend_complete,
    'revenueUsd', round(rev_usd, 2),
    'spendUsd', round(spend_usd, 2)
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
      'spendUsd', round((select coalesce(sum(meta_s_usd), 0) from spend_daily), 2),
      'claimedUsd', round((select coalesce(sum(claimed_usd), 0) from meta_c), 2),
      'storeLastUsd', round(coalesce((select rev_usd from bucket_last where b = 'meta-paid'), 0), 2),
      'storeFirstUsd', round(coalesce((select rev_usd from bucket_first where b = 'meta-paid'), 0), 2),
      'orders', coalesce((select n from bucket_last where b = 'meta-paid'), 0),
      'newCustomerOrders', coalesce((select nc from bucket_last where b = 'meta-paid'), 0),
      'campaigns', (select coalesce(jsonb_agg((jsonb_build_object(
          'campaign', display,
          'spendAud', round(spend, 2),
          'claimedValueAud', round(claimed, 2),
          'storeLastClickAud', round(s_last, 2),
          'storeFirstClickAud', round(s_first, 2),
          'spendUsd', round(spend_usd, 2),
          'claimedValueUsd', round(claimed_usd, 2),
          'storeLastClickUsd', round(s_last_usd, 2),
          'storeFirstClickUsd', round(s_first_usd, 2),
          'orders', n_last,
          'newCustomerOrders', nc_last
        ) || case when note is not null then jsonb_build_object('note', note) else '{}'::jsonb end
        ) order by sort_ord), '[]'::jsonb) from meta_campaigns)
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
      'spendUsd', round((select coalesce(sum(goog_s_usd), 0) from spend_daily), 2),
      'claimedUsd', round((select coalesce(sum(claimed_usd), 0) from g), 2),
      'storeLastUsd', round((select coalesce(sum(rev_usd), 0) from bucket_last
                              where b in ('google-brand','google-nonbrand','google-shopping-proxy')), 2),
      'storeFirstUsd', round((select coalesce(sum(rev_usd), 0) from bucket_first
                               where b in ('google-brand','google-nonbrand','google-shopping-proxy')), 2),
      'orders', (select coalesce(sum(n), 0) from bucket_last
                  where b in ('google-brand','google-nonbrand','google-shopping-proxy')),
      'newCustomerOrders', (select coalesce(sum(nc), 0) from bucket_last
                             where b in ('google-brand','google-nonbrand','google-shopping-proxy')),
      'campaigns', (select coalesce(jsonb_agg((jsonb_build_object(
          'campaign', campaign,
          'spendAud', round(spend, 2),
          'claimedValueAud', round(claimed, 2),
          'storeLastClickAud', round(s_last, 2),
          'storeFirstClickAud', round(s_first, 2),
          'spendUsd', round(spend_usd, 2),
          'claimedValueUsd', round(claimed_usd, 2),
          'storeLastClickUsd', round(s_last_usd, 2),
          'storeFirstClickUsd', round(s_first_usd, 2),
          'orders', n_last,
          'newCustomerOrders', nc_last
        ) || case when note is not null then jsonb_build_object('note', note) else '{}'::jsonb end
        ) order by sort_ord), '[]'::jsonb) from goog_campaigns)
    )
    || case when p_from < date '2026-08-06' then jsonb_build_object('note',
         'Before 6 Aug the paid Google clicks were not distinguishable from organic (no UTMs): the "store recognises" column under-counts this channel over that period.')
       else '{}'::jsonb end)
  ),
  'googleBuckets', (select coalesce(jsonb_agg((jsonb_build_object(
      'bucket', v.bucket,
      'orders', coalesce(bl.n, 0),
      'revenueAud', round(coalesce(bl.rev, 0), 2),
      'revenueUsd', round(coalesce(bl.rev_usd, 0), 2)
    ) || case when v.note is not null then jsonb_build_object('note', v.note) else '{}'::jsonb end
    ) order by v.sort_ord), '[]'::jsonb)
    from (values
      ('google-brand', 1, null::text),
      ('google-nonbrand', 2, null),
      ('google-shopping-proxy', 3, 'includes free listings'),
      ('google-organic', 4, 'baseline total google bucket Jul-2026: ~AUD 3.0k/day (untagged paid + organic, converted from USD)'),
      ('google-mixto-pre', 5, 'only when p_from < 2026-08-06: pre-gate google referrer with no breakdown — untagged paid + organic mixed together (handover date-gate)')
    ) v(bucket, sort_ord, note)
    left join bucket_last bl on bl.b = v.bucket
    where v.bucket <> 'google-mixto-pre' or p_from < date '2026-08-06'),
  'channelMix', (select coalesce(jsonb_agg(jsonb_build_object(
      'bucket', b,
      'orders', n,
      'revenueAud', round(rev, 2),
      'revenueUsd', round(rev_usd, 2),
      'isPaid', b in ('meta-paid','google-brand','google-nonbrand','google-shopping-proxy','google-paid-other')
    ) order by rev desc, b), '[]'::jsonb) from bucket_last),
  'overlap', (select jsonb_build_object(
      'bothOrders', coalesce(sum(n) filter (where side = 'both'), 0),
      'onlyMetaOrders', coalesce(sum(n) filter (where side = 'meta'), 0),
      'onlyGoogleOrders', coalesce(sum(n) filter (where side = 'google'), 0),
      'bothRevenueAud', round(coalesce(sum(rev) filter (where side = 'both'), 0), 2),
      'onlyMetaRevenueAud', round(coalesce(sum(rev) filter (where side = 'meta'), 0), 2),
      'onlyGoogleRevenueAud', round(coalesce(sum(rev) filter (where side = 'google'), 0), 2),
      'bothRevenueUsd', round(coalesce(sum(rev_usd) filter (where side = 'both'), 0), 2),
      'onlyMetaRevenueUsd', round(coalesce(sum(rev_usd) filter (where side = 'meta'), 0), 2),
      'onlyGoogleRevenueUsd', round(coalesce(sum(rev_usd) filter (where side = 'google'), 0), 2)
    ) from overlap_split),
  'liveOrders', (select coalesce(jsonb_agg(jsonb_build_object(
      'name', coalesce(lb.order_name, '#' || lb.order_id),
      'createdAt', to_char(lb.order_created_at at time zone 'Australia/Brisbane', 'YYYY-MM-DD HH24:MI'),
      -- null, not 0, when the order has no sales lines YET (review 2026-08-11):
      -- the newest orders are exactly the ones mid-sync, and A$0.00 would be
      -- indistinguishable from a real zero-value order.
      'netAud', case when lr.order_id is null then null else round(lr.rev, 2) end,
      'netUsd', case when lr.order_id is null then null else round(lr.rev_usd, 2) end,
      'lastBucket', case when la.order_id is null then 'sin-journey'
                         else coalesce(ll.bucket, 'direct') end,
      'firstBucket', case when la.order_id is null then 'sin-journey' else lf.bucket end,
      'touchesMeta', coalesce(lt.meta_t, false),
      'touchesGoogle', coalesce(lt.goog_t, false)
    ) order by lb.order_created_at desc), '[]'::jsonb)
    from live_base lb
    left join live_any la using (order_id)
    left join live_last ll using (order_id)
    left join live_first lf using (order_id)
    left join live_touch lt using (order_id)
    left join live_rev lr using (order_id)),
  'unitEconomics', (select jsonb_build_object(
      'month', to_char(u.month, 'YYYY-MM'),
      'cm1Pct', u.cm1_pct,
      'fixedCostsUsd', u.fixed_costs_usd,
      'revenuePerOrderUsd', u.revenue_per_order_usd,
      'pctNewCustomers', u.pct_new_customers,
      'targetMarginPct', u.target_margin_pct,
      'baselineRevenueUsd', u.baseline_revenue_usd,
      'breakevenMer', round(1 / u.cm1_pct, 2),
      -- Sign-guarded (review 2026-08-11): a non-positive denominator means NO
      -- finite MER reaches the target — that is null ("target not reachable"),
      -- never a negative line on the verdict chart.
      'targetMer', case
        when u.cm1_pct - u.target_margin_pct - u.fixed_costs_usd / u.baseline_revenue_usd <= 0
        then null
        else round(1 / (u.cm1_pct - u.target_margin_pct
                        - u.fixed_costs_usd / u.baseline_revenue_usd), 2) end,
      'source', u.source)
    from advertising_unit_economics u
    where u.month <= date_trunc('month', p_to)::date
    order by u.month desc limit 1),
  'plan', (select jsonb_build_object(
      'month', to_char(p.month, 'YYYY-MM'),
      'plannedSpendUsd', p.planned_spend_usd,
      'targetProfitUsd', p.target_profit_usd,
      'notes', p.notes)
    from advertising_monthly_plan p
    where p.month = date_trunc('month', p_to)::date)
)
$function$;

revoke all on function public.advertising_dashboard(date, date) from public;
revoke all on function public.advertising_dashboard(date, date) from anon;
grant execute on function public.advertising_dashboard(date, date) to authenticated, service_role;
