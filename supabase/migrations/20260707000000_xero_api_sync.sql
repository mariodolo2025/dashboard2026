-- Xero API sync foundation: OAuth token storage, monthly P&L cache, and
-- journal-line detail for accounts that need real breakdown (e.g. splitting
-- "Rates & Taxes" into tax remittances vs genuine property/compliance opex).
--
-- All tables are service-role only (RLS enabled, no policies): the edge
-- functions xero-oauth / xero-sync own them; the frontend consumes derived
-- data through parse-xero-costs.

create table if not exists xero_oauth_tokens (
  id int primary key default 1 check (id = 1),
  refresh_token text not null,
  tenant_id text not null,
  tenant_name text,
  updated_at timestamptz not null default now()
);
alter table xero_oauth_tokens enable row level security;

create table if not exists xero_pl_monthly (
  account_name text not null,
  year int not null,
  month int not null check (month between 1 and 12),
  amount numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (account_name, year, month)
);
alter table xero_pl_monthly enable row level security;

create table if not exists xero_account_lines (
  journal_line_id uuid primary key,
  journal_number bigint,
  journal_date date not null,
  account_name text not null,
  contact_name text,
  description text,
  net_amount numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists xero_account_lines_account_date_idx
  on xero_account_lines (account_name, journal_date);
alter table xero_account_lines enable row level security;

create table if not exists xero_sync_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table xero_sync_state enable row level security;
