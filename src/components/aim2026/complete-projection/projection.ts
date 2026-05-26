// =============================================================================
// AIM 2026 — Complete Projection: pure computation module (no React)
// =============================================================================

import type { SKURow } from '@/lib/aim2026/types';
import type { RecentOrder } from '@/lib/aim2026/api';

// ─── Pipeline events (real ETAs from purchase orders) ────────────────────────-

/** A single inbound shipment that lands on `day` (offset from today). */
export interface PipelineEvent {
  day: number;
  qty: number;
}

/**
 * Derive pipeline events from a SKU's recent orders. DHL + Container statuses
 * are excluded — they're already counted inside `sohGlobal` (per BUG #1
 * decision: in-transit stock is treated as available today). Only production
 * POs (status=Placed in the China warehouse, or qty matching onProduction)
 * count as future arrivals.
 */
export function buildPipelineEvents(
  orders: RecentOrder[],
  row: SKURow,
  today: Date,
): PipelineEvent[] {
  const events: PipelineEvent[] = [];
  for (const o of orders) {
    if (o.orderType !== 'purchase' || !o.deliveryDate) continue;
    const status = (o.status ?? '').toLowerCase();
    // Skip DHL/Container — already in sohGlobal.
    if (status === 'dhl' || status === 'container') continue;
    // Production orders: status=Placed, China warehouse OR matching onProduction qty.
    if (status !== 'placed') continue;
    const isChina = (o.warehouse ?? '').toLowerCase().trim().startsWith('china');
    const matchesOnProd = row.onProduction > 0 && Math.abs(o.quantity - row.onProduction) < 1;
    if (!isChina && !matchesOnProd) continue;
    const eta = new Date(o.deliveryDate);
    if (isNaN(eta.getTime())) continue;
    const day = Math.round((eta.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    events.push({ day, qty: o.quantity });
  }
  return events;
}

/** Sum of qty for events whose ETA day <= t (already arrived by day t). */
export function pipelineReceivedAt(events: PipelineEvent[], t: number): number {
  let sum = 0;
  for (const e of events) {
    if (e.day <= t) sum += e.qty;
  }
  return sum;
}


export type Scenario = 'optimistic' | 'expected' | 'pessimistic';

export const SCENARIO_MULT: Record<Scenario, number> = {
  optimistic: 0.85,
  expected: 1.0,
  pessimistic: 1.2,
};

export const SCENARIO_LABEL: Record<Scenario, string> = {
  optimistic: 'Low demand −15%',
  expected: 'Expected 0%',
  pessimistic: 'High demand +20%',
};

export type ProjectionStatus = 'stockout' | 'atrisk' | 'surplus' | 'healthy';

export interface ProjectionRow {
  sku: string;
  group: string;
  dailyDemand: number;
  effDailyDemand: number;
  sohMain: number;
  sohChina: number;
  dhl: number;
  container: number;
  onProd: number;
  sohGlobal: number;
  pipeline: number;
  leadTime: number;
  safety: number;
  target: number;
  t: number;
  pipelineReceived: number;
  demandConsumed: number;
  /** Units reserved against pending sales orders (cross-warehouse). Pulled
   *  from SKURow.allocatedTotal — already computed upstream. */
  allocated: number;
  /** Units physically available in China warehouse today (sohChina − allocatedChina). */
  availableChinaToday: number;
  /** Available China at projection date = availableChinaToday + production POs arriving
   *  in China by day t. Does NOT subtract China outbound demand (no breakdown yet from
   *  the dashboard endpoint). Use this for "what can I load into a container on day X". */
  availableChinaOnDate: number;
  projectedOnHand: number;
  daysOfCover: number;
  status: ProjectionStatus;
  neededQty: number;
  coverageDemand: number;
}

export interface SeriesPoint {
  day: number;
  date: Date;
  withPipeline: number;
  demandOnly: number;
}

export interface ChartSeries {
  points: SeriesPoint[];
  horizonDays: number;
  safety: number;
  stockoutDay: number | null;
  maxY: number;
}

const DAY_MS = 1000 * 60 * 60 * 24;

export function baseDailyDemand(row: SKURow, demandIsDaily: boolean): number {
  const d = Number(row.projectedDemand ?? 0);
  if (!isFinite(d) || d <= 0) return 0;
  return demandIsDaily ? d : d / 30;
}

export function daysBetween(from: Date, to: Date): number {
  const diff = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  return diff > 0 ? diff : 0;
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

export function classifyStatus(
  projectedOnHand: number,
  safety: number,
  target: number,
): ProjectionStatus {
  if (projectedOnHand <= 0) return 'stockout';
  if (projectedOnHand < safety) return 'atrisk';
  if (projectedOnHand > target * 2.5) return 'surplus';
  return 'healthy';
}

export function buildProjectionRow(
  row: SKURow,
  projectionDate: Date,
  today: Date,
  scenario: Scenario,
  demandIsDaily: boolean,
  coverageDays = 90,
  events?: PipelineEvent[],
  /** When true ("Apply China commitments" toggle on), subtract from
   *  availableChinaOnDate: (1) allocatedChina (units reserved against pending
   *  sales orders), and (2) chinaDailyDemand × t (China-W outbound consumption
   *  over the projection window). Default false — Dolo prioritises B2C and
   *  most allocations aren't firm commitments, so raw stock is the right
   *  baseline. */
  applyChinaCommitments?: boolean,
  /** Daily outbound demand from the China warehouse for this SKU (units/day).
   *  Only used when applyChinaCommitments is true. */
  chinaDailyDemand?: number,
): ProjectionRow {
  const dailyDemand = baseDailyDemand(row, demandIsDaily);
  const effDailyDemand = dailyDemand * SCENARIO_MULT[scenario];

  const sohMain = Number(row.sohMainWH ?? 0);
  const sohChina = Number(row.sohChina ?? 0);
  const dhl = Number(row.dhl ?? 0);
  const container = Number(row.container ?? 0);
  const onProd = Number(row.onProduction ?? 0);

  const sohGlobal = sohMain + sohChina + dhl + container;
  // pipeline = onProd only. DHL + Container already counted inside sohGlobal
  // (they are "available today" stock, not future arrivals). Counting them here
  // too caused double-counting when pipelineReceived was added back into
  // projectedOnHand. Only onProduction is the genuine "arriving via lead time".
  const pipeline = onProd;
  const leadTime = Number(row.leadTimeDays ?? 0);
  const safety = Number(row.safetyStock ?? 0);
  const target = Number(row.targetStockLevel ?? 0);

  const t = daysBetween(today, projectionDate);

  // Real ETAs (preferred): sum POs with day(ETA) ≤ t. Fallback to linear lead
  // time approximation only when no events were loaded.
  const pipelineReceived = events
    ? pipelineReceivedAt(events, t)
    : pipeline * (leadTime > 0 ? Math.min(t / leadTime, 1) : 1);
  const demandConsumed = effDailyDemand * t;
  const allocated = Number(row.allocatedTotal ?? 0);
  // Available China today = sohChina − allocatedChina (from backend). For future date
  // we add production POs arriving by day t (all PipelineEvents target China). We do
  // NOT subtract China outbound demand here — that requires a backend field
  // (demand_china) we don't have yet; tracked separately.
  // Default: availableChinaToday = raw sohChina (Dolo prioritises B2C, allocations
  // aren't firm commitments). Toggle "Apply China commitments" makes us subtract
  // both allocatedChina and the projected China-W outbound demand.
  const allocChina = Number(row.allocatedChina ?? 0);
  const availableChinaToday = applyChinaCommitments
    ? Math.max(0, sohChina - allocChina)
    : sohChina;
  const chinaDemandConsumed = applyChinaCommitments && chinaDailyDemand != null && chinaDailyDemand > 0
    ? chinaDailyDemand * t
    : 0;
  const availableChinaOnDate = availableChinaToday + pipelineReceived - chinaDemandConsumed;
  const projectedOnHand = sohGlobal + pipelineReceived - demandConsumed;

  const daysOfCover =
    effDailyDemand > 0 ? Math.max(projectedOnHand, 0) / effDailyDemand : Infinity;

  const coverageDemand = effDailyDemand * coverageDays;
  const neededQty = coverageDemand - projectedOnHand;

  return {
    sku: row.sku,
    group: row.productGroup ?? '',
    dailyDemand,
    effDailyDemand,
    sohMain,
    sohChina,
    dhl,
    container,
    onProd,
    sohGlobal,
    pipeline,
    leadTime,
    safety,
    target,
    t,
    pipelineReceived,
    demandConsumed,
    allocated,
    availableChinaToday,
    availableChinaOnDate,
    projectedOnHand,
    daysOfCover,
    status: classifyStatus(projectedOnHand, safety, target),
    neededQty,
    coverageDemand,
  };
}

export function buildProjectionRows(
  rows: SKURow[],
  projectionDate: Date,
  today: Date,
  scenario: Scenario,
  demandIsDaily: boolean,
  coverageDays = 90,
  eventsBySku?: Map<string, PipelineEvent[]>,
  /** When true, applies China commitments (allocatedChina + chinaDailyBySku
   *  outbound demand) to availableChinaOnDate per SKU. */
  applyChinaCommitments?: boolean,
  /** Optional daily China outbound demand per SKU. Used only when
   *  applyChinaCommitments is true. */
  chinaDailyBySku?: Map<string, number>,
): ProjectionRow[] {
  return rows.map((r) =>
    buildProjectionRow(
      r, projectionDate, today, scenario, demandIsDaily, coverageDays,
      eventsBySku?.get(r.sku),
      applyChinaCommitments,
      chinaDailyBySku?.get(r.sku),
    ),
  );
}

export function buildChartSeries(
  row: SKURow,
  today: Date,
  scenario: Scenario,
  demandIsDaily: boolean,
  horizonDays = 180,
  events?: PipelineEvent[],
): ChartSeries {
  const effDaily = baseDailyDemand(row, demandIsDaily) * SCENARIO_MULT[scenario];

  const sohMain = Number(row.sohMainWH ?? 0);
  const sohChina = Number(row.sohChina ?? 0);
  const dhl = Number(row.dhl ?? 0);
  const container = Number(row.container ?? 0);
  const onProd = Number(row.onProduction ?? 0);

  const sohGlobal = sohMain + sohChina + dhl + container;
  // pipeline = onProd only. DHL + Container already counted inside sohGlobal
  // (they are "available today" stock, not future arrivals). Counting them here
  // too caused double-counting when pipelineReceived was added back into
  // projectedOnHand. Only onProduction is the genuine "arriving via lead time".
  const pipeline = onProd;
  const leadTime = Number(row.leadTimeDays ?? 0);
  const safety = Number(row.safetyStock ?? 0);

  const points: SeriesPoint[] = [];
  let stockoutDay: number | null = null;

  for (let day = 0; day <= horizonDays; day++) {
    const pipelineReceived = events
      ? pipelineReceivedAt(events, day)
      : pipeline * (leadTime > 0 ? Math.min(day / leadTime, 1) : 1);
    const withPipeline = sohGlobal + pipelineReceived - effDaily * day;
    const demandOnly = sohGlobal - effDaily * day;
    if (stockoutDay === null && withPipeline <= 0) stockoutDay = day;
    points.push({ day, date: addDays(today, day), withPipeline, demandOnly });
  }

  const maxY = Math.max(sohGlobal, sohGlobal + pipeline, safety, 1) * 1.1;

  return { points, horizonDays, safety, stockoutDay, maxY };
}
