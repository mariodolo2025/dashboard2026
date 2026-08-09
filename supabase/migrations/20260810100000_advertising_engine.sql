-- =============================================================================
-- Advertising — attribution engine: bucket classifier + order channels view (Bloque 3)
-- =============================================================================
-- Applied as migration 'advertising_engine' on 2026-08-10 via MCP.
-- Design: docs/DESIGN-ADVERTISING-TAB.md §4 Bloque 3.
-- Plan: docs/PLAN-ADVERTISING-04-MOTOR.md (Task 1).
--
-- Verification (2026-08-10, full table, 59,108 orders / 138,403 moments):
--   last_bucket distribution:
--     meta-paid              28171
--     google-mixto-pre       11462
--     direct                  6280
--     referral-other          5015
--     social-organic          2590
--     sin-journey             2536
--     other-tagged            1827
--     search-other             958
--     google-organic           123
--     email                     79
--     google-brand              49
--     google-shopping-proxy     12
--     google-nonbrand            6
--   null last_bucket/first_bucket: 0.
--   google-organic before 2026-08-06 (date-gate proof): 0.
--   pct_direct (view, last-non-direct model): 10.6%.
--   pct_raw_direct (literal shopify_order_attribution.last_source, contrast):
--     26.6% — confirms the model resolves well below the raw lastVisit-direct
--     share, i.e. it is finding real channels behind direct-looking closes.
--   Hand-checked 5 orders, inputs (raw moments) -> view output:
--     1. PSD#64984 order 7334339739955 (2026-08-08): seq0 google/cpc/
--        brand-search -> google-brand; seq1 facebook/paid -> meta-paid.
--        View: first_bucket=google-brand, last_bucket=meta-paid. Match.
--     2. Email closer, order 7337936421171 (2026-08-10): seq0 no utm,
--        referrer=pesado585.com checkout thank-you (self-referral) -> direct;
--        seq1 utm_source=Klaviyo utm_medium=email -> email. View:
--        first_bucket=direct, last_bucket=email, last_campaign='Cross Sell -
--        Shower Screens - BREVILLE Buyers 2026'. Match.
--     3. Google-organic closer, order 7337705177395 (2026-08-10): single
--        moment, no utm, referrer=https://www.google.com/, order_date
--        2026-08-10 (>= gate) -> google-organic. View: first_bucket=
--        google-organic, last_bucket=google-organic. Match.
--     4. All-direct journey, order 7337943302451 (2026-08-10): single
--        moment, no utm, referrer=pesado585.com/collections/portafilter
--        (self-referral) -> direct. View: first_bucket=direct, last_bucket=
--        direct (no non-direct moment exists, falls back to direct — not
--        sin-journey, since one moment does exist). Match.
--     5. Sin-journey order 7335081214259 (2026-08-09): 0 rows in
--        shopify_order_journey_moments. View: first_bucket=sin-journey,
--        last_bucket=sin-journey. Match.
--   Runtime: explain analyze select last_bucket, count(*) from
--   advertising_order_channels group by 1 -> Execution Time 1516 ms
--   (~1.5s) for the full 59k-order / 138k-moment table.

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
