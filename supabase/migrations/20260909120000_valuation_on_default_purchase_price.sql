-- Stock is valued at what we paid the supplier in China — Unleashed's Default
-- Purchase Price, kept in aim2026_sku_parameters.product_cost_china by the
-- products sync. Freight, duty and insurance (12.24% from aim2026_cost_config)
-- stay OUT of the stock value: they are reported as their own expense
-- categories from Xero, and adding them here counted the same money twice.
--
-- They remain in COGS, margin, turnover and GMROI, which is where a unit's
-- true cost to sell belongs. Only the valuation changes basis.
--
-- Main Warehouse, Container, DHL and Pesado Korea used to carry the uplift.
-- China-W and On Production never did — goods still at the factory have not
-- been freighted — so those two lines are unchanged and now agree with the
-- rest instead of being the odd ones out.
--
-- Mirrors the same change in aim2026-calc-kpis-v2 (totalValuation* and
-- avgInventoryValue). The two must always agree: the KPI card and this history
-- are shown side by side.

create or replace function public.aim2026_recalc_valuation_history()
 returns table(snapshots integer, first_date date, last_date date)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_n int;
begin
  -- No landed-cost rates are read any more: every warehouse is valued at the
  -- bare Default Purchase Price. The rates live on in aim2026_cost_config and
  -- are still applied by the KPI function to COGS and margin.
  with wh as (
    select s.snapshot_date, s.sku,
           sum(s.quantity) filter (where lower(s.warehouse) like '%main%')       main_q,
           sum(s.quantity) filter (where lower(s.warehouse) like '%china%')      china_q,
           sum(s.quantity) filter (where lower(s.warehouse) like '%container%')  cont_q,
           sum(s.quantity) filter (where lower(s.warehouse) like '%dhl%')        dhl_q,
           sum(s.quantity) filter (where lower(s.warehouse) like '%production%') prod_q,
           sum(s.quantity) filter (where lower(s.warehouse) like '%korea%')      korea_q
    from aim2026_soh_snapshots s
    group by 1, 2
  ),
  val as (
    select w.snapshot_date,
           sum(coalesce(w.main_q,0)  * coalesce(p.product_cost_china,0))         main_v,
           sum(greatest(0, coalesce(w.china_q,0) - coalesce(w.cont_q,0) - coalesce(w.dhl_q,0))
               * coalesce(p.product_cost_china,0))                              china_v,
           sum(coalesce(w.cont_q,0)  * coalesce(p.product_cost_china,0))         cont_v,
           sum(coalesce(w.dhl_q,0)   * coalesce(p.product_cost_china,0))         dhl_v,
           sum(coalesce(w.prod_q,0)  * coalesce(p.product_cost_china,0))         prod_v,
           sum(coalesce(w.korea_q,0) * coalesce(p.product_cost_china,0))         korea_v,
           count(distinct w.sku) filter (where coalesce(p.product_cost_china,0) > 0) costed,
           count(distinct w.sku) filter (where coalesce(p.product_cost_china,0) = 0) missing
    from wh w
    left join aim2026_sku_parameters p on p.sku = w.sku
    group by 1
  )
  update aim2026_stock_valuation_history h
     set main_warehouse_recalc = round(v.main_v),
         china_recalc          = round(v.china_v),
         container_recalc      = round(v.cont_v),
         dhl_recalc            = round(v.dhl_v),
         on_production_recalc  = round(v.prod_v),
         pesado_korea_recalc   = round(v.korea_v),
         total_inventory_recalc = round(v.main_v + v.china_v + v.cont_v + v.dhl_v + v.prod_v + v.korea_v),
         recalc_at             = now(),
         recalc_skus_costed    = v.costed,
         recalc_skus_missing_cost = v.missing
    from val v
   where v.snapshot_date = h.snapshot_date;

  get diagnostics v_n = row_count;

  return query
    select v_n,
           min(h.snapshot_date) filter (where h.recalc_at is not null),
           max(h.snapshot_date) filter (where h.recalc_at is not null)
    from aim2026_stock_valuation_history h;
end
$function$;
