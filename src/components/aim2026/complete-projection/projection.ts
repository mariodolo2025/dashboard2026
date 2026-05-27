// =============================================================================
// AIM 2026 — Complete Projection: pure computation module (no React)
// =============================================================================

import type { SKURow } from '@/lib/aim2026/types';
import type { RecentOrder } from '@/lib/aim2026/api';

// ─── Pipeline events (real ETAs from purchase orders) ────────────────────────-

/** A single inbound shipment that lands on `day` (offset from today).
 *  destination tells where the stock physically ends up:
 *  - 'china' = production PO arriving at the China warehouse (still has to be
 *    loaded into a container to reach Main).
 *  - 'main'  = container/DHL PO already in transit to Main. Counts as arrival
 *    at Main when computing mainAtContainerArrival. */
export interface PipelineEvent {
  day: number;
  qty: number;
  destination: 'china' | 'main';
}

/**
 * Derive pipeline events from a SKU's recent orders. Distinción por warehouse,
 * no por status — todas las POs vienen con status='Placed' desde Unleashed;
 * el CustomOrderStatus (Container/Production/DHL) NO está expuesto en el
 * endpoint recent_orders, pero el WAREHOUSE sí distingue claramente:
 *  - warehouse 'Main Warehouse' (o 'MAIN') → la PO va a Main = container o DHL → destination='main'
 *  - warehouse 'China-W' (o cualquier 'China*') → la PO va a China = production → destination='china'
 *
 * Solo se consideran POs en status 'Placed' (in-flight). Status como
 * 'Completed', 'Receipted', etc. se ignoran (ya están reflejadas en SOH).
 */
export function buildPipelineEvents(
  orders: RecentOrder[],
  row: SKURow,
  today: Date,
): PipelineEvent[] {
  const events: PipelineEvent[] = [];
  for (const o of orders) {
    if (o.orderType !== 'purchase' || !o.deliveryDate) continue;
    const status = (o.status ?? '').toLowerCase().trim();
    if (status !== 'placed') continue;
    const eta = new Date(o.deliveryDate);
    if (isNaN(eta.getTime())) continue;
    const day = Math.round((eta.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    const wh = (o.warehouse ?? '').toLowerCase().trim();
    if (wh.startsWith('china')) {
      // Production PO → China-W. También usamos el match por qty contra
      // onProduction como salvavidas si el warehouse no estuviera presente.
      const matchesOnProd = row.onProduction > 0 && Math.abs(o.quantity - row.onProduction) < 1;
      if (!wh && !matchesOnProd) continue;
      events.push({ day, qty: o.quantity, destination: 'china' });
      continue;
    }
    if (wh.startsWith('main')) {
      // Container o DHL llegando a Main. Status='Placed' siempre, el
      // CustomOrderStatus real (Container/DHL-Inbounds) no nos lo da el endpoint.
      events.push({ day, qty: o.quantity, destination: 'main' });
      continue;
    }
    // Otros warehouses: ignorar.
  }
  return events;
}

/** Sum of qty for events whose ETA day <= t and destination matches.
 *  Default destination = 'china' (back-compat for production POs landing in China). */
export function pipelineReceivedAt(
  events: PipelineEvent[],
  t: number,
  destination: 'china' | 'main' = 'china',
): number {
  let sum = 0;
  for (const e of events) {
    if (e.destination === destination && e.day <= t) sum += e.qty;
  }
  return sum;
}


/** Days for sea-freight transit from China to Main warehouse. Default for
 *  Container loading mode: the user picks a "container loading date", and the
 *  container arrives at Main this many days later. */
export const CONTAINER_TRANSIT_DAYS = 30;

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
  /** Units que Main va a tener que recibir desde China antes que el container
   *  (DHL urgente) para no quebrar durante el tránsito = max(0, dailyDemand ×
   *  containerArrivalDay − sohMain). Se restan de availableChinaOnDate porque
   *  esas unidades ya están comprometidas implícitamente para Main. */
  mainDeficitAtArrival: number;
  /** Available China at projection date = availableChinaToday + production POs
   *  arriving in China by day t − chinaDemandConsumed − mainDeficitAtArrival.
   *  Use this for "what can I load into a container on day X". */
  availableChinaOnDate: number;
  projectedOnHand: number;
  daysOfCover: number;
  status: ProjectionStatus;
  neededQty: number;
  coverageDemand: number;
  // ─── Container loading & production planning ─────────────────────────────
  /** Days from today until the container arrives at Main (= t + CONTAINER_TRANSIT_DAYS). */
  containerArrivalDay: number;
  /** Days from today until production order arrives at Main (= leadTime). */
  productionArrivalDay: number;
  /** Main stock projected at container arrival = mainSoh − dailyDemand × containerArrivalDay. */
  mainAtContainerArrival: number;
  /** Main stock projected at production arrival = mainSoh − dailyDemand × productionArrivalDay. */
  mainAtProductionArrival: number;
  /** Units to load into container = max(0, coverageDemand − mainAtContainerArrival). */
  containerLoadQty: number;
  /** Units to produce = max(0, coverageDemand − mainAtProductionArrival). */
  productionQty: number;
  /** Units per master carton. Suggested qty se redondea al múltiplo más cercano
   *  en onAddToCart. Default 1 = sin redondeo. */
  packSize: number;
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
  // both allocatedChina and the projected China-W outbound demand. When on, the
  // same descuentos también se aplican al on-hand global (porque esos
  // commitments china reducen lo verdaderamente disponible cross-warehouse).
  const allocChina = Number(row.allocatedChina ?? 0);
  const availableChinaToday = applyChinaCommitments
    ? Math.max(0, sohChina - allocChina)
    : sohChina;
  const chinaDemandConsumed = applyChinaCommitments && chinaDailyDemand != null && chinaDailyDemand > 0
    ? chinaDailyDemand * t
    : 0;
  // Container Load and Production qty take into account the Main stock that
  // will be left when the order actually arrives. The user-picked projection
  // date IS the container loading date in container mode — the container then
  // takes CONTAINER_TRANSIT_DAYS to reach Main. For production, the lead time
  // is per-SKU (fabrication + shipping).
  const containerArrivalDay = t + CONTAINER_TRANSIT_DAYS;
  const productionArrivalDay = leadTime;
  // Main arrivals: container y DHL POs ya en tránsito hacia Main. Sumamos los
  // que llegan dentro del horizonte. Si no hay events cargados, fallback
  // conservador = 0 (no asumimos nada). Fix 2026-05-27 — antes la fórmula
  // ignoraba container/DHL en mainAtArrival, lo que sobreestimaba la carga
  // sugerida cuando ya había un container en tránsito.
  const mainArrivalsByContainer = events
    ? pipelineReceivedAt(events, containerArrivalDay, 'main')
    : 0;
  const mainArrivalsByProduction = events
    ? pipelineReceivedAt(events, productionArrivalDay, 'main')
    : 0;
  const mainAtContainerArrival = Math.max(0, sohMain + mainArrivalsByContainer - effDailyDemand * containerArrivalDay);
  const mainAtProductionArrival = Math.max(0, sohMain + mainArrivalsByProduction - effDailyDemand * productionArrivalDay);

  // Main deficit at container arrival: las unidades que Main va a tener que
  // recibir desde China antes que el container (DHL u otro envío urgente) para
  // no quebrar durante el tránsito. Salen de China sí o sí → no están
  // disponibles para cargar al container. Se aplica SIEMPRE (Mario, 2026-05-26),
  // no condicionado al toggle "Apply China commitments". El deficit también
  // descuenta los main arrivals existentes (container/DHL ya en tránsito).
  const mainDeficitAtArrival = Math.max(0, effDailyDemand * containerArrivalDay - sohMain - mainArrivalsByContainer);
  const availableChinaOnDate = availableChinaToday + pipelineReceived - chinaDemandConsumed - mainDeficitAtArrival;

  const globalCommitmentsDeduction = applyChinaCommitments
    ? allocChina + chinaDemandConsumed
    : 0;
  const projectedOnHand = sohGlobal + pipelineReceived - demandConsumed - globalCommitmentsDeduction;

  const daysOfCover =
    effDailyDemand > 0 ? Math.max(projectedOnHand, 0) / effDailyDemand : Infinity;

  const coverageDemand = effDailyDemand * coverageDays;
  const neededQty = coverageDemand - projectedOnHand;

  const containerLoadQty = Math.max(0, Math.round(coverageDemand - mainAtContainerArrival));
  const productionQty = Math.max(0, Math.round(coverageDemand - mainAtProductionArrival));

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
    mainDeficitAtArrival: Math.round(mainDeficitAtArrival),
    availableChinaOnDate,
    projectedOnHand,
    daysOfCover,
    status: classifyStatus(projectedOnHand, safety, target),
    neededQty,
    coverageDemand,
    containerArrivalDay,
    productionArrivalDay,
    mainAtContainerArrival: Math.round(mainAtContainerArrival),
    mainAtProductionArrival: Math.round(mainAtProductionArrival),
    containerLoadQty,
    productionQty,
    packSize: Math.max(1, Number(row.packSize) || 1),
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
