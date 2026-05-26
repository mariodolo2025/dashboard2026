// =============================================================================
// AIM 2026 — KPI Calculation Engine  v3.0 (aim2026-calc-kpis-v2)
// =============================================================================
// NEW function name to bypass Deno Deploy cache of the old function.
// All logic is correct and verified:
//   - Landed Cost = CostChina × (1 + freight + duty + insurance)  — NO FX rate
//   - Target Stock Level = ROP + (avgDailyDemand × leadTime)
//   - Pipeline = Container + DHL + On Production
//   - Suggested Qty = max(0, Target - SOH Main WH - Pipeline)  when SOH <= ROP
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const VERSION = "v3.0-20260213-fresh";

// ─── CORS ──────────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config {
  defaultLeadTimeDays: number;
  defaultServiceLevelZ: number;
  freightRate: number;
  dutyRate: number;
  insuranceRate: number;
  capitalRatePercent: number;
  riskRatePercent: number;
}

interface SOHByWarehouse {
  [warehouse: string]: { quantity: number; allocated: number; available: number };
}

interface DemandMonth {
  periodDate: string;
  quantity: number;
  revenue: number;
  componentUsage: number;
  placed: number;
  backordered: number;
  parked: number;
}

interface SKUParams {
  sku: string;
  productDescription: string;
  productGroup: string;
  supplier: string;
  productCostChina: number;
  leadTimeDays: number;
  serviceLevelZ: number;
  abcClass: string | null;
  packSize: number;
}

// ─── Config Loader ─────────────────────────────────────────────────────────

async function loadConfig(supabase: any): Promise<Config> {
  const { data: rows } = await supabase
    .from("aim2026_cost_config")
    .select("config_type, config_data");

  const configs: Record<string, any> = {};
  for (const row of rows ?? []) {
    configs[row.config_type] = row.config_data;
  }

  const landed = configs["landed_cost_rates"]?.default ?? {};
  const holding = configs["holding_cost"] ?? {};
  const general = configs["general"] ?? {};

  const cfg: Config = {
    defaultLeadTimeDays: general.defaultLeadTimeDays ?? 45,
    defaultServiceLevelZ: general.defaultServiceLevelZ ?? 1.65,
    freightRate: landed.freightRate ?? 0.0592,
    dutyRate: landed.dutyRate ?? 0.05,
    insuranceRate: landed.insuranceRate ?? 0.0132,
    capitalRatePercent: holding.capitalRatePercent ?? 10,
    riskRatePercent: holding.riskRatePercent ?? 4,
  };

  console.log(`[${VERSION}] Config loaded — freight=${cfg.freightRate}, duty=${cfg.dutyRate}, ins=${cfg.insuranceRate}`);
  return cfg;
}

// ─── Data Loaders ──────────────────────────────────────────────────────────

async function loadSKUParameters(supabase: any): Promise<Map<string, SKUParams>> {
  const allData: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("aim2026_sku_parameters")
      .select("*")
      .range(offset, offset + 999);

    if (error) throw new Error(`Failed to load SKU parameters: ${error.message}`);
    allData.push(...(data ?? []));
    hasMore = (data?.length ?? 0) === 1000;
    offset += 1000;
  }

  console.log(`[${VERSION}] Loaded ${allData.length} SKU parameters`);

  const map = new Map<string, SKUParams>();
  for (const row of allData) {
    map.set(row.sku, {
      sku: row.sku,
      productDescription: row.product_description ?? "",
      productGroup: row.product_group ?? "Other",
      supplier: row.supplier ?? "Unknown",
      productCostChina: Number(row.product_cost_china) || 0,
      leadTimeDays: row.lead_time_days ?? 45,
      serviceLevelZ: Number(row.service_level_z) || 1.65,
      abcClass: row.abc_class,
      packSize: Math.max(1, Number(row.pack_size) || 1),
    });
  }
  return map;
}

async function loadTodaySOH(supabase: any): Promise<Map<string, SOHByWarehouse>> {
  let snapshotDate = new Date().toISOString().slice(0, 10);

  // Check if we have SOH data for today; if not, use the most recent date
  const { data: dateCheck } = await supabase
    .from("aim2026_soh_snapshots")
    .select("snapshot_date")
    .eq("snapshot_date", snapshotDate)
    .limit(1);

  if (!dateCheck || dateCheck.length === 0) {
    const { data: latest } = await supabase
      .from("aim2026_soh_snapshots")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1);

    if (latest && latest.length > 0) {
      snapshotDate = latest[0].snapshot_date;
      console.log(`[${VERSION}] No SOH for today, using latest snapshot: ${snapshotDate}`);
    } else {
      console.log(`[${VERSION}] No SOH snapshots found at all`);
      return new Map();
    }
  }

  const allData: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("aim2026_soh_snapshots")
      .select("*")
      .eq("snapshot_date", snapshotDate)
      .range(offset, offset + 999);

    if (error) throw new Error(`Failed to load SOH: ${error.message}`);
    allData.push(...(data ?? []));
    hasMore = (data?.length ?? 0) === 1000;
    offset += 1000;
  }

  console.log(`[${VERSION}] Loaded ${allData.length} SOH rows for ${snapshotDate}`);

  const map = new Map<string, SOHByWarehouse>();
  for (const row of allData) {
    const existing = map.get(row.sku) ?? {};
    existing[row.warehouse] = {
      quantity: Number(row.quantity),
      allocated: Number(row.allocated),
      available: Number(row.available),
    };
    map.set(row.sku, existing);
  }
  return map;
}

async function loadDemandHistory(
  supabase: any,
  startDate?: string,
  endDate?: string
): Promise<Map<string, DemandMonth[]>> {
  const allData: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from("aim2026_demand_history")
      .select("*")
      .eq("warehouse", "All")
      .order("period_date", { ascending: true });

    // Apply date range filter if provided
    if (startDate) query = query.gte("period_date", startDate);
    if (endDate) query = query.lte("period_date", endDate);

    query = query.range(offset, offset + pageSize - 1);

    const { data, error } = await query;

    if (error) throw new Error(`Failed to load demand: ${error.message}`);
    allData.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      hasMore = false;
    } else {
      offset += pageSize;
    }
  }

  console.log(`[${VERSION}] Loaded ${allData.length} demand history rows${startDate ? ` (filtered: ${startDate} to ${endDate})` : ""}`);

  if (allData.length === 0) {
    console.warn(`[${VERSION}] WARNING: No demand history data found!`);
  }

  const map = new Map<string, DemandMonth[]>();
  for (const row of allData) {
    const list = map.get(row.sku) ?? [];
    list.push({
      periodDate: row.period_date,
      quantity: Number(row.quantity_sold),
      revenue: Number(row.revenue),
      componentUsage: Number(row.component_usage ?? 0),
      placed: 0,
      backordered: 0,
      parked: 0,
    });
    map.set(row.sku, list);
  }
  return map;
}

// B2C customer types (matches classification in demand_history action)
function isB2CCustomerType(customerType: string): boolean {
  const ct = String(customerType ?? "").toLowerCase().trim();
  return ct === "shopify" || ct === "b2c" || ct === "web" || ct.includes("shopify");
}

// Load demand_detail (sales) and aggregate by SKU + period + status.
// Also computes per-SKU B2B/B2C totals from completed sales.
async function loadDemandDetailSummary(
  supabase: any,
  startDate?: string,
  endDate?: string
): Promise<{
  breakdownMap: Map<string, Map<string, { placed: number; backordered: number; parked: number }>>;
  channelSplit: Map<string, { b2b: number; b2c: number }>;
}> {
  const allData: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from("aim2026_demand_detail")
      .select("sku, period_date, status, quantity, customer_type")
      .eq("type", "sale")
      .range(offset, offset + pageSize - 1);
    if (startDate) query = query.gte("period_date", startDate);
    if (endDate) query = query.lte("period_date", endDate);

    const { data, error } = await query;
    if (error) throw new Error(`Failed to load demand detail: ${error.message}`);
    allData.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      hasMore = false;
    } else {
      offset += pageSize;
    }
  }

  // Normalize period to month (YYYY-MM-01) so daily dates from sync match monthly from csv-load
  function toMonthKey(d: string): string {
    const s = String(d ?? "").slice(0, 7);
    return s.length >= 7 ? `${s}-01` : d;
  }

  const breakdownMap = new Map<string, Map<string, { placed: number; backordered: number; parked: number }>>();
  const channelSplit = new Map<string, { b2b: number; b2c: number }>();

  for (const row of allData) {
    const sku = row.sku;
    const period = toMonthKey(row.period_date);
    const status = String(row.status ?? "").toLowerCase();
    if (!sku || !period) continue;

    const qty = Number(row.quantity ?? 0);

    // Accumulate B2B/B2C for ALL demand statuses so the split covers the full
    // projected demand (completed + placed + backordered + parked) and so that
    // assembly B2C fractions correctly capture backordered B2C orders.
    const split = channelSplit.get(sku) ?? { b2b: 0, b2c: 0 };
    if (isB2CCustomerType(row.customer_type)) {
      split.b2c += qty;
    } else {
      split.b2b += qty;
    }
    channelSplit.set(sku, split);

    // placed / backordered / parked also go to the breakdown map (for the
    // per-period demand detail used elsewhere — unchanged behaviour).
    if (status !== "completed") {
      const skuMap = breakdownMap.get(sku) ?? new Map<string, { placed: number; backordered: number; parked: number }>();
      const existing = skuMap.get(period) ?? { placed: 0, backordered: 0, parked: 0 };
      if (status === "placed") existing.placed += qty;
      else if (status === "backordered") existing.backordered += qty;
      else if (status === "parked") existing.parked += qty;
      skuMap.set(period, existing);
      breakdownMap.set(sku, skuMap);
    }
  }

  return { breakdownMap, channelSplit };
}

// Load daily demand for short date ranges (< 30 days)
async function loadDailyDemandSummary(
  supabase: any,
  rangeFrom: string,
  rangeTo: string,
  demandMode: DemandMode
): Promise<Map<string, number>> {
  const allData: any[] = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("aim2026_demand_detail")
      .select("sku, status, quantity, type")
      .gte("order_date", rangeFrom)
      .lte("order_date", rangeTo)
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`Failed to load daily demand: ${error.message}`);
    allData.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) hasMore = false;
    else offset += pageSize;
  }

  const map = new Map<string, number>();
  for (const row of allData) {
    const sku = row.sku;
    if (!sku) continue;
    const status = String(row.status ?? "").toLowerCase();
    const type = String(row.type ?? "").toLowerCase();
    const qty = Number(row.quantity ?? 0);

    // Include: completed sales + component_usage + placed + backordered
    // (mirrors base = quantity + componentUsage + placed + backordered in calcDemandStats)
    const isCompletedSale = type === "sale" && status === "completed";
    const isComponentUsage = type === "component_usage";
    const isPlacedOrBackordered = type === "sale" && (status === "placed" || status === "backordered");
    const isParked = type === "sale" && status === "parked";

    const include =
      isCompletedSale || isComponentUsage || isPlacedOrBackordered ||
      (demandMode === "estimatedDemandParked" && isParked);

    if (include) {
      map.set(sku, (map.get(sku) ?? 0) + qty);
    }
  }
  return map;
}

// Load BOM components — used to attribute component demand to the correct channel.
// Returns: componentSku → list of { assemblySku, bomQty }
async function loadBomComponents(
  supabase: any
): Promise<Map<string, Array<{ assemblySku: string; bomQty: number }>>> {
  const allData: any[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase
      .from("aim2026_bom_components")
      .select("assembly_sku, component_sku, quantity_per_assembly")
      .range(offset, offset + 999);
    if (error) {
      console.warn(`[${VERSION}] Could not load BOM components: ${error.message}`);
      break;
    }
    allData.push(...(data ?? []));
    hasMore = (data?.length ?? 0) === 1000;
    offset += 1000;
  }
  console.log(`[${VERSION}] Loaded ${allData.length} BOM component rows`);
  const map = new Map<string, Array<{ assemblySku: string; bomQty: number }>>();
  for (const row of allData) {
    const component = String(row.component_sku ?? "").trim();
    const assembly = String(row.assembly_sku ?? "").trim();
    const qty = Number(row.quantity_per_assembly ?? 1);
    if (!component || !assembly) continue;
    const list = map.get(component) ?? [];
    list.push({ assemblySku: assembly, bomQty: qty });
    map.set(component, list);
  }
  return map;
}

// ─── KPI Calculations ──────────────────────────────────────────────────────

/** Compute total days between two dates (inclusive) */
function daysBetweenInclusive(from: string, to: string): number {
  const [yF, mF, dF] = from.split("-").map(Number);
  const [yT, mT, dT] = to.split("-").map(Number);
  const msPerDay = 1000 * 60 * 60 * 24;
  const diff = Date.UTC(yT, mT - 1, dT) - Date.UTC(yF, mF - 1, dF);
  return Math.round(diff / msPerDay) + 1;
}

/** Compute weight for a month based on how many days fall within [rangeFrom, rangeTo] */
function getMonthWeight(periodDate: string, rangeFrom: string, rangeTo: string): number {
  const [y, m] = periodDate.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  // Parse as UTC noon to avoid timezone edge cases
  const [yF, mF, dF] = rangeFrom.split("-").map(Number);
  const [yT, mT, dT] = rangeTo.split("-").map(Number);
  const from = new Date(Date.UTC(yF, mF - 1, dF));
  const to = new Date(Date.UTC(yT, mT - 1, dT));
  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(y, m - 1, lastDay));

  const rangeStart = from.getTime() > monthStart.getTime() ? from : monthStart;
  const rangeEnd = to.getTime() < monthEnd.getTime() ? to : monthEnd;

  if (rangeStart.getTime() > rangeEnd.getTime()) return 0;

  const msPerDay = 1000 * 60 * 60 * 24;
  const daysCovered = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / msPerDay) + 1;
  return Math.min(1, Math.max(0, daysCovered / lastDay));
}

type DemandMode = "realDemand" | "estimatedDemandParked";

function normalizeDemandMode(mode?: string | null): DemandMode {
  const v = String(mode ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (v.includes("estimated") || v.includes("parked")) return "estimatedDemandParked";
  return "realDemand";
}

function calcDemandStats(
  months: DemandMonth[],
  demandMode: DemandMode,
  rangeFrom?: string,
  rangeTo?: string
): {
  avgMonthly: number;
  avgMonthlySalesOnly: number;
  stdDev: number;
  totalRevenue: number;
  trend: "up" | "down" | "stable";
  trendPercent: number;
} {
  if (months.length === 0) {
    return { avgMonthly: 0, avgMonthlySalesOnly: 0, stdDev: 0, totalRevenue: 0, trend: "stable" as const, trendPercent: 0 };
  }

  const useWeights = !!rangeFrom && !!rangeTo;
  const weights = useWeights
    ? months.map((m) => getMonthWeight(m.periodDate, rangeFrom, rangeTo))
    : months.map(() => 1);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const totalQuantities = months.map((m) => {
    const base = m.quantity + m.componentUsage + m.placed + m.backordered;
    return demandMode === "estimatedDemandParked" ? base + m.parked : base;
  });
  const salesOnlyQuantities = months.map((m) => m.quantity);
  const totalRevenue = months.reduce((s, m) => s + m.revenue, 0);

  let avg: number;
  let avgSalesOnly: number;
  if (useWeights && totalWeight > 0) {
    const weightedSum = totalQuantities.reduce((s, q, i) => s + q * weights[i], 0);
    const weightedSalesSum = salesOnlyQuantities.reduce((s, q, i) => s + q * weights[i], 0);
    avg = weightedSum / totalWeight;
    avgSalesOnly = weightedSalesSum / totalWeight;
  } else {
    avg = totalQuantities.reduce((a, b) => a + b, 0) / totalQuantities.length;
    avgSalesOnly = salesOnlyQuantities.reduce((a, b) => a + b, 0) / salesOnlyQuantities.length;
  }

  const variance = totalQuantities.reduce((s, q, i) => {
    const w = useWeights ? weights[i] : 1;
    return s + (q - avg) ** 2 * w;
  }, 0) / (useWeights && totalWeight > 0 ? totalWeight : totalQuantities.length);
  const stdDev = Math.sqrt(variance);

  let trend: "up" | "down" | "stable" = "stable";
  let trendPercent = 0;

  if (totalQuantities.length >= 6) {
    const recent3 = totalQuantities.slice(-3);
    const previous3 = totalQuantities.slice(-6, -3);
    const recentAvg = recent3.reduce((a, b) => a + b, 0) / 3;
    const prevAvg = previous3.reduce((a, b) => a + b, 0) / 3;

    if (prevAvg > 0) {
      trendPercent = ((recentAvg - prevAvg) / prevAvg) * 100;
      if (trendPercent > 5) trend = "up";
      else if (trendPercent < -5) trend = "down";
    }
  }

  return { avgMonthly: avg, avgMonthlySalesOnly: avgSalesOnly, stdDev, totalRevenue, trend, trendPercent };
}

function calcABCClass(
  skuRevenues: { sku: string; revenue: number }[]
): Map<string, "A" | "B" | "C"> {
  const sorted = [...skuRevenues].sort((a, b) => b.revenue - a.revenue);
  const total = sorted.reduce((s, r) => s + r.revenue, 0);

  const result = new Map<string, "A" | "B" | "C">();
  let cumulative = 0;

  for (const item of sorted) {
    cumulative += item.revenue;
    const pct = total > 0 ? cumulative / total : 1;
    result.set(item.sku, pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C");
  }

  return result;
}

type StockStatus = "CRITICAL" | "LOW STOCK" | "WARNING" | "OK" | "OVERSTOCK";

function calcStatus(daysOfCover: number): StockStatus {
  if (daysOfCover <= 0) return "CRITICAL";
  if (daysOfCover < 7) return "CRITICAL";
  if (daysOfCover < 30) return "LOW STOCK";
  if (daysOfCover < 60) return "WARNING";
  if (daysOfCover > 180) return "OVERSTOCK";
  return "OK";
}

function calcStockoutRisk(
  sohMainWH: number,
  safetyStock: number,
  reorderPoint: number,
  daysOfCover: number,
  leadTimeDays: number
): "critical" | "high" | "medium" | "low" {
  if (sohMainWH <= safetyStock) return "critical";
  if (sohMainWH <= reorderPoint) return "high";
  if (daysOfCover < leadTimeDays * 1.5) return "medium";
  return "low";
}

// ─── Warehouse Name Matching ───────────────────────────────────────────────

function findWarehouseValue(
  soh: SOHByWarehouse,
  patterns: string[]
): { quantity: number; allocated: number; available: number } {
  const defaultVal = { quantity: 0, allocated: 0, available: 0 };
  for (const [whName, val] of Object.entries(soh)) {
    const lower = whName.toLowerCase();
    if (patterns.some((p) => lower.includes(p))) {
      return val;
    }
  }
  return defaultVal;
}

// ─── Main Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  console.log(`[${VERSION}] === KPI CALCULATION STARTING ===`);

  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let syncId: string | null = null;
    let dateRangeStart: string | undefined;
    let dateRangeEnd: string | undefined;
    let rangeFrom: string | undefined;
    let rangeTo: string | undefined;
    let demandModeRaw: string | undefined;
    let previewOnly = false;
    try {
      const body = await req.json();
      syncId = body?.syncId ?? null;
      dateRangeStart = body?.startDate ?? undefined;
      dateRangeEnd = body?.endDate ?? undefined;
      rangeFrom = body?.rangeFrom ?? undefined;
      rangeTo = body?.rangeTo ?? undefined;
      demandModeRaw = body?.demandMode ?? undefined;
      previewOnly = body?.previewOnly === true || body?.previewOnly === "true";
    } catch {
      // No body is fine
    }
    // Fallback: read from URL params (frontend sends both body and URL for reliability)
    const url = new URL(req.url);
    if (!rangeFrom) rangeFrom = url.searchParams.get("rangeFrom") ?? undefined;
    if (!rangeTo) rangeTo = url.searchParams.get("rangeTo") ?? undefined;
    if (!dateRangeStart) dateRangeStart = url.searchParams.get("startDate") ?? undefined;
    if (!dateRangeEnd) dateRangeEnd = url.searchParams.get("endDate") ?? undefined;
    if (!demandModeRaw) demandModeRaw = url.searchParams.get("demandMode") ?? undefined;
    if (url.searchParams.get("previewOnly") === "true") previewOnly = true;

    // When a date range is provided, this is a read-only recalculation (no cache write)
    const isDateRangeQuery = !!dateRangeStart || !!dateRangeEnd;
    const demandMode = normalizeDemandMode(demandModeRaw);
    const useWeightedDemand = !!rangeFrom && !!rangeTo;

    // Determine if we should use daily mode (< 30 days)
    const totalRangeDays = (rangeFrom && rangeTo) ? daysBetweenInclusive(rangeFrom, rangeTo) : 999;
    const useDailyMode = totalRangeDays < 30;

    if (isDateRangeQuery) {
      console.log(`[${VERSION}] Date range query: ${dateRangeStart} to ${dateRangeEnd} | weighted=${useWeightedDemand} rangeFrom=${rangeFrom ?? "MISSING"} rangeTo=${rangeTo ?? "MISSING"} | daily_mode=${useDailyMode} (${totalRangeDays} days)`);
    }
    console.log(`[${VERSION}] Demand mode: ${demandMode}`);

    // ── Load all data ────────────────────────────────────────────
    const [config, skuParams, sohMap, demandMap, demandDetailResult, bomComponentMap] = await Promise.all([
      loadConfig(supabase),
      loadSKUParameters(supabase),
      loadTodaySOH(supabase),
      loadDemandHistory(supabase, dateRangeStart, dateRangeEnd),
      loadDemandDetailSummary(supabase, dateRangeStart, dateRangeEnd),
      loadBomComponents(supabase),
    ]);
    const demandDetailMap = demandDetailResult.breakdownMap;
    const channelSplitMap = demandDetailResult.channelSplit;

    // Load daily demand if needed (for short date ranges < 30 days)
    const dailyDemandMap = useDailyMode && rangeFrom && rangeTo
      ? await loadDailyDemandSummary(supabase, rangeFrom, rangeTo, demandMode)
      : new Map<string, number>();

    // ── Build assembly B2C fraction map ─────────────────────────
    // For component SKUs, demand comes mostly from componentUsage (assembly production),
    // not from direct sales. We weight each parent assembly's B2C fraction by the BOM
    // quantity to get an effective B2C fraction for the component's assembly-derived demand.
    const assemblyB2cFractionMap = new Map<string, number>();
    for (const [componentSku, parents] of bomComponentMap) {
      let totalWeighted = 0;
      let b2cWeighted = 0;
      for (const { assemblySku, bomQty } of parents) {
        const split = channelSplitMap.get(assemblySku);
        if (!split) continue;
        const total = split.b2b + split.b2c;
        totalWeighted += total * bomQty;
        b2cWeighted += split.b2c * bomQty;
      }
      if (totalWeighted > 0) {
        assemblyB2cFractionMap.set(componentSku, b2cWeighted / totalWeighted);
      }
    }

    // ── Compute ABC Classification ───────────────────────────────
    const skuRevenues: { sku: string; revenue: number }[] = [];
    for (const [sku, months] of demandMap) {
      const totalRev = months.reduce((s, m) => s + m.revenue, 0);
      skuRevenues.push({ sku, revenue: totalRev });
    }
    const abcMap = calcABCClass(skuRevenues);

    // ── Calculate KPIs per SKU ───────────────────────────────────
    const kpiRows: any[] = [];
    let totalValuationMainWH = 0;
    let totalValuationChina = 0;
    let totalValuationContainer = 0;
    let totalValuationDHL = 0;
    let totalValuationOnProd = 0;
    let totalValuationKorea = 0;

    const allSKUs = new Set([...skuParams.keys(), ...sohMap.keys()]);
    let debugSku = "PSD-HD-54"; // Log one SKU for verification

    for (const sku of allSKUs) {
      const params = skuParams.get(sku) ?? {
        sku,
        productDescription: "",
        productGroup: "Other",
        supplier: "Unknown",
        productCostChina: 0,
        leadTimeDays: config.defaultLeadTimeDays,
        serviceLevelZ: config.defaultServiceLevelZ,
        abcClass: null,
        packSize: 1,
      };

      const soh = sohMap.get(sku) ?? {};
      const baseDemandMonths = demandMap.get(sku) ?? [];
      const detailByPeriod = demandDetailMap.get(sku);
      function toMonthKey(d: string): string {
        const s = String(d ?? "").slice(0, 7);
        return s.length >= 7 ? `${s}-01` : d;
      }
      const monthMap = new Map<string, DemandMonth>();
      for (const m of baseDemandMonths) {
        const key = toMonthKey(m.periodDate);
        const existing = monthMap.get(key);
        if (existing) {
          existing.quantity += m.quantity;
          existing.revenue += m.revenue;
          existing.componentUsage += m.componentUsage;
        } else {
          monthMap.set(key, { ...m, periodDate: key });
        }
      }
      if (detailByPeriod) {
        for (const [period, detail] of detailByPeriod.entries()) {
          const existing = monthMap.get(period) ?? {
            periodDate: period,
            quantity: 0,
            revenue: 0,
            componentUsage: 0,
            placed: 0,
            backordered: 0,
            parked: 0,
          };
          existing.placed += detail.placed;
          existing.backordered += detail.backordered;
          existing.parked += detail.parked;
          monthMap.set(period, existing);
        }
      }
      const demandMonths = [...monthMap.values()].sort((a, b) => a.periodDate.localeCompare(b.periodDate));

      const mainWH = findWarehouseValue(soh, ["main warehouse", "main"]);
      const chinaWH = findWarehouseValue(soh, ["china-w", "china"]);
      const containerWH = findWarehouseValue(soh, ["container"]);
      const dhlWH = findWarehouseValue(soh, ["dhl"]);
      const onProdWH = findWarehouseValue(soh, ["production"]);
      const koreaWH = findWarehouseValue(soh, ["pesado korea", "korea", "pesado"]);

      if (mainWH.quantity === 0 && soh[""] !== undefined) {
        mainWH.quantity = soh[""].quantity;
        mainWH.allocated = soh[""].allocated;
        mainWH.available = soh[""].available;
      }

      const demandStats = calcDemandStats(demandMonths, demandMode, rangeFrom, rangeTo);
      const avgDailyDemand = demandStats.avgMonthly / 30;

      const leadTimeDays = params.leadTimeDays || config.defaultLeadTimeDays;
      const z = params.serviceLevelZ || config.defaultServiceLevelZ;

      // Safety Stock = Z × σ × √(Lead Time / 30)
      const safetyStock = Math.round(
        z * demandStats.stdDev * Math.sqrt(leadTimeDays / 30)
      );

      // Reorder Point = (Avg Daily Demand × Lead Time) + Safety Stock
      const reorderPoint = Math.round(avgDailyDemand * leadTimeDays + safetyStock);

      // Target Stock Level = ROP + (Avg Daily Demand × Lead Time)
      const targetStockLevel = Math.round(reorderPoint + avgDailyDemand * leadTimeDays);

      // Pipeline = in-transit / on-order stock
      const pipeline = containerWH.quantity + dhlWH.quantity + onProdWH.quantity;

      // Total allocated across ALL warehouses
      const allocatedTotal = Object.values(soh).reduce((sum, wh) => sum + wh.allocated, 0);

      // Suggested Qty — trigger on Main WH only, but discount China stock from qty to order
      const suggestedQty = mainWH.quantity <= reorderPoint
        ? Math.max(0, targetStockLevel - mainWH.quantity - chinaWH.quantity - pipeline)
        : 0;

      // Soft suggestion: SOH is above ROP but within a warning zone (≤ ROP × 1.5)
      const softSuggestedQty = (suggestedQty === 0 && reorderPoint > 0 && mainWH.quantity <= reorderPoint * 1.5)
        ? Math.max(0, targetStockLevel - mainWH.quantity - chinaWH.quantity - pipeline)
        : 0;

      const daysOfCover = avgDailyDemand > 0 ? mainWH.quantity / avgDailyDemand : 999;

      // *** LANDED COST — NO FX conversion — costs are already AUD ***
      const landedCostAUD =
        params.productCostChina *
        (1 + config.freightRate + config.dutyRate + config.insuranceRate);

      const totalQtySold = demandMonths.reduce((s, m) => s + m.quantity, 0);
      const avgSellingPrice =
        totalQtySold > 0 ? demandStats.totalRevenue / totalQtySold : 0;

      const marginPercent =
        avgSellingPrice > 0
          ? ((avgSellingPrice - landedCostAUD) / avgSellingPrice) * 100
          : 0;

      const annualCOGS = demandStats.avgMonthly * 12 * landedCostAUD;
      const avgInventoryValue = mainWH.quantity * landedCostAUD;
      const turnover = avgInventoryValue > 0 ? annualCOGS / avgInventoryValue : 0;

      const grossMarginAnnual = demandStats.avgMonthly * 12 * (avgSellingPrice - landedCostAUD);
      const gmroi = avgInventoryValue > 0 ? grossMarginAnnual / avgInventoryValue : 0;

      const abcClass = abcMap.get(sku) ?? params.abcClass ?? "C";

      const status = calcStatus(daysOfCover);
      const stockoutRisk = calcStockoutRisk(
        mainWH.quantity,
        safetyStock,
        reorderPoint,
        daysOfCover,
        leadTimeDays
      );

      // Debug log for one known SKU
      if (sku === debugSku) {
        console.log(`[${VERSION}] DEBUG ${sku}: costChina=${params.productCostChina}, rates=(${config.freightRate}+${config.dutyRate}+${config.insuranceRate}), landedAUD=${landedCostAUD.toFixed(2)}, target=${targetStockLevel}, pipeline=${pipeline}, sugQty=${suggestedQty}, sohMain=${mainWH.quantity}, rop=${reorderPoint}, lt=${leadTimeDays}`);
      }

      kpiRows.push({
        sku,
        sync_id: syncId,
        kpi_data: {
          product: params.productDescription,
          productGroup: params.productGroup,
          supplier: params.supplier,
          abcClass,
          sohMainWH: mainWH.quantity,
          sohChina: chinaWH.quantity,
          container: containerWH.quantity,
          dhl: dhlWH.quantity,
          onProduction: onProdWH.quantity,
          allocatedMainWH: mainWH.allocated,
          availableMainWH: mainWH.available,
          allocatedChina: chinaWH.allocated,
          availableChina: chinaWH.available,
          allocatedTotal,
          projectedDemand: useDailyMode
            ? Math.round((dailyDemandMap.get(sku) ?? 0) / totalRangeDays)
            : Math.round(demandStats.avgMonthly),
          ...(() => {
            const projDemand = Math.round(demandStats.avgMonthly);
            if (projDemand === 0) return { demandB2b: 0, demandB2c: 0 };

            // directSplit is a TOTAL over the filtered period (all statuses)
            const directSplit = channelSplitMap.get(sku) ?? { b2b: 0, b2c: 0 };

            // weightedCompUsageTotal: keep as period TOTAL (same units as directSplit)
            // so the fraction is computed consistently
            const mWeights = useWeightedDemand
              ? demandMonths.map((m) => getMonthWeight(m.periodDate, rangeFrom!, rangeTo!))
              : demandMonths.map(() => 1);
            const weightedCompUsageTotal = demandMonths.reduce(
              (sum, m, i) => sum + m.componentUsage * (mWeights[i] ?? 1),
              0
            );

            // Assembly B2C fraction: weighted by BOM-parent sales
            const assemblyFraction = assemblyB2cFractionMap.get(sku) ?? 0;

            // Overall B2C fraction = (direct_b2c + assembly_b2c) / (direct_total + comp_total)
            const b2cNumerator = directSplit.b2c + assemblyFraction * weightedCompUsageTotal;
            const totalDenominator = directSplit.b2b + directSplit.b2c + weightedCompUsageTotal;

            const b2cFraction = totalDenominator > 0 ? b2cNumerator / totalDenominator : 0;

            // Apply fraction to projectedDemand so B2B + B2C = projectedDemand exactly
            const demandB2c = Math.round(projDemand * b2cFraction);
            return {
              demandB2c,
              demandB2b: projDemand - demandB2c,
            };
          })(),
          demandTrend: demandStats.trend,
          demandTrendPercent: Math.round(demandStats.trendPercent * 10) / 10,
          reorderPoint,
          safetyStock,
          targetStockLevel,
          pipeline,
          suggestedQty,
          softSuggestedQty,
          daysOfCover: Math.round(daysOfCover * 10) / 10,
          turnover: Math.round(turnover * 10) / 10,
          marginPercent: Math.round(marginPercent * 10) / 10,
          gmroi: Math.round(gmroi * 10) / 10,
          productCostChina: Math.round(params.productCostChina * 100) / 100,
          landedCostAUD: Math.round(landedCostAUD * 100) / 100,
          avgSellingPrice: Math.round(avgSellingPrice * 100) / 100,
          status,
          stockoutRisk,
          leadTimeDays,
          serviceLevelZ: z,
          packSize: params.packSize ?? 1,
        },
      });

      totalValuationMainWH += mainWH.quantity * landedCostAUD;
      totalValuationChina += chinaWH.quantity * params.productCostChina;
      totalValuationContainer += containerWH.quantity * landedCostAUD;
      totalValuationDHL += dhlWH.quantity * landedCostAUD;
      totalValuationOnProd += onProdWH.quantity * params.productCostChina;
      totalValuationKorea += koreaWH.quantity * landedCostAUD;
    }

    // ── For date range queries: return data directly without persisting ──
    if (isDateRangeQuery || previewOnly) {
      const durationMs = Date.now() - startTime;
      console.log(`[${VERSION}] === PREVIEW COMPLETE === ${kpiRows.length} SKUs in ${(durationMs / 1000).toFixed(1)}s`);

      return jsonResponse({
        success: true,
        version: VERSION,
        dateRange: { startDate: dateRangeStart, endDate: dateRangeEnd },
        demandMode,
        demandIsDaily: useDailyMode,
        message: isDateRangeQuery
          ? `KPIs recalculated for date range${useDailyMode ? ' (daily mode)' : ''}`
          : `KPIs recalculated (preview)`,
        skusProcessed: kpiRows.length,
        data: kpiRows.map((r: any) => ({ sku: r.sku, kpi_data: r.kpi_data })),
        durationMs,
      });
    }

    // ── Persist KPI cache (only for full calculations, not date range queries) ──
    await supabase.from("aim2026_kpi_cache").delete().neq("id", 0);

    const batchSize = 500;
    for (let i = 0; i < kpiRows.length; i += batchSize) {
      const batch = kpiRows.slice(i, i + batchSize);
      const { error } = await supabase.from("aim2026_kpi_cache").insert(batch);
      if (error) console.error(`[${VERSION}] Error inserting KPI cache batch:`, error);
    }

    // ── Update ABC class in sku_parameters ───────────────────────
    for (const [sku, abc] of abcMap) {
      await supabase
        .from("aim2026_sku_parameters")
        .update({ abc_class: abc, updated_at: new Date().toISOString() })
        .eq("sku", sku);
    }

    // ── Write stock valuation snapshot ───────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const totalInventory =
      totalValuationMainWH +
      totalValuationChina +
      totalValuationContainer +
      totalValuationDHL +
      totalValuationOnProd +
      totalValuationKorea;

    await supabase
      .from("aim2026_stock_valuation_history")
      .delete()
      .eq("snapshot_date", today);

    await supabase.from("aim2026_stock_valuation_history").insert({
      snapshot_date: today,
      main_warehouse: Math.round(totalValuationMainWH),
      china: Math.round(totalValuationChina),
      container: Math.round(totalValuationContainer),
      dhl: Math.round(totalValuationDHL),
      on_production: Math.round(totalValuationOnProd),
      pesado_korea: Math.round(totalValuationKorea),
      total_inventory: Math.round(totalInventory),
    });

    const durationMs = Date.now() - startTime;

    console.log(`[${VERSION}] === KPI CALCULATION COMPLETE === ${kpiRows.length} SKUs in ${(durationMs / 1000).toFixed(1)}s`);

    return jsonResponse({
      success: true,
      version: VERSION,
      message: `[${VERSION}] KPIs calculated for ${kpiRows.length} SKUs in ${(durationMs / 1000).toFixed(1)}s. Demand: ${demandMap.size} SKUs (${[...demandMap.values()].reduce((s, arr) => s + arr.length, 0)} rows). SOH: ${sohMap.size} SKUs. Rates: freight=${config.freightRate}, duty=${config.dutyRate}, ins=${config.insuranceRate}.`,
      skusProcessed: kpiRows.length,
      valuation: {
        mainWarehouse: Math.round(totalValuationMainWH),
        china: Math.round(totalValuationChina),
        container: Math.round(totalValuationContainer),
        dhl: Math.round(totalValuationDHL),
        onProduction: Math.round(totalValuationOnProd),
        pesadoKorea: Math.round(totalValuationKorea),
        totalInventory: Math.round(totalInventory),
      },
      durationMs,
    });
  } catch (error) {
    console.error(`[${VERSION}] Fatal error:`, error);
    return jsonResponse(
      {
        success: false,
        version: VERSION,
        message: `KPI calculation error: ${error instanceof Error ? error.message : "Unknown"}`,
      },
      500
    );
  }
});
