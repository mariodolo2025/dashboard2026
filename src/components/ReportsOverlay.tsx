// =============================================================================
// Reports — full-screen container for op-manager reports.
//
// Body-portaled overlay (same pattern as AIM2026Overlay) with a left sidebar
// to pick a report; the selected report's content renders on the right. New
// reports (e.g. Transports by Market, once Starshipit is connected) are added
// as entries in REPORTS.
// =============================================================================

import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, CalendarRange, Truck, Globe, Gauge, Printer, ShoppingBag, TrendingUp, Landmark, LockKeyhole, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FYReportContent } from '@/components/fyreport/FYReportOverlay';
import { FreightReportContent } from '@/components/fyreport/FreightReportContent';
import { FreightMarketContent } from '@/components/fyreport/FreightMarketContent';
import { ShippingPerformanceContent } from '@/components/fyreport/ShippingPerformanceContent';
import { EcommerceReportContent } from '@/components/fyreport/EcommerceReportContent';
import { GrowthForecastContent } from '@/components/fyreport/GrowthForecastContent';
import { DoloBalanceBoundary } from '@/components/dolo-balance/DoloBalanceBoundary';
import { fetchBalanceAccess } from '@/lib/doloBalanceApi';
import type { DoloBalanceAccess } from '@/lib/doloBalance';
import { supabase } from '@/lib/supabase';

const DoloBalanceContent = lazy(() => import('@/components/dolo-balance/DoloBalanceContent').then(m => ({ default: m.DoloBalanceContent })));

interface ReportsOverlayProps {
  open: boolean;
  onClose: () => void;
  initialReport?: ReportId;
}

type ReportId = 'growth' | 'fy' | 'ecommerce' | 'freight' | 'market' | 'performance' | 'dolo-balance';

// Fiscal year the current reports cover (Jul–Jun).
const FY = 'FY25-26';

const REPORTS: { id: ReportId; label: string; icon: LucideIcon; render: () => JSX.Element }[] = [
  { id: 'dolo-balance', label: 'DOLO Balance', icon: Landmark, render: () => <></> },
  // Forward-looking, so it sits above the FY reports: those close a year, this
  // one plans the next spend. It carries no FY suffix for the same reason.
  { id: 'growth', label: 'Spend to Stock', icon: TrendingUp, render: () => <GrowthForecastContent /> },
  { id: 'fy', label: `FY Report ${FY}`, icon: CalendarRange, render: () => <FYReportContent /> },
  { id: 'ecommerce', label: `E-commerce EOFY ${FY}`, icon: ShoppingBag, render: () => <EcommerceReportContent /> },
  { id: 'freight', label: `Freight by Category ${FY}`, icon: Truck, render: () => <FreightReportContent /> },
  { id: 'market', label: `Freight by Market ${FY}`, icon: Globe, render: () => <FreightMarketContent /> },
  { id: 'performance', label: `Shipping Performance ${FY}`, icon: Gauge, render: () => <ShippingPerformanceContent /> },
];

export function ReportsOverlay({ open, onClose, initialReport = 'fy' }: ReportsOverlayProps) {
  const [active, setActive] = useState<ReportId>(initialReport);
  const [balanceAccess, setBalanceAccess] = useState<DoloBalanceAccess | null>(null);
  const [balanceAccessError, setBalanceAccessError] = useState('');
  const [balancePrintMetadata, setBalancePrintMetadata] = useState('No monthly snapshot selected');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let request = 0;
    let identity: string | null | undefined;
    const refresh = async () => {
      const currentRequest = ++request;
      try {
        const next = await fetchBalanceAccess();
        if (!cancelled && currentRequest === request) { setBalanceAccess(next); setBalanceAccessError(''); }
      } catch (error) {
        if (!cancelled && currentRequest === request) {
          setBalanceAccess(null);
          setBalanceAccessError(error instanceof Error ? error.message : 'Unable to verify access.');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const nextIdentity = session?.user.id ?? null;
      // Clear on identity changes, but do not discard an editor's unsaved form
      // during an ordinary token refresh for the same signed-in user.
      if (identity !== nextIdentity || event === 'SIGNED_OUT') {
        request++;
        setBalanceAccess(null);
      }
      identity = nextIdentity;
      queueMicrotask(() => { if (!cancelled) void refresh(); });
    });
    return () => { cancelled = true; request++; window.clearInterval(timer); window.removeEventListener('focus', focus); subscription.unsubscribe(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A child drawer/help bubble handles its own Escape before Reports closes.
      // Leave the existing Escape behavior of every other report unchanged.
      if (active === 'dolo-balance' && (e.defaultPrevented || document.querySelector('[data-dolo-layer]'))) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, active]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const current = REPORTS.find((r) => r.id === active) ?? REPORTS[0];
  const canViewBalance = balanceAccess?.can_view === true;
  const visibleReports = REPORTS.filter(report => report.id !== 'dolo-balance' || canViewBalance);
  const balanceSelected = current.id === 'dolo-balance';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reports"
      className="pointer-events-auto fixed inset-0 z-[50] flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f5]"
    >
      {/* Print stylesheet — turns the on-screen dashboard into a warm, editorial
          annual-report document (paper background, Fraunces serif display,
          flat blocks instead of cards, terracotta accent). Also: content flows
          across pages (no absolute positioning → no clipping/repeat) and colours
          are forced on (browsers drop them by default). Shared by all reports. */}
      <style>{`
        @media print {
          @page { margin: 16mm 15mm; }
          html, body { background: #F6F1E9 !important; }
          /* Show only the Reports overlay; let it flow normally so it paginates. */
          body > * { display: none !important; }
          body > [role="dialog"][aria-label="Reports"] {
            display: block !important; position: static !important;
            height: auto !important; overflow: visible !important; background: #F6F1E9 !important;
          }
          .reports-no-print, .fy-no-print { display: none !important; }
          .reports-print-only { display: block !important; }
          #reports-print-root {
            display: block !important; position: static !important;
            height: auto !important; overflow: visible !important; background: transparent !important;
            color: #2A211B !important;
          }
          #reports-print-root .overflow-y-auto { overflow: visible !important; height: auto !important; max-height: none !important; }
          #reports-print-root .flex.min-h-0, #reports-print-root .min-h-0 { min-height: 0 !important; }

          /* Force colours (charts, table shading, accents). */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

          /* ── Editorial type ── */
          #reports-print-root { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
          #reports-print-root h1, #reports-print-root h2, #reports-print-root h3,
          #reports-print-root .text-3xl, #reports-print-root .text-2xl, #reports-print-root .text-xl,
          #reports-print-root .reports-print-only h1 {
            font-family: 'Fraunces', Georgia, 'Times New Roman', serif !important;
            letter-spacing: -0.01em;
          }
          #reports-print-root .tabular-nums { font-variant-numeric: tabular-nums; }
          #reports-print-root .text-muted-foreground { color: #8A7B6E !important; }

          /* Paper everywhere (report bodies use their own off-white bg). */
          #reports-print-root [class*="bg-[#f7f7f5]"], #reports-print-root [class*="bg-[#faf9f7]"] { background: transparent !important; }
          /* ── Flat blocks: drop the card chrome, sit content on the paper ── */
          #reports-print-root .bg-card, #reports-print-root .bg-white,
          #reports-print-root .rounded-2xl, #reports-print-root .rounded-xl, #reports-print-root .rounded-lg,
          #reports-print-root [class*="border-[#e8e8e3]"] {
            border: 0 !important; box-shadow: none !important;
            background: transparent !important; border-radius: 0 !important;
          }
          /* Editorial rhythm: a hairline above each stat / section block. */
          #reports-print-root .grid > .bg-card, #reports-print-root .grid > div > .bg-card,
          #reports-print-root .grid > .bg-white, #reports-print-root .grid > div > .bg-white {
            border-top: 1px solid #DCCFBB !important; padding-top: 4px !important;
          }
          /* Tables: warm hairlines. */
          #reports-print-root table td, #reports-print-root table th { border-color: #E4D9C8 !important; }
          #reports-print-root .border-b { border-bottom-color: #E4D9C8 !important; }

          /* ── Cover masthead ── */
          .reports-print-only { padding: 0 0 10px !important; border-bottom: 2px solid #B0562F; margin-bottom: 14px; }
          .reports-print-only h1 { font-size: 30px !important; font-weight: 500 !important; color: #2A211B !important; }
          .reports-print-only p { color: #9A8B79 !important; letter-spacing: .04em; }

          /* Don't split a stat / chart / table across pages. */
          .recharts-wrapper, .recharts-responsive-container, table,
          .fy-print-break, [class*="rounded-xl"], [class*="rounded-lg"] { break-inside: avoid; page-break-inside: avoid; }
          h1, h2, h3 { break-after: avoid; }
        }
      `}</style>

      {/* Top bar */}
      <div className="reports-no-print flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-3">
        <h2 className="text-base font-bold text-[#0f1115]">Reports</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            disabled={balanceSelected && !canViewBalance}
            className="flex items-center gap-1.5 rounded-md border border-[#e8e8e3] px-2.5 py-1.5 text-xs font-medium text-[#2a2f38] hover:bg-[#faf9f7]"
          >
            <Printer size={14} /> Print / PDF
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Sidebar + content */}
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Report selection" className={cn('reports-no-print shrink-0 border-r border-[#e8e8e3] bg-white', balanceSelected ? 'w-14 p-1 sm:w-52 sm:p-2' : 'w-52 p-2')}>
          {visibleReports.map((r) => {
            const Icon = r.icon;
            return (
              <button
                key={r.id}
                type="button"
                aria-label={r.label}
                aria-current={active === r.id ? 'page' : undefined}
                title={r.label}
                onClick={() => setActive(r.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg py-2 text-left text-sm font-medium',
                  balanceSelected ? 'justify-center px-2 sm:justify-start sm:px-3' : 'px-3',
                  active === r.id ? 'bg-[#f1f1ee] text-foreground' : 'text-muted-foreground hover:bg-[#faf9f7]',
                )}
              >
                <Icon className="h-4 w-4" />
                {balanceSelected ? <span className="hidden sm:inline">{r.label}</span> : r.label}
              </button>
            );
          })}
        </nav>

        {/* Keep each report mounted only when active so it loads on demand.
            key forces a fresh mount when switching. */}
        <div className={cn('min-h-0 flex-1', balanceSelected && 'min-w-0')} id="reports-print-root" key={current.id} data-report={current.id}>
          {/* Print-only masthead so every printout is labelled. */}
          <div className="reports-print-only hidden px-6 pt-5">
            <h1 className="text-xl font-bold text-[#0f1115]">Dolo Ent PTY Ltd — {current.label}</h1>
            <p className="text-xs text-[#828a98]">{balanceSelected ? (canViewBalance ? balancePrintMetadata : 'Access restricted') : 'Frozen snapshot · fiscal year Jul 2025 – Jun 2026'}</p>
          </div>
          {balanceSelected ? (
            canViewBalance && balanceAccess ? (
              <DoloBalanceBoundary onLeaveBalance={() => setActive('fy')}>
                <Suspense fallback={<div role="status" className="p-8 text-sm text-muted-foreground">Loading DOLO Balance…</div>}>
                  <DoloBalanceContent access={balanceAccess} onPrintMetadata={setBalancePrintMetadata} />
                </Suspense>
              </DoloBalanceBoundary>
            ) : (
              <div role="status" className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <LockKeyhole className="h-6 w-6 text-muted-foreground" />
                <h3 className="text-lg font-semibold">DOLO Balance is restricted</h3>
                <p className="max-w-md text-sm text-muted-foreground">{balanceAccessError || 'Access must be granted by your administrator. Your other reports are unchanged.'}</p>
              </div>
            )
          ) : current.render()}
        </div>
      </div>
    </div>,
    document.body,
  );
}
