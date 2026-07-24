-- byMachine: keep the grouped machine row but expose the ORIGINAL labels under it
-- as `variants` (only when more than one raw label was grouped), so normalizing
-- ("The X" / "Compatible with your X" -> "X") loses no information.
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('web_upgrade_performance(date,date,text)'::regprocedure);
  v_def := replace(v_def,
    $$'Unknown') machine,
    case$$,
    $$'Unknown') machine,
    coalesce(nullif(btrim(a.pesado_machine), ''), 'Unknown') machine_raw,
    case$$);
  v_def := replace(v_def,
    $$'byMachine', (select coalesce(jsonb_agg(jsonb_build_object('machine', machine, 'orders', ords, 'lines', lines, 'revenue', rev) order by rev desc, lines desc), '[]'::jsonb) from (
      select machine, count(distinct order_id) ords, count(*) lines, round(coalesce(sum(net_aud), 0)) rev from sales group by machine) mm),$$,
    $$'byMachine', (select coalesce(jsonb_agg(jsonb_build_object('machine', machine, 'orders', ords, 'lines', lines, 'revenue', rev, 'variants', variants) order by rev desc, lines desc), '[]'::jsonb) from (
      select machine, count(distinct order_id) ords, count(*) lines, round(coalesce(sum(net_aud), 0)) rev,
             case when count(distinct machine_raw) > 1 then (
               select jsonb_agg(jsonb_build_object('label', label, 'orders', o, 'lines', l, 'revenue', r) order by r desc) from (
                 select s2.machine_raw label, count(distinct s2.order_id) o, count(*) l, round(coalesce(sum(s2.net_aud), 0)) r
                 from sales s2 where s2.machine = mm.machine group by s2.machine_raw) v
             ) end variants
      from sales mm group by machine) mm2),$$);
  execute v_def;
end $do$;

notify pgrst, 'reload schema';
