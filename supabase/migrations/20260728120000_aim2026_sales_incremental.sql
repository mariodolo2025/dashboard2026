-- =============================================================================
-- AIM 2026 — incremental sales demand (watermark + upsert, no window wipes)
-- =============================================================================
-- Replaces the delete-a-rolling-window-and-refill design that silently destroyed
-- 34,317 units of 2026 demand. Mirrors the pattern already proven in
-- `unleashed-sales-sync` / `unleashed_sales_lines`:
--   * every order line carries its Unleashed Guid, so writes are upserts
--   * a watermark records how far the sync has read; the next run resumes there
--   * aim2026_demand_history stops accumulating (existing + new) and becomes a
--     pure aggregate recomputed from aim2026_demand_detail
--
-- Nothing here is destructive: additive columns, one new table, one new function.

-- ─── 1. Natural keys on the detail rows ──────────────────────────────────────
-- line_guid is Unleashed's SalesOrderLine.Guid — the stable identity of a line.
-- order_guid is SalesOrder.Guid, used to replace an order's lines as a unit when
-- the order is edited upstream (a line removed in Unleashed must disappear here).

alter table public.aim2026_demand_detail
  add column if not exists line_guid  text,
  add column if not exists order_guid text;

-- Unique, but NULL-tolerant: rows predating this migration have no guid and
-- Postgres treats each NULL as distinct, so they coexist until the backfill
-- replaces them.
create unique index if not exists aim2026_demand_detail_line_guid_key
  on public.aim2026_demand_detail (line_guid)
  where line_guid is not null;

create index if not exists idx_aim2026_detail_order_guid
  on public.aim2026_demand_detail (order_guid)
  where order_guid is not null;

-- ─── 2. Watermark ────────────────────────────────────────────────────────────

create table if not exists public.aim2026_sales_sync_state (
  id                       integer primary key default 1,
  last_modified_watermark  timestamptz,
  last_run_at              timestamptz,
  last_mode                text,
  orders_seen              integer,
  lines_upserted           integer,
  updated_at               timestamptz not null default now(),
  constraint aim2026_sales_sync_state_singleton check (id = 1)
);

alter table public.aim2026_sales_sync_state enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'aim2026_sales_sync_state'
      and policyname = 'aim2026_sales_sync_state_rw'
  ) then
    create policy aim2026_sales_sync_state_rw
      on public.aim2026_sales_sync_state
      for all
      to authenticated, service_role
      using (true) with check (true);
  end if;
end $$;

-- ─── 3. demand_history as a derived aggregate ────────────────────────────────
-- The old code did `quantity_sold = existing.quantity_sold + new`, so correctness
-- depended on a separate zero-out having run first. If the zero-out was skipped,
-- mismatched or partially applied, the numbers silently doubled. Recomputing from
-- the detail rows instead makes a re-run a no-op by construction.
--
-- Scope: ONLY quantity_sold / revenue, and ONLY from Completed sales — which is
-- what these columns have always meant. component_usage belongs to the assemblies
-- sync and is never touched here.

create or replace function public.aim2026_rebuild_demand_history(p_periods date[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if p_periods is null or array_length(p_periods, 1) is null then
    return 0;
  end if;

  -- Reset the sales figures for the affected periods. Rows whose last sale was
  -- removed upstream must fall back to zero rather than keep a stale value.
  update public.aim2026_demand_history
     set quantity_sold = 0,
         revenue       = 0
   where period_date = any(p_periods)
     and (quantity_sold <> 0 or revenue <> 0);

  with agg as (
    select period_date,
           sku,
           coalesce(nullif(trim(warehouse), ''), 'Unknown') as warehouse,
           sum(quantity) as qty,
           sum(amount)   as rev
      from public.aim2026_demand_detail
     where type = 'sale'
       and status = 'Completed'
       and period_date = any(p_periods)
     group by 1, 2, 3
    union all
    select period_date,
           sku,
           'All' as warehouse,
           sum(quantity),
           sum(amount)
      from public.aim2026_demand_detail
     where type = 'sale'
       and status = 'Completed'
       and period_date = any(p_periods)
     group by 1, 2
  )
  insert into public.aim2026_demand_history
    (period_date, sku, warehouse, quantity_sold, revenue, component_usage)
  select period_date, sku, warehouse, qty, rev, 0
    from agg
  on conflict (period_date, sku, warehouse) do update
    set quantity_sold = excluded.quantity_sold,
        revenue       = excluded.revenue;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.aim2026_rebuild_demand_history(date[]) is
  'Recomputes quantity_sold/revenue in aim2026_demand_history from Completed sale rows in aim2026_demand_detail, for the given month-start periods. Idempotent: running it twice produces the same result. Never touches component_usage.';

grant execute on function public.aim2026_rebuild_demand_history(date[]) to authenticated, service_role;
