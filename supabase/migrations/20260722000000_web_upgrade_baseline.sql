-- Pre-launch sales baseline for the Web Upgrade tab.
--
-- The old theme carries no upgrade instrumentation, so there is no module-level
-- history to compare against. What we DO have is the complete per-SKU sales
-- history, so the honest comparison is a before/after of the sales themselves.
--
-- This snapshot must be frozen BEFORE the new theme is published: once it is
-- live, "before" stops being observable. It is also frozen rather than computed
-- on the fly because shopify_sales_lines is re-synced by updated_at — refunds and
-- returns rewrite history, which would silently move the baseline underneath us.
--
-- Several window lengths are stored so the comparison can pick the one that best
-- matches the post-launch period being measured (and so a single seasonal quirk
-- in one window can be sanity-checked against the others).
create table if not exists web_upgrade_baseline (
  sku             text    not null,
  window_days     int     not null,
  period_from     date    not null,
  period_to       date    not null,
  product_title   text,
  fitment         text,
  units           numeric not null default 0,
  revenue_aud     numeric not null default 0,
  units_per_week  numeric,
  revenue_per_week numeric,
  captured_at     timestamptz not null default now(),
  primary key (sku, window_days)
);

alter table web_upgrade_baseline enable row level security;

comment on table web_upgrade_baseline is
  'Frozen pre-launch (old theme) per-SKU sales run-rate. Baseline for the Web Upgrade before/after comparison. Observational, not a controlled experiment.';

-- Fitment is the machine-side dimension the SKU can express. Note it identifies
-- the SCREEN's fitment, not the customer's machine brand: every non-Breville 54mm
-- machine (DeLonghi, Ascaso, …) shares PSD-HD-54, so brand for those is only
-- recoverable from the pixel's `machine` field, never from the SKU.
create or replace function web_upgrade_fitment(p_sku text) returns text
language sql immutable as $$
  select case
    when p_sku = 'PSD-HD-EX54' then 'Breville 54mm (Express/Infuser)'
    when p_sku = 'PSD-HD-54'   then 'Breville 54mm (other 54mm machines)'
    when p_sku = 'PSD-HD-MV58' then 'Breville 58mm'
    when p_sku = 'PSD-HD-GA'   then 'Gaggia'
    when p_sku = 'PSD-HD-LM'   then 'La Marzocco'
    when p_sku = 'PSD-HD-E61'  then 'E61 group'
    when p_sku = 'PSD-HD-HX'   then 'HX group'
    when p_sku = 'PSD-HD-MV'   then 'MV group'
    else null end;
$$;
