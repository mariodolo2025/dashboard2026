-- =============================================================================
-- Advertising — spend & claims tables (Bloque 2)
-- =============================================================================
-- Applied as migration 'advertising_spend_tables' on 2026-08-09 via MCP.
-- Design: docs/DESIGN-ADVERTISING-TAB.md §4 Bloque 2.
-- Plan: docs/PLAN-ADVERTISING-03-GASTO.md (Task 1).
-- 2026-08-09: security_invoker=on added (migration 'ad_spend_unified_security_invoker')
-- — the view must not bypass the base tables' RLS.

-- Advertising Bloque 2 — spend & claims (spec DESIGN-ADVERTISING-TAB §4).
-- New tables only. meta_ads_daily (account level) stays untouched and remains
-- the authoritative spend total; campaign level is ADDITIVE detail.

create table public.meta_ads_campaign_daily (
  date date not null,
  account_id text not null,
  campaign_id text not null,
  campaign_name text,
  currency text,                      -- native per row, like meta_ads_daily
  spend numeric not null default 0,
  claimed_purchases numeric not null default 0,
  claimed_value numeric not null default 0,   -- omni_purchase value, native currency
  synced_at timestamptz not null default now(),
  primary key (date, account_id, campaign_id)
);
create index meta_ads_campaign_daily_date_idx on public.meta_ads_campaign_daily (date);

create table public.google_ads_daily (
  date date not null,
  -- Closed set, aligned to the store-side buckets. 'shopping' crosses against
  -- the proxy bucket product_sync/sag_organic (spec Bloque 3). NEVER free text.
  campaign text not null check (campaign in ('brand-search', 'non-brand', 'shopping')),
  spend_aud numeric,                  -- null = not loaded (never 0 for missing)
  claimed_conversions numeric,
  claimed_value_aud numeric,          -- AUD, conversion-time date (panel "Conv. value")
  source text not null default 'manual' check (source in ('manual', 'csv', 'api')),
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (date, campaign)
);
-- A DAY WITH NO ROW = "not loaded" -> the motor must render MER as null for
-- that day, never compute with partial spend (regla dura: null nunca 0).

create table public.meta_ads_campaign_sync_state (
  id int primary key default 1 check (id = 1),
  last_run_at timestamptz,
  last_run_status text,
  rows_total bigint
);

alter table public.meta_ads_campaign_daily enable row level security;
alter table public.google_ads_daily enable row level security;
alter table public.meta_ads_campaign_sync_state enable row level security;
-- Service-role writes only; future RPC reads as SECURITY DEFINER (Plan 4).

-- One AUD spend series for the motor. Meta converts USD rows at the month's
-- rate with latest-known fallback (fx_fallback_latest_known_rate convention);
-- AU rows are already AUD. Google is loaded in AUD directly.
create view public.ad_spend_unified with (security_invoker = on) as
select m.date, 'meta'::text as platform,
       sum(case when m.currency = 'USD'
                then m.spend * coalesce(r.rate, (select rate from public.currency_exchange_rates
                                                 order by year desc, month desc limit 1))
                else m.spend end) as spend_aud
from public.meta_ads_daily m
left join public.currency_exchange_rates r
       on r.year = extract(year from m.date)::int and r.month = extract(month from m.date)::int
group by m.date
union all
select g.date, 'google'::text, sum(g.spend_aud)
from public.google_ads_daily g
where g.spend_aud is not null
group by g.date;
