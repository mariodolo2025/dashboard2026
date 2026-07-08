// =============================================================================
// Reports — full-screen container for op-manager reports.
//
// Body-portaled overlay (same pattern as AIM2026Overlay) with a left sidebar
// to pick a report; the selected report's content renders on the right. New
// reports (e.g. Transports by Market, once Starshipit is connected) are added
// as entries in REPORTS.
// =============================================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, CalendarRange, Truck, Globe, Gauge, Printer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FYReportContent } from '@/components/fyreport/FYReportOverlay';
import { FreightReportContent } from '@/components/fyreport/FreightReportContent';
import { FreightMarketContent } from '@/components/fyreport/FreightMarketContent';
import { ShippingPerformanceContent } from '@/components/fyreport/ShippingPerformanceContent';

interface ReportsOverlayProps {
  open: boolean;
  onClose: () => void;
}

type ReportId = 'fy' | 'freight' | 'market' | 'performance';

// Fiscal year the current reports cover (Jul–Jun).
const FY = 'FY25-26';

const REPORTS: { id: ReportId; label: string; icon: any; render: () => JSX.Element }[] = [
  { id: 'fy', label: `FY Report ${FY}`, icon: CalendarRange, render: () => <FYReportContent /> },
  { id: 'freight', label: `Freight by Category ${FY}`, icon: Truck, render: () => <FreightReportContent /> },
  { id: 'market', label: `Freight by Market ${FY}`, icon: Globe, render: () => <FreightMarketContent /> },
  { id: 'performance', label: `Shipping Performance ${FY}`, icon: Gauge, render: () => <ShippingPerformanceContent /> },
];

export function ReportsOverlay({ open, onClose }: ReportsOverlayProps) {
  const [active, setActive] = useState<ReportId>('fy');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const current = REPORTS.find((r) => r.id === active) ?? REPORTS[0];

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reports"
      className="pointer-events-auto fixed inset-0 z-[50] flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f5]"
    >
      {/* Print stylesheet — shared by all reports. The on-screen app is a fixed,
          scrolling overlay; for print we hide the chrome, lift only the active
          report body to the page, let it flow (no clipping), keep colours
          (charts / badges / table shading) and avoid splitting cards. */}
      <style>{`
        @media print {
          @page { margin: 12mm; }
          html, body { background: #fff !important; }
          body * { visibility: hidden !important; }
          #reports-print-root, #reports-print-root * { visibility: visible !important; }
          #reports-print-root {
            position: absolute !important; inset: 0 !important;
            height: auto !important; overflow: visible !important;
            background: #fff !important;
          }
          #reports-print-root .overflow-y-auto,
          #reports-print-root .overflow-y-auto * { overflow: visible !important; }
          #reports-print-root .overflow-y-auto { height: auto !important; max-height: none !important; }
          .reports-no-print, .fy-no-print { display: none !important; }
          .reports-print-only { display: block !important; }
          /* Keep every colour when printing (Chrome/Safari drop them otherwise). */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          /* Don't split a card / chart / table across pages. */
          .recharts-wrapper, .recharts-responsive-container, table,
          .fy-print-break, [class*="rounded-xl"], [class*="rounded-lg"] { break-inside: avoid; page-break-inside: avoid; }
          h1, h2, h3, p { break-after: avoid; }
        }
      `}</style>

      {/* Top bar */}
      <div className="reports-no-print flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-3">
        <h2 className="text-base font-bold text-[#0f1115]">Reports</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
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
        <nav className="reports-no-print w-52 shrink-0 border-r border-[#e8e8e3] bg-white p-2">
          {REPORTS.map((r) => {
            const Icon = r.icon;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setActive(r.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium',
                  active === r.id ? 'bg-[#f1f1ee] text-foreground' : 'text-muted-foreground hover:bg-[#faf9f7]',
                )}
              >
                <Icon className="h-4 w-4" />
                {r.label}
              </button>
            );
          })}
        </nav>

        {/* Keep each report mounted only when active so it loads on demand.
            key forces a fresh mount when switching. */}
        <div className="min-h-0 flex-1" id="reports-print-root" key={current.id}>
          {/* Print-only masthead so every printout is labelled. */}
          <div className="reports-print-only hidden px-6 pt-5">
            <h1 className="text-xl font-bold text-[#0f1115]">Dolo Ent PTY Ltd — {current.label}</h1>
            <p className="text-xs text-[#828a98]">Frozen snapshot · fiscal year Jul 2025 – Jun 2026</p>
          </div>
          {current.render()}
        </div>
      </div>
    </div>,
    document.body,
  );
}
