-- =============================================================================
-- Advertising Bloque 3 — advertising_dashboard(p_from, p_to) RPC
-- =============================================================================
-- SUPERSEDED 2026-08-11: the deployed body now lives in
-- 20260811110000_advertising_dashboard_v3.sql (additive: orders/NC counters,
-- overlap split, liveOrders, unitEconomics, plan). This file stays as the
-- v1/v2 history and verification record.
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
--   Re-applied 2026-08-10 as `advertising_dashboard_rpc_review_fixes`, then again
--   the same day as `advertising_dashboard_usd_and_channel_mix` — see the two
--   dated blocks below. The body in this file IS the deployed body (prosrc md5
--   e179064073d58392cdecceae802c82c8, verified against pg_proc after the apply).
--
-- MAINTENANCE RULE: this body inlines the classification logic of the view
--   advertising_order_channels (for window pushdown). A change to advertising_bucket
--   or to the view's first/last-non-direct resolution MUST be mirrored here, and the
--   equivalence re-proven (per-bucket last-click revenue, RPC vs view, on a window
--   with data — the last proof was 2026-07-01..31, exact).
--
-- Plan:     ADVERTISING/plans/04-motor.md — Task 2
-- Spec:     ADVERTISING/SPEC.md §4 Bloque 3, §2 principios
-- Contract: src/components/advertising/types.ts (AdvertisingDashboard) — the RPC
--           returns EXACTLY that shape, key by key. Fixture: mockData.ts.
--
-- -----------------------------------------------------------------------------
--
-- -----------------------------------------------------------------------------
-- 2026-08-10 — USD companions, channelMix, English notes
--   (migration `advertising_dashboard_usd_and_channel_mix`)
-- -----------------------------------------------------------------------------
-- DECISION (Mario, 2026-08-10): revenue on this tab stays TAX-INCLUSIVE. The
--   figures are read against Triple Whale, which reports tax-inclusive, and that
--   comparison is the only external calibration the engine has — switching to
--   ex-tax would break it. The B2C Sales Explorer deliberately differs (ex-tax):
--   the two surfaces answer different questions and are NOT meant to tie out.
--   Nothing in this migration changed an existing number.
--
--   1. USD companion for every money figure (contract change, purely additive).
--      House convention: the dashboard renders AUD with a small (US$...) beside it
--      (B2CSalesPanel's <Usd>), so the RPC has to return both sides.
--      RULE: USD is built PER CONTRIBUTING ROW and only then summed. An
--      already-summed AUD total is never divided by a single rate, so a cross-month
--      window comes back at a revenue-weighted blended rate instead of one month's.
--      Two branches, both exact, never stacked:
--        - native-USD rows (the Meta US account): the native amount, used as-is.
--          ad_spend_unified and meta_c multiply those rows by the row's month rate
--          to make AUD, so dividing that same day by that same rate returns the
--          native USD to the cent. Proven: channels[meta].spendUsd for 2026-07 =
--          132,669.74, recomputed straight from meta_ads_daily = 132,669.74, of
--          which 72,883.58 is natively USD. No double conversion anywhere.
--        - AUD-native rows (Meta AU, all of Google, AUD Shopify lines):
--          aud / that row's month rate, with fxlast as fallback — never a literal.
--      shopify_sales_lines: the AUD branch divides; every other currency uses the
--      line's OWN net_usd, which is precisely the base the AUD figure was
--      multiplied from, so it is exact rather than a round trip.
--      New keys: blended.{spendUsd, revenueUsd, claimedTotalUsd, cacBlendedUsd};
--      merSeries[].{revenueUsd, spendUsd}; channels[].{spendUsd, claimedUsd,
--      storeLastUsd, storeFirstUsd}; channels[].campaigns[].{spendUsd,
--      claimedValueUsd, storeLastClickUsd, storeFirstClickUsd};
--      googleBuckets[].revenueUsd. Nullability mirrors each AUD twin:
--      merSeries[].spendUsd repeats the spend CASE guard for guard, so it is null
--      on EXACTLY the days spendAud is (verified 2026-08-08..current_date+3:
--      3 null / 3 null, 0 mismatches).
--      FALLBACK CAVEAT: shopify_sales_by_variant falls back to the literal 1.54
--      when a month has no rate row, while these USD figures fall back to fxlast.
--      Immaterial today (every month in range has a rate loaded) but the two would
--      diverge for a month whose rate was never loaded.
--   2. channelMix (new top-level key). The tab showed paid channels (A$10,511 on
--      2026-08-09) next to total revenue (A$18,048) with no way to see where the
--      rest came from — that reads as a contradiction rather than as a share. One
--      row per last-click bucket present in the window, ordered by revenueAud desc:
--      { bucket, orders, revenueAud, revenueUsd, isPaid }. RAW bucket keys only;
--      the UI owns the English labels. isPaid = meta-paid, google-brand,
--      google-nonbrand, google-shopping-proxy, google-paid-other.
--      INVARIANT (the acceptance test): sum(channelMix[].revenueAud) ==
--      blended.revenueAud. It holds by construction — both sides walk the same
--      `ord` universe — but the two figures are read from DIFFERENT sources
--      (shopify_sales_lines per order vs shopify_sales_by_variant), so it is a real
--      check that those two stay in agreement, not a tautology.
--   3. Notes translated to English (the tab's UI language). The brief named two;
--      the RPC can actually emit SIX, and a half-translated surface is worse than
--      an untranslated one, so all six moved. Meaning unchanged, no number touched:
--        - google channel pre-gate caveat   - shopping-proxy campaign caveat
--        - meta residual row 'grouped: ...' - googleBuckets 'includes free listings'
--        - googleBuckets google-organic baseline
--        - googleBuckets google-mixto-pre date-gate
--      Left in Spanish ON PURPOSE: the campaign DISPLAY strings '(sin campaña)' and
--      '(otras N campañas)'. '(sin campaña)' is a join key (meta_store_last.cid),
--      not a label — renaming it is a behaviour change, not a translation.
--
--   Verification (2026-08-10, immediately after apply):
--     a. channelMix reconciliation. 2026-08-09: blended 18,048.04 vs mix 18,048.05
--        (diff 0.01, 12 buckets). 2026-07-01..31: 449,641.88 vs 449,641.87
--        (diff 0.01). 2026-06-20..08-09 cross-month: 871,678.51 vs 871,678.51
--        (diff 0.00). All inside the +/-0.05 tolerance; the cent is per-row
--        rounding, not a leak. 2026-08-09 mix: meta-paid 8,311.73 (92 orders) /
--        google-organic 2,680.67 / direct 2,370.27 / google-brand 2,016.54 /
--        sin-journey 986.55 — matches the expected shape exactly.
--     b. Implied rate (revenueAud / revenueUsd). Single month 2026-08: 1.4249,
--        exactly the Aug rate. 2026-07: 1.4410, exactly the Jul rate. Cross-month
--        2026-06-20..08-09: 1.4301, a revenue-weighted blend of 1.4150 / 1.4410 /
--        1.4249. That blend is the proof the conversion is per-row, not post-hoc.
--     c. Campaign tables reconcile in USD too (2026-07 Meta): sum campaigns
--        spendUsd 132,669.75 vs channel spendUsd 132,669.74; storeLast diff 0.00 in
--        both AUD and USD; claimedUsd diff 0.01.
--     d. Existing numbers untouched. 2026-08-06..current_date measured immediately
--        BEFORE and AFTER the apply: spendAud 28,370.13, revenueAud 79,649.73,
--        mer 2.81, doubleCountRatio 1.72 — identical on both sides.
--        These differ from the values recorded earlier the same day (spend
--        25,763.59, revenue 78,200.45, mer 3.04, dcr 1.74) only because the sync
--        loaded more of 06-10 in between: the drift predates this migration and is
--        not caused by it. Frozen windows (2026-07, 2026-08-09) are unchanged.
--     e. Contract keys match types.ts exactly at every level — top 7 (channelMix
--        added); blended 14; merSeries 7; channels 11 + optional note; campaigns 9
--        + optional note; googleBuckets 4 + optional note; channelMix 5.
--     f. Runtime, 30-day window 2026-07-11..08-09: 424ms (was 427-614ms). The added
--        USD arithmetic rides the CTEs that were already being scanned, so there is
--        no new pass over the data and no regression.
--     g. SECURITY DEFINER, STABLE, proconfig {search_path=public, pg_temp,
--        statement_timeout=25s, work_mem=16MB} and the ACL
--        {postgres, authenticated, service_role} all survived the replace.
--     h. Frontend: npx tsc -b --noEmit exit 0 after the types.ts / mockData.ts
--        edits; the fixture's channelMix sums to its own blended.revenueAud
--        (236,400) so the invariant is exercised by the mock too.
-- -----------------------------------------------------------------------------
-- 2026-08-10 review fixes (migration `advertising_dashboard_rpc_review_fixes`)
-- -----------------------------------------------------------------------------
--   1. merSeries.spendComplete (new boolean, contract change). A day before
--      google_active_from (2026-06-25) carried a Meta-only MER that looked exactly
--      like a both-platform MER: 06-24 MER 2.74 → 06-25 MER 2.51 read as a
--      performance drop when it is only Google entering the denominator. true ONLY
--      when the day's spendAud covers every platform with coverage that day; false
--      when Meta-only because the day precedes google_active_from, and false when a
--      platform row is missing (those days already carry mer null).
--      Verified 2026-06-20..30: false 20→24, true 25→30 (google_active_from
--      2026-06-25). Verified 2026-08-06..10: true 06→09, false on 08-10 (Meta not
--      loaded yet for today; spend/mer null).
--   2. Meta campaigns table now reconciles. `order by spend desc limit 15` dropped
--      every store-only key — July hid '(sin campaña)' A$6,639.64 / 68 orders and
--      '{{campaign_name}}' A$3,533.87 / 41 orders, the unidentified-campaign tramo
--      the spec wants surfaced (locked decision #3) — and hid A$4,622 of spend with
--      no residual row. Now ordered by (spend + storeLastClick) desc, still limit 15,
--      plus ONE aggregate row '(otras N campañas)' summing the remainder with a note.
--      The rendered rows add up to the channel totals.
--      Verified 2026-07-01..31: Σ campaigns spendAud 191,177.09 == channel spendAud
--      191,177.09 (diff 0.00); Σ storeLastClickAud 199,068.41 == storeLastAud
--      199,068.41 (diff 0.00); Σ claimedValueAud 372,994.16 == claimedAud 372,994.16;
--      Σ storeFirstClickAud 204,732.37 vs 204,732.36 (0.01, per-row rounding).
--      16 rows: '(sin campaña)' renders at position 12; '{{campaign_name}}' falls
--      inside '(otras 15 campañas)'.
--      CAVEAT (source data, not this RPC): the spend identity holds only while the
--      two Meta tables agree. channels[meta].spendAud comes from ad_spend_unified →
--      meta_ads_daily (account level); the campaign rows come from
--      meta_ads_campaign_daily. They match to the cent through 2026-08-07, then
--      drift on the freshest days (08-08 A$0.11, 08-09 A$176.93 — Meta still
--      settling), so a window ending on the last synced day can show that residual.
--   3. channels[google].note (new optional field, contract change). For windows
--      starting before 2026-08-06 the Google channel reads as a catastrophe that is
--      arithmetically right and commercially wrong (July: spend 15,190.53, claimed
--      177,917.01, storeLast 128.25 — the paid Google clicks of that tramo live in
--      google-mixto-pre, outside the paid denominator). The caveat existed only on a
--      googleBuckets row; now it travels with the channel. No number changed.
--      Verified: note present for 2026-07-01..31, absent for 2026-08-06..10.
--   4. SECURITY DEFINER search_path now includes pg_temp.
--      NOTE: written `set search_path to 'public', 'pg_temp'` — two quoted elements,
--      NOT the single string 'public, pg_temp'. In a function SET clause the
--      single-string form is stored verbatim as one schema name
--      (proconfig `search_path="public, pg_temp"`) and the function stops resolving
--      public relations altogether (CREATE fails: relation
--      "currency_exchange_rates" does not exist). Probed both forms before applying.
--      Deployed proconfig: {search_path=public, pg_temp, statement_timeout=25s,
--      work_mem=16MB}.
--   Post-fix re-verification: contract keys unchanged apart from the two additions
--   (top [blended, channels, from, googleBuckets, merSeries, to]; blended 10 keys;
--   merSeries [d, mer, revenueAud, spendAud, spendComplete]; channels 7 keys + note
--   on google pre-gate; campaigns 5 keys + optional note; googleBuckets
--   [bucket, orders, revenueAud] + optional note). Conservation 2026-07-01..31:
--   all-bucket last-click revenue 449,641.88 == window revenue 449,641.88
--   (diff 0.00, 4,304 orders). Runtime 30-day windows: 2026-07-01..30 427ms;
--   2026-07-11..08-09 614ms (previous record 1.23s). Frontend typecheck
--   `npx tsc -b --noEmit` exit 0 after the types.ts/mockData.ts contract edits.
-- -----------------------------------------------------------------------------
--
-- Acceptance battery (2026-08-10, window 2026-08-06 → current_date unless noted):
--   a. Contract keys — exact match, no extras/missing (re-run after the review
--      fixes, see above).
--   b. Conservation — sum of ALL last-click bucket revenues == window total
--      from the same per-order source: 66,684.90 == 66,684.90 (diff 0.00,
--      634 orders). 12-month window: 6,120,131.49 == 6,120,131.49 (diff 0.00).
--   c. merSeries length == days in window (4 == 4; 12-month 366 == 366).
--      Google rule + spendComplete: days before google_active_from → meta-only
--      spend, spendComplete false; days on/after without a google row → spend and
--      mer null (never 0), spendComplete false.
--   d. blended.revenueAud == E-commerce figure (shopify_sales_by_variant
--      net_aud): 66,684.90 both. PASS.
--   e. Runtime (explain analyze): ('2026-08-06', current_date) 80ms;
--      true 30-day window 0.4–0.6s (< 2s target, PASS);
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
set search_path to 'public', 'pg_temp'
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
  -- per-order net AUD over the window (native AUD exact; USD x monthly rate, fxlast fallback).
  -- USD companion (2026-08-10): AUD branch = aud / that row's month rate; every other
  -- currency uses the line's OWN net_usd, which is the exact base the AUD figure was
  -- multiplied from — no double conversion, no rate applied twice.
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
  -- attribution universe: every order with revenue and/or journey in the window.
  -- Sales orders absent from attribution entirely count as 'sin-journey' (capture gap).
  select coalesce(o.last_bucket, 'sin-journey') last_bucket,
         o.last_campaign,
         coalesce(o.first_bucket, 'sin-journey') first_bucket,
         o.first_campaign,
         o.customer_order_index,
         coalesce(r.rev, 0) rev,
         coalesce(r.rev_usd, 0) rev_usd
  from oc o full join orders_rev r using (order_id)
),
bucket_last as (select last_bucket b, count(*) n, sum(rev) rev, sum(rev_usd) rev_usd from ord group by 1),
bucket_first as (select first_bucket b, sum(rev) rev, sum(rev_usd) rev_usd from ord group by 1),
spend_daily as (
  -- USD companion: ad_spend_unified already multiplied the Meta US (USD) rows by the
  -- row's month rate, so dividing that same day by that same rate returns the NATIVE
  -- USD to the cent. Meta AU and Google are AUD-native: their USD is aud / month rate.
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
  -- USD per DAY (a day never straddles two monthly rates), summed — never one rate
  -- applied to an already-summed window total.
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
  -- spend rule (locked): meta missing -> null; day >= google_active_from without a
  -- loaded google spend row -> null; otherwise meta (+ google when loaded).
  -- google_active_from null (Google not started) -> meta-only MER. Null never 0.
  -- spendComplete (review 2026-08-10): true ONLY when the day's spend covers every
  -- platform with coverage that day. Days before google_active_from are Meta-only by
  -- construction (Google did not exist yet) -> false, so a one-platform MER is never
  -- read as comparable to a both-platform one. Days with a platform row missing
  -- (spend/mer already null) -> false too.
  -- spend_usd mirrors the spend case guard for guard, so spendUsd is null on exactly
  -- the same days as spendAud.
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
  -- Meta campaign spend/claims in NATIVE currency per row: convert USD only (no double conversion).
  -- USD companion: the USD rows ARE native USD (used as-is, exact); the AUD rows are
  -- divided by that row's month rate.
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
  select coalesce(last_campaign, '(sin campaña)') cid, sum(rev) rev, sum(rev_usd) rev_usd
  from ord where last_bucket = 'meta-paid' group by 1
),
meta_store_first as (
  select coalesce(first_campaign, '(sin campaña)') cid, sum(rev) rev, sum(rev_usd) rev_usd
  from ord where first_bucket = 'meta-paid' group by 1
),
meta_keys as (
  -- campaign present in the window: platform spend/claims OR store-recognised revenue
  select campaign_id cid from meta_c
  union select cid from meta_store_last
  union select cid from meta_store_first
),
meta_all as (
  -- display = campaign_name (latest known); store side joins utm campaign_id::text.
  -- Unmatched store keys (e.g. the {{campaign_name}} literal tramo) fall back to the raw key.
  select coalesce(mc.campaign_name, k.cid) display,
         coalesce(mc.spend_aud, 0) spend,
         coalesce(mc.claimed_aud, 0) claimed,
         coalesce(sl.rev, 0) s_last,
         coalesce(sf.rev, 0) s_first,
         coalesce(mc.spend_usd, 0) spend_usd,
         coalesce(mc.claimed_usd, 0) claimed_usd,
         coalesce(sl.rev_usd, 0) s_last_usd,
         coalesce(sf.rev_usd, 0) s_first_usd
  from meta_keys k
  left join meta_c mc on mc.campaign_id = k.cid
  left join meta_store_last sl on sl.cid = k.cid
  left join meta_store_first sf on sf.cid = k.cid
),
meta_ranked as (
  -- relevance = spend + what the store recognises (review 2026-08-10). Ordering by
  -- spend alone hid every store-only key — '(sin campaña)' and the '{{campaign_name}}'
  -- literal tramo — which is precisely the unidentified-campaign tramo the spec wants
  -- surfaced (locked decision #3).
  select display, spend, claimed, s_last, s_first,
         spend_usd, claimed_usd, s_last_usd, s_first_usd,
         row_number() over (order by (spend + s_last) desc, s_last desc, display) rn
  from meta_all
),
meta_campaigns as (
  -- top 15 + ONE residual row: the rendered rows always add up to the channel totals,
  -- so the table can be reconciled against channels[0] (review 2026-08-10).
  select display, spend, claimed, s_last, s_first,
         spend_usd, claimed_usd, s_last_usd, s_first_usd, null::text note, rn sort_ord
  from meta_ranked where rn <= 15
  union all
  select '(otras ' || count(*) || ' campañas)',
         sum(spend), sum(claimed), sum(s_last), sum(s_first),
         sum(spend_usd), sum(claimed_usd), sum(s_last_usd), sum(s_first_usd),
         'grouped: the table reconciles with the channel total', 16
  from meta_ranked where rn > 15
  having count(*) > 0
),
g as (
  -- Google is AUD-native (manual panel load): USD = aud / that row's month rate.
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
  -- exactly the closed enum, mapped to its bucket; rows present even with no data
  select v.campaign, v.note, v.sort_ord,
         coalesce(g.spend, 0) spend,
         coalesce(g.claimed, 0) claimed,
         coalesce(bl.rev, 0) s_last,
         coalesce(bf.rev, 0) s_first,
         coalesce(g.spend_usd, 0) spend_usd,
         coalesce(g.claimed_usd, 0) claimed_usd,
         coalesce(bl.rev_usd, 0) s_last_usd,
         coalesce(bf.rev_usd, 0) s_first_usd
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
    -- USD twins: summed from the per-day / per-row CTEs above, never from the AUD total
    (select coalesce(sum(coalesce(meta_s_usd, 0) + coalesce(goog_s_usd, 0)), 0) from spend_daily) spend_usd,
    (select coalesce(sum(rev_usd), 0) from rev_daily) revenue_usd,
    (select coalesce(sum(claimed_usd), 0) from meta_c)
      + (select coalesce(sum(claimed_usd), 0) from g) claimed_usd,
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
      -- spendUsd: recovered per day from ad_spend_unified (US account rows return to
      -- their native USD exactly); claimedUsd: meta_c, native USD rows used as-is.
      'spendUsd', round((select coalesce(sum(meta_s_usd), 0) from spend_daily), 2),
      'claimedUsd', round((select coalesce(sum(claimed_usd), 0) from meta_c), 2),
      'storeLastUsd', round(coalesce((select rev_usd from bucket_last where b = 'meta-paid'), 0), 2),
      'storeFirstUsd', round(coalesce((select rev_usd from bucket_first where b = 'meta-paid'), 0), 2),
      'campaigns', (select coalesce(jsonb_agg((jsonb_build_object(
          'campaign', display,
          'spendAud', round(spend, 2),
          'claimedValueAud', round(claimed, 2),
          'storeLastClickAud', round(s_last, 2),
          'storeFirstClickAud', round(s_first, 2),
          'spendUsd', round(spend_usd, 2),
          'claimedValueUsd', round(claimed_usd, 2),
          'storeLastClickUsd', round(s_last_usd, 2),
          'storeFirstClickUsd', round(s_first_usd, 2)
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
      -- Google is AUD-native everywhere: every USD figure here is aud / month rate.
      'spendUsd', round((select coalesce(sum(goog_s_usd), 0) from spend_daily), 2),
      'claimedUsd', round((select coalesce(sum(claimed_usd), 0) from g), 2),
      'storeLastUsd', round((select coalesce(sum(rev_usd), 0) from bucket_last
                              where b in ('google-brand','google-nonbrand','google-shopping-proxy')), 2),
      'storeFirstUsd', round((select coalesce(sum(rev_usd), 0) from bucket_first
                               where b in ('google-brand','google-nonbrand','google-shopping-proxy')), 2),
      'campaigns', (select coalesce(jsonb_agg((jsonb_build_object(
          'campaign', campaign,
          'spendAud', round(spend, 2),
          'claimedValueAud', round(claimed, 2),
          'storeLastClickAud', round(s_last, 2),
          'storeFirstClickAud', round(s_first, 2),
          'spendUsd', round(spend_usd, 2),
          'claimedValueUsd', round(claimed_usd, 2),
          'storeLastClickUsd', round(s_last_usd, 2),
          'storeFirstClickUsd', round(s_first_usd, 2)
        ) || case when note is not null then jsonb_build_object('note', note) else '{}'::jsonb end
        ) order by sort_ord), '[]'::jsonb) from goog_campaigns)
    )
    -- pre-gate caveat (review 2026-08-10): before 2026-08-06 the paid Google clicks
    -- were not distinguishable from organic (no UTMs) and land in google-mixto-pre,
    -- outside this channel's storeLast. Numbers unchanged; the caveat now travels
    -- with the channel instead of hiding on a googleBuckets row.
    -- English since 2026-08-10 (the tab's UI language); meaning unchanged.
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
  -- channelMix (2026-08-10): every last-click bucket in the window, paid and unpaid,
  -- so the tab reconciles on screen — the paid channels are a SLICE of total revenue,
  -- not a rival figure. INVARIANT: sum(channelMix[].revenueAud) == blended.revenueAud.
  -- Raw bucket keys only; the UI owns the English labels.
  'channelMix', (select coalesce(jsonb_agg(jsonb_build_object(
      'bucket', b,
      'orders', n,
      'revenueAud', round(rev, 2),
      'revenueUsd', round(rev_usd, 2),
      'isPaid', b in ('meta-paid','google-brand','google-nonbrand','google-shopping-proxy','google-paid-other')
    ) order by rev desc, b), '[]'::jsonb) from bucket_last)
)
$function$;

-- Access posture: the definer RPC is the gate over ad-spend data; the anon key
-- must not read spend (agujero real 2026-08-09, spec §8).
revoke all on function public.advertising_dashboard(date, date) from public;
revoke all on function public.advertising_dashboard(date, date) from anon;
grant execute on function public.advertising_dashboard(date, date) to authenticated, service_role;
