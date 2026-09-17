-- =============================================================================
-- Spend to Stock — the opening balance is what is IN AUSTRALIA, not everywhere
-- =============================================================================
-- Mario, 2026-09-18, looking at PSD-HD-BR54: "arranca contando 4715 cuando en
-- realidad ya tengo 3500 en mano."
--
-- He was right about the number and it is worth writing down why, because the
-- cause was not the one anybody assumed. `stock` summed three warehouses:
--
--     Main (Australia)   3,067
--     China              1,648
--     Container              0
--     ----------------------------
--     opening balance    4,715
--
-- So the projection opened every product with goods that are sitting in a
-- factory warehouse in China. They are real, but they cannot be sold next week:
-- they have to be loaded and sailed. Counting them as on-hand makes the opening
-- balance optimistic, pushes the first stockout later than it really is, and
-- starts the production run late — which is the one thing this whole screen
-- exists to get right.
--
-- The fix is not to drop them. They ARE coming. The UI now opens the balance
-- with Main alone and credits China + Container as an ARRIVAL after sea freight,
-- using the same 30-day transit the container-loading planner already assumes
-- (CONTAINER_TRANSIT_DAYS in complete-projection/projection.ts). The running
-- balance already had an "arrives" column, so the inbound lands where a reader
-- can see it instead of being folded invisibly into day one.
--
-- `stock` therefore CHANGES MEANING: it is now Main only. `inbound` is the new
-- field. Both are rounded the same way. The only consumer is
-- GrowthForecastContent, which is updated in the same commit.

do $mig$
declare
  src  text;
  anchor text := $a$         coalesce((k.kpi_data->>'sohMainWH')::numeric, 0)
           + coalesce((k.kpi_data->>'sohChina')::numeric, 0)
           + coalesce((k.kpi_data->>'container')::numeric, 0) stock,$a$;
  repl text := $a$         coalesce((k.kpi_data->>'sohMainWH')::numeric, 0) stock,
         coalesce((k.kpi_data->>'sohChina')::numeric, 0)
           + coalesce((k.kpi_data->>'container')::numeric, 0) inbound,$a$;
  anchor2 text := $a$      'stock', round(stock), 'lead', lead, 'cost', round(cost::numeric, 2),$a$;
  repl2 text := $a$      'stock', round(stock), 'inbound', round(inbound), 'lead', lead, 'cost', round(cost::numeric, 2),$a$;
begin
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'growth_forecast_report';
  if src is null then raise exception 'growth_forecast_report not found'; end if;

  if position('''inbound''' in src) > 0 then
    raise exception 'already applied: growth_forecast_report already returns inbound';
  end if;
  if position(anchor in src) = 0 then
    raise exception 'stock anchor not found — the function body moved, patch by hand';
  end if;
  if position(anchor2 in src) = 0 then
    raise exception 'output anchor not found — the function body moved, patch by hand';
  end if;

  src := replace(src, anchor, repl);
  src := replace(src, anchor2, repl2);
  execute src;
end
$mig$;

comment on function public.growth_forecast_report(integer, integer, date[]) is
  'Growth forecast inputs for the Reports tab. stock = Main warehouse only (what can be sold now); inbound = China + Container, which the UI credits as an arrival after sea freight. Splitting them on 2026-09-18 stopped the projection opening with goods still in China.';
