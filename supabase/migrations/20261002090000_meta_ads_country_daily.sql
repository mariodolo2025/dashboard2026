-- =============================================================================
-- meta_ads_country_daily — Meta spend by the country it was delivered in
-- =============================================================================
-- Mario, 2026-10-01, on DDP Markets: "no estas cargando info de ad spend para
-- UK, y tampoco estoy seguro si lo que estas poniendo como ad spend de canada
-- esta bien".
--
-- The tab guessed a market's spend from the campaign NAME ('europe%' paid for
-- DE+DK+SE, 'canada%' for CA). Meta can say where each dollar was actually
-- delivered (insights breakdowns=country), and checked against it for
-- 22-Aug -> 1-Oct-2026 the guess was wrong where it mattered:
--   * GB got A$10,506.80 from the Europe campaigns — 60% of their A$17,651 —
--     and the tab showed the UK with no spend at all.
--   * DE A$3,326.20, DK A$2,913.95, SE A$676.38, CH A$227.93 (CH is not a live
--     market). Those five add up to the Europe campaigns' total exactly.
--   * CA US$21,384.16, all of it from the CANADA campaign — that one was right.
--
-- One row per day, ad account, campaign and delivery country, in the account's
-- own currency (act_1619… bills USD, act_1919… AUD; never summed raw). Written
-- by the meta-ads-country-sync edge function: upsert only, the same rule as
-- meta_ads_campaign_daily — spend is final and a re-pull only revises it.

create table if not exists public.meta_ads_country_daily (
  date          date        not null,
  account_id    text        not null,
  campaign_id   text        not null,
  country       text        not null,
  campaign_name text,
  currency      text        not null,
  spend         numeric     not null default 0,
  synced_at     timestamptz not null default now(),
  primary key (date, account_id, campaign_id, country)
);

create index if not exists meta_ads_country_daily_country_date
  on public.meta_ads_country_daily (country, date);

comment on table public.meta_ads_country_daily is
  'Meta ad spend per day, ad account, campaign and DELIVERY country (Graph insights breakdowns=country). Native account currency per row. Written by meta-ads-country-sync (upsert only). Read by ddp_markets_dashboard for each market''s own spend and MER.';
comment on column public.meta_ads_country_daily.country is
  'ISO-2 country Meta says the spend was delivered in. Not the campaign''s target list, which can be stale.';
comment on column public.meta_ads_country_daily.spend is
  'Spend in the ad account''s currency (see currency). USD rows must be converted before adding to AUD rows.';

alter table public.meta_ads_country_daily enable row level security;

drop policy if exists "meta_ads_country_daily_read" on public.meta_ads_country_daily;
create policy "meta_ads_country_daily_read"
  on public.meta_ads_country_daily for select
  to authenticated, service_role using (true);
