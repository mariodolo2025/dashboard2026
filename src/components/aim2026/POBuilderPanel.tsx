import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, ShoppingCart, Loader2, CheckCircle2, AlertTriangle, Package, Maximize2, Minimize2, GripVertical, Container as ContainerIcon, Factory, PanelRightOpen, Pin, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { POBuilderItem, POType } from '@/lib/aim2026/types';

const getDefaultPos = () => ({ x: 16, y: Math.max(80, (typeof window !== 'undefined' ? window.innerHeight : 600) - 420) });
const PANEL_WIDTH = 340;

interface POBuilderPanelProps {
  items: POBuilderItem[];
  onRemove: (sku: string, poType: POType) => void;
  onUpdateQty: (sku: string, poType: POType, qty: number) => void;
  onClear: () => void;
  /** Auto-split por poType: si hay items en ambos buckets crea 2 POs (Container
   *  → MAIN, Production → China-W); si hay uno solo crea 1 PO. */
  onCreatePO: () => Promise<void>;
  creating: boolean;
  /** Si true, render inline (no portal, no fixed) — el padre lo ubica como
   *  columna anclada a la derecha del modal. Si false (default), flotante
   *  draggable global como toda la vida. */
  docked?: boolean;
  /** Si true Y docked, render como rail vertical de ~48px (solo badge + icon).
   *  Click en el rail dispara onExpandFromRail (típicamente cierra el SkuPanel). */
  collapsed?: boolean;
  /** Callback para alternar entre docked y flotante. Si está presente, el
   *  panel muestra el botón de toggle. */
  onToggleDocked?: () => void;
  /** Click sobre el rail colapsado. El padre debería cerrar lo que está
   *  ocupando el espacio (ej. SkuProjectionPanel) para dejar lugar al cart. */
  onExpandFromRail?: () => void;
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
  docked = false,
  collapsed = false,
  onToggleDocked,
  onExpandFromRail,
}: POBuilderPanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState(getDefaultPos);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  const totalUnits = items.reduce((s, i) => s + i.quantity, 0);
  const totalValue = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  // Split en dos buckets para el render. Mismo SKU puede estar en ambos.
  const containerItems = items.filter((i) => i.poType === 'Container');
  const productionItems = items.filter((i) => i.poType === 'Production');
  const containerUnits = containerItems.reduce((s, i) => s + i.quantity, 0);
  const productionUnits = productionItems.reduce((s, i) => s + i.quantity, 0);

  // Container DeliveryDate = max(projectionDate) + 30d transit. Mismo cálculo
  // que hace el handler en el dashboard — duplicado para mostrar preview.
  const containerDeliveryLabel = (() => {
    const dates = containerItems.map((i) => i.projectionDate).filter((d): d is string => !!d);
    if (dates.length === 0) return null;
    const maxIso = dates.reduce((a, b) => (a > b ? a : b));
    const d = new Date(maxIso + 'T00:00:00');
    d.setDate(d.getDate() + 30);
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  })();

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (docked) return;
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
  }, [pos, docked]);

  useEffect(() => {
    if (docked) return;
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
  }, [docked]);

  if (items.length === 0) return null;

  // ─── Rail colapsado (docked + collapsed) ─────────────────────────────────
  // Slim vertical bar a la derecha de todo. Solo badge + ícono + texto rotado.
  // Click expande (cierra el SkuPanel via onExpandFromRail).
  if (docked && collapsed) {
    return (
      <div
        onClick={onExpandFromRail}
        className="flex h-full w-[46px] cursor-pointer select-none flex-col items-center gap-3 border-l border-border bg-card py-3 hover:bg-muted/40"
        title="Expand PO Draft (collapses the SKU detail panel)"
      >
        <div className="relative">
          <ShoppingCart size={18} className="text-blue-600" />
          <span className="absolute -right-2 -top-2 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-600 px-1 text-[9px] font-bold leading-none text-white">
            {items.length}
          </span>
        </div>
        <div
          className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          PO Draft · {fmt(totalUnits)} u
        </div>
        <ChevronLeft size={14} className="mt-auto text-muted-foreground" />
      </div>
    );
  }

  // ─── Contenido común (header + secciones + footer) ───────────────────────
  const cardBody = (
    <>
      {/* Header */}
      <div
        onMouseDown={handleMouseDown}
        className={`bg-blue-600 text-white px-4 py-3 flex items-center justify-between select-none ${docked ? '' : 'cursor-grab active:cursor-grabbing'}`}
      >
        <div className="flex items-center gap-2">
          {!docked && <GripVertical size={14} className="text-white/60" />}
          <ShoppingCart size={16} />
          <span className="text-sm font-semibold">PO Draft</span>
          <span className="bg-white/20 text-[11px] px-1.5 py-0.5 rounded-full font-medium">
            {items.length} items
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onToggleDocked && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleDocked(); }}
              className="text-white/70 hover:text-white transition-colors p-0.5"
              title={docked ? 'Detach (float)' : 'Dock to right'}
            >
              {docked ? <PanelRightOpen size={14} /> : <Pin size={14} />}
            </button>
          )}
          {!docked && (
            <button
              onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
              className="text-white/70 hover:text-white transition-colors p-0.5"
              title={minimized ? 'Expand' : 'Minimize'}
            >
              {minimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onClear(); }} className="text-white/70 hover:text-white transition-colors p-0.5" title="Clear all">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
        {/* Items list — agrupado por poType. Mismo SKU puede aparecer en ambas secciones. */}
        <div className={`overflow-y-auto ${docked ? 'flex-1' : 'max-h-[320px]'}`}>
          {containerItems.length > 0 && (
            <CartSection
              title="Container Load"
              icon={<ContainerIcon size={11} />}
              accentClass="text-violet-600 dark:text-violet-400 bg-violet-50/60 dark:bg-violet-950/30"
              items={containerItems}
              subtotal={containerUnits}
              onRemove={onRemove}
              onUpdateQty={onUpdateQty}
            />
          )}
          {productionItems.length > 0 && (
            <CartSection
              title="Production"
              icon={<Factory size={11} />}
              accentClass="text-orange-700 dark:text-orange-400 bg-orange-50/60 dark:bg-orange-950/30"
              items={productionItems}
              subtotal={productionUnits}
              onRemove={onRemove}
              onUpdateQty={onUpdateQty}
            />
          )}
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
                    <p className="font-semibold mb-1">
                      Confirm PO Creation{(containerItems.length > 0 && productionItems.length > 0) ? ' · 2 POs' : ''}
                    </p>
                    <p className="mb-1.5">Supplier: <strong>WINKIN 2025 (AUD)</strong></p>
                    {containerItems.length > 0 && (
                      <div className="mt-1 rounded bg-violet-50/80 dark:bg-violet-950/40 px-2 py-1 border border-violet-200/60 dark:border-violet-800/40">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300 font-semibold">
                            <ContainerIcon size={10} /> Container → MAIN
                          </span>
                          <span className="tabular-nums">{containerItems.length} items · {fmt(containerUnits)} u</span>
                        </div>
                        {containerDeliveryLabel && (
                          <div className="mt-0.5 text-[9px] text-violet-700/80 dark:text-violet-300/80">
                            DeliveryDate: <strong>{containerDeliveryLabel}</strong> (max projection + 30d transit)
                          </div>
                        )}
                      </div>
                    )}
                    {productionItems.length > 0 && (
                      <div className="mt-1 rounded bg-orange-50/80 dark:bg-orange-950/40 px-2 py-1 border border-orange-200/60 dark:border-orange-800/40">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 text-orange-700 dark:text-orange-300 font-semibold">
                            <Factory size={10} /> Production → China-W
                          </span>
                          <span className="tabular-nums">{productionItems.length} items · {fmt(productionUnits)} u</span>
                        </div>
                        <div className="mt-0.5 text-[9px] text-orange-700/80 dark:text-orange-300/80">
                          DeliveryDate per line: <strong>today + leadTime</strong> per SKU
                        </div>
                      </div>
                    )}
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
                    await onCreatePO();
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
    </>
  );

  // ─── Docked: render inline (sin portal, sin fixed) ───────────────────────
  if (docked) {
    return (
      <div className="flex h-full w-[340px] flex-col overflow-hidden border-l border-border bg-card">
        {cardBody}
      </div>
    );
  }

  // ─── Flotante (default): portal + fixed draggable ────────────────────────
  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        style={{ left: pos.x, top: pos.y }}
        className="pointer-events-auto fixed z-[60] w-[340px] bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {cardBody}
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

// ─── Cart section (Container or Production bucket) ──────────────────────────-
function CartSection({
  title, icon, accentClass, items, subtotal, onRemove, onUpdateQty,
}: {
  title: string;
  icon: React.ReactNode;
  accentClass: string;
  items: POBuilderItem[];
  subtotal: number;
  onRemove: (sku: string, poType: POType) => void;
  onUpdateQty: (sku: string, poType: POType, qty: number) => void;
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className={`flex items-center justify-between px-3 py-1.5 ${accentClass}`}>
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
          {icon}
          <span>{title}</span>
          <span className="rounded-full bg-white/70 dark:bg-black/30 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
            {items.length}
          </span>
        </div>
        <span className="text-[11px] font-semibold tabular-nums">{fmt(subtotal)} u</span>
      </div>
      <div className="divide-y divide-border/40">
        {items.map((item) => (
          <div
            key={`${item.sku}::${item.poType}`}
            className="px-3 py-2 flex items-center gap-2 hover:bg-muted/30 transition-colors group"
          >
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono font-medium text-blue-600 dark:text-blue-400 truncate">
                {item.sku}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{item.product}</div>
            </div>
            <QtyInput
              sku={item.sku}
              poType={item.poType}
              quantity={item.quantity}
              onUpdateQty={onUpdateQty}
            />
            <button
              onClick={() => onRemove(item.sku, item.poType)}
              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all p-0.5"
              title="Remove"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Quantity input ──────────────────────────────────────────────────────────-
// Uncontrolled-friendly: keeps a local string while the user types so blank /
// in-progress values do not get clobbered. Commits the parsed number on blur or
// Enter, and clamps to >= 1. Without this, `parseInt('')` is NaN and the parent
// state never updates, leaving the user unable to retype a quantity.
function QtyInput({
  sku,
  poType,
  quantity,
  onUpdateQty,
}: {
  sku: string;
  poType: POType;
  quantity: number;
  onUpdateQty: (sku: string, poType: POType, qty: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(quantity));

  // Sync external changes (e.g. spinner via arrows, or item replaced).
  useEffect(() => {
    setDraft(String(quantity));
  }, [quantity, sku, poType]);

  const commit = () => {
    const v = parseInt(draft, 10);
    if (!Number.isFinite(v) || v < 1) {
      setDraft(String(quantity)); // revert
      return;
    }
    if (v !== quantity) onUpdateQty(sku, poType, v);
    setDraft(String(v));
  };

  return (
    <input
      type="number"
      min={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(String(quantity));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-16 text-right text-xs font-semibold tabular-nums bg-muted/50 border border-border/50 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
    />
  );
}

// Silence unused import warning for ChevronRight (reserved for future expand-from-rail icon).
void ChevronRight;
