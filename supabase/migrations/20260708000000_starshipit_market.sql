-- Starshipit market data: monthly shipping cost by carrier × destination
-- market, aggregated from the uploaded "Shipping Price Report". Feeds the
-- Freight by Market report and the outbound-B2C market reallocation in
-- parse-xero-costs (Australia Post etc. ship to AU AND US; Starshipit knows
-- the real split, Xero only knows the carrier). Service-role only.

create table if not exists starshipit_market_monthly (
  year int not null,
  month int not null,
  carrier text not null,          -- raw carrier name (for the report)
  carrier_key text not null,      -- canonical: auspost / dhl_ecommerce / ups / dhl_express / other
  market text not null,           -- AU / US / Other
  orders int not null default 0,
  freight_charge numeric not null default 0,  -- what we paid the carrier
  price_quoted numeric not null default 0,     -- what the app quoted
  synced_at timestamptz not null default now(),
  primary key (year, month, carrier, market)
);
alter table starshipit_market_monthly enable row level security;
