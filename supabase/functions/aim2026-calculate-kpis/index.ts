// =============================================================================
// AIM 2026 — KPI Calculation Engine  (v2 — 2026-02-13)
// =============================================================================
// Reads synced data from aim2026_* tables, computes all KPIs for each SKU,
// and stores results in aim2026_kpi_cache. Also computes stock valuation
// and writes a daily snapshot to aim2026_stock_valuation_history.
//
// Called automatically after sync, or can be invoked independently.
//
// KPIs computed per SKU:
//   - Projected Demand (avg monthly)
//   - Demand Trend (up/down/stable)
//   - Reorder Point (ROP) = (Avg Daily Demand × Lead Time) + Safety Stock
//   - Safety Stock = Z × σ × √(Lead Time / 30)
//   - Target Stock Level = ROP + (Avg Daily Demand × Lead Time)
//   - Suggested Qty = max(0, Target − SOH Main WH − Pipeline)
//     where Pipeline = Container + DHL + On Production
//   - Days of Cover = SOH / Avg Daily Demand
//   - Turnover (annualized)
//   - Margin % (costs & revenue both in AUD)
//   - GMROI
//   - ABC Classification (revenue-based)
//   - Stockout Risk
//   - Status
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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
  exchangeRateUSDToAUD: number;
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
  quantity: number;      // sales quantity
  revenue: number;
  componentUsage: number; // component usage from production
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

  return {
    defaultLeadTimeDays: general.defaultLeadTimeDays ?? 45,
    defaultServiceLevelZ: general.defaultServiceLevelZ ?? 1.65,
    exchangeRateUSDToAUD: general.exchangeRateUSDToAUD ?? 1.54,
    freightRate: landed.freightRate ?? 0.0592,
    dutyRate: landed.dutyRate ?? 0.05,
    insuranceRate: landed.insuranceRate ?? 0.0132,
    capitalRatePercent: holding.capitalRatePercent ?? 10,
    riskRatePercent: holding.riskRatePercent ?? 4,
  };
}

// ─── Data Loaders ──────────────────────────────────────────────────────────

async function loadSKUParameters(supabase: any): Promise<Map<string, SKUParams>> {
  // Paginate to fetch all SKUs (Supabase max_rows caps at 1000)
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

  console.log(`Loaded ${allData.length} SKU parameters (paginated)`);

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
    // No data for today — find the most recent snapshot date
    const { data: latest } = await supabase
      .from("aim2026_soh_snapshots")
      .select("snapshot_date")
      .order("snapshot_date", { ascending: false })
      .limit(1);

    if (latest && latest.length > 0) {
      snapshotDate = latest[0].snapshot_date;
      console.log(`No SOH for today, using latest snapshot: ${snapshotDate}`);
    } else {
      console.log("No SOH snapshots found at all");
      return new Map();
    }
  }

  // Paginate to fetch all SOH rows (Supabase max_rows caps at 1000)
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

  console.log(`Loaded ${allData.length} SOH rows for ${snapshotDate} (paginated)`);

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

async function loadDemandHistory(supabase: any): Promise<Map<string, DemandMonth[]>> {
  // Must fetch ALL demand rows — with 5000+ SKU×month combinations,
  // the default PostgREST limit of 1000 is far too low!
  // Use pagination to get everything.
  const allData: any[] = [];
  const pageSize = 1000; // Supabase max_rows caps at 1000 per request
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("aim2026_demand_history")
      .select("*")
      .order("period_date", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`Failed to load demand: ${error.message}`);

    allData.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      hasMore = false;
    } else {
      offset += pageSize;
    }
  }

  console.log(`Loaded ${allData.length} demand history rows (paginated)`);

  if (allData.length === 0) {
    console.warn("WARNING: No demand history data found!");
  }

  const map = new Map<string, DemandMonth[]>();
  for (const row of allData) {
    const list = map.get(row.sku) ?? [];
    list.push({
      periodDate: row.period_date,
      quantity: Number(row.quantity_sold),
      revenue: Number(row.revenue),
      componentUsage: Number(row.component_usage ?? 0),
    });
    map.set(row.sku, list);
  }
  return map;
}

// ─── KPI Calculations ──────────────────────────────────────────────────────

function calcDemandStats(months: DemandMonth[]) {
  if (months.length === 0) {
    return { avgMonthly: 0, avgMonthlySalesOnly: 0, stdDev: 0, totalRevenue: 0, trend: "stable" as const, trendPercent: 0 };
  }

  // Total demand per month = sales + component usage (same as AIM tab's ROD)
  const totalQuantities = months.map((m) => m.quantity + m.componentUsage);
  const salesOnlyQuantities = months.map((m) => m.quantity);
  const totalRevenue = months.reduce((s, m) => s + m.revenue, 0);
  const avg = totalQuantities.reduce((a, b) => a + b, 0) / totalQuantities.length;
  const avgSalesOnly = salesOnlyQuantities.reduce((a, b) => a + b, 0) / salesOnlyQuantities.length;

  // Std deviation (on total demand)
  const variance = totalQuantities.reduce((s, q) => s + (q - avg) ** 2, 0) / totalQuantities.length;
  const stdDev = Math.sqrt(variance);

  // Trend: compare last 3 months avg vs previous 3 months avg
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
  // Sort descending by revenue
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
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Optional: accept syncId from request body
    let syncId: string | null = null;
    try {
      const body = await req.json();
      syncId = body?.syncId ?? null;
    } catch {
      // No body is fine
    }

    // ── Load all data ────────────────────────────────────────────
    const [config, skuParams, sohMap, demandMap] = await Promise.all([
      loadConfig(supabase),
      loadSKUParameters(supabase),
      loadTodaySOH(supabase),
      loadDemandHistory(supabase),
    ]);

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
      };

      const soh = sohMap.get(sku) ?? {};
      const demandMonths = demandMap.get(sku) ?? [];

      // Stock from warehouses (matching by name patterns)
      // Warehouse names from Unleashed: "Main Warehouse", "China-W", "Pesado Korea"
      // The sync stores exact warehouse names from per-warehouse API calls or CSV.
      const mainWH = findWarehouseValue(soh, ["main warehouse", "main"]);
      const chinaWH = findWarehouseValue(soh, ["china-w", "china"]);
      const containerWH = findWarehouseValue(soh, ["container"]);
      const dhlWH = findWarehouseValue(soh, ["dhl"]);
      const onProdWH = findWarehouseValue(soh, ["production"]);
      const koreaWH = findWarehouseValue(soh, ["pesado korea", "korea", "pesado"]);

      // Fallback: if no named warehouse matched for Main WH, use aggregate ("" key)
      if (mainWH.quantity === 0 && soh[""] !== undefined) {
        mainWH.quantity = soh[""].quantity;
        mainWH.allocated = soh[""].allocated;
        mainWH.available = soh[""].available;
      }

      // Demand stats
      const demandStats = calcDemandStats(demandMonths);
      const avgDailyDemand = demandStats.avgMonthly / 30;

      // Lead time & service level
      const leadTimeDays = params.leadTimeDays || config.defaultLeadTimeDays;
      const z = params.serviceLevelZ || config.defaultServiceLevelZ;

      // Safety Stock = Z × σ × √(Lead Time / 30)
      const safetyStock = Math.round(
        z * demandStats.stdDev * Math.sqrt(leadTimeDays / 30)
      );

      // Reorder Point = (Avg Daily Demand × Lead Time) + Safety Stock
      // This is the TRIGGER level — when stock drops below this, place an order.
      const reorderPoint = Math.round(avgDailyDemand * leadTimeDays + safetyStock);

      // Target Stock Level = ROP + (Avg Daily Demand × Lead Time)
      // This is the ORDER-UP-TO level — the quantity we want to have AFTER receiving the order.
      // Covers: lead time demand + safety stock + one more lead time of demand buffer.
      const targetStockLevel = Math.round(reorderPoint + avgDailyDemand * leadTimeDays);

      // Pipeline = in-transit / on-order stock that will arrive
      const pipeline = containerWH.quantity + dhlWH.quantity + onProdWH.quantity;

      // Suggested Qty = max(0, Target − SOH Main WH − Pipeline)
      // Only suggest when SOH is below ROP (the trigger)
      const suggestedQty = mainWH.quantity <= reorderPoint
        ? Math.max(0, targetStockLevel - mainWH.quantity - pipeline)
        : 0;

      // Days of Cover
      const daysOfCover = avgDailyDemand > 0 ? mainWH.quantity / avgDailyDemand : 999;

      // Landed Cost (costs.csv and revenue are already in AUD — no FX conversion needed)
      const landedCostAUD =
        params.productCostChina *
        (1 + config.freightRate + config.dutyRate + config.insuranceRate);

      // Avg selling price (from demand revenue)
      const totalQtySold = demandMonths.reduce((s, m) => s + m.quantity, 0);
      const avgSellingPrice =
        totalQtySold > 0 ? demandStats.totalRevenue / totalQtySold : 0;

      // Margin %
      const marginPercent =
        avgSellingPrice > 0
          ? ((avgSellingPrice - landedCostAUD) / avgSellingPrice) * 100
          : 0;

      // Turnover (annualized): COGS / Avg Inventory Value
      const annualCOGS = demandStats.avgMonthly * 12 * landedCostAUD;
      const avgInventoryValue = mainWH.quantity * landedCostAUD;
      const turnover = avgInventoryValue > 0 ? annualCOGS / avgInventoryValue : 0;

      // GMROI: Gross Margin / Avg Inventory Cost
      const grossMarginAnnual = demandStats.avgMonthly * 12 * (avgSellingPrice - landedCostAUD);
      const gmroi = avgInventoryValue > 0 ? grossMarginAnnual / avgInventoryValue : 0;

      // ABC Class
      const abcClass = abcMap.get(sku) ?? params.abcClass ?? "C";

      // Status & Risk
      const status = calcStatus(daysOfCover);
      const stockoutRisk = calcStockoutRisk(
        mainWH.quantity,
        safetyStock,
        reorderPoint,
        daysOfCover,
        leadTimeDays
      );

      // KPI row
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
          projectedDemand: Math.round(demandStats.avgMonthly),
          demandTrend: demandStats.trend,
          demandTrendPercent: Math.round(demandStats.trendPercent * 10) / 10,
          reorderPoint,
          safetyStock,
          targetStockLevel,
          pipeline,
          suggestedQty,
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
        },
      });

      // Accumulate valuation (all costs already in AUD)
      totalValuationMainWH += mainWH.quantity * landedCostAUD;
      totalValuationChina += chinaWH.quantity * params.productCostChina; // China stock at cost (AUD)
      totalValuationContainer += containerWH.quantity * landedCostAUD;
      totalValuationDHL += dhlWH.quantity * landedCostAUD;
      totalValuationOnProd += onProdWH.quantity * params.productCostChina; // On prod at cost (AUD)
      totalValuationKorea += koreaWH.quantity * landedCostAUD;
    }

    // ── Persist KPI cache ────────────────────────────────────────
    // Clear old cache
    await supabase.from("aim2026_kpi_cache").delete().neq("id", 0);

    // Insert in batches
    const batchSize = 500;
    for (let i = 0; i < kpiRows.length; i += batchSize) {
      const batch = kpiRows.slice(i, i + batchSize);
      const { error } = await supabase.from("aim2026_kpi_cache").insert(batch);
      if (error) console.error("Error inserting KPI cache batch:", error);
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

    // Delete today's existing snapshot (if re-running)
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

    return jsonResponse({
      success: true,
      version: "v2.1-20260213",
      message: `[v2.1] KPIs calculated for ${kpiRows.length} SKUs in ${(durationMs / 1000).toFixed(1)}s. Demand: ${demandMap.size} SKUs (${[...demandMap.values()].reduce((s, arr) => s + arr.length, 0)} rows). SOH: ${sohMap.size} SKUs. Rates: freight=${config.freightRate}, duty=${config.dutyRate}, ins=${config.insuranceRate}.`,
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
    console.error("Fatal error in aim2026-calculate-kpis:", error);
    return jsonResponse(
      {
        success: false,
        message: `KPI calculation error: ${error instanceof Error ? error.message : "Unknown"}`,
      },
      500
    );
  }
});
