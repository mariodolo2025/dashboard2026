// =============================================================================
// AIM 2026 — Complete Projection: unified help popup
// =============================================================================

import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CONTAINER_TRANSIT_DAYS } from './projection';

interface HelpPopupProps {
  open: boolean;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[#e8e8e3] bg-white p-4">
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-[#4c1d95]">{title}</h3>
      <div className="space-y-2 text-sm text-[#2a2f38]">{children}</div>
    </section>
  );
}

function Formula({ label, formula, example }: { label: string; formula: string; example?: string }) {
  return (
    <div className="rounded-md border border-[#e8e8e3] bg-[#faf9f7] p-2.5">
      <div className="text-xs font-semibold text-[#5b6270]">{label}</div>
      <div className="mt-0.5 font-mono text-xs text-[#0f1115]">{formula}</div>
      {example && <div className="mt-1 text-[11px] italic text-[#828a98]">e.g. {example}</div>}
    </div>
  );
}

function Chip({ color, label }: { color: string; label: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold', color)}>
      {label}
    </span>
  );
}

export function CompleteProjectionHelpPopup({ open, onClose }: HelpPopupProps) {
  if (!open) return null;
  return createPortal(
    <div role="dialog" aria-modal="true" className="pointer-events-auto fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-[#fbfbf9] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-[#7c3aed]">Complete projection</div>
            <h2 className="text-lg font-bold text-[#0f1115]">How it all works</h2>
            <p className="mt-0.5 text-xs text-[#5b6270]">Formulas, modes and what every column means.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="space-y-3">
          <Section title="Core projection">
            <p className="text-xs text-[#5b6270]">For any projection date, each SKU's on-hand is:</p>
            <Formula
              label="On hand on date (global)"
              formula="sohGlobal + pipelineReceived(t) − demandConsumed"
              example="sohGlobal = Main + China + DHL + Container; pipeline = production POs only"
            />
            <Formula
              label="demandConsumed"
              formula="effDailyDemand × t"
              example="effDailyDemand = dailyDemand × scenarioMultiplier; t = days from today"
            />
            <Formula
              label="pipelineReceived(t)"
              formula="Σ qty of production POs with ETA ≤ today + t"
              example="Falls back to a linear pipeline × min(t/leadTime, 1) when ETAs are not loaded"
            />
          </Section>

          <Section title="Container vs Production">
            <p className="text-xs text-[#5b6270]">
              Both modes target the same coverage but the order arrives on a different day. Main keeps consuming until the order lands, so what you need to order is the gap between the coverage target and what Main has left at arrival.
            </p>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="rounded-md border border-[#ddd6fe] bg-[#ede9fe]/40 p-2.5">
                <div className="text-xs font-bold uppercase tracking-wide text-[#4c1d95]">Container</div>
                <div className="mt-1 text-[11px] text-[#5b6270]">Loading happens on the picked date in China; the container then takes <b>{CONTAINER_TRANSIT_DAYS}d</b> sea freight to Main.</div>
                <div className="mt-1.5 font-mono text-[11px] text-[#0f1115]">
                  arrival = loadingDate + {CONTAINER_TRANSIT_DAYS}d
                </div>
                <div className="font-mono text-[11px] text-[#0f1115]">
                  load = max(0, coverageDemand − mainAtArrival)
                </div>
              </div>
              <div className="rounded-md border border-[#fed7aa] bg-[#fff7ed] p-2.5">
                <div className="text-xs font-bold uppercase tracking-wide text-[#c2410c]">Production</div>
                <div className="mt-1 text-[11px] text-[#5b6270]">Lead time is per-SKU (fabrication + shipping). Production qty is sized against the Main level at lead-time arrival.</div>
                <div className="mt-1.5 font-mono text-[11px] text-[#0f1115]">
                  arrival = today + leadTime[sku]
                </div>
                <div className="font-mono text-[11px] text-[#0f1115]">
                  produce = max(0, coverageDemand − mainAtArrival)
                </div>
              </div>
            </div>
            <Formula label="mainAtArrival" formula="max(0, sohMain − effDailyDemand × arrivalDay)" />
          </Section>

          <Section title="Available China on date (Container mode only)">
            <p className="text-xs text-[#5b6270]">
              What can physically be loaded into the container on the loading day. Starts from raw China stock + production POs landing in China by that date, then always subtracts the <b>Main deficit at arrival</b> — units Main needs urgently from China (DHL) before the container lands.
            </p>
            <Formula
              label="Default (toggle OFF)"
              formula="sohChina + Σ POs by date − mainDeficitAtArrival"
            />
            <Formula
              label="Apply China commitments (toggle ON)"
              formula="(sohChina − allocatedChina) + Σ POs − chinaDailyDemand × t − mainDeficitAtArrival"
              example="Adds two more deductions: allocated and projected outbound China-W demand. Default is OFF because Dolo prioritises B2C and most allocations aren't firm."
            />
            <Formula
              label="mainDeficitAtArrival (always applied)"
              formula={`max(0, effDailyDemand × (t + ${CONTAINER_TRANSIT_DAYS}d) − sohMain)`}
              example="If Main runs out before the container lands, those units must ship from China by DHL — they can't be loaded into the container. Applied even when 'Apply China commitments' is OFF."
            />
            <p className="text-[11px] text-[#5b6270]">
              When ON, the allocated + chinaDailyDemand deductions also reduce the global <em>On hand on date</em>. mainDeficitAtArrival doesn't reduce global — it's a routing constraint inside the China-to-Main flow, not extra demand.
            </p>
          </Section>

          <Section title="Container Load colours">
            <p className="text-xs text-[#5b6270]">In container mode, the Container Load cell signals whether China can cover the load:</p>
            <div className="grid grid-cols-1 gap-1.5">
              <div className="flex items-center gap-2 rounded-md bg-[#ede9fe]/60 px-2.5 py-1.5">
                <Chip color="bg-[#ede9fe] text-[#4c1d95]" label="Covered" />
                <span className="text-[11px] text-[#2a2f38]">availableChinaOnDate ≥ load</span>
              </div>
              <div className="flex items-center gap-2 rounded-md bg-amber-50 px-2.5 py-1.5">
                <Chip color="bg-amber-100 text-amber-800" label="Partial" />
                <span className="text-[11px] text-[#2a2f38]">gap &lt; 30% of load — small shortfall</span>
              </div>
              <div className="flex items-center gap-2 rounded-md bg-red-50 px-2.5 py-1.5">
                <Chip color="bg-red-100 text-red-700" label="⚠ Short" />
                <span className="text-[11px] text-[#2a2f38]">gap ≥ 30% — China can't cover; consider production first</span>
              </div>
            </div>
            <p className="text-[11px] text-[#5b6270]">
              Click adds <b>only what China can cover</b> to the container cart. An inline "+ N to production" button appears so you can route the gap to a parallel Production PO.
            </p>
          </Section>

          <Section title="Demand scenarios">
            <p className="text-xs text-[#5b6270]">All projections multiply demand by the selected scenario:</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded border border-[#e8e8e3] bg-white p-2">
                <div className="text-[11px] font-semibold text-[#5b6270]">Low −15%</div>
                <div className="font-mono text-sm text-[#2a2f38]">× 0.85</div>
              </div>
              <div className="rounded border border-[#0f1115] bg-[#0f1115] p-2 text-white">
                <div className="text-[11px] font-semibold">Expected</div>
                <div className="font-mono text-sm">× 1.00</div>
              </div>
              <div className="rounded border border-[#e8e8e3] bg-white p-2">
                <div className="text-[11px] font-semibold text-[#5b6270]">High +20%</div>
                <div className="font-mono text-sm text-[#2a2f38]">× 1.20</div>
              </div>
            </div>
            <p className="text-[11px] text-[#5b6270]">High demand = more units consumed = less stock projected and bigger load/produce qty.</p>
          </Section>

          <Section title="Pack size rounding">
            <p className="text-xs text-[#5b6270]">
              When a SKU has <b>pack size &gt; 1</b>, the qty sent to the cart is rounded to the nearest multiple of the pack size — so you order full boxes, not loose units.
            </p>
            <Formula
              label="Rounding"
              formula="qtyOnCart = max(packSize, round(suggested / packSize) × packSize)"
              example="suggested = 1,537 u, packSize = 200 → cart gets 1,600 u (8 boxes). suggested = 1,520 → 1,400 u (7 boxes)."
            />
            <p className="text-[11px] text-[#5b6270]">
              Pack size is loaded from <code className="font-mono">ProductList.csv</code> in a column named <b>Pack Size</b> (or any of: <em>packsize</em>, <em>carton qty</em>, <em>units per box</em>, <em>case pack</em>, <em>innerpack</em>). Same file as the lead times — load it from Settings → "Load Lead Times from CSV". Missing column or value = 1 (no rounding).
            </p>
          </Section>

          <Section title="Shortcuts">
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-[#2a2f38]">
              <li><b>Click row</b> — open the SKU detail panel.</li>
              <li><b>Click Container Load / To Produce cell</b> — add to cart with suggested qty (rounded to pack).</li>
              <li><b>Ctrl/Cmd + click on Container Load cell</b> — add to Production cart (independent of Container). Uses productionQty if &gt; 0, otherwise coverageDemand (monthly × coverage months) as fallback.</li>
              <li><b>Alt + click on cell</b> — open inline input for custom Container qty.</li>
              <li><b>Click on a cell showing "+ add / custom qty"</b> — open inline input (no suggestion).</li>
            </ul>
          </Section>
        </div>

        <footer className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md bg-[#0f1115] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#2a2f38]">OK</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
