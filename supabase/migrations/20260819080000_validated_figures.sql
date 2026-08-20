-- =============================================================================
-- Cifras validadas por Mario — se leen, no se recalculan.
-- =============================================================================
-- Nace de un error concreto: growth_forecast_report calculaba por su cuenta el
-- costo de envío a USA y le erraba. Promediaba DHL eCommerce — el carrier viejo,
-- abandonado — con Australia Post, y dejaba ZONOS afuera. Daba $18,68 contra los
-- $19,42 del reporte de fin de año. Los dos errores se compensaban, así que el
-- número PARECÍA correcto, que es la peor forma de estar mal: nadie lo revisa.
--
-- Regla: si un número vive acá, se LEE. El cálculo propio queda al lado como
-- `costComputed` y sirve sólo para detectar deriva, nunca para reemplazarlo.
--
-- Aplicado en la base el 2026-08-19 (migraciones validated_figures_table y
-- growth_forecast_read_validated_shipping); este archivo es el espejo.
create table if not exists public.aim2026_validated_figures (
  key          text primary key,
  value        numeric not null,
  unit         text    not null,
  what         text    not null,
  includes     text,
  excludes     text,
  source       text    not null,
  valid_from   date    not null,
  validated_by text    not null default 'Mario',
  validated_at timestamptz not null default now()
);

alter table public.aim2026_validated_figures enable row level security;

drop policy if exists validated_figures_read on public.aim2026_validated_figures;
create policy validated_figures_read on public.aim2026_validated_figures
  for select to authenticated, service_role using (true);

insert into public.aim2026_validated_figures
  (key, value, unit, what, includes, excludes, source, valid_from)
values
  ('us_shipping_cost_per_parcel', 19.42, 'AUD',
   'Lo que cuesta poner un paquete en manos de un cliente de Estados Unidos.',
   'Flete de Australia Post MAS los derechos de importacion de ZONOS. ZONOS entra porque son duties de las ordenes que se mandan a USA - decision de Mario, 18-ago-2026.',
   'DHL eCommerce: era el carrier viejo ($33,25/paquete) y ya no se usa. Promediarlo con AusPost da un numero que no describe ni el pasado ni el presente.',
   'DOLO_FY25-26_Executive_Report · seccion 3 · mismo metodo que la edge function starshipit-market',
   '2025-07-01'),
  ('au_shipping_cost_per_parcel', 5.52, 'AUD',
   'Costo de flete por paquete a Australia.',
   'Flete de Australia Post asignado a AU por el reparto de Starshipit.',
   'ZONOS no aplica: son derechos de importacion de Estados Unidos.',
   'xero_account_lines · Freight & Courier · reparto Starshipit FY25-26',
   '2025-07-01')
on conflict (key) do update set
  value = excluded.value, unit = excluded.unit, what = excluded.what,
  includes = excluded.includes, excludes = excluded.excludes,
  source = excluded.source, valid_from = excluded.valid_from,
  validated_at = now();

comment on table public.aim2026_validated_figures is
  'Cifras validadas por Mario, con su fuente y que incluye o excluye cada una. Los reportes las LEEN; no las recalculan. Nacio del error del costo de envio a USA (18-ago-2026).';
