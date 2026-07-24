-- modules[]: add whole-basket AOV per module — the average FULL order value of
-- the paid orders that used that module. Patched in place on the deployed
-- definition (two-expression change):
do $do$
declare v_def text;
begin
  v_def := pg_get_functiondef('web_upgrade_performance(date,date,text)'::regprocedure);
  v_def := replace(v_def,
    $$'orders', coalesce(so.ords, 0),
      'revenue', coalesce(so.rev, 0)$$,
    $$'orders', coalesce(so.ords, 0),
      'revenue', coalesce(so.rev, 0),
      'aov', so.aov$$);
  v_def := replace(v_def,
    $$    left join (
      select web_upgrade_module_of_source(pesado_source) module,
             count(distinct order_id) ords, round(coalesce(sum(net_aud), 0)) rev
      from sales group by 1) so on so.module = m.module),$$,
    $$    left join (
      select mod as module,
             count(*) ords,
             round(sum(attr_rev)) rev,
             round(avg(basket_rev), 2) aov
      from (
        select web_upgrade_module_of_source(s.pesado_source) mod, s.order_id,
               sum(s.net_aud) attr_rev,
               min(b.rev) basket_rev
        from sales s join basket b on b.order_id = s.order_id
        group by 1, 2) t
      group by mod) so on so.module = m.module),$$);
  execute v_def;
end $do$;

notify pgrst, 'reload schema';
