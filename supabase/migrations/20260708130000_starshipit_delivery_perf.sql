-- Starshipit delivery performance: aggregated from the "Delivery Performance
-- Report" export (per-parcel tracking dates). Pre-aggregated into buckets by
-- dimension (overall / market / type / carrier / month / market_month) holding
-- counts + duration sums, so the report serves fast without touching the 66k
-- raw rows. Feeds the Shipping Performance report. Service-role only.
--
-- Metric definitions:
--   delivered %      = Delivered Date present / shipped
--   early/ontime/late = Delivered Date vs SSI Estimated Delivery Date (day),
--                       over parcels that have both (est count)
--   handling (hours) = Pickup Date − Printed Date (label ready → carrier pickup)
--   transit (days)   = Delivered Date − Pickup Date (carrier in transit)
--   total (days)     = Delivered Date − Printed Date
-- Order→ship time is deliberately excluded (pre-orders/backorders distort it).

create table if not exists starshipit_delivery_perf (
  dim text not null,        -- overall / market / type / carrier / month / market_month
  key text not null,        -- all / AU|US|Other / Domestic|International / carrier / YYYY-MM / market|YYYY-MM
  shipped numeric not null default 0,
  delivered numeric not null default 0,
  est numeric not null default 0,
  early numeric not null default 0,
  ontime numeric not null default 0,
  late numeric not null default 0,
  handle_sum numeric not null default 0,
  handle_n numeric not null default 0,
  transit_sum numeric not null default 0,
  transit_n numeric not null default 0,
  total_sum numeric not null default 0,
  total_n numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (dim, key)
);
alter table starshipit_delivery_perf enable row level security;
