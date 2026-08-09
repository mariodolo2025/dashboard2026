# Advertising Tab — Plan 4: Attribution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The brain: buckets over raw journeys, last-non-direct and first-click models, MER, overlap, claimed-vs-actual — exposed as ONE RPC returning exactly the shape the mockup already renders (spec Bloque 3; contract: `src/components/advertising/mockData.ts`).

**Architecture:** One IMMUTABLE classifier function (`advertising_bucket`) — single source of truth for both models. One helper view (`advertising_order_channels`, `security_invoker=on`) computing per-order first/last-non-direct buckets from the raw moments — reused by the RPC and by every acceptance query. One SECURITY DEFINER RPC (`advertising_dashboard(p_from, p_to)`) assembling the contract JSON. Read-only over existing tables; only new objects.

**Tech Stack:** Postgres (SQL function + view + RPC via MCP `apply_migration`). No edge functions, no frontend in this plan (tab wiring = Plan 5).

**Branch:** `feat/advertising-tab`.

**Locked decisions (from spec + review history — do not re-litigate):**
- Last click principal = último momento **no-directo** (paridad Shopify Analytics). "Directo" = un momento cuyo bucket resuelve `direct`.
- Date-gate: referrer google **sin UTM** antes de 2026-08-06 → bucket `google-mixto-pre` (jamás "orgánico").
- `{{campaign_name}}` literal → bucket Meta pago igual (source/medium válidos); la campaña queda no-identificada solo en el cruce por campaña.
- MER: días sin fila de Google en `google_ads_daily` a partir de `google_active_from` (primera fila cargada) → **null, nunca 0**. Días ANTERIORES a `google_active_from` → MER = ventas ÷ gasto Meta, marcado `spendComplete: false` (no existía gasto Google que cargar; esperar a Juan no puede dejar 13 meses de MER en blanco).
- Dinero: net ex tax AUD, la misma cifra del tab E-commerce (`shopify_sales_by_variant.net_aud` para totales; por orden = suma de sus líneas con la convención AUD nativa + mensual con fallback última tasa).

---

### Task 1: Migration — classifier + per-order channels view

**Files:**
- Create (doc): `supabase/migrations/20260810100000_advertising_engine.sql`
- Apply via MCP `apply_migration`, name `advertising_engine`

- [ ] **Step 1.1: Apply**

```sql
-- Advertising Bloque 3 — the engine's foundations (spec §4 Bloque 3).
-- advertising_bucket is THE single classifier: both models, every acceptance
-- query, and the RPC call this one function. Changing taxonomy = changing it
-- here only, and everything recomputes at read time (spec principio 4).

create or replace function public.advertising_bucket(
  p_source text, p_medium text, p_campaign text, p_referrer text, p_date date
) returns text
language sql immutable as $$
  select case
    -- Meta pago (fb|facebook|ig; el {{campaign_name}} roto sigue siendo Meta pago)
    when lower(coalesce(p_source, '')) in ('facebook', 'fb', 'ig')
     and lower(coalesce(p_medium, '')) = 'paid' then 'meta-paid'
    -- Google pago por UTM (existe desde 2026-08-06; si apareciera antes, se
    -- clasifica igual — es un click real etiquetado)
    when lower(coalesce(p_source, '')) = 'google' and lower(coalesce(p_medium, '')) = 'cpc' then
      case coalesce(p_campaign, '')
        when 'brand-search' then 'google-brand'
        when 'non-brand' then 'google-nonbrand'
        else 'google-paid-other'
      end
    -- Shopping proxy: tag del feed del canal Google & YouTube (mezcla free
    -- listings; impureza documentada, tagueo limpio post test de click)
    when lower(coalesce(p_source, '')) = 'google'
     and lower(coalesce(p_medium, '')) = 'product_sync' then 'google-shopping-proxy'
    -- Email (Klaviyo etiqueta source=Klaviyo medium=email)
    when lower(coalesce(p_medium, '')) = 'email'
      or lower(coalesce(p_source, '')) = 'klaviyo' then 'email'
    -- Social orgánico etiquetado (ig/fb medium=social)
    when lower(coalesce(p_source, '')) in ('facebook', 'fb', 'ig', 'instagram') then 'social-organic'
    -- Cualquier otro UTM presente → otros-tagged
    when coalesce(p_source, '') <> '' or coalesce(p_medium, '') <> '' then 'other-tagged'
    -- ── Sin UTM: clasifica el referrer ──
    when p_referrer is null or btrim(p_referrer) = '' then 'direct'
    when p_referrer ilike '%google.%' then
      case when p_date >= date '2026-08-06' then 'google-organic' else 'google-mixto-pre' end
    when p_referrer ilike '%facebook.%' or p_referrer ilike '%instagram.%'
      or p_referrer ilike '%l.facebook%' or p_referrer ilike '%l.instagram%' then 'social-organic'
    when p_referrer ilike '%bing.%' or p_referrer ilike '%duckduckgo.%'
      or p_referrer ilike '%yahoo.%' or p_referrer ilike '%ecosia.%' then 'search-other'
    when p_referrer ilike '%pesado585.com%' or p_referrer ilike '%shop.app%'
      or p_referrer ilike '%shopify.com%' then 'direct'   -- self/checkout referrals
    else 'referral-other'
  end
$$;

-- Per-order channel resolution from the RAW moments. One row per attributed
-- order: the first visit's bucket and the last NON-DIRECT visit's bucket
-- (falling back to 'direct' when every visit is direct, 'sin-journey' when
-- the journey is empty). security_invoker=on: the view must not bypass the
-- base tables' RLS (regla de la spec, agujero real encontrado 2026-08-09).
create view public.advertising_order_channels
with (security_invoker = on) as
with m as (
  select mo.order_id, mo.seq, mo.occurred_at,
         mo.utm_source, mo.utm_medium, mo.utm_campaign, mo.utm_content, mo.referrer,
         a.order_date,
         public.advertising_bucket(mo.utm_source, mo.utm_medium, mo.utm_campaign,
                                   mo.referrer, a.order_date) as bucket
  from public.shopify_order_journey_moments mo
  join public.shopify_order_attribution a using (order_id)
),
last_nd as (
  select distinct on (order_id) order_id, bucket, utm_campaign, utm_content
  from m where bucket <> 'direct'
  order by order_id, seq desc
),
first_v as (
  select distinct on (order_id) order_id, bucket, utm_campaign, utm_content
  from m order by order_id, seq asc
),
any_moment as (
  select order_id, count(*) n from m group by order_id
)
select a.order_id, a.order_date, a.customer_order_index, a.days_to_conversion,
       case when am.order_id is null then 'sin-journey'
            else coalesce(ln.bucket, 'direct') end as last_bucket,
       ln.utm_campaign as last_campaign, ln.utm_content as last_content,
       case when am.order_id is null then 'sin-journey'
            else fv.bucket end as first_bucket,
       fv.utm_campaign as first_campaign
from public.shopify_order_attribution a
left join any_moment am on am.order_id = a.order_id
left join last_nd ln on ln.order_id = a.order_id
left join first_v fv on fv.order_id = a.order_id;
```

- [ ] **Step 1.2: Verify — the classifier against reality (acceptance, not vibes)**

```sql
-- every order resolves; bucket distribution sane; NO nulls
select last_bucket, count(*) from advertising_order_channels group by 1 order by 2 desc;
select count(*) from advertising_order_channels where last_bucket is null or first_bucket is null; -- 0
-- date-gate proof: google-organic must not exist before 2026-08-06
select count(*) from advertising_order_channels
 where last_bucket = 'google-organic' and order_date < '2026-08-06';  -- 0
-- direct share sanity: last_bucket='direct' should be well under the raw
-- lastVisit-direct share (~15-20%) because the model skips direct closers
select round(100.0 * count(*) filter (where last_bucket = 'direct') / count(*), 1) pct_direct
from advertising_order_channels;
-- spot-check 5 known orders by hand (e.g. PSD#64984's order: first google-brand, last meta-paid)
```

- [ ] **Step 1.3: Repo doc + commit** (`feat(advertising): attribution engine — bucket classifier + order channels view`)

---

### Task 2: The RPC `advertising_dashboard(p_from, p_to)`

**Files:**
- Create (doc): `supabase/migrations/20260810110000_advertising_dashboard_rpc.sql`
- Apply via MCP, name `advertising_dashboard_rpc`

Returns jsonb with EXACTLY the mockData.ts contract keys: `{ from, to, blended{spendAud, revenueAud, mer, claimedTotalAud, doubleCountRatio, overlapOrders, cacBlended, newCustomerOrders, unclassifiedOrders, noJourneyOrders}, merSeries[{d, revenueAud, spendAud, mer}], channels[{key,label,spendAud,claimedAud,storeLastAud,storeFirstAud,campaigns[{campaign,spendAud,claimedValueAud,storeLastClickAud,storeFirstClickAud,note?}]}], googleBuckets[{bucket,orders,revenueAud,note?}] }`

- [ ] **Step 2.1: Apply** — full body (SECURITY DEFINER, `SET statement_timeout '25s'`, `SET work_mem '16MB'`, `SET search_path public`):

Key internals (write them exactly like this):
- `fxlast` CTE (latest-known rate — never a literal).
- `orders_rev` CTE: per-order net AUD over the window (native AUD exact, USD × monthly rate with fxlast fallback) from `shopify_sales_lines`.
- `oc` CTE: `advertising_order_channels` join `orders_rev`, window-filtered.
- `google_active_from` = `(select min(date) from google_ads_daily)`.
- `merSeries`: generate_series day × revenue (from `shopify_sales_by_variant.net_aud` grouped by day) × spend: meta from `ad_spend_unified` platform meta; google from platform google; `spendAud = meta + google` when google row exists OR day < google_active_from (then meta alone); `mer = revenueAud / spendAud` (null when day >= google_active_from and google row missing, or google_active_from is null and... if google_active_from is null → NO google data at all yet → meta-only MER for all days, spendComplete=false semantics).
- `blended`: sums over the window with the same google rule; `claimedTotalAud` = Meta claimed (meta_ads_campaign_daily claimed_value converted) + Google claimed (google_ads_daily.claimed_value_aud); `doubleCountRatio` = claimedTotal ÷ (storeLast meta-paid + google pagos); `overlapOrders` = orders whose moments contain BOTH a meta-paid AND a google-paid bucket anywhere in the journey (moment-based, per handover); `cacBlended` = spend ÷ orders with customer_order_index = 1; `unclassifiedOrders` = last_bucket in ('other-tagged','google-paid-other','referral-other'); `noJourneyOrders` = last_bucket = 'sin-journey'.
- `channels`: meta = {spend: ad_spend_unified meta; claimed: Σ meta_ads_campaign_daily claimed_value AUD-converted; storeLast: Σ oc.net where last_bucket='meta-paid'; storeFirst: same first_bucket; campaigns: per campaign_id join meta_ads_campaign_daily (name from there; spend/claimed native→AUD) vs store last/first by oc.last_campaign/first_campaign}. google = {spend/claimed from google_ads_daily; storeLast: Σ where last_bucket in ('google-brand','google-nonbrand','google-shopping-proxy'); campaigns: the enum three, mapping brand-search→google-brand, non-brand→google-nonbrand, shopping→google-shopping-proxy (note del proxy)}.
- `googleBuckets`: the 4 rows (brand/nonbrand/shopping-proxy/organic) + `google-mixto-pre` when the window crosses the gate, orders + revenue, with the baseline note.
- Round money to whole AUD except ratios (2 decimals), matching the mock's magnitudes.

- [ ] **Step 2.2: Acceptance (spec §9 — executable)**

```sql
-- 1. Contract: every key present, exactly (compare vs the TS interface list)
select jsonb_object_keys(advertising_dashboard('2026-08-06', current_date));
-- 2. Conservation: channel storeLast sums + all other buckets = total window revenue (±rounding)
-- 3. merSeries day count == window days; days with google missing and >= google_active_from → mer null
-- 4. blended.revenueAud == E-commerce tab revenue for same window (same source figure)
-- 5. runtime < 2s for 30 days (explain analyze)
```
Plus the Shopify Analytics cross-check: attempt via the Shopify MCP analytics tool (ShopifyQL `FROM sales SHOW total_sales ... GROUP BY utm_campaign...` if the schema allows utm dims); if ShopifyQL cannot express it, document that the reconciliation runs manually against the Admin "Sales attributed to marketing" report with Mario (tolerance ±2%, spec §9) and record it as a Plan 5 checkpoint.

- [ ] **Step 2.3: Repo doc + commit** (`feat(advertising): advertising_dashboard RPC — the engine behind the tab`)

---

### Task 3: Engine calibration report (vs TW + internals)

- [ ] **Step 3.1:** Produce (as SQL outputs pasted into the migration doc header):
  - last-click channel split for the comparable window (6-ago → hoy) — the numbers Mario will see;
  - vs Triple Whale's free dashboard figures for the same window (Mario reads TW; we record OUR numbers and the known convention differences — TW MER inverted, TW includes view-through);
  - the 5 hand-checked orders (inputs → expected bucket → view output).
- [ ] **Step 3.2:** Commit doc updates (`docs(advertising): engine calibration figures`).

---

## Self-review (done at write time)

- **Spec Bloque 3 coverage:** buckets (con date-gate y normalización fb|ig), last no-directo desde moments (paridad Analytics), first click, MER con la regla google_active_from, overlap momento-based, claimed vs actual por campaña (Meta por ID, Google por enum→bucket), contadores. El RPC devuelve el contrato de la maqueta clave por clave.
- **Placeholders:** Task 2 da la estructura exacta y las fórmulas de cada bloque; el implementador escribe el SQL final y la aceptación §2.2 lo verifica contra invariantes ejecutables (conservación, contrato, paridad con E-commerce). Los criterios son objetivos.
- **Type consistency:** buckets del classifier == buckets leídos por la view == buckets usados por el RPC == enum de google_ads_daily mapeado explícito.
