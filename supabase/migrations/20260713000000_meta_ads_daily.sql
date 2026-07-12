-- Meta ads, DB-first (mirrors the Unleashed/Shopify pattern). Stored per (day,
-- account) in the ACCOUNT'S native currency + currency code, so meta-export-csv
-- reproduces the manual "2-Mario-for-Danshboard.csv" byte-for-byte in meaning and
-- parse-csv-data's parseMetaData converts per-row exactly as before (no change).
--   spend + conversion_value are native; conversion_value = Meta "omni_purchase" value.
create table if not exists meta_ads_daily (
  id bigint generated always as identity primary key,
  date date not null,
  account_id text not null,
  currency text not null default 'USD',
  spend numeric not null default 0,
  conversion_value numeric not null default 0,
  synced_at timestamptz not null default now(),
  unique (date, account_id)
);
create index if not exists meta_ads_daily_date_idx on meta_ads_daily (date);
alter table meta_ads_daily enable row level security;

create table if not exists meta_ads_sync_state (
  id int primary key default 1,
  last_run_at timestamptz,
  last_run_status text,
  rows_live int,
  constraint meta_ads_sync_state_singleton check (id = 1)
);
