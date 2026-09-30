import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/lib/supabase';

// Which purchase orders make up a SKU's "On Prod." figure.
//
// Mario, 2026-10-01: "si hay algo en prod, si le hago click al num me muestre
// un pop up con la info de en que PO number esta esa cantidad". The column is
// built by the inventory sync from open POs in the PRODUCTION stage; this reads
// the same lines, kept in aim2026_inbound_po_lines by that sync, so they add
// up to the column unless the KPIs were refreshed at a different moment — in
// which case the footer says so instead of hiding the difference.

interface POLine {
  order_number: string;
  supplier: string | null;
  custom_status: string | null;
  order_status: string | null;
  warehouse: string | null;
  order_date: string | null;
  delivery_date: string | null;
  quantity: number;
  received_quantity: number | null;
  comments: string | null;
  synced_at: string;
}

const day = (s: string | null) => (s ? format(parseISO(s), 'd MMM yyyy') : '—');
const n0 = (v: number) => v.toLocaleString('en-AU', { maximumFractionDigits: 0 });

export function ProductionPOsDialog({
  sku, product, columnValue, open, onOpenChange,
}: {
  sku: string | null;
  product?: string;
  /** The On Prod. figure shown in the table, to check the lines against. */
  columnValue: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [lines, setLines] = useState<POLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !sku) return;
    let cancelled = false;
    setLines(null); setError(null);
    supabase
      .from('aim2026_inbound_po_lines')
      .select('order_number, supplier, custom_status, order_status, warehouse, order_date, delivery_date, quantity, received_quantity, comments, synced_at')
      .eq('sku', sku)
      .eq('stage', 'On Production')
      .order('delivery_date', { ascending: true, nullsFirst: false })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message);
        else setLines((data ?? []).map((r: any) => ({ ...r, quantity: Number(r.quantity), received_quantity: r.received_quantity == null ? null : Number(r.received_quantity) })));
      });
    return () => { cancelled = true; };
  }, [open, sku]);

  const total = (lines ?? []).reduce((s, l) => s + l.quantity, 0);
  const syncedAt = lines && lines.length > 0 ? lines[0].synced_at : null;
  const th = 'px-3 py-2 text-left text-[13px] font-medium text-muted-foreground cursor-help';
  const td = 'px-3 py-2 text-[13px]';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>On production — {sku}</DialogTitle>
          <DialogDescription>
            {product ? `${product}. ` : ''}Open purchase orders in the PRODUCTION stage that make up the On Prod. figure, from Unleashed.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-red-600">Couldn&apos;t load the purchase orders: {error}</p>}
        {!error && lines === null && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading purchase orders…
          </div>
        )}
        {!error && lines !== null && lines.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">
            No open purchase order in production for this SKU at the last sync. If the column still shows a quantity, it
            comes from an earlier KPI refresh and will clear on the next one.
          </p>
        )}
        {!error && lines !== null && lines.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className={th} title="Unleashed purchase order number.">PO</th>
                  <th className={th} title="Supplier on the purchase order.">Supplier</th>
                  <th className={th} title="Order date of the purchase order.">Ordered</th>
                  <th className={th} title="Expected delivery date: the line's date if it has one, otherwise the order's.">Expected</th>
                  <th className={th} title="Operational stage in Unleashed (Custom Order Status). Blank custom status counts as production when the PO goes to the China warehouse.">Stage</th>
                  <th className={`${th} text-right`} title="Ordered quantity on this line. This is what the On Prod. column adds up.">Qty</th>
                  <th className={`${th} text-right`} title="Quantity already receipted on this line in Unleashed. Shown for context; the column does not subtract it.">Received</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.order_number}-${i}`} className="border-t" title={l.comments ?? undefined}>
                    <td className={`${td} font-medium`}>{l.order_number}</td>
                    <td className={td}>{l.supplier ?? '—'}</td>
                    <td className={td}>{day(l.order_date)}</td>
                    <td className={td}>{day(l.delivery_date)}</td>
                    <td className={td}>{l.custom_status ?? `${l.order_status ?? ''} · ${l.warehouse ?? ''}`}</td>
                    <td className={`${td} text-right tabular-nums font-semibold`}>{n0(l.quantity)}</td>
                    <td className={`${td} text-right tabular-nums text-muted-foreground`}>{l.received_quantity ? n0(l.received_quantity) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/30">
                  <td className={`${td} font-medium`} colSpan={5}>Total</td>
                  <td className={`${td} text-right tabular-nums font-bold`}>{n0(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {!error && lines !== null && lines.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Purchase orders as of the last Unleashed sync{syncedAt ? ` (${format(new Date(syncedAt), 'd MMM yyyy, HH:mm')})` : ''}.
            {Math.round(total) !== Math.round(columnValue) && (
              <> The table shows {n0(columnValue)} because its figures come from an earlier refresh; they match after the next one.</>
            )}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ProductionPOsDialog;
