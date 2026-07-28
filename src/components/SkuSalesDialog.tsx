// =============================================================================
// SKU Sales Dialog — the B2C Sales Explorer for one product, as a popup
// =============================================================================
// Opened by clicking a SKU in the Web Upgrade products table. Same shape as the
// AIM 2026 SKU detail dialog, same controls as the explorer tab: date presets,
// custom range, day/week/month granularity and the trend curve.
//
// Its date state is its own — a range picked here does not move the explorer
// tab's, so drilling into one product from Web Upgrade never disturbs the view
// you left behind.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { B2CSalesPanel, DATE_PRESETS } from '@/components/B2CSalesPanel';
import type { SalesGranularity } from '@/lib/aim2026/api';

export function SkuSalesDialog({
  sku,
  productTitle,
  open,
  onClose,
  initialFrom,
  initialTo,
}: {
  sku: string | null;
  productTitle?: string | null;
  open: boolean;
  onClose: () => void;
  /** Window the calling tab is showing (YYYY-MM-DD). The dialog opens on it so
   *  the drill-down answers the same period as the row that was clicked.
   *  Changing it here stays local — the caller's own range never moves. */
  initialFrom?: string;
  initialTo?: string;
}) {
  const fallback = DATE_PRESETS.find((p) => p.label === '90 days')!.range();
  const [from, setFrom] = useState(initialFrom ?? fallback.from);
  const [to, setTo] = useState(initialTo ?? fallback.to);
  const [granularity, setGranularity] = useState<SalesGranularity>('day');
  const [showTrend, setShowTrend] = useState(true);

  // Re-seed each time it opens: the caller's window may have moved, or a
  // different row may have been clicked, since the last time this was mounted.
  useEffect(() => {
    if (!open) return;
    if (initialFrom) setFrom(initialFrom);
    if (initialTo) setTo(initialTo);
  }, [open, sku, initialFrom, initialTo]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !sku) return null;

  // Portalled to <body> on purpose. The Web Upgrade tab lives inside a Radix
  // DialogContent, which is positioned with translate-x/y — a transform makes
  // that element the containing block for every `position: fixed` descendant, so
  // "fixed inset-0" would centre on the dialog box rather than the screen. That
  // is why this popup kept opening pinned near the top.
  //
  // Centred on the viewport; the panel caps at 90vh and scrolls its own body, so
  // a tall report stays centred instead of pushing its header off screen.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 sm:p-6">
      {/* Backdrop click closes; clicks inside must not bubble to it. */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        className="relative flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Shopify sales for ${sku}`}
      >
        <div className="flex flex-none items-start justify-between gap-4 border-b bg-background px-5 py-4 rounded-t-xl">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <Package size={16} className="text-muted-foreground" />
              {sku}
            </h2>
            {productTitle && (
              <p className="text-sm text-muted-foreground truncate">{productTitle}</p>
            )}
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">
              Shopify sales · B2C
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 p-0 flex-shrink-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <B2CSalesPanel
            skus={[sku]}
            from={from}
            to={to}
            onRangeChange={(f, t) => { setFrom(f); setTo(t); }}
            granularity={granularity}
            onGranularityChange={setGranularity}
            showTrend={showTrend}
            onShowTrendChange={setShowTrend}
            showSearch={false}
            compact
          />
        </div>
      </div>
    </div>,
    document.body
  );
}

export default SkuSalesDialog;
