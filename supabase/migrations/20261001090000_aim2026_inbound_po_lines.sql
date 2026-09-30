-- =============================================================================
-- aim2026_inbound_po_lines — which purchase order each inbound unit is on
-- =============================================================================
-- Mario, 2026-10-01, on the AIM 2026 table: "en la col de on production,
-- quiero que si hay algo en prod, si le hago click al num me muestre un pop up
-- con la info de en que PO number esta esa cantidad".
--
-- "On Production", "Container" and "DHL" are not Unleashed warehouses. The
-- inventory sync (aim2026-sync-unleashed, step purchase) builds them from the
-- OPEN purchase orders: OrderStatus Placed, grouped by CustomOrderStatus
-- (PRODUCTION / CONTAINER / DHL-INBOUNDS), each line's OrderQuantity summed per
-- SKU into a pseudo-warehouse row of aim2026_soh_snapshots. The PO number was
-- in the API response and thrown away, so the screen could say "540 in
-- production" but not where.
--
-- This keeps the lines those totals are built from, one row per PO line, with
-- the same stage rule — so for any SKU the lines of a stage add up to what the
-- column shows. Checked before writing it: HC7123ST 540, HC7125ST 540,
-- HC7124PK 108, HC7123TB 108 are all PO-00001393 (WINKIN 2025, ordered
-- 2026-09-04, delivery 2026-11-04).
--
-- Current state only: every successful purchase step upserts the lines it saw
-- and deletes the ones it did not, so a PO that leaves the pipeline leaves the
-- table. A failed fetch writes nothing and deletes nothing.

create table if not exists public.aim2026_inbound_po_lines (
  line_guid         text primary key,
  order_number      text not null,
  order_guid        text,
  sku               text not null,
  stage             text not null check (stage in ('On Production', 'Container', 'DHL')),
  order_status      text,
  custom_status     text,
  warehouse         text,
  supplier          text,
  order_date        date,
  delivery_date     date,
  quantity          numeric not null,
  received_quantity numeric,
  comments          text,
  synced_at         timestamptz not null default now()
);

create index if not exists aim2026_inbound_po_lines_sku_stage on public.aim2026_inbound_po_lines (sku, stage);

comment on table public.aim2026_inbound_po_lines is
  'Open purchase-order lines behind the On Production / Container / DHL pseudo-warehouses of aim2026_soh_snapshots, one row per PO line, same stage rule as aim2026-sync-unleashed step purchase. Replaced on every successful purchase sync. Read by the On Prod. popup in the AIM 2026 table.';
comment on column public.aim2026_inbound_po_lines.quantity is
  'Line OrderQuantity — the figure the pseudo-warehouse sums, so the lines of a stage add up to the column.';
comment on column public.aim2026_inbound_po_lines.received_quantity is
  'Line ReceiptQuantity from Unleashed, shown for context; the column does not subtract it.';

alter table public.aim2026_inbound_po_lines enable row level security;

drop policy if exists "aim2026_inbound_po_lines_read" on public.aim2026_inbound_po_lines;
create policy "aim2026_inbound_po_lines_read"
  on public.aim2026_inbound_po_lines for select
  to authenticated, service_role using (true);
