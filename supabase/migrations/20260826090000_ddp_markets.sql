-- =============================================================================
-- DDP Markets — per-order reconciliation for the DDP European markets
-- (Germany, Denmark, Switzerland; window opens 2026-08-01 with the markets).
--
-- One row per Shopify order, three sources side by side:
--   charged_*  what the customer paid at checkout        (Shopify, shop USD → AUD)
--   freight_*  what the label really cost                (Starshipit, AUD)
--   zonos_*    what ZONOS billed us for duty/tax/fees    (ZONOS API, AUD)
--
-- Currency: everything lands in AUD. Shopify amounts are taken from shop_money
-- (the store operates in USD) and converted with the monthly USD→AUD rate in
-- currency_exchange_rates — the same convention as the rest of the dashboard.
-- The native presentment amounts are kept alongside for reference, never summed.
--
-- Write pattern: ddp-sync runs three passes and each pass touches ONLY its own
-- columns (Shopify upsert, then Starshipit UPDATE, then ZONOS UPDATE) — a full-row
-- upsert would null out the other sources' columns (the PostgREST trap that once
-- wiped 753 costs). Rows are never deleted.
-- =============================================================================

create table if not exists ddp_shipments (
  shopify_order_id bigint primary key,
  order_name text not null,
  order_date timestamptz not null,
  country_code text not null,               -- DE / DK / CH
  presentment_currency text,

  -- charged to the customer (AUD; fx_rate = USD→AUD of the order month)
  subtotal_aud numeric,
  charged_shipping_aud numeric,
  charged_duties_aud numeric,
  charged_taxes_aud numeric,
  charged_shipping_native numeric,
  charged_duties_native numeric,
  charged_taxes_native numeric,
  fx_rate numeric,

  tracking_number text,

  -- Starshipit (label cost, AUD)
  freight_cost_aud numeric,
  ss_order_id bigint,
  ss_carrier text,
  freight_matched_at timestamptz,

  -- ZONOS (billed to Dolo, AUD)
  zonos_duty_aud numeric,
  zonos_tax_aud numeric,
  zonos_fee_aud numeric,
  zonos_matched_at timestamptz,

  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ddp_shipments_date_idx on ddp_shipments (order_date);
create index if not exists ddp_shipments_tracking_idx on ddp_shipments (tracking_number);

-- ZONOS rows the sync could not match to any local order — surfaced in the
-- "needs attention" panel. Derived cache: fully rebuilt on every sync (this is
-- NOT stock/movement data, replacing it is safe).
create table if not exists ddp_zonos_unmatched (
  tracking_number text primary key,
  country_code text,
  zonos_duty_aud numeric,
  zonos_tax_aud numeric,
  zonos_fee_aud numeric,
  zonos_created_at timestamptz,
  seen_at timestamptz not null default now()
);

alter table ddp_shipments enable row level security;
alter table ddp_zonos_unmatched enable row level security;
create policy "service role only" on ddp_shipments for all to service_role using (true) with check (true);
create policy "service role only" on ddp_zonos_unmatched for all to service_role using (true) with check (true);

-- =============================================================================
-- ddp_markets_dashboard(p_from, p_to) — one jsonb for the whole tab.
-- Dates are STORE days (Australia/Brisbane), matching the sales convention.
-- "Matched" = the order has both a freight cost and a ZONOS record; net absorbed
-- and recovery are computed over matched orders only, so a half-synced order
-- never distorts the verdict.
-- =============================================================================
create or replace function ddp_markets_dashboard(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
with base as (
  select *,
    (order_date at time zone 'Australia/Brisbane')::date as day,
    coalesce(charged_shipping_aud,0) + coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0) as charged_total,
    coalesce(freight_cost_aud,0) + coalesce(zonos_duty_aud,0) + coalesce(zonos_tax_aud,0) + coalesce(zonos_fee_aud,0) as paid_total,
    (freight_cost_aud is not null and zonos_matched_at is not null) as matched
  from ddp_shipments
  where (order_date at time zone 'Australia/Brisbane')::date between p_from and p_to
),
m as (select * from base where matched),
kpis as (
  select jsonb_build_object(
    'orders', (select count(*) from base),
    'matchedOrders', (select count(*) from m),
    'byCountry', (select coalesce(jsonb_object_agg(country_code, n), '{}'::jsonb)
                  from (select country_code, count(*) as n from base group by 1) c),
    'revenue', (select round(coalesce(sum(subtotal_aud),0)) from base),
    'chargedTotal', (select round(coalesce(sum(charged_total),0)) from base),
    'chargedShipping', (select round(coalesce(sum(charged_shipping_aud),0)) from base),
    'chargedDuties', (select round(coalesce(sum(charged_duties_aud),0)) from base),
    'chargedTaxes', (select round(coalesce(sum(charged_taxes_aud),0)) from base),
    'paidTotal', (select round(coalesce(sum(paid_total),0)) from base),
    'paidFreight', (select round(coalesce(sum(freight_cost_aud),0)) from base),
    'paidZonosDT', (select round(coalesce(sum(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)),0)) from base),
    'paidZonosFees', (select round(coalesce(sum(zonos_fee_aud),0)) from base),
    'netAbsorbed', (select round(coalesce(sum(charged_total - paid_total),0)) from m),
    'netPerOrder', (select round(coalesce(avg(charged_total - paid_total),0), 2) from m),
    'recoveryPct', (select case when coalesce(sum(paid_total),0) = 0 then null
                    else round(100.0 * sum(charged_total) / sum(paid_total), 1) end from m)
  ) as j
),
components as (
  select jsonb_build_array(
    jsonb_build_object('key','shipping',
      'charged', round(coalesce(sum(charged_shipping_aud),0)),
      'paid',    round(coalesce(sum(freight_cost_aud),0)),
      'gap',     round(coalesce(sum(coalesce(charged_shipping_aud,0) - coalesce(freight_cost_aud,0)),0)),
      'perOrder', round(coalesce(avg(coalesce(charged_shipping_aud,0) - coalesce(freight_cost_aud,0)),0), 2)),
    jsonb_build_object('key','duties_taxes',
      'charged', round(coalesce(sum(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)),0)),
      'paid',    round(coalesce(sum(coalesce(zonos_duty_aud,0) + coalesce(zonos_tax_aud,0)),0)),
      'gap',     round(coalesce(sum(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)
                       - coalesce(zonos_duty_aud,0) - coalesce(zonos_tax_aud,0)),0)),
      'perOrder', round(coalesce(avg(coalesce(charged_duties_aud,0) + coalesce(charged_taxes_aud,0)
                       - coalesce(zonos_duty_aud,0) - coalesce(zonos_tax_aud,0)),0), 2)),
    jsonb_build_object('key','fees',
      'charged', 0,
      'paid',    round(coalesce(sum(zonos_fee_aud),0)),
      'gap',     round(-coalesce(sum(zonos_fee_aud),0)),
      'perOrder', round(-coalesce(avg(coalesce(zonos_fee_aud,0)),0), 2))
  ) as j from m
),
weekly as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'weekStart', w, 'charged', c, 'paid', p, 'orders', n) order by w), '[]'::jsonb) as j
  from (
    select date_trunc('week', day)::date as w,
           round(sum(charged_total)) as c, round(sum(paid_total)) as p, count(*) as n
    from m group by 1
  ) t
),
countries as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', country_code, 'orders', n, 'matchedOrders', nm, 'revenue', rev,
    'charged', c, 'paid', p, 'net', net,
    'netPerOrder', case when nm = 0 then null else round(net::numeric / nm, 2) end,
    'recoveryPct', case when p = 0 then null else round(100.0 * c / p, 1) end
  ) order by n desc), '[]'::jsonb) as j
  from (
    select b.country_code,
      count(*) as n,
      count(*) filter (where b.matched) as nm,
      round(coalesce(sum(b.subtotal_aud),0)) as rev,
      round(coalesce(sum(b.charged_total) filter (where b.matched),0)) as c,
      round(coalesce(sum(b.paid_total) filter (where b.matched),0)) as p,
      round(coalesce(sum(b.charged_total - b.paid_total) filter (where b.matched),0)) as net
    from base b group by 1
  ) t
),
ledger as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'order', order_name, 'date', day, 'country', country_code,
    'chargedShipping', round(coalesce(charged_shipping_aud,0),2),
    'chargedDuties', round(coalesce(charged_duties_aud,0),2),
    'chargedTaxes', round(coalesce(charged_taxes_aud,0),2),
    'chargedTotal', round(charged_total,2),
    'freight', round(freight_cost_aud,2),
    'zonosDT', case when zonos_matched_at is null then null
               else round(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0),2) end,
    'zonosFees', case when zonos_matched_at is null then null else round(coalesce(zonos_fee_aud,0),2) end,
    'paidTotal', case when matched then round(paid_total,2) else null end,
    'net', case when matched then round(charged_total - paid_total,2) else null end,
    'tracking', tracking_number, 'carrier', ss_carrier, 'matched', matched
  ) order by day desc, order_name desc), '[]'::jsonb) as j
  from base
),
exceptions as (
  select jsonb_build_object(
    'awaitingZonos', (select coalesce(jsonb_agg(order_name order by day desc), '[]'::jsonb)
                      from base where zonos_matched_at is null),
    'awaitingFreight', (select coalesce(jsonb_agg(order_name order by day desc), '[]'::jsonb)
                        from base where freight_cost_aud is null),
    'zonosUnmatched', (select coalesce(jsonb_agg(jsonb_build_object(
                         'tracking', tracking_number, 'country', country_code,
                         'amount', round(coalesce(zonos_duty_aud,0)+coalesce(zonos_tax_aud,0)+coalesce(zonos_fee_aud,0),2))
                         order by zonos_created_at desc), '[]'::jsonb)
                       from ddp_zonos_unmatched
                       where (zonos_created_at at time zone 'Australia/Brisbane')::date between p_from and p_to)
  ) as j
)
select jsonb_build_object(
  'kpis', (select j from kpis),
  'components', (select j from components),
  'weekly', (select j from weekly),
  'countries', (select j from countries),
  'ledger', (select j from ledger),
  'exceptions', (select j from exceptions),
  'window', jsonb_build_object('from', p_from, 'to', p_to)
);
$$;

revoke all on function public.ddp_markets_dashboard(date, date) from public;
revoke all on function public.ddp_markets_dashboard(date, date) from anon;
grant execute on function public.ddp_markets_dashboard(date, date) to authenticated, service_role;
