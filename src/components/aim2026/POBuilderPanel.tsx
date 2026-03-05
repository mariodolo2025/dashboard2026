import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, ShoppingCart, Loader2, CheckCircle2, AlertTriangle, Package, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { POBuilderItem } from '@/lib/aim2026/types';

const CUSTOM_ORDER_STATUSES = [
  { value: 'Production', label: 'Production' },
  { value: 'Container', label: 'Container' },
  { value: 'DHL-Inbounds', label: 'DHL Inbounds' },
] as const;

interface POBuilderPanelProps {
  items: POBuilderItem[];
  onRemove: (sku: string) => void;
  onUpdateQty: (sku: string, qty: number) => void;
  onClear: () => void;
  onCreatePO: (customOrderStatus: string) => Promise<void>;
  creating: boolean;
}

function fmt(v: number): string {
  return v.toLocaleString('en-AU');
}

export function POBuilderPanel({
  items,
  onRemove,
  onUpdateQty,
  onClear,
  onCreatePO,
  creating,
}: POBuilderPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState('Production');
  const [expanded, setExpanded] = useState(false);

  const totalUnits = items.reduce((s, i) => s + i.quantity, 0);
  const totalValue = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  if (items.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ x: -320, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: -320, opacity: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="fixed bottom-4 left-4 z-50 w-[340px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="bg-blue-600 text-white px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingCart size={16} />
            <span className="text-sm font-semibold">PO Draft</span>
            <span className="bg-white/20 text-[11px] px-1.5 py-0.5 rounded-full font-medium">
              {items.length} items
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-white/70 hover:text-white transition-colors"
              title={expanded ? 'Minimize' : 'Maximize'}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button onClick={onClear} className="text-white/70 hover:text-white transition-colors" title="Clear all">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Items list */}
        <div className={cn('overflow-y-auto divide-y divide-border/40', expanded ? 'max-h-[500px]' : 'max-h-[300px]')}>
          {items.map((item) => (
            <div
              key={item.sku}
              className="px-3 py-2 flex items-center gap-2 hover:bg-muted/30 transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono font-medium text-blue-600 dark:text-blue-400 truncate">
                  {item.sku}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">{item.product}</div>
              </div>
              <input
                type="number"
                min={1}
                value={item.quantity}
                onChange={(e) => {
                  const v = parseInt(e.target.value);
                  if (v > 0) onUpdateQty(item.sku, v);
                }}
                className="w-16 text-right text-xs font-semibold tabular-nums bg-muted/50 border border-border/50 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={() => onRemove(item.sku)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all p-0.5"
                title="Remove"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t bg-muted/20 px-4 py-3 space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Total units</span>
            <span className="font-semibold tabular-nums">{fmt(totalUnits)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Est. value (FOB)</span>
            <span className="font-semibold tabular-nums">
              ${totalValue.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>

          {!confirmOpen ? (
            <Button
              className="w-full h-9 text-xs font-semibold gap-1.5"
              onClick={() => setConfirmOpen(true)}
              disabled={creating}
            >
              <Package size={14} />
              Create PO in Unleashed
            </Button>
          ) : (
            <div className="space-y-2.5 pt-1">
              <div className="bg-amber-50 dark:bg-amber-950/30 rounded-lg px-3 py-2.5 border border-amber-200/50 dark:border-amber-800/40">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
                  <div className="text-[10px] text-amber-700 dark:text-amber-300 leading-relaxed w-full">
                    <p className="font-semibold mb-1">Confirm PO Creation</p>
                    <p>
                      Supplier: <strong>WINKIN 2025 (AUD)</strong><br />
                      Warehouse: <strong>{selectedStatus === 'Production' ? 'China-W' : 'Main Warehouse'}</strong><br />
                      {items.length} items, {fmt(totalUnits)} units
                    </p>
                    <div className="mt-2">
                      <label className="block text-[10px] font-medium mb-1 text-amber-800 dark:text-amber-200">
                        Order Status
                      </label>
                      <select
                        value={selectedStatus}
                        onChange={(e) => setSelectedStatus(e.target.value)}
                        className="w-full h-7 text-[11px] font-semibold bg-white dark:bg-zinc-900 border border-amber-300 dark:border-amber-700 rounded px-2 text-amber-900 dark:text-amber-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        {CUSTOM_ORDER_STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            Placed → {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => setConfirmOpen(false)}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 h-8 text-xs gap-1"
                  onClick={async () => {
                    await onCreatePO(selectedStatus);
                    setConfirmOpen(false);
                  }}
                  disabled={creating}
                >
                  {creating ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={12} />
                      Confirm
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
