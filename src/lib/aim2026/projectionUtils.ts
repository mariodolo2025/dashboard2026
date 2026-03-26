// =============================================================================
// AIM 2026 — Future Projected Demand: Tiered Supply Simulation
// =============================================================================
//
// TIER 1 — Automatic (no action needed, already ordered/in transit):
//   Main WH      → day 0    (stock on hand in Australia)
//   DHL Transit  → day 7    (shipment already in transit to Australia)
//   Container    → day leadTimeDays  (already shipped, arriving automatically)
//
// TIER 2 — Requires action (must place order):
//   China WH     → order placed 10 days before Tier-1 runs out.
//                  DHL transit = 7 days → arrives 3 days before Tier-1 stockout.
//                  Effective China stock = sohChina×0.9 + (onProduction×0.9 if production
//                  will be ready in China before the order departs). 10% stays in China.
//   Production   → completes in China at PRODUCTION_READY_DAYS.
//                  If NOT already included in the China DHL shipment, it can be
//                  ordered separately (DHL) once production is complete.
//
// China order deadline = tier1StockoutDay − (CHINA_ARRIVAL_BUFFER + DHL_LEAD_DAYS)
//                      = tier1StockoutDay − 10
// China arrives        = tier1StockoutDay − CHINA_ARRIVAL_BUFFER  (3 days before)
// Production included in China if: productionReadyDay ≤ chinaOrderDeadlineDay
// projectedDemand is always avgMonthly ÷ 30.
//
// Bar rendering rules:
//   Automatic sources (DHL, Container): bar starts at consumptionStartDay (no overlap)
//   Ordered sources  (China, Prod):     bar starts at arrivalDay (3-day buffer overlap)
//   Bar right edge is always: consumptionStartDay + coveragePotentialDays
// =============================================================================

import { addDays, differenceInDays, startOfDay } from 'date-fns';
import type { SKURow } from './types';
import {
  type SKUProjection,
  type CoverageSegment,
  type TimelinePoint,
  type RiskLevel,
} from './types';

const DHL_LEAD_DAYS = 7;

/**
 * Estimated manufacturing days to produce units (they land in China WH after this).
 * Used when no explicit ready date is available on the SKU.
 */
const PRODUCTION_READY_DAYS = 30;

/**
 * Safety buffer (days): China stock arrives this many days BEFORE Tier-1 runs out.
 * Order logic: place China DHL order 10 days before Tier-1 stockout, transit = 7 days,
 * → arrives 3 days before Tier-1 is exhausted.
 * chinaOrderDeadlineDay = tier1StockoutDay − (CHINA_ARRIVAL_BUFFER + DHL_LEAD_DAYS) = T − 10
 * chinaArrivalDay       = tier1StockoutDay − CHINA_ARRIVAL_BUFFER                   = T − 3
 */
const CHINA_ARRIVAL_BUFFER = 3;

/**
 * Fraction of China/Production stock shipped to Australia.
 * 10% stays in China as a local safety buffer.
 */
const CHINA_SHIP_RATIO = 0.9;

// ─── Core simulation ─────────────────────────────────────────────────────────

/**
 * Day-by-day combined stock simulation.
 * Arrivals: array of { units, day } — units arrive at the START of that day.
 * Returns: first stockout day (null if none), stock at target, daily stock array.
 */
function simulateCombined(
  sohMain: number,
  arrivals: { units: number; day: number }[],
  dailyDemand: number,
  daysToTarget: number
): {
  stockoutDay: number | null;
  stockAtTarget: number;
  dailyStocks: number[];
} {
  let stock = sohMain;
  let stockoutDay: number | null = null;
  const dailyStocks: number[] = [Math.round(stock)];

  for (let d = 1; d <= daysToTarget; d++) {
    for (const a of arrivals) {
      if (a.day === d && a.units > 0) stock += a.units;
    }
    stock -= dailyDemand;
    if (stock < 0 && stockoutDay === null) stockoutDay = d;
    stock = Math.max(0, stock);
    dailyStocks.push(Math.round(stock));
  }

  return {
    stockoutDay,
    stockAtTarget: dailyStocks[daysToTarget] ?? 0,
    dailyStocks,
  };
}

/** Sample daily stock array into chart timeline points. */
function buildTimeline(
  dailyStocks: number[],
  today: Date,
  daysToTarget: number
): TimelinePoint[] {
  const step = Math.max(1, Math.floor(daysToTarget / 60));
  const points: TimelinePoint[] = [];
  for (let d = 0; d <= daysToTarget; d += step) {
    points.push({ date: addDays(today, d), stock: dailyStocks[d] ?? 0 });
  }
  if (daysToTarget % step !== 0) {
    points.push({ date: addDays(today, daysToTarget), stock: dailyStocks[daysToTarget] ?? 0 });
  }
  return points;
}

// ─── Segment builder helper ───────────────────────────────────────────────────

function makeSeg(
  source: CoverageSegment['source'],
  label: string,
  units: number,
  arrivalDay: number,
  transitStartDay: number,
  consumptionStartDay: number,
  isAutomatic: boolean,
  dailyDemand: number,
  today: Date,
  extra?: Partial<CoverageSegment>
): CoverageSegment {
  const coveragePotentialDays = dailyDemand > 0 ? units / dailyDemand : 0;
  const toDay = consumptionStartDay + coveragePotentialDays;
  return {
    source,
    label,
    units: Math.round(units),
    arrivalDay,
    consumptionStartDay,
    transitStartDay,
    isAutomatic,
    coShippedWithChina: false,
    coveragePotentialDays,
    fromDay:  arrivalDay,
    toDay,
    fromDate: addDays(today, arrivalDay),
    toDate:   addDays(today, toDay),
    ...extra,
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function simulateStockTimeline(
  row: SKURow,
  targetDate: Date,
  _dateRangeDays?: number
): SKUProjection {
  const today = startOfDay(new Date());
  const target = startOfDay(targetDate);
  const daysToTarget = Math.max(1, differenceInDays(target, today));

  const sohMain   = Math.max(0, row.availableMainWH);
  const sohChina  = Math.max(0, row.availableChina);
  const dailyDemand = row.projectedDemand > 0 ? row.projectedDemand / 30 : 0;

  // 90% of China/Production stock ships to Australia; 10% stays as safety buffer.
  const sohChinaShipped     = Math.floor(sohChina * CHINA_SHIP_RATIO);
  const productionShipped   = Math.floor(row.onProduction * CHINA_SHIP_RATIO);

  // Container lead time: already in transit
  const containerArrivalDay = Math.max(DHL_LEAD_DAYS + 1, row.leadTimeDays);

  // Main-only stockout (raw urgency, ignoring all pipeline)
  const mainOnlyDays  = dailyDemand > 0 ? sohMain / dailyDemand : Infinity;
  const daysToStockout = mainOnlyDays < daysToTarget ? Math.floor(mainOnlyDays) : null;
  const stockoutDate   = daysToStockout !== null ? addDays(today, daysToStockout) : null;

  // ── consumptionStartDay mini-sims ─────────────────────────────────────────
  // Main-only: determines when DHL consumption begins
  const simMainOnly = simulateCombined(sohMain, [], dailyDemand, daysToTarget);
  const mainStockoutDay = simMainOnly.stockoutDay ?? daysToTarget;

  // Main + DHL: determines when Container consumption begins (if Container exists)
  const dhlArrival = row.dhl > 0 ? { units: row.dhl, day: DHL_LEAD_DAYS } : null;
  const simMainAndDhl = row.container > 0 && dhlArrival
    ? simulateCombined(sohMain, [dhlArrival], dailyDemand, daysToTarget)
    : null;
  const mainAndDhlStockoutDay = simMainAndDhl?.stockoutDay ?? mainStockoutDay;

  // ── TIER 1 simulation: Main + DHL Transit + Container (automatic, no action) ──
  const tier1Arrivals = [
    dhlArrival,
    row.container > 0 ? { units: row.container, day: containerArrivalDay } : null,
  ].filter(Boolean) as { units: number; day: number }[];

  const simTier1 = simulateCombined(sohMain, tier1Arrivals, dailyDemand, daysToTarget);
  const tier1StockoutDay = simTier1.stockoutDay;

  // ── China arrival target ──────────────────────────────────────────────────
  // China arrives CHINA_ARRIVAL_BUFFER days before Tier-1 runs out.
  // Order placed 10 days before (= buffer + DHL_LEAD_DAYS = 3 + 7).
  const chinaTargetArrivalDay =
    tier1StockoutDay !== null && (sohChinaShipped > 0 || productionShipped > 0)
      ? Math.max(DHL_LEAD_DAYS, tier1StockoutDay - CHINA_ARRIVAL_BUFFER)
      : null;

  const chinaOrderDeadlineDay =
    chinaTargetArrivalDay !== null
      ? chinaTargetArrivalDay - DHL_LEAD_DAYS
      : null;

  const chinaOrderDeadline =
    chinaOrderDeadlineDay !== null
      ? addDays(today, chinaOrderDeadlineDay)
      : null;

  // ── Production timing ─────────────────────────────────────────────────────
  const productionReadyDay = PRODUCTION_READY_DAYS;

  const productionIncludedInChina =
    row.onProduction > 0 &&
    chinaOrderDeadlineDay !== null &&
    productionReadyDay <= Math.max(0, chinaOrderDeadlineDay);

  // ── China effective units (shipped = 90%) ─────────────────────────────────
  const chinaEffectiveUnits =
    sohChinaShipped + (productionIncludedInChina ? productionShipped : 0);

  // China arrives at the buffered target day (or soonest possible if deadline passed)
  const chinaArrivalDay =
    chinaEffectiveUnits > 0 && chinaTargetArrivalDay !== null
      ? (chinaOrderDeadlineDay !== null && chinaOrderDeadlineDay > 0
          ? chinaTargetArrivalDay
          : DHL_LEAD_DAYS)
      : null;

  // Transit for China starts at the order deadline (or today if overdue)
  const chinaTransitStartDay =
    chinaOrderDeadlineDay !== null
      ? Math.max(0, chinaOrderDeadlineDay)
      : 0;

  // Consumption for China starts when Tier-1 is exhausted
  const chinaConsumptionStartDay = tier1StockoutDay ?? (chinaArrivalDay ?? 0);

  // ── TIER 2 simulation: Tier 1 + China effective ───────────────────────────
  const tier2Arrivals = [
    ...tier1Arrivals,
    chinaArrivalDay !== null && chinaEffectiveUnits > 0
      ? { units: chinaEffectiveUnits, day: chinaArrivalDay }
      : null,
  ].filter(Boolean) as { units: number; day: number }[];

  const simWithChina = simulateCombined(sohMain, tier2Arrivals, dailyDemand, daysToTarget);
  const combinedStockoutDay = simWithChina.stockoutDay;

  // ── Production remaining wave ─────────────────────────────────────────────
  const productionRemaining = !productionIncludedInChina && row.onProduction > 0
    ? productionShipped
    : 0;
  const productionWaveArrivalDay  = productionReadyDay + DHL_LEAD_DAYS;
  const productionWaveOrderByDay  = productionReadyDay;
  const productionWaveOrderDeadline =
    productionRemaining > 0 ? addDays(today, productionWaveOrderByDay) : null;

  // Production wave consumption starts when combined (Tier1+China) runs out
  const productionWaveConsumptionStart = combinedStockoutDay ?? productionWaveArrivalDay;

  // Include production wave in final simulation for stock curve
  const finalArrivals = [
    ...tier2Arrivals,
    productionRemaining > 0 && productionWaveArrivalDay <= daysToTarget
      ? { units: productionRemaining, day: productionWaveArrivalDay }
      : null,
  ].filter(Boolean) as { units: number; day: number }[];

  const simFinal = simulateCombined(sohMain, finalArrivals, dailyDemand, daysToTarget);
  const projectedFinalStock = simFinal.stockAtTarget;

  // ── Gap analysis ──────────────────────────────────────────────────────────
  const finalStockoutDay = simFinal.stockoutDay;
  const gapDays  = finalStockoutDay !== null
    ? Math.max(0, daysToTarget - finalStockoutDay)
    : 0;
  const gapUnits        = Math.round(gapDays * dailyDemand);
  const requiredUnits   = gapUnits;
  const recommendedOrder = Math.round(requiredUnits * 1.1);

  const orderDeadline = finalStockoutDay !== null
    ? addDays(today, finalStockoutDay - DHL_LEAD_DAYS)
    : null;

  const totalCoveredDays = finalStockoutDay ?? daysToTarget;

  // ── Coverage segments (for swimlane visualization) ────────────────────────
  // Automatic: bar starts at consumptionStartDay (no overlap with prior tier)
  // Ordered:   bar starts at arrivalDay (intentional 3-day overlap as safety buffer)
  const coverageChain: CoverageSegment[] = [];

  if (sohMain > 0)
    coverageChain.push(makeSeg('MAIN', 'Main WH', sohMain, 0, 0, 0, true, dailyDemand, today));

  if (row.dhl > 0)
    coverageChain.push(makeSeg('DHL', 'DHL Transit', row.dhl, DHL_LEAD_DAYS, 0, mainStockoutDay, true, dailyDemand, today));

  if (row.container > 0)
    coverageChain.push(makeSeg('CONTAINER', 'Container', row.container, containerArrivalDay, 0, mainAndDhlStockoutDay, true, dailyDemand, today));

  // China WH — always its own row, uses 90% of sohChina
  if (sohChinaShipped > 0 && chinaArrivalDay !== null) {
    coverageChain.push(
      makeSeg('CHINA', 'China WH', sohChinaShipped, chinaArrivalDay, chinaTransitStartDay, chinaConsumptionStartDay, false, dailyDemand, today, {
        orderDeadline: chinaOrderDeadline ?? undefined,
      })
    );
  }

  // Production segment — always its own row, uses 90% of onProduction
  if (row.onProduction > 0) {
    if (productionIncludedInChina && chinaArrivalDay !== null) {
      coverageChain.push(
        makeSeg('PRODUCTION', 'On Production', productionShipped, chinaArrivalDay, chinaTransitStartDay, chinaConsumptionStartDay, false, dailyDemand, today, {
          orderDeadline: chinaOrderDeadline ?? undefined,
          coShippedWithChina: true,
        })
      );
    } else if (productionRemaining > 0) {
      coverageChain.push(
        makeSeg('PRODUCTION', 'On Production', productionRemaining, productionWaveArrivalDay, productionReadyDay, productionWaveConsumptionStart, false, dailyDemand, today, {
          orderDeadline: productionWaveOrderDeadline ?? undefined,
        })
      );
    }
  }

  // ── Risk classification ───────────────────────────────────────────────────
  let riskLevel: RiskLevel;
  if (gapDays === 0) {
    riskLevel = 'SAFE';
  } else if (orderDeadline && orderDeadline >= today) {
    riskLevel = 'ORDER_REQUIRED';
  } else {
    riskLevel = 'CRITICAL';
  }

  // ── Stock curve (use final simulation which includes all waves) ───────────
  const timeline = buildTimeline(simFinal.dailyStocks, today, daysToTarget);

  return {
    sku:                     row.sku,
    product:                 row.product,
    abcClass:                row.abcClass,
    dailyDemand,
    daysToStockout,
    stockoutDate,
    coverageChain,
    totalCoveredDays,
    tier1StockoutDay,
    combinedStockoutDay,
    chinaOrderDeadline,
    productionIncludedInChina,
    gapDays,
    gapUnits,
    orderDeadline,
    requiredUnits,
    recommendedOrder,
    projectedFinalStock,
    riskLevel,
    timeline,
  };
}

/**
 * Run simulations for all SKUs. Sorted: CRITICAL first, then by gap size desc.
 */
export function runProjections(
  filteredData: SKURow[],
  targetDate: Date,
  _dateRangeDays?: number
): SKUProjection[] {
  const riskOrder: Record<RiskLevel, number> = {
    CRITICAL: 0,
    ORDER_REQUIRED: 1,
    SAFE: 2,
  };

  return filteredData
    .map((row) => simulateStockTimeline(row, targetDate))
    .sort((a, b) => {
      const rd = riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
      if (rd !== 0) return rd;
      return b.gapDays - a.gapDays;
    });
}
