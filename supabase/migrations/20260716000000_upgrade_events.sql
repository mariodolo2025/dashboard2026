-- Web Upgrade performance — raw event store for the Pesado site upgrade modules.
-- The Shopify Custom Pixel POSTs each 'pesado_upgrade' event to the
-- upgrade-events-ingest edge function, which writes one row here. Query dimensions
-- (action, attribution_id, environment, timestamp) are typed + indexed; the full
-- event is kept in payload jsonb so the contract can evolve without migrations.
-- environment distinguishes 'preview' (test) from 'production' — commercial stats
-- must filter environment='production'.
create table if not exists upgrade_events (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  event_timestamp timestamptz,
  action text,
  attribution_id text,
  environment text,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists upgrade_events_attribution_idx on upgrade_events (attribution_id);
create index if not exists upgrade_events_action_idx on upgrade_events (action);
create index if not exists upgrade_events_env_ts_idx on upgrade_events (environment, event_timestamp);
-- Only the edge function (service role) writes; the dashboard reads via a
-- SECURITY DEFINER RPC later. RLS on + no policies = anon/authenticated denied.
alter table upgrade_events enable row level security;
