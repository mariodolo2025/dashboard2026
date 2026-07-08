-- Shopify shipping revenue: what customers paid us for shipping, per month ×
-- destination market, aggregated from the "Shipping by order" export. Feeds the
-- net shipping cost metric in the Freight by Market report (what we paid the
-- carrier minus what the customer covered). ex_gst matches the ex-GST Xero
-- carrier cost for a like-for-like net. Service-role only.

create table if not exists shopify_shipping_revenue_monthly (
  year int not null,
  month int not null,
  market text not null,               -- AU / US / Other
  orders int not null default 0,
  revenue_ex_gst numeric not null default 0,   -- shipping charged − discounts (ex GST)
  revenue_incl_gst numeric not null default 0, -- total shipping charged (incl GST)
  synced_at timestamptz not null default now(),
  primary key (year, month, market)
);
alter table shopify_shipping_revenue_monthly enable row level security;
