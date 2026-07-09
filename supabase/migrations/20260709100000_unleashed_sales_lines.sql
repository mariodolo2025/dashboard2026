-- Unleashed sales — DB-first source of truth for the live sales dashboard,
-- replacing the manual SalesEnquiryList.csv upload.
--
-- Two segments in one table:
--   source='frozen' : history up to 2026-06-30, loaded once from the last
--                      uploaded CSV (immutable; the fiscal years close here).
--   source='api'    : OrderDate >= 2026-07-01, appended day by day by
--                      unleashed-sales-sync from the Unleashed API (upsert by
--                      the sales-order-line Guid; a synced order's lines are
--                      cleared and re-inserted so edits/deletions/status
--                      changes never duplicate or go stale).
--
-- The dashboard keeps reading a regenerated SalesEnquiryList.csv (+ a pre-parsed
-- cache) built from this table, so nothing downstream changes. Service-role only.

create table if not exists unleashed_sales_lines (
  id text primary key,               -- line Guid (api) or 'frozen-<n>' (frozen)
  order_date date not null,
  product_code text,
  product text,
  customer text,
  product_group text,
  warehouse text,
  status text,
  quantity numeric not null default 0,
  sub_total numeric not null default 0,
  customer_type text,
  source text not null,              -- 'frozen' | 'api'
  order_guid text,                   -- api: the parent order (for clear+reinsert)
  synced_at timestamptz not null default now()
);
create index if not exists unleashed_sales_lines_date_idx on unleashed_sales_lines (order_date);
create index if not exists unleashed_sales_lines_order_idx on unleashed_sales_lines (order_guid);
alter table unleashed_sales_lines enable row level security;

-- Sync watermark (last modified-date successfully pulled from the API).
create table if not exists unleashed_sales_sync_state (
  id int primary key default 1,
  last_modified_watermark timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  rows_live int,
  check (id = 1)
);
alter table unleashed_sales_sync_state enable row level security;
