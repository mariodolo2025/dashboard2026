// =============================================================================
// AIM 2026 — Complete Projection: per-SKU detail side panel
// =============================================================================

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectionRow, ChartSeries, PipelineEvent } from './projection';
import { addDays } from './projection';
import { StatusPill } from './ProjectionTable';
import { SkuProjectionChart } from './SkuProjectionChart';

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const dec = (n: number) => n.toFixed(2);
const mono = 'font-mono tabular-nums';

interface SkuProjectionPanelProps {
  row: ProjectionRow;
  series: ChartSeries;
  today: Date;
  projectionDate: Date;
  onSetProjectionDate: (d: Date) => void;
  onClose: () => void;
  /** Real PO ETAs for this SKU. When present, "Pipeline fully arrived"
   *  uses the latest event date instead of today+leadTime. */
  events?: PipelineEvent[];
  /** When 'container', the panel surfaces Available China on date alongside
   *  the global on-hand block (China is what actually loads into a container). */
  poMode?: 'container' | 'production' | null;
}

interface DemandStats {
  monthlyAvg: number;
  total12M: number;
  peak: number;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

async function fetchSkuStats(sku: string): Promise<DemandStats | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/aim2026-get-dashboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON}`,
        apikey: SUPABASE_ANON,
      },
      body: JSON.stringify({ action: 'demand_history', sku, warehouse: 'all' }),
    });
    const json = await res.json();
    if (!json.success || !json.data) return null;
    const monthMap = new Map<string, number>();
    for (const r of json.data) {
      const d = new Date(r.period_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const totalDemand =
        Number(r.quantity_completed ?? r.quantity_sold ?? 0) +
        Number(r.quantity_placed ?? 0) +
        Number(r.quantity_parked ?? 0) +
        Number(r.quantity_backordered ?? 0) +
        Number(r.component_usage ?? 0);
      monthMap.set(key, (monthMap.get(key) ?? 0) + totalDemand);
    }
    const months = [...monthMap.values()].slice(-12);
    if (months.length === 0) return { monthlyAvg: 0, total12M: 0, peak: 0 };
    const total = months.reduce((a, b) => a + b, 0);
    return {
      monthlyAvg: total / months.length,
      total12M: total,
      peak: Math.max(...months),
    };
  } catch {
    return null;
  }
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-start gap-1 rounded-lg border px-3 py-2.5',
        accent ? 'border-[#ddd6fe] bg-[#ede9fe]/40' : 'border-[#e8e8e3] bg-white',
      )}
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-[#5b6270]">
        {label}
      </span>
      <span className={cn('text-2xl font-bold leading-none text-[#0f1115]', mono)}>{value}</span>
    </div>
  );
}

function WarehouseBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-[#5b6270]">{label}</span>
      <div className="h-2.5 flex-1 overflow-hidden rounded-sm bg-[#f3f3ef]">
        <div className="h-full rounded-sm" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className={cn('w-12 shrink-0 text-right text-xs text-[#2a2f38]', mono)}>{num(value)}</span>
    </div>
  );
}

export function SkuProjectionPanel({
  row,
  series,
  today,
  projectionDate,
  onSetProjectionDate,
  onClose,
  events,
  poMode,
}: SkuProjectionPanelProps) {
  const [stats, setStats] = useState<DemandStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setStatsLoading(true);
    fetchSkuStats(row.sku).then((s) => {
      if (!cancelled) {
        setStats(s);
        setStatsLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [row.sku]);

  const deltaVsToday = row.projectedOnHand - row.sohGlobal;
  const pipelinePct = row.pipeline > 0 ? (row.pipelineReceived / row.pipeline) * 100 : 0;
  const whMax = Math.max(row.sohMain, row.sohChina, row.dhl, row.container, row.onProd, 1);

  const stockoutDate = series.stockoutDay != null ? addDays(today, series.stockoutDay) : null;
  // Use latest real ETA when available; fallback to today+leadTime.
  const lastEventDay = events && events.length > 0 ? Math.max(...events.map((e) => e.day)) : null;
  const pipelineArrivalDay = lastEventDay != null ? lastEventDay : row.leadTime;
  const pipelineArrival = addDays(today, pipelineArrivalDay);
  const pipelineArrivalLabel = lastEventDay != null
    ? (events!.length === 1 ? 'real ETA' : `last of ${events!.length} POs`)
    : `lead time ${row.leadTime}d`;

  return (
    <div className="flex h-full flex-col overflow-auto bg-white">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#e8e8e3] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">SKU detail</div>
            <div className={cn('mt-0.5 text-lg font-bold text-[#0f1115]', mono)}>{row.sku}</div>
          </div>
          <StatusPill status={row.status} />
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]">
          <X size={16} />
        </button>
      </div>

      <div className="flex shrink-0 gap-2 border-b border-[#e8e8e3] px-4 py-2.5">
        <StatCard label="Monthly Avg" value={stats ? num(stats.monthlyAvg) : statsLoading ? '…' : '—'} />
        <StatCard label="12M Total" value={stats ? num(stats.total12M) : statsLoading ? '…' : '—'} />
        <StatCard label="Peak" value={stats ? num(stats.peak) : statsLoading ? '…' : '—'} accent />
      </div>

      <div className="space-y-3 p-3">
        <div className="rounded-lg border border-[#e8e8e3] p-2">
          <SkuProjectionChart series={series} today={today} projectionDate={projectionDate} onSetProjectionDate={onSetProjectionDate} />
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-1 text-[11px] text-[#5b6270]">
            <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 rounded bg-[#7c3aed]" /> With pipeline</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-0 w-3 border-t-2 border-dashed border-[#828a98]" />Demand only</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-0 w-3 border-t-2 border-dashed border-[#dc2626]" />Safety</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-0.5 bg-[#f59e0b]" /> Projection</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-0.5 bg-[#0f1115]" /> Today</span>
          </div>
        </div>

        <div className="rounded-lg border border-[#e8e8e3] bg-[#faf9f7] px-3 py-2.5">
          {poMode === 'container' ? (
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#4c1d95]">
                  Available China on {format(projectionDate, 'd MMM yyyy')}
                </div>
                <div className={cn('mt-0.5 text-3xl font-bold leading-none', mono, row.availableChinaOnDate <= 0 ? 'text-[#dc2626]' : 'text-[#0f1115]')}>
                  {num(row.availableChinaOnDate)}
                </div>
                <div className="mt-1 text-[11px] text-[#5b6270]">
                  China today {num(row.availableChinaToday)} + production arriving {num(row.pipelineReceived)}
                  {row.mainDeficitAtArrival > 0 && (
                    <> − Main deficit (DHL) {num(row.mainDeficitAtArrival)}</>
                  )}
                </div>
              </div>
              <div className="text-right leading-tight">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">Global on hand</div>
                <div className={cn('mt-0.5 text-xl font-bold', mono, row.projectedOnHand <= 0 ? 'text-[#dc2626]' : 'text-[#2a2f38]')}>
                  {num(row.projectedOnHand)}
                </div>
                <div className={cn('text-[11px] font-medium', deltaVsToday >= 0 ? 'text-[#059669]' : 'text-[#dc2626]')}>
                  {deltaVsToday >= 0 ? '+' : '−'}{num(Math.abs(deltaVsToday))} vs today
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">
                  On-hand on {format(projectionDate, 'd MMM yyyy')}
                </div>
                <div className={cn('mt-0.5 text-3xl font-bold leading-none', mono, row.projectedOnHand <= 0 ? 'text-[#dc2626]' : 'text-[#0f1115]')}>
                  {num(row.projectedOnHand)}
                </div>
              </div>
              <div className={cn('text-sm font-medium', deltaVsToday >= 0 ? 'text-[#059669]' : 'text-[#dc2626]')}>
                {deltaVsToday >= 0 ? '+' : '−'}{num(Math.abs(deltaVsToday))} vs today
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-[#e8e8e3] bg-white p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">Calculation</div>
            <div className="space-y-1 text-xs">
              <div className="flex items-center justify-between"><span className="text-[#5b6270]">SOH global</span><span className={cn('text-[#2a2f38]', mono)}>{num(row.sohGlobal)}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#5b6270]">+ Pipeline ({Math.round(pipelinePct)}%)</span><span className={cn('text-[#059669]', mono)}>+{num(row.pipelineReceived)}</span></div>
              <div className="flex items-center justify-between"><span className="text-[#5b6270]">− Demand ({dec(row.effDailyDemand)}/d × {row.t}d)</span><span className={cn('text-[#dc2626]', mono)}>−{num(row.demandConsumed)}</span></div>
              <div className="mt-1 flex items-center justify-between border-t border-[#e8e8e3] pt-1">
                <span className="font-semibold text-[#0f1115]">= On hand</span>
                <span className={cn('font-bold', mono, row.projectedOnHand <= 0 ? 'text-[#dc2626]' : 'text-[#0f1115]')}>{num(row.projectedOnHand)}</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-[#e8e8e3] bg-white p-2.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">Warehouse</div>
            <div className="space-y-1">
              <WarehouseBar label="Main" value={row.sohMain} max={whMax} color="#2563eb" />
              <WarehouseBar label="China" value={row.sohChina} max={whMax} color="#2563eb" />
              <WarehouseBar label="DHL" value={row.dhl} max={whMax} color="#7c3aed" />
              <WarehouseBar label="Container" value={row.container} max={whMax} color="#7c3aed" />
              <WarehouseBar label="On Prod." value={row.onProd} max={whMax} color="#7c3aed" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[#e8e8e3] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">Projected stockout</div>
            {stockoutDate ? (
              <>
                <div className={cn('text-sm font-semibold text-[#dc2626]', mono)}>{format(stockoutDate, 'd MMM yyyy')}</div>
                <div className="text-xs text-[#828a98]">in {series.stockoutDay}d</div>
              </>
            ) : (
              <div className="text-sm font-semibold text-[#059669]">No stockout in {series.horizonDays}d</div>
            )}
          </div>
          <div className="rounded-lg border border-[#e8e8e3] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#828a98]">Pipeline fully arrived</div>
            {row.pipeline > 0 || (events && events.length > 0) ? (
              <>
                <div className={cn('text-sm font-semibold text-[#2a2f38]', mono)}>{format(pipelineArrival, 'd MMM yyyy')}</div>
                <div className="text-xs text-[#828a98]">{pipelineArrivalLabel}</div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-[#828a98]">—</div>
                <div className="text-xs text-[#828a98]">no pipeline</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
