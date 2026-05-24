// =============================================================================
// AIM 2026 — Complete Projection: pure computation module (no React)
// =============================================================================

import type { SKURow } from '@/lib/aim2026/types';

export type Scenario = 'optimistic' | 'expected' | 'pessimistic';

export const SCENARIO_MULT: Record<Scenario, number> = {
  optimistic: 0.85,
  expected: 1.0,
  pessimistic: 1.2,
};

export const SCENARIO_LABEL: Record<Scenario, string> = {
  optimistic: 'Optimistic −15%',
  expected: 'Expected 0%',
  pessimistic: 'Pessimistic +20%',
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
): ProjectionRow {
  const dailyDemand = baseDailyDemand(row, demandIsDaily);
  const effDailyDemand = dailyDemand * SCENARIO_MULT[scenario];

  const sohMain = Number(row.sohMainWH ?? 0);
  const sohChina = Number(row.sohChina ?? 0);
  const dhl = Number(row.dhl ?? 0);
  const container = Number(row.container ?? 0);
  const onProd = Number(row.onProduction ?? 0);

  const sohGlobal = sohMain + sohChina + dhl + container;
  const pipeline = dhl + container + onProd;
  const leadTime = Number(row.leadTimeDays ?? 0);
  const safety = Number(row.safetyStock ?? 0);
  const target = Number(row.targetStockLevel ?? 0);

  const t = daysBetween(today, projectionDate);

  const arrivedFrac = leadTime > 0 ? Math.min(t / leadTime, 1) : 1;
  const pipelineReceived = pipeline * arrivedFrac;
  const demandConsumed = effDailyDemand * t;
  const allocated = Number(row.allocatedTotal ?? 0);
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
): ProjectionRow[] {
  return rows.map((r) =>
    buildProjectionRow(r, projectionDate, today, scenario, demandIsDaily, coverageDays),
  );
}

export function buildChartSeries(
  row: SKURow,
  today: Date,
  scenario: Scenario,
  demandIsDaily: boolean,
  horizonDays = 180,
): ChartSeries {
  const effDaily = baseDailyDemand(row, demandIsDaily) * SCENARIO_MULT[scenario];

  const sohMain = Number(row.sohMainWH ?? 0);
  const sohChina = Number(row.sohChina ?? 0);
  const dhl = Number(row.dhl ?? 0);
  const container = Number(row.container ?? 0);
  const onProd = Number(row.onProduction ?? 0);

  const sohGlobal = sohMain + sohChina + dhl + container;
  const pipeline = dhl + container + onProd;
  const leadTime = Number(row.leadTimeDays ?? 0);
  const safety = Number(row.safetyStock ?? 0);

  const points: SeriesPoint[] = [];
  let stockoutDay: number | null = null;

  for (let day = 0; day <= horizonDays; day++) {
    const arrivedFrac = leadTime > 0 ? Math.min(day / leadTime, 1) : 1;
    const withPipeline = sohGlobal + pipeline * arrivedFrac - effDaily * day;
    const demandOnly = sohGlobal - effDaily * day;
    if (stockoutDay === null && withPipeline <= 0) stockoutDay = day;
    points.push({ day, date: addDays(today, day), withPipeline, demandOnly });
  }

  const maxY = Math.max(sohGlobal, sohGlobal + pipeline, safety, 1) * 1.1;

  return { points, horizonDays, safety, stockoutDay, maxY };
}
