import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, ShoppingCart, Loader2, CheckCircle2, AlertTriangle, Package, Maximize2, Minimize2, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { POBuilderItem } from '@/lib/aim2026/types';

const CUSTOM_ORDER_STATUSES = [
  { value: 'Production', label: 'Production' },
  { value: 'Container', label: 'Container' },
  { value: 'DHL-Inbounds', label: 'DHL Inbounds' },
] as const;

const getDefaultPos = () => ({ x: 16, y: Math.max(80, (typeof window !== 'undefined' ? window.innerHeight : 600) - 420) });
const PANEL_WIDTH = 340;

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
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState(getDefaultPos);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  const totalUnits = items.reduce((s, i) => s + i.quantity, 0);
  const totalValue = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, dragRef.current.startPosX + dx)),
        y: Math.max(0, Math.min(window.innerHeight - 100, dragRef.current.startPosY + dy)),
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 w-[340px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header - draggable */}
        <div
          onMouseDown={handleMouseDown}
          className="bg-blue-600 text-white px-4 py-3 flex items-center justify-between cursor-grab active:cursor-grabbing select-none"
        >
          <div className="flex items-center gap-2">
            <GripVertical size={14} className="text-white/60" />
            <ShoppingCart size={16} />
            <span className="text-sm font-semibold">PO Draft</span>
            <span className="bg-white/20 text-[11px] px-1.5 py-0.5 rounded-full font-medium">
              {items.length} items
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
              className="text-white/70 hover:text-white transition-colors p-0.5"
              title={minimized ? 'Expand' : 'Minimize'}
            >
              {minimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onClear(); }} className="text-white/70 hover:text-white transition-colors p-0.5" title="Clear all">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {!minimized && (
          <>
        {/* Items list */}
        <div className="overflow-y-auto divide-y divide-border/40 max-h-[300px]">
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
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
