// =============================================================================
// AIM 2026 — Action List (Replenishment Worklist): pure computation module.
//
// Decision-first layer on top of the Complete Projection engine. Instead of
// "explore a projection", it answers "what needs a decision today, and is it
// Container (cheap sea freight) or DHL (expensive air)?".
//
// It reuses buildProjectionRow so the numbers stay identical to Complete
// Projection for the same inputs — no parallel demand/stock model. The only
// new logic is the recommended-action derivation and the urgency ranking.
//
// Container vs DHL, per SKU:
//   - A container loaded on `containerLoadDate` reaches Main CONTAINER_TRANSIT_DAYS
//     later. mainDeficitAtArrival (already computed by the engine) = the units
//     Main runs short DURING that transit → they can only arrive by urgent DHL.
//     mainDeficitAtArrival > 0  ⟹  DHL needed.
//   - Otherwise, if the SKU still needs replenishment to hit the coverage target
//     (containerLoadQty > 0), Main survives until sea freight lands ⟹ Container.
//   - If China can't cover the shipment (availableChinaOnDate < shipment qty),
//     a Production order must come first ⟹ Produce.
// =============================================================================

import type { SKURow } from '@/lib/aim2026/types';
import {
  buildProjectionRow,
  addDays,
  CONTAINER_TRANSIT_DAYS,
  type Scenario,
  type ProjectionRow,
} from '../complete-projection/projection';

export type WorklistAction = 'DHL' | 'Container' | 'Produce' | 'OK';

export interface WorklistConfig {
  /** Days from today the next container would be loaded. 0 = "if I ship now".
   *  The container then reaches Main CONTAINER_TRANSIT_DAYS later. */
  containerLoadInDays: number;
  /** Target days of stock coverage a replenishment should reach. */
  coverageDays: number;
  scenario: Scenario;
}

export const DEFAULT_WORKLIST_CONFIG: WorklistConfig = {
  containerLoadInDays: 0,
  coverageDays: 90,
  scenario: 'expected',
};

export interface WorklistRow {
  sku: string;
  product: string;
  group: string;
  effDailyDemand: number;
  sohMain: number;
  sohChina: number;
  dhl: number;
  container: number;
  onProd: number;
  availableChinaOnDate: number;
  leadTime: number;
  /** Days until Main hits zero on current demand, ignoring future arrivals
   *  (conservative "when does Main break"). Infinity when demand is 0. */
  daysOfCoverMain: number;
  /** Days until Main breaks counting stock already in transit to Main
   *  (DHL + Container inbound). */
  daysOfCoverMainWithInbound: number;
  action: WorklistAction;
  /** Quantity tied to the action: DHL bridge units, container load units, or
   *  production units. 0 for OK. */
  actionQty: number;
  /** Units China is short by to fulfil the recommended shipment (>0 ⟹ Produce). */
  chinaShortfall: number;
  /** Urgency: lower = act sooner. Used for the default sort. */
  urgencyRank: number;
  projection: ProjectionRow;
}

function daysOfCover(stock: number, effDailyDemand: number): number {
  if (effDailyDemand <= 0) return Infinity;
  return Math.max(0, stock) / effDailyDemand;
}

export function buildWorklistRow(
  row: SKURow,
  today: Date,
  config: WorklistConfig,
): WorklistRow {
  const loadDate = addDays(today, Math.max(0, config.containerLoadInDays));
  const p = buildProjectionRow(
    row,
    loadDate,
    today,
    config.scenario,
    /* demandIsDaily */ false,
    config.coverageDays,
    /* events */ undefined,
    /* applyChinaCommitments */ false,
  );

  const eff = p.effDailyDemand;
  const daysMain = daysOfCover(p.sohMain, eff);
  const daysMainInbound = daysOfCover(p.sohMain + p.dhl + p.container, eff);

  // Recommended shipment size for the primary lane.
  const needDHL = p.mainDeficitAtArrival > 0;
  const needContainer = p.containerLoadQty > 0;
  const shipmentQty = needDHL ? p.mainDeficitAtArrival : p.containerLoadQty;
  const chinaShortfall = Math.max(0, Math.round(shipmentQty - p.availableChinaOnDate));

  let action: WorklistAction;
  let actionQty: number;
  if (eff <= 0) {
    action = 'OK';
    actionQty = 0;
  } else if (chinaShortfall > 0 && (needDHL || needContainer)) {
    // Can't ship what China doesn't have — produce first.
    action = 'Produce';
    actionQty = Math.max(p.productionQty, chinaShortfall);
  } else if (needDHL) {
    action = 'DHL';
    actionQty = Math.round(p.mainDeficitAtArrival);
  } else if (needContainer) {
    action = 'Container';
    actionQty = Math.round(p.containerLoadQty);
  } else {
    action = 'OK';
    actionQty = 0;
  }

  // Urgency: actionable rows first (by lane severity), then by how soon Main
  // breaks. OK rows sink to the bottom.
  const laneWeight: Record<WorklistAction, number> = { DHL: 0, Produce: 1, Container: 2, OK: 9 };
  const urgencyRank = laneWeight[action] * 100000 + Math.min(daysMain, 99999);

  return {
    sku: row.sku,
    product: row.product ?? '',
    group: row.productGroup ?? '',
    effDailyDemand: eff,
    sohMain: p.sohMain,
    sohChina: p.sohChina,
    dhl: p.dhl,
    container: p.container,
    onProd: p.onProd,
    availableChinaOnDate: p.availableChinaOnDate,
    leadTime: p.leadTime,
    daysOfCoverMain: daysMain,
    daysOfCoverMainWithInbound: daysMainInbound,
    action,
    actionQty,
    chinaShortfall,
    urgencyRank,
    projection: p,
  };
}

export function buildWorklist(
  rows: SKURow[],
  today: Date,
  config: WorklistConfig,
): WorklistRow[] {
  return rows
    .map((r) => buildWorklistRow(r, today, config))
    .sort((a, b) => a.urgencyRank - b.urgencyRank);
}

/** The container arrival day (from today) implied by the config — used for
 *  labels and the DHL-vs-Container explanation. */
export function containerArrivalDays(config: WorklistConfig): number {
  return Math.max(0, config.containerLoadInDays) + CONTAINER_TRANSIT_DAYS;
}
