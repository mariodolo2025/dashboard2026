-- FY Operations extras: Shopify order volume (from the "Orders over time" /
-- "Gross sales over time" exports, both FYs) and the B2B receivables payment
-- reference (aggregated from the Receivable Invoice Detail export, retail
-- contacts excluded). Feed the Operations view of the FY Report. Service-role.

create table if not exists shopify_orders_monthly (
  year int not null,
  month int not null,
  orders int not null default 0,
  gross_sales numeric not null default 0,
  primary key (year, month)
);
alter table shopify_orders_monthly enable row level security;

-- One row per FY. Retail (PESADO-NEW / *-OnlineSale / Shop Sale) excluded so
-- this reflects wholesale payment behaviour only. DSO is $-weighted days-to-pay.
create table if not exists xero_b2b_payment (
  fy text primary key,
  invoices int not null default 0,
  customers int not null default 0,
  total numeric not null default 0,
  avg_days numeric not null default 0,
  median_days numeric not null default 0,
  dso_days numeric not null default 0,
  ontime_pct numeric not null default 0,
  late_pct numeric not null default 0
);
alter table xero_b2b_payment enable row level security;
