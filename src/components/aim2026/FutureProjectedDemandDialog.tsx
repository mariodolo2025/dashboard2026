import { useMemo, useState } from 'react';
import { format, differenceInDays, addDays, startOfDay, isPast, isToday } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  Calendar as CalendarIcon,
  AlertTriangle,
  CheckCircle2,
  Zap,
  Package,
  TrendingDown,
  Clock,
  ShoppingCart,
  BarChart3,
  Table2,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SKURow, CoverageSegment } from '@/lib/aim2026/types';
import type { SKUProjection, RiskLevel } from '@/lib/aim2026/types';
import { runProjections } from '@/lib/aim2026/projectionUtils';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DateRange { from?: Date; to?: Date; }

interface FutureProjectedDemandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filteredData: SKURow[];
  dateRange?: DateRange;
}

// ─── Segment styles ──────────────────────────────────────────────────────────

const SEG_STYLE: Record<
  CoverageSegment['source'],
  { bg: string; bgLight: string; text: string; border: string; label: string; dot: string }
> = {
  MAIN:       { bg: 'bg-blue-500',    bgLight: 'bg-blue-500/15',    text: 'text-white', border: 'border-blue-600',    label: 'Main WH',       dot: 'bg-blue-500' },
  CHINA:      { bg: 'bg-violet-500',  bgLight: 'bg-violet-500/15',  text: 'text-white', border: 'border-violet-600',  label: 'China WH',      dot: 'bg-violet-500' },
  DHL:        { bg: 'bg-amber-500',   bgLight: 'bg-amber-500/15',   text: 'text-white', border: 'border-amber-600',   label: 'DHL Transit',   dot: 'bg-amber-500' },
  CONTAINER:  { bg: 'bg-orange-500',  bgLight: 'bg-orange-500/15',  text: 'text-white', border: 'border-orange-600',  label: 'Container',     dot: 'bg-orange-500' },
  PRODUCTION: { bg: 'bg-emerald-500', bgLight: 'bg-emerald-500/15', text: 'text-white', border: 'border-emerald-600', label: 'On Production', dot: 'bg-emerald-500' },
};

// ─── Risk config ────────────────────────────────────────────────────────────

const RISK_CFG: Record<RiskLevel, { label: string; icon: typeof AlertTriangle; chip: string; row: string }> = {
  CRITICAL:       { label: 'Critical',       icon: AlertTriangle, chip: 'bg-red-500/15 text-red-500 border border-red-500/30',       row: 'bg-red-500/5' },
  ORDER_REQUIRED: { label: 'Order Required', icon: Zap,           chip: 'bg-amber-500/15 text-amber-500 border border-amber-500/30', row: 'bg-amber-500/5' },
  SAFE:           { label: 'Safe',           icon: CheckCircle2,  chip: 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/30', row: '' },
};

// ─── Tiny helpers ───────────────────────────────────────────────────────────

function RiskBadge({ level }: { level: RiskLevel }) {
  const c = RISK_CFG[level]; const Icon = c.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap', c.chip)}>
      <Icon size={10} />{c.label}
    </span>
  );
}

function KPIChip({ label, count, level }: { label: string; count: number; level: RiskLevel }) {
  const c = RISK_CFG[level]; const Icon = c.icon;
  return (
    <div className={cn('flex items-center gap-2 rounded-lg px-3 py-2 border', c.chip)}>
      <Icon size={14} />
      <span className="text-sm font-bold">{count}</span>
      <span className="text-xs opacity-80">{label}</span>
    </div>
  );
}

const fmtD = (d: Date) => format(d, 'dd MMM');
const fmtFull = (d: Date) => format(d, 'dd MMM yyyy');

function deadlineUrgency(d: Date | null | undefined): string {
  if (!d) return '';
  const days = differenceInDays(d, new Date());
  if (days < 0) return 'text-red-500 font-bold';
  if (days <= 3) return 'text-red-500 font-semibold';
  if (days <= 7) return 'text-amber-500 font-semibold';
  return 'text-violet-600 font-medium';
}

// ─── Swimlane (Coverage Chain) ───────────────────────────────────────────────

const LABEL_W    = 120; // px — fixed label column
const ROW_H      = 30;  // px — each source row height
const GAP_ROW_H  = 22;  // px — GAP row height
const MILESTONE_H = 44; // px — milestone header area height

/** Milestone event shown in the header and as a spanning vertical line. */
interface KeyEvent {
  day: number;
  date: string;           // formatted date, e.g. "01 Apr"
  eventLabel: string;     // e.g. "DHL arrives"
  lineClass: string;      // border colour
  textClass: string;      // text colour
  dashed?: boolean;       // dashed line (deadlines)
  strong?: boolean;       // thicker line
}

/**
 * Full swimlane for one SKU.
 *
 * Layout (two-column: labels | bars):
 *   [LABEL_W fixed] [flex-1 relative — all bars + spanning vertical lines]
 *
 * The relative bars column holds:
 *   - Milestone header (MILESTONE_H): date chips + event names at the top
 *   - Spanning vertical lines: absolute children covering from milestone bottom to bars bottom
 *   - Per-source bar rows: waiting zone / transit box / coverage bar
 *   - GAP row
 */
function SKUSwimlane({
  p,
  daysToTarget,
  targetDate,
}: {
  p: SKUProjection;
  daysToTarget: number;
  targetDate: Date;
}) {
  const today = startOfDay(new Date());

  // displayRange: at minimum target + 10, extend to show late arrivals (capped at +60d)
  const maxArrival = Math.max(0, ...p.coverageChain.map((s) => s.arrivalDay));
  const displayRange = Math.max(daysToTarget + 10, Math.min(maxArrival + 20, daysToTarget + 60));

  const pct = (day: number) => `${(day / displayRange) * 100}%`;

  // ── Key events (milestone header + spanning vertical lines) ───────────────
  const keyEvents: KeyEvent[] = [];

  const addEvent = (
    day: number,
    eventLabel: string,
    lineClass: string,
    textClass: string,
    options: { dashed?: boolean; strong?: boolean } = {}
  ) => {
    if (day > 0 && day <= displayRange) {
      keyEvents.push({
        day,
        date: fmtD(addDays(today, day)),
        eventLabel,
        lineClass,
        textClass,
        ...options,
      });
    }
  };

  // China order deadline (dashed line — action required)
  if (p.chinaOrderDeadline) {
    const d = differenceInDays(startOfDay(p.chinaOrderDeadline), today);
    addEvent(d, '← order China', 'border-violet-500', 'text-violet-600 font-semibold', { dashed: true });
  }

  // DHL in transit arrives
  const dhlSeg = p.coverageChain.find((s) => s.source === 'DHL');
  if (dhlSeg) addEvent(dhlSeg.arrivalDay, 'DHL arrives', 'border-amber-400/80', 'text-amber-500');

  // Container arrives
  const contSeg = p.coverageChain.find((s) => s.source === 'CONTAINER');
  if (contSeg) addEvent(contSeg.arrivalDay, 'Container', 'border-orange-400/80', 'text-orange-500');

  // China arrives (before Tier-1 runs out — separate milestone so the gap is visible)
  const chinaSeg = p.coverageChain.find((s) => s.source === 'CHINA');
  if (chinaSeg && p.chinaOrderDeadline) {
    addEvent(chinaSeg.arrivalDay, 'China arrives', 'border-violet-400', 'text-violet-500');
  }

  // Tier-1 runs out (always a separate line from China arrives)
  if (p.tier1StockoutDay) {
    addEvent(p.tier1StockoutDay, 'Tier-1 out', 'border-rose-500', 'text-rose-500', { strong: true });
  }

  // Production arrives
  const prodSeg = p.coverageChain.find((s) => s.source === 'PRODUCTION');
  if (prodSeg && prodSeg.arrivalDay !== chinaSeg?.arrivalDay) {
    addEvent(prodSeg.arrivalDay, 'Production ↓', 'border-emerald-400/80', 'text-emerald-500');
  }

  // Gap order deadline (dashed, only if gap exists)
  if (p.orderDeadline && p.gapDays > 0) {
    const d = differenceInDays(startOfDay(p.orderDeadline), today);
    addEvent(d, '← order gap fill', 'border-red-500', 'text-red-500 font-semibold', { dashed: true });
  }

  // Combined stockout / gap start (only if different from tier1)
  if (p.combinedStockoutDay && p.combinedStockoutDay !== p.tier1StockoutDay) {
    addEvent(p.combinedStockoutDay, 'All supply out', 'border-red-400', 'text-red-500', { strong: true });
  }

  // Target date (always last)
  keyEvents.push({
    day: daysToTarget,
    date: fmtD(targetDate),
    eventLabel: 'TARGET',
    lineClass: 'border-primary',
    textClass: 'text-primary font-bold',
    strong: true,
  });

  // ── Gap bar metrics ────────────────────────────────────────────────────────
  const gapStartDay    = p.combinedStockoutDay ?? daysToTarget;
  const gapStartPct    = p.gapDays > 0 ? (Math.min(gapStartDay, daysToTarget) / displayRange) * 100 : null;
  const gapWidthPct    = p.gapDays > 0 ? (p.gapDays / displayRange) * 100 : 0;
  const gapDeadlinePct = p.orderDeadline
    ? (Math.max(0, differenceInDays(startOfDay(p.orderDeadline), today)) / displayRange) * 100
    : null;

  return (
    <div className={cn('rounded-lg border p-3', RISK_CFG[p.riskLevel].row)}>
      {/* SKU header */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="font-mono text-sm font-bold">{p.sku}</span>
        <span className="text-xs text-muted-foreground truncate max-w-[200px]">{p.product}</span>
        <span className="text-[10px] font-bold bg-muted rounded px-1.5 py-0.5">{p.abcClass}</span>
        <span className="text-xs text-muted-foreground">{p.dailyDemand.toFixed(1)} u/day</span>
        <div className="ml-auto"><RiskBadge level={p.riskLevel} /></div>
      </div>

      {/* ── Two-column layout ─────────────────────────────────────────────── */}
      <div className="flex gap-0">

        {/* LEFT: labels column */}
        <div className="shrink-0 flex flex-col" style={{ width: LABEL_W }}>
          {/* Spacer matching milestone header */}
          <div style={{ height: MILESTONE_H }} />

          {/* Per-source labels */}
          {p.coverageChain.map((seg) => {
            const s = SEG_STYLE[seg.source];
            return (
              <div
                key={seg.source}
                className="flex flex-col items-end justify-center pr-2"
                style={{ height: ROW_H, marginBottom: 2 }}
              >
                <span className="text-xs font-medium leading-tight" style={{ color: 'hsl(var(--foreground))' }}>
                  <span className={cn('inline-block w-2 h-2 rounded-sm mr-1 align-middle', s.dot)} />
                  {s.label}
                </span>
                <span className="text-[10px] text-muted-foreground/60 leading-tight">
                  {seg.units.toLocaleString()} u
                </span>
                {!seg.isAutomatic && !seg.coShippedWithChina && (
                  <span className="text-[9px] text-amber-500 leading-tight font-medium">⚡ action req.</span>
                )}
                {seg.coShippedWithChina && (
                  <span className="text-[9px] text-violet-400 leading-tight">↑ ships w/ China</span>
                )}
              </div>
            );
          })}

          {/* GAP label */}
          {p.gapDays > 0 && (
            <div
              className="flex items-center justify-end pr-2"
              style={{ height: GAP_ROW_H, marginBottom: 2 }}
            >
              <span className="text-xs font-semibold text-red-500">GAP</span>
            </div>
          )}
        </div>

        {/* RIGHT: bars + spanning lines */}
        <div className="flex-1 relative overflow-visible">

          {/* ── MILESTONE HEADER ─────────────────────────────────────────── */}
          {/* Date chips positioned above the bars; spanning lines hang from here down */}
          <div className="relative" style={{ height: MILESTONE_H }}>
            {/* "Today" at left edge */}
            <div
              className="absolute bottom-1 flex flex-col items-center"
              style={{ left: 0, transform: 'translateX(-50%)' }}
            >
              <span className="text-[10px] font-semibold text-muted-foreground">Today</span>
            </div>

            {keyEvents.map((evt) => (
              <div
                key={`lbl-${evt.day}-${evt.eventLabel}`}
                className="absolute bottom-1 flex flex-col items-center"
                style={{ left: pct(evt.day), transform: 'translateX(-50%)', maxWidth: 72 }}
              >
                {/* Date badge */}
                <span
                  className={cn(
                    'text-[11px] font-bold whitespace-nowrap leading-tight border rounded px-1 bg-background shadow-sm',
                    evt.textClass,
                    evt.lineClass.replace('border-', 'border-')
                  )}
                >
                  {evt.date}
                </span>
                {/* Event name */}
                <span className={cn('text-[9px] text-center leading-tight whitespace-nowrap mt-0.5', evt.textClass)}>
                  {evt.eventLabel}
                </span>
              </div>
            ))}
          </div>

          {/* ── SPANNING VERTICAL LINES ──────────────────────────────────── */}
          {/* Absolute, positioned from bottom of milestone header to bottom of bars area */}
          {keyEvents.map((evt) => (
            <div
              key={`vline-${evt.day}-${evt.eventLabel}`}
              className={cn(
                'absolute pointer-events-none z-10',
                evt.strong ? 'border-l-2' : 'border-l',
                evt.dashed ? 'border-dashed' : '',
                evt.lineClass
              )}
              style={{ left: pct(evt.day), top: MILESTONE_H, bottom: 0 }}
            />
          ))}

          {/* ── SOURCE BAR ROWS ────────────────────────────────────────────── */}
          {p.coverageChain.map((seg) => {
            const s = SEG_STYLE[seg.source];
            const waitingPct   = (seg.transitStartDay / displayRange) * 100;
            const transitLPct  = (seg.transitStartDay / displayRange) * 100;
            const arrivalLPct  = (seg.arrivalDay / displayRange) * 100;
            const transitW     = arrivalLPct - transitLPct;

            // Bar start: automatic sources begin at consumptionStartDay (no overlap with prior tier).
            // Ordered sources (China, Production) begin at arrivalDay (creates 3-day safety overlap).
            const barStartDay  = seg.isAutomatic ? seg.consumptionStartDay : seg.arrivalDay;
            const barEndDay    = seg.consumptionStartDay + seg.coveragePotentialDays;
            const coverageL    = (barStartDay / displayRange) * 100;
            const coverageW    = ((barEndDay - barStartDay) / displayRange) * 100;

            const hasWaiting   = seg.transitStartDay > 0;
            const hasTransit   = seg.arrivalDay > seg.transitStartDay;
            const overflows    = barEndDay > displayRange;
            const isVioletType = seg.source === 'CHINA' || seg.coShippedWithChina;

            return (
              <div
                key={seg.source}
                className="relative z-20"
                style={{ height: ROW_H, marginBottom: 2 }}
              >
                {/* WAITING ZONE: stock is in China WH, not yet ordered */}
                {hasWaiting && (
                  <div
                    className={cn(
                      'absolute top-1 bottom-1 border border-dashed rounded flex items-center px-1.5 overflow-hidden',
                      isVioletType
                        ? 'border-violet-300/40 bg-violet-500/5'
                        : 'border-emerald-300/40 bg-emerald-500/5'
                    )}
                    style={{ left: 0, width: `${waitingPct}%` }}
                    title={`${seg.units.toLocaleString()} units in China WH · order by ${seg.orderDeadline ? fmtFull(seg.orderDeadline) : 'deadline'}`}
                  >
                    {waitingPct > 8 && (
                      <span className={cn('text-[9px] truncate', isVioletType ? 'text-violet-400/80' : 'text-emerald-400/80')}>
                        in China WH
                      </span>
                    )}
                  </div>
                )}

                {/* TRANSIT box: transitStartDay → arrivalDay */}
                {hasTransit && transitW > 0 && (
                  <div
                    className="absolute top-0 h-full border border-dashed border-muted-foreground/40 bg-muted/20 flex items-center justify-center z-20"
                    style={{ left: `${transitLPct}%`, width: `${Math.max(transitW, 0.5)}%` }}
                    title={`${seg.arrivalDay - seg.transitStartDay}d DHL transit`}
                  >
                    {transitW > 4 && (
                      <span className="text-[9px] text-muted-foreground/60 whitespace-nowrap">
                        {seg.arrivalDay - seg.transitStartDay}d
                      </span>
                    )}
                  </div>
                )}

                {/* COVERAGE bar */}
                {coverageW > 0 && (
                  <div
                    className={cn(
                      'absolute top-0 h-full flex items-center overflow-hidden z-20',
                      s.bg,
                      !hasTransit && barStartDay === 0 ? 'rounded' : 'rounded-r'
                    )}
                    style={{ left: `${coverageL}%`, width: `${Math.max(coverageW, 0.3)}%`, minWidth: 2 }}
                    title={`${s.label}: ${Math.round(seg.coveragePotentialDays)}d coverage · 90% shipped`}
                  >
                    {coverageW > 5 && (
                      <span className={cn('text-[10px] px-1.5 font-medium whitespace-nowrap', s.text)}>
                        {seg.units.toLocaleString()}u · {Math.round(seg.coveragePotentialDays)}d
                      </span>
                    )}
                    {overflows && <span className="ml-auto pr-1 text-[10px] text-white/80">→</span>}
                  </div>
                )}
              </div>
            );
          })}

          {/* ── GAP ROW ───────────────────────────────────────────────────── */}
          {p.gapDays > 0 && gapStartPct !== null && (
            <div
              className="relative z-20"
              style={{ height: GAP_ROW_H, marginBottom: 2 }}
            >
              <div
                className="absolute top-0.5 bottom-0.5 bg-red-500/15 border border-dashed border-red-500/50 rounded flex items-center justify-center text-[10px] text-red-500 font-semibold z-20"
                style={{ left: `${gapStartPct}%`, width: `${Math.max(gapWidthPct, 0.5)}%` }}
                title={`${Math.round(p.gapDays)}d gap · ${p.gapUnits.toLocaleString()} units needed`}
              >
                {gapWidthPct > 5 ? `${Math.round(p.gapDays)}d · ${p.gapUnits.toLocaleString()}u` : ''}
              </div>
              {/* Gap order deadline vertical line on gap row */}
              {gapDeadlinePct !== null && gapDeadlinePct >= 0 && gapDeadlinePct <= 100 && (
                <div
                  className="absolute top-0 bottom-0 border-l-2 border-dashed border-red-500 z-30"
                  style={{ left: `${gapDeadlinePct}%` }}
                  title={`Order gap fill by ${p.orderDeadline ? fmtFull(p.orderDeadline) : ''}`}
                />
              )}
            </div>
          )}

        </div> {/* end bars column */}
      </div> {/* end two-column layout */}

      {/* Summary line */}
      <div className="mt-2">
        {p.gapDays === 0 ? (
          <div className="flex items-center gap-1 text-[10px] text-emerald-600">
            <CheckCircle2 size={10} />
            Fully covered · {p.projectedFinalStock.toLocaleString()} u remaining at target
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
            {p.chinaOrderDeadline && (
              <span className={cn('flex items-center gap-1', deadlineUrgency(p.chinaOrderDeadline))}>
                <span className={cn('w-2 h-2 rounded-sm inline-block', SEG_STYLE.CHINA.dot)} />
                Order China{p.productionIncludedInChina ? ' + Prod.' : ''} by {fmtD(p.chinaOrderDeadline)}
                {(isPast(p.chinaOrderDeadline) || isToday(p.chinaOrderDeadline)) && ' ⚠ URGENT'}
              </span>
            )}
            {p.orderDeadline && (
              <span className={cn('flex items-center gap-1', deadlineUrgency(p.orderDeadline))}>
                <AlertTriangle size={9} />
                Order {p.recommendedOrder.toLocaleString()} u gap fill by {fmtD(p.orderDeadline)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Action Table ────────────────────────────────────────────────────────────

type ActionType = 'china' | 'production-wave' | 'gap';

interface ActionRow {
  sku: string;
  product: string;
  action: string;
  units: number;
  orderBy: Date;
  daysLeft: number;
  type: ActionType;
  note?: string;
}

function ActionTable({ projections }: { projections: SKUProjection[] }) {
  const today = startOfDay(new Date());

  const actions: ActionRow[] = [];
  for (const p of projections) {
    // 1. China WH order (Tier 2, action required)
    if (p.chinaOrderDeadline) {
      const chinaSeg = p.coverageChain.find((s) => s.source === 'CHINA');
      const note = p.productionIncludedInChina
        ? 'Includes production units (ready before order departs)'
        : undefined;
      actions.push({
        sku: p.sku,
        product: p.product,
        action: 'Order China WH via DHL',
        units: chinaSeg?.units ?? 0,
        orderBy: p.chinaOrderDeadline,
        daysLeft: differenceInDays(p.chinaOrderDeadline, today),
        type: 'china',
        note,
      });
    }

    // 2. Production wave order (if NOT merged into China shipment)
    const prodSeg = p.coverageChain.find((s) => s.source === 'PRODUCTION');
    if (prodSeg?.orderDeadline) {
      actions.push({
        sku: p.sku,
        product: p.product,
        action: 'Order production units from China (when ready)',
        units: prodSeg.units,
        orderBy: prodSeg.orderDeadline,
        daysLeft: differenceInDays(prodSeg.orderDeadline, today),
        type: 'production-wave',
        note: `Production ready in China ~${Math.round(prodSeg.transitStartDay)}d from now`,
      });
    }

    // 3. Gap fill order (any remaining gap after all Tier 2 sources)
    if (p.orderDeadline && p.recommendedOrder > 0) {
      actions.push({
        sku: p.sku,
        product: p.product,
        action: 'Order gap fill (+10% buffer)',
        units: p.recommendedOrder,
        orderBy: p.orderDeadline,
        daysLeft: differenceInDays(p.orderDeadline, today),
        type: 'gap',
      });
    }
  }

  if (actions.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-600 py-3 px-1">
        <CheckCircle2 size={14} />
        No actions required — all SKUs are fully covered through the target date.
      </div>
    );
  }

  actions.sort((a, b) => a.daysLeft - b.daysLeft);

  const dotColor: Record<ActionType, string> = {
    'china':            SEG_STYLE.CHINA.dot,
    'production-wave':  SEG_STYLE.PRODUCTION.dot,
    'gap':              'bg-red-500',
  };

  return (
    <div className="overflow-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">SKU</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Action</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Units</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Order By</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Days Left</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Arrives In</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a, i) => (
            <tr key={i} className={cn(
              'border-b last:border-0 hover:bg-muted/30',
              a.daysLeft < 0 ? 'bg-red-500/5' : a.daysLeft <= 3 ? 'bg-amber-500/5' : ''
            )}>
              <td className="px-3 py-2 font-mono font-medium">{a.sku}</td>
              <td className="px-3 py-2">
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('w-2 h-2 rounded-sm shrink-0', dotColor[a.type])} />
                    {a.action}
                  </span>
                  {a.note && (
                    <span className="text-[10px] text-muted-foreground pl-3.5">{a.note}</span>
                  )}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {a.units.toLocaleString()}
              </td>
              <td className={cn('px-3 py-2 font-medium', deadlineUrgency(a.orderBy))}>
                {fmtFull(a.orderBy)}
                {a.daysLeft < 0 && <span className="ml-1 text-red-500 text-[10px]">OVERDUE</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {a.daysLeft < 0
                  ? <span className="text-red-500 font-bold">{Math.abs(a.daysLeft)}d ago</span>
                  : a.daysLeft === 0
                  ? <span className="text-red-500 font-bold">TODAY</span>
                  : <span className={a.daysLeft <= 7 ? 'text-amber-500 font-semibold' : ''}>{a.daysLeft}d</span>
                }
              </td>
              <td className="px-3 py-2 text-muted-foreground">~7 days (DHL)</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Coverage Chain View ─────────────────────────────────────────────────────

function CoverageChainView({
  projections,
  daysToTarget,
  targetDate,
}: {
  projections: SKUProjection[];
  daysToTarget: number;
  targetDate: Date;
}) {
  if (projections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
        <Layers size={32} className="opacity-40" />
        <p className="text-sm">No SKUs to display.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground px-1">
        <span className="font-medium text-foreground/60 mr-1">Automatic:</span>
        {(['MAIN', 'DHL', 'CONTAINER'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={cn('inline-block w-2 h-2 rounded-sm', SEG_STYLE[k].bg)} />{SEG_STYLE[k].label}
          </span>
        ))}
        <span className="font-medium text-foreground/60 mx-1">Action required:</span>
        {(['CHINA', 'PRODUCTION'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={cn('inline-block w-2 h-2 rounded-sm', SEG_STYLE[k].bg)} />{SEG_STYLE[k].label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-red-500/20 border border-dashed border-red-500/50" />Gap
        </span>
        <span className="ml-1 flex items-center gap-1">
          <span className="inline-block w-4 border-t-2 border-dashed border-muted-foreground/50" />transit window
        </span>
      </div>

      {/* SKU swimlanes */}
      <div className="space-y-3">
        {projections.map((p) => (
          <SKUSwimlane
            key={p.sku}
            p={p}
            daysToTarget={daysToTarget}
            targetDate={targetDate}
          />
        ))}
      </div>

      {/* Action table */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <ShoppingCart size={12} />
          Required Actions — sorted by urgency
        </h4>
        <ActionTable projections={projections} />
      </div>
    </div>
  );
}

// ─── Summary Table ───────────────────────────────────────────────────────────

function SummaryTable({ projections }: { projections: SKUProjection[] }) {
  if (projections.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
        <Package size={32} className="opacity-40" />
        <p className="text-sm">No SKUs to display.</p>
      </div>
    );
  }

  const getSeg = (p: SKUProjection, src: CoverageSegment['source']) =>
    p.coverageChain.find((s) => s.source === src);

  return (
    <div className="overflow-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">SKU</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Product</th>
            <th className="px-3 py-2 text-center font-medium text-muted-foreground">ABC</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Daily</th>
            {(['MAIN','CHINA','DHL','CONTAINER','PRODUCTION'] as const).map((src) => (
              <th key={src} className="px-3 py-2 text-right font-medium text-muted-foreground">
                <span className="flex items-center justify-end gap-1">
                  <span className={cn('w-2 h-2 rounded-sm inline-block', SEG_STYLE[src].dot)} />
                  {src === 'MAIN' ? 'Main' : src === 'CONTAINER' ? 'Cont.' : src === 'PRODUCTION' ? 'Prod.' : src}
                </span>
              </th>
            ))}
            <th className="px-3 py-2 text-right font-medium text-muted-foreground text-red-500/70">GAP</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">China by</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Order by</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Rec. Order</th>
            <th className="px-3 py-2 text-center font-medium text-muted-foreground">Risk</th>
          </tr>
        </thead>
        <tbody>
          {projections.map((p) => (
            <tr key={p.sku} className={cn('border-b last:border-0 hover:bg-muted/30', RISK_CFG[p.riskLevel].row)}>
              <td className="px-3 py-2 font-mono font-medium">{p.sku}</td>
              <td className="px-3 py-2 max-w-[140px] truncate text-muted-foreground">{p.product}</td>
              <td className="px-3 py-2 text-center">
                <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold bg-muted">{p.abcClass}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{p.dailyDemand.toFixed(1)}</td>
              {(['MAIN','CHINA','DHL','CONTAINER','PRODUCTION'] as const).map((src) => {
                const seg = getSeg(p, src);
                const days = seg ? Math.round(seg.coveragePotentialDays) : null;
                return (
                  <td key={src} className="px-3 py-2 text-right tabular-nums">
                    {days !== null
                      ? <span className={src === 'CHINA' ? deadlineUrgency(seg?.orderDeadline ?? null) : ''}>{days}d</span>
                      : <span className="text-muted-foreground/40">—</span>}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-right tabular-nums">
                {p.gapDays > 0
                  ? <span className="text-red-500 font-semibold">{Math.round(p.gapDays)}d</span>
                  : <span className="text-emerald-500">—</span>}
              </td>
              <td className={cn('px-3 py-2 whitespace-nowrap', deadlineUrgency(p.chinaOrderDeadline))}>
                {p.chinaOrderDeadline ? format(p.chinaOrderDeadline, 'dd MMM') : '—'}
              </td>
              <td className={cn('px-3 py-2 whitespace-nowrap', deadlineUrgency(p.orderDeadline))}>
                {p.orderDeadline ? format(p.orderDeadline, 'dd MMM') : '—'}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {p.recommendedOrder > 0 ? p.recommendedOrder.toLocaleString() : '—'}
              </td>
              <td className="px-3 py-2 text-center">
                <RiskBadge level={p.riskLevel} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Stock Curve ─────────────────────────────────────────────────────────────

const CHART_COLORS = ['#3b82f6','#8b5cf6','#f59e0b','#ef4444','#10b981','#ec4899','#06b6d4','#f97316','#84cc16','#6366f1'];

function StockCurveView({ projections, targetDate }: { projections: SKUProjection[]; targetDate: Date }) {
  const today = startOfDay(new Date());
  const daysToTarget = Math.max(1, differenceInDays(startOfDay(targetDate), today));
  const chartSKUs = projections.slice(0, 10);

  const chartData = useMemo(() => {
    if (!chartSKUs.length) return [];
    const step = Math.max(1, Math.floor(daysToTarget / 60));
    const days = Array.from({ length: Math.floor(daysToTarget / step) + 2 }, (_, i) => Math.min(i * step, daysToTarget));
    const unique = [...new Set(days)];
    return unique.map((d) => {
      const pt: Record<string, number | string> = {
        label: d === 0 ? 'Today' : format(addDays(today, d), 'dd MMM'),
      };
      for (const p of chartSKUs) {
        const nearest = p.timeline.reduce((prev, cur) => {
          return Math.abs(differenceInDays(cur.date, addDays(today, d))) <
            Math.abs(differenceInDays(prev.date, addDays(today, d))) ? cur : prev;
        }, p.timeline[0] ?? { date: today, stock: 0 });
        pt[p.sku] = nearest?.stock ?? 0;
      }
      return pt;
    });
  }, [projections, daysToTarget]);

  if (!chartSKUs.length) return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
      <BarChart3 size={32} className="opacity-40" />
      <p className="text-sm">No data.</p>
    </div>
  );

  return (
    <div className="space-y-2">
      {projections.length > 10 && (
        <p className="text-xs text-muted-foreground px-1">Showing top 10 by urgency.</p>
      )}
      <ResponsiveContainer width="100%" height={340}>
        <AreaChart data={chartData} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v)} width={48} />
          <RechartsTooltip
            contentStyle={{ backgroundColor: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '11px' }}
            formatter={(value: number, name: string) => [`${Math.round(value).toLocaleString()} u`, name]}
          />
          <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeOpacity={0.4} />
          <ReferenceLine x={format(targetDate, 'dd MMM')} stroke="hsl(var(--primary))" strokeDasharray="4 4"
            label={{ value: 'Target', position: 'insideTopRight', fontSize: 10, fill: 'hsl(var(--primary))' }} />
          {chartSKUs.map((p, i) => (
            <Area key={p.sku} type="monotone" dataKey={p.sku}
              stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]}
              fillOpacity={0.07} strokeWidth={1.5} dot={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function FutureProjectedDemandDialog({
  open,
  onOpenChange,
  filteredData,
  dateRange,
}: FutureProjectedDemandDialogProps) {
  const [targetDate, setTargetDate]     = useState<Date>(() => addDays(new Date(), 90));
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [activeTab, setActiveTab]       = useState<'chain' | 'table' | 'chart'>('chain');

  const daysToTarget = differenceInDays(startOfDay(targetDate), startOfDay(new Date()));

  const projections = useMemo(
    () => runProjections(filteredData, targetDate),
    [filteredData, targetDate]
  );

  const counts = useMemo(() => ({
    critical:      projections.filter((p) => p.riskLevel === 'CRITICAL').length,
    orderRequired: projections.filter((p) => p.riskLevel === 'ORDER_REQUIRED').length,
    safe:          projections.filter((p) => p.riskLevel === 'SAFE').length,
  }), [projections]);

  const dateRangeLabel = dateRange?.from && dateRange?.to
    ? `${format(dateRange.from, 'dd MMM')} – ${format(dateRange.to, 'dd MMM yyyy')}`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[96vw] w-[1200px] max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <TrendingDown size={16} className="text-primary" />
            Future Projected Demand
          </DialogTitle>
          <DialogDescription className="text-xs">
            Supply coverage analysis — {' '}
            <span className="font-medium text-foreground">
              {filteredData.length} SKU{filteredData.length !== 1 ? 's' : ''}
            </span>{' '}
            currently filtered
            {dateRangeLabel && <> · demand range: {dateRangeLabel}</>}
          </DialogDescription>
        </DialogHeader>

        {/* Controls */}
        <div className="shrink-0 flex flex-wrap items-center gap-3 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Target date:</span>
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen} modal>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                  <CalendarIcon size={12} />
                  {format(targetDate, 'dd MMM yyyy')}
                  <span className="text-muted-foreground">({daysToTarget}d)</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={targetDate}
                  onSelect={(d) => { if (d) { setTargetDate(d); setDatePickerOpen(false); } }}
                  disabled={{ before: addDays(new Date(), 1) }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-1">
            {[30, 60, 90, 180].map((d) => (
              <Button key={d} variant={daysToTarget === d ? 'default' : 'outline'} size="sm"
                className="h-7 px-2 text-[11px]" onClick={() => setTargetDate(addDays(new Date(), d))}>
                {d}d
              </Button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <KPIChip label="Critical"       count={counts.critical}      level="CRITICAL" />
            <KPIChip label="Order Required" count={counts.orderRequired} level="ORDER_REQUIRED" />
            <KPIChip label="Safe"           count={counts.safe}          level="SAFE" />
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          className="flex flex-col flex-1 min-h-0 mt-2">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="chain" className="gap-1.5 text-xs"><Layers size={13} />Coverage Chain</TabsTrigger>
            <TabsTrigger value="table" className="gap-1.5 text-xs"><Table2 size={13} />Summary Table</TabsTrigger>
            <TabsTrigger value="chart" className="gap-1.5 text-xs"><BarChart3 size={13} />Stock Curve</TabsTrigger>
          </TabsList>

          <TabsContent value="chain" className="flex-1 overflow-auto mt-2 pr-1">
            <CoverageChainView projections={projections} daysToTarget={daysToTarget} targetDate={targetDate} />
          </TabsContent>
          <TabsContent value="table" className="flex-1 overflow-auto mt-2">
            <SummaryTable projections={projections} />
          </TabsContent>
          <TabsContent value="chart" className="flex-1 overflow-auto mt-2">
            <StockCurveView projections={projections} targetDate={targetDate} />
          </TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="shrink-0 border-t pt-2 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <ArrowRight size={9} />
            Auto: Main → DHL transit (7d) → Container
          </span>
          <span className="flex items-center gap-1">
            <ArrowRight size={9} />
            Action: China WH (order 10d before Tier-1 stockout, arrives 3d before · ships 90%) · Production → China WH (~30d) → DHL (7d · ships 90%)
          </span>
          <span className="flex items-center gap-1 ml-auto">
            <Clock size={10} />Demand = monthly avg ÷ 30 · SOH uses allocation-adjusted values
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
