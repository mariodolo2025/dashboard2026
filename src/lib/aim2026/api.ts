// =============================================================================
// AIM 2026 — Supabase API Layer
// =============================================================================
// Handles all communication with Supabase edge functions for the AIM 2026
// dashboard. Includes fallback to mock data when Supabase is not configured.
// =============================================================================

import type {
  SKURow,
  KPISummary,
  SyncProgress,
  AIM2026Config,
  StockValuationTotals,
  StockValuationHistoryRecord,
  DemandMode,
} from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** Check if Supabase is configured */
export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL !== 'your_supabase_project_url');
}

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
  };
}

async function callFunction<T>(
  functionName: string,
  body?: unknown,
  method?: 'GET' | 'POST'
): Promise<T> {
  const url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  const m = method ?? (body ? 'POST' : 'GET');

  const response = await fetch(url, {
    method: m,
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${functionName} failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ─── Sync with Unleashed ──────────────────────────────────────────────────

export interface SyncResult {
  success: boolean;
  status: 'success' | 'partial' | 'failed';
  syncId: string | null;
  recordsSynced: { products: number; soh: number; sales: number; purchase: number; assemblies: number };
  errors: string[];
  durationMs: number;
  message: string;
}

/** Check if the aim2026 tables have data (for determining if CSV initial load is needed) */
async function hasExistingData(): Promise<boolean> {
  try {
    const result = await callFunction<{ success: boolean; data: any[] }>(
      'aim2026-get-dashboard',
      { action: 'kpi_cache' }
    );
    return (result.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Load initial data from CSV files (step-by-step to avoid compute limits) */
export async function loadFromCSV(
  onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
  const allErrors: string[] = [];
  const totals = { products: 0, soh: 0, sales: 0, purchase: 0, costs: 0, production: 0 };
  let totalDuration = 0;

  // CSV load steps — each one is a separate edge function call
  const csvSteps = [
    { step: 'soh', label: 'Loading SOH & Products from CSV...', progress: 5 },
    { step: 'sales', label: 'Loading Sales/Demand from CSV...', progress: 20 },
    { step: 'costs', label: 'Loading Costs from CSV...', progress: 50 },
    { step: 'purchase', label: 'Loading Purchase Orders from CSV...', progress: 55 },
    { step: 'leadtimes', label: 'Loading Lead Times from ProductList.csv...', progress: 65 },
    { step: 'production', label: 'Loading Production data from CSV...', progress: 75 },
  ];

  for (const { step, label, progress } of csvSteps) {
    onProgress?.({ status: 'syncing', currentStep: label, progress });

    try {
      const result = await callFunction<{
        success: boolean;
        step: string;
        result: Record<string, number>;
        errors: string[];
        durationMs: number;
      }>('aim2026-csv-load', { step });

      const r = result.result ?? {};
      totals.soh += r.soh ?? 0;
      totals.products += r.products ?? 0;
      totals.sales += r.sales ?? 0;
      totals.costs += r.costs ?? 0;
      totals.purchase += r.purchase ?? 0;
      totals.production += r.production ?? 0;
      totalDuration += result.durationMs ?? 0;

      if (result.errors?.length) allErrors.push(...result.errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      allErrors.push(`CSV ${step}: ${msg}`);
      console.error(`CSV step ${step} failed:`, e);
    }

    // Small delay between steps
    await new Promise((r) => setTimeout(r, 1000));
  }

  const success = allErrors.length === 0;

  onProgress?.({
    status: success ? 'success' : allErrors.length < 5 ? 'syncing' : 'error',
    currentStep: success
      ? `CSV loaded: ${totals.products} products, ${totals.sales} demand, ${totals.costs} costs`
      : `CSV load completed with ${allErrors.length} warning(s)`,
    progress: 85,
    error: success ? undefined : allErrors.join('; '),
    completedAt: success ? new Date().toISOString() : undefined,
  });

  return {
    success: allErrors.length < 5,
    status: allErrors.length === 0 ? 'success' : allErrors.length < 5 ? 'partial' : 'failed',
    syncId: null,
    recordsSynced: {
      products: totals.products,
      soh: totals.soh,
      sales: totals.sales,
      purchase: totals.purchase,
      assemblies: 0,
    },
    errors: allErrors,
    durationMs: totalDuration,
    message: `CSV: Products ${totals.products}, SOH ${totals.soh}, Sales ${totals.sales}, Costs ${totals.costs}`,
  };
}

/** Refresh only BOM tables from latest BOM_*.csv in Storage (no SOH/sales/production CSVs). */
export async function reloadBomFromStorage(): Promise<{
  success: boolean;
  assemblies: number;
  components: number;
  message: string;
  errors: string[];
}> {
  try {
    const result = await callFunction<{
      success: boolean;
      step: string;
      result: Record<string, number>;
      errors: string[];
      durationMs: number;
    }>('aim2026-csv-load', { step: 'bom' });

    const assemblies = result.result?.bomAssemblies ?? 0;
    const components = result.result?.bomComponents ?? 0;
    const errs = result.errors ?? [];
    const ok = result.success !== false && errs.length === 0;

    return {
      success: ok,
      assemblies,
      components,
      message: ok
        ? `BOM updated: ${assemblies} assembled SKUs, ${components} component lines`
        : errs.join('; ') || 'BOM reload failed',
      errors: errs,
    };
  } catch (e) {
    return {
      success: false,
      assemblies: 0,
      components: 0,
      message: e instanceof Error ? e.message : 'Failed to reload BOM',
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
}

/** Load lead times from ProductList.csv (calls the 'leadtimes' step of csv-load) */
export async function loadLeadTimesFromCSV(): Promise<{
  success: boolean;
  count: number;
  message: string;
}> {
  try {
    const result = await callFunction<{
      success: boolean;
      step: string;
      result: Record<string, number>;
      errors: string[];
      durationMs: number;
    }>('aim2026-csv-load', { step: 'leadtimes' });

    const count = result.result?.leadtimes ?? 0;
    return {
      success: result.success !== false && (result.errors?.length ?? 0) === 0,
      count,
      message: count > 0
        ? `Loaded lead times for ${count} SKUs`
        : result.errors?.join('; ') || 'No lead times found in ProductList.csv',
    };
  } catch (e) {
    return {
      success: false,
      count: 0,
      message: e instanceof Error ? e.message : 'Failed to load lead times',
    };
  }
}

/** Full CSV reload: runs all csv-load steps + KPI recalculation */
export interface CsvReloadProgress {
  step: string;
  label: string;
  progress: number;
  error?: string;
}
export async function reloadFromCSVs(
  onProgress?: (p: CsvReloadProgress) => void
): Promise<{ success: boolean; message: string; errors: string[] }> {
  const steps = [
    { step: 'soh', label: 'Loading SOH & Products...', progress: 10 },
    { step: 'sales', label: 'Loading Sales History...', progress: 25 },
    { step: 'production', label: 'Loading Production / Assemblies...', progress: 45 },
    { step: 'costs', label: 'Loading Costs...', progress: 55 },
    { step: 'purchase', label: 'Loading Purchase Orders...', progress: 65 },
    { step: 'leadtimes', label: 'Loading Lead Times...', progress: 75 },
  ];

  const allErrors: string[] = [];
  const results: Record<string, number> = {};

  for (const { step, label, progress } of steps) {
    onProgress?.({ step, label, progress });
    try {
      const res = await callFunction<{
        success: boolean;
        step: string;
        result: Record<string, number>;
        errors: string[];
      }>('aim2026-csv-load', { step });
      if (res.errors?.length) allErrors.push(...res.errors);
      Object.assign(results, res.result ?? {});
    } catch (e) {
      const msg = `${step}: ${e instanceof Error ? e.message : String(e)}`;
      allErrors.push(msg);
      onProgress?.({ step, label: `Error: ${msg}`, progress, error: msg });
    }
  }

  onProgress?.({ step: 'kpis', label: 'Recalculating KPIs...', progress: 90 });
  try {
    await callFunction('aim2026-calc-kpis-v2');
  } catch (e) {
    allErrors.push(`KPIs: ${e instanceof Error ? e.message : String(e)}`);
  }

  onProgress?.({ step: 'done', label: 'Done', progress: 100 });

  const loaded = Object.entries(results)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  return {
    success: allErrors.length === 0,
    message: allErrors.length === 0
      ? `CSV reload complete. ${loaded}`
      : `Completed with ${allErrors.length} error(s). ${loaded}`,
    errors: allErrors,
  };
}

/** Trigger KPI recalculation (called after loading new data) */
export async function recalculateKPIs(): Promise<{ success: boolean; message: string }> {
  try {
    const result = await callFunction<{
      success: boolean;
      message: string;
      skusProcessed: number;
    }>('aim2026-calc-kpis-v2');

    return {
      success: result.success !== false,
      message: result.message ?? `KPIs recalculated for ${result.skusProcessed ?? 0} SKUs`,
    };
  } catch (e) {
    return {
      success: false,
      message: e instanceof Error ? e.message : 'Failed to recalculate KPIs',
    };
  }
}

/** Main sync: runs steps sequentially, with CSV initial load if tables are empty */
export async function syncUnleashed(
  onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
  const allErrors: string[] = [];
  const totals = { products: 0, soh: 0, sales: 0, purchase: 0, assemblies: 0 };
  let lastSyncId: string | null = null;
  let totalDuration = 0;

  // Check if we need CSV initial load
  const dataExists = await hasExistingData();

  if (!dataExists) {
    // First run: load initial data from CSV files
    onProgress?.({
      status: 'syncing',
      currentStep: 'Loading initial data from CSV files...',
      progress: 5,
    });

    try {
      const csvResult = await loadFromCSV((p) => {
        onProgress?.({
          ...p,
          progress: Math.round(p.progress * 0.3), // CSV load = 0-30%
        });
      });

      totals.products += csvResult.recordsSynced.products;
      totals.soh += csvResult.recordsSynced.soh;
      totals.sales += csvResult.recordsSynced.sales;
      totalDuration += csvResult.durationMs;
      if (csvResult.errors.length) allErrors.push(...csvResult.errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      allErrors.push(`CSV initial load: ${msg}`);
      console.error('CSV initial load failed:', e);
    }
  }

  // Incremental sync from Unleashed API
  const coreSteps: { step: string; label: string; progress: number; extra?: Record<string, string> }[] = [
    { step: 'products', label: 'Syncing Products from Unleashed...', progress: dataExists ? 10 : 35 },
    { step: 'soh', label: 'Syncing Stock on Hand (per warehouse)...', progress: dataExists ? 20 : 42 },
    { step: 'sales', label: 'Syncing Sales (Completed)...', progress: dataExists ? 26 : 46, extra: { salesStatus: 'Completed', isFirstSalesStatus: 'true' } },
    { step: 'sales', label: 'Syncing Sales (Placed)...', progress: dataExists ? 30 : 50, extra: { salesStatus: 'Placed' } },
    { step: 'sales', label: 'Syncing Sales (Backordered)...', progress: dataExists ? 34 : 54, extra: { salesStatus: 'Backordered' } },
    { step: 'sales', label: 'Syncing Sales (Parked)...', progress: dataExists ? 36 : 56, extra: { salesStatus: 'Parked' } },
    { step: 'purchase', label: 'Syncing Purchase Orders...', progress: dataExists ? 40 : 58 },
  ];

  for (let i = 0; i < coreSteps.length; i++) {
    const { step, label, progress, extra } = coreSteps[i];

    onProgress?.({
      status: 'syncing',
      currentStep: label,
      progress,
    });

    try {
      const result = await callFunction<SyncResult>('aim2026-sync-unleashed', { step, ...extra });
      totals.products += result.recordsSynced?.products ?? 0;
      totals.soh += result.recordsSynced?.soh ?? 0;
      totals.sales += result.recordsSynced?.sales ?? 0;
      totals.purchase += result.recordsSynced?.purchase ?? 0;
      totalDuration += result.durationMs ?? 0;
      if (result.syncId) lastSyncId = result.syncId;
      if (result.errors?.length) allErrors.push(...result.errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      allErrors.push(`${step}: ${msg}`);
      console.error(`Sync step ${step} failed:`, e);
    }
  }

  // Assemblies: split into monthly chunks to stay within memory/time limits
  const now = new Date();
  const assemblyChunks: { start: string; end: string; label: string }[] = [];
  for (let m = 12; m >= 1; m--) {
    const chunkStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const chunkEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
    const startStr = chunkStart.toISOString().slice(0, 10);
    const endStr = chunkEnd.toISOString().slice(0, 10);
    const label = chunkStart.toLocaleDateString('en', { month: 'short', year: 'numeric' });
    assemblyChunks.push({ start: startStr, end: endStr, label });
  }
  // Current (incomplete) month
  const curStart = new Date(now.getFullYear(), now.getMonth(), 1);
  assemblyChunks.push({
    start: curStart.toISOString().slice(0, 10),
    end: now.toISOString().slice(0, 10),
    label: curStart.toLocaleDateString('en', { month: 'short', year: 'numeric' }),
  });

  for (let c = 0; c < assemblyChunks.length; c++) {
    const chunk = assemblyChunks[c];
    const pct = dataExists
      ? 48 + Math.round((c / assemblyChunks.length) * 25)
      : 62 + Math.round((c / assemblyChunks.length) * 15);

    onProgress?.({
      status: 'syncing',
      currentStep: `Syncing Assemblies (${chunk.label})...`,
      progress: pct,
    });

    try {
      const result = await callFunction<SyncResult>('aim2026-sync-unleashed', {
        step: 'assemblies',
        assemblyStartDate: chunk.start,
        assemblyEndDate: chunk.end,
        ...(c === 0 ? { isFirstAssemblyChunk: 'true' } : {}),
      });
      totals.assemblies += result.recordsSynced?.assemblies ?? 0;
      totalDuration += result.durationMs ?? 0;
      if (result.syncId) lastSyncId = result.syncId;
      if (result.errors?.length) allErrors.push(...result.errors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      allErrors.push(`assemblies (${chunk.label}): ${msg}`);
      console.error(`Assembly chunk ${chunk.label} failed:`, e);
    }
  }

  // Supplement assembly component_usage from CSV for warehouses not covered by API
  onProgress?.({
    status: 'syncing',
    currentStep: 'Supplementing assembly data from CSV...',
    progress: 76,
  });

  try {
    await callFunction<{ success: boolean; errors: string[] }>(
      'aim2026-sync-unleashed',
      { step: 'supplement_assembly_csv' }
    );
  } catch (e) {
    console.error('Assembly CSV supplement failed:', e);
    allErrors.push(`Assembly CSV supplement: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Reload costs from CSV to ensure costs.csv values take precedence
  onProgress?.({
    status: 'syncing',
    currentStep: 'Reloading costs from CSV...',
    progress: 82,
  });

  try {
    const costResult = await callFunction<{ success: boolean; errors: string[] }>(
      'aim2026-csv-load',
      { step: 'costs' }
    );
    if (costResult.errors?.length) allErrors.push(...costResult.errors);
  } catch (e) {
    console.error('Cost reload failed:', e);
    allErrors.push(`Cost reload: ${e instanceof Error ? e.message : String(e)}`);
  }

  // NOTE: Purchase orders are now synced directly from the Unleashed API (step 'purchase' above).
  // The CSV reload was removed because it was overwriting fresh API data with stale CSV values.
  // CSV PO data is only used for the initial load when tables are empty (via loadFromCSV).

  // Calculate KPIs from synced data
  onProgress?.({
    status: 'syncing',
    currentStep: 'Calculating KPIs...',
    progress: 92,
  });

  try {
    const kpiResult = await callFunction<{ success: boolean; message: string; version?: string }>(
      'aim2026-calc-kpis-v2',
      { syncId: lastSyncId }
    );
    console.log('KPI calculation result:', kpiResult.message, 'version:', kpiResult.version);
  } catch (e) {
    console.error('KPI calculation failed:', e);
    allErrors.push(`KPI calculation: ${e instanceof Error ? e.message : String(e)}`);
  }

  const success = allErrors.length === 0;
  const status: SyncResult['status'] = success ? 'success' : allErrors.length < 5 ? 'partial' : 'failed';

  const syncResult: SyncResult = {
    success: status !== 'failed',
    status,
    syncId: lastSyncId,
    recordsSynced: totals,
    errors: allErrors,
    durationMs: totalDuration,
    message: success
      ? `Sync completed. Products: ${totals.products}, SOH: ${totals.soh}, Sales: ${totals.sales}, PO: ${totals.purchase}, Assemblies: ${totals.assemblies}.`
      : `Sync completed with ${allErrors.length} error(s).`,
  };

  onProgress?.({
    status: syncResult.success ? 'success' : 'error',
    currentStep: syncResult.success ? 'Sync complete' : 'Sync completed with errors',
    progress: 100,
    error: syncResult.success ? undefined : syncResult.message,
    completedAt: new Date().toISOString(),
  });

  return syncResult;
}

// ─── Fetch Dashboard Data (from KPI cache) ────────────────────────────────

export interface BOMComponent {
  assembly_sku: string;
  component_sku: string;
  quantity_per_assembly: number;
}

export interface DashboardData {
  rows: SKURow[];
  kpiSummary: KPISummary;
  valuation: StockValuationTotals;
  valuationHistory: StockValuationHistoryRecord[];
  /** SKUs that are assembled products (have a BOM). Used to filter table by default. */
  assembledProductSKUs: string[];
  /** BOM components: assembly -> component -> qty. For dashboard component relationship display. */
  bomComponents: BOMComponent[];
}

export async function fetchDashboardData(): Promise<DashboardData> {
  // Fetch KPI cache + valuation history in parallel
  const [kpiResponse, valuationHistory] = await Promise.all([
    callFunction<{
      success: boolean;
      data: Array<{ sku: string; kpi_data: any; calculated_at: string }>;
      assembledProductSKUs?: string[];
      bomComponents?: BOMComponent[];
    }>('aim2026-get-dashboard', {}),
    fetchValuationHistory(10),
  ]);

  const kpiData = kpiResponse.data ?? [];
  const assembledProductSKUs = kpiResponse.assembledProductSKUs ?? [];
  const bomComponents = kpiResponse.bomComponents ?? [];

  // Transform KPI cache rows into SKURow[]
  const rows: SKURow[] = kpiData.map((row) => {
    const d = row.kpi_data;
    return {
      sku: row.sku,
      product: d.product ?? '',
      productGroup: d.productGroup ?? 'Other',
      supplier: d.supplier ?? 'Unknown',
      abcClass: d.abcClass ?? 'C',
      sohMainWH: d.sohMainWH ?? 0,
      sohChina: d.sohChina ?? 0,
      container: d.container ?? 0,
      dhl: d.dhl ?? 0,
      onProduction: d.onProduction ?? 0,
      allocatedMainWH: d.allocatedMainWH ?? 0,
      availableMainWH: d.availableMainWH ?? 0,
      allocatedChina: d.allocatedChina ?? 0,
      availableChina: d.availableChina ?? 0,
      allocatedTotal: d.allocatedTotal ?? (d.allocatedMainWH ?? 0) + (d.allocatedChina ?? 0),
      projectedDemand: d.projectedDemand ?? 0,
      demandB2b: d.demandB2b ?? 0,
      demandB2c: d.demandB2c ?? 0,
      demandTrend: d.demandTrend ?? 'stable',
      demandTrendPercent: d.demandTrendPercent ?? 0,
      reorderPoint: d.reorderPoint ?? 0,
      safetyStock: d.safetyStock ?? 0,
      targetStockLevel: d.targetStockLevel ?? 0,
      pipeline: d.pipeline ?? 0,
      suggestedQty: d.suggestedQty ?? 0,
      softSuggestedQty: d.softSuggestedQty ?? 0,
      daysOfCover: d.daysOfCover ?? 0,
      turnover: d.turnover ?? 0,
      turnoverTrend: 'stable',
      marginPercent: d.marginPercent ?? 0,
      gmroi: d.gmroi ?? 0,
      productCostChina: d.productCostChina ?? 0,
      landedCostAUD: d.landedCostAUD ?? 0,
      avgSellingPrice: d.avgSellingPrice ?? 0,
      status: d.status ?? 'OK',
      stockoutRisk: d.stockoutRisk ?? 'low',
      leadTimeDays: d.leadTimeDays ?? 45,
      serviceLevelZ: d.serviceLevelZ ?? 1.65,
    };
  });

  // Compute KPI summary from rows
  // Use valuation from stock_valuation_history (same source as popup dialog)
  // to keep the KPI card and popup consistent
  const latestValuation = valuationHistory[0];
  const totalInventoryValue = latestValuation
    ? latestValuation.totalInventory
    : rows.reduce((s, r) => s + r.sohMainWH * r.landedCostAUD, 0);

  const itemsAtRisk = rows.filter(
    (r) => r.status === 'CRITICAL' || r.status === 'LOW STOCK'
  ).length;

  // Exclude products without selling price from avg margin (old/obsolete parts skew the metric)
  const rowsWithSellingPrice = rows.filter((r) => (r.avgSellingPrice ?? 0) > 0);

  // Use exchange rate from config if available, else default 1.54
  const exchangeRate = 1.54;

  const kpiSummary: KPISummary = {
    totalInventoryValueAUD: Math.round(totalInventoryValue),
    totalInventoryValueUSD: Math.round(totalInventoryValue / exchangeRate),
    itemsAtRisk,
    avgTurnover: rows.length > 0 ? rows.reduce((s, r) => s + r.turnover, 0) / rows.length : 0,
    avgTurnoverTrend: 'stable',
    avgGMROI: rows.length > 0 ? rows.reduce((s, r) => s + r.gmroi, 0) / rows.length : 0,
    avgMarginPercent: rowsWithSellingPrice.length > 0 ? rowsWithSellingPrice.reduce((s, r) => s + r.marginPercent, 0) / rowsWithSellingPrice.length : 0,
    avgMarginTrend: 'stable',
    avgDaysOfCover: rows.length > 0 ? rows.reduce((s, r) => s + r.daysOfCover, 0) / rows.length : 0,
    totalProducts: rows.length,
    lastSyncAt: kpiData[0]?.calculated_at ?? null,
    inventoryValueHistory: valuationHistory.map((h) => ({
      date: h.snapshotDate,
      value: h.totalInventory,
    })),
  };

  // Valuation from latest history record
  const latestVal = valuationHistory[0];
  const valuation: StockValuationTotals = latestVal
    ? {
        mainWarehouse: latestVal.mainWarehouse,
        china: latestVal.china,
        container: latestVal.container,
        dhl: latestVal.dhl,
        onProduction: latestVal.onProduction,
        pesadoKorea: latestVal.pesadoKorea,
        totalInventory: latestVal.totalInventory,
      }
    : {
        mainWarehouse: 0,
        china: 0,
        container: 0,
        dhl: 0,
        onProduction: 0,
        pesadoKorea: 0,
        totalInventory: 0,
      };

  return { rows, kpiSummary, valuation, valuationHistory, assembledProductSKUs, bomComponents };
}

// ─── Date Range KPI Recalculation ─────────────────────────────────────────

function kpiDataToRow(sku: string, d: any): SKURow {
  return {
    sku,
    product: d.product ?? '',
    productGroup: d.productGroup ?? 'Other',
    supplier: d.supplier ?? 'Unknown',
    abcClass: d.abcClass ?? 'C',
    sohMainWH: d.sohMainWH ?? 0,
    sohChina: d.sohChina ?? 0,
    container: d.container ?? 0,
    dhl: d.dhl ?? 0,
    onProduction: d.onProduction ?? 0,
    allocatedMainWH: d.allocatedMainWH ?? 0,
    availableMainWH: d.availableMainWH ?? 0,
    allocatedChina: d.allocatedChina ?? 0,
    availableChina: d.availableChina ?? 0,
    allocatedTotal: d.allocatedTotal ?? (d.allocatedMainWH ?? 0) + (d.allocatedChina ?? 0),
    projectedDemand: d.projectedDemand ?? 0,
    demandB2b: d.demandB2b ?? 0,
    demandB2c: d.demandB2c ?? 0,
    demandTrend: d.demandTrend ?? 'stable',
    demandTrendPercent: d.demandTrendPercent ?? 0,
    reorderPoint: d.reorderPoint ?? 0,
    safetyStock: d.safetyStock ?? 0,
    targetStockLevel: d.targetStockLevel ?? 0,
    pipeline: d.pipeline ?? 0,
    suggestedQty: d.suggestedQty ?? 0,
    softSuggestedQty: d.softSuggestedQty ?? 0,
    daysOfCover: d.daysOfCover ?? 0,
    turnover: d.turnover ?? 0,
    turnoverTrend: 'stable',
    marginPercent: d.marginPercent ?? 0,
    gmroi: d.gmroi ?? 0,
    productCostChina: d.productCostChina ?? 0,
    landedCostAUD: d.landedCostAUD ?? 0,
    avgSellingPrice: d.avgSellingPrice ?? 0,
    status: d.status ?? 'OK',
    stockoutRisk: d.stockoutRisk ?? 'low',
    leadTimeDays: d.leadTimeDays ?? 45,
    serviceLevelZ: d.serviceLevelZ ?? 1.65,
  };
}

export async function recalcKPIsForDateRange(
  startDate: string,
  endDate: string,
  rangeFrom?: string,
  rangeTo?: string,
  demandMode?: DemandMode
): Promise<{ rows: SKURow[]; kpiSummary: KPISummary; demandIsDaily: boolean }> {
  const body: Record<string, string> = { startDate, endDate };
  if (rangeFrom) body.rangeFrom = rangeFrom;
  if (rangeTo) body.rangeTo = rangeTo;
  if (demandMode) body.demandMode = demandMode;
  // Use URL params as backup so rangeFrom/rangeTo always reach the backend
  const params = new URLSearchParams({ startDate, endDate });
  if (rangeFrom) params.set('rangeFrom', rangeFrom);
  if (rangeTo) params.set('rangeTo', rangeTo);
  if (demandMode) params.set('demandMode', demandMode);
  const url = `${SUPABASE_URL}/functions/v1/aim2026-calc-kpis-v2?${params.toString()}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`aim2026-calc-kpis-v2 failed (${response.status}): ${errorText}`);
  }
  const result = await response.json() as {
    success: boolean;
    data: Array<{ sku: string; kpi_data: any }>;
    skusProcessed: number;
    demandIsDaily?: boolean;
  };

  const kpiData = result.data ?? [];
  const rows: SKURow[] = kpiData.map((row) => kpiDataToRow(row.sku, row.kpi_data));

  const totalInventoryValue = rows.reduce((s, r) => s + r.sohMainWH * r.landedCostAUD, 0);
  const itemsAtRisk = rows.filter(
    (r) => r.status === 'CRITICAL' || r.status === 'LOW STOCK'
  ).length;
  const rowsWithSellingPrice = rows.filter((r) => (r.avgSellingPrice ?? 0) > 0);
  const exchangeRate = 1.54;

  const kpiSummary: KPISummary = {
    totalInventoryValueAUD: Math.round(totalInventoryValue),
    totalInventoryValueUSD: Math.round(totalInventoryValue / exchangeRate),
    itemsAtRisk,
    avgTurnover: rows.length > 0 ? rows.reduce((s, r) => s + r.turnover, 0) / rows.length : 0,
    avgTurnoverTrend: 'stable',
    avgGMROI: rows.length > 0 ? rows.reduce((s, r) => s + r.gmroi, 0) / rows.length : 0,
    avgMarginPercent: rowsWithSellingPrice.length > 0 ? rowsWithSellingPrice.reduce((s, r) => s + r.marginPercent, 0) / rowsWithSellingPrice.length : 0,
    avgMarginTrend: 'stable',
    avgDaysOfCover: rows.length > 0 ? rows.reduce((s, r) => s + r.daysOfCover, 0) / rows.length : 0,
    totalProducts: rows.length,
    lastSyncAt: null,
    inventoryValueHistory: [],
  };

  return { rows, kpiSummary, demandIsDaily: result.demandIsDaily ?? false };
}

// ─── Demand Mode KPI Preview ──────────────────────────────────────────────

export async function recalcKPIsForDemandMode(
  demandMode: DemandMode
): Promise<{ rows: SKURow[]; kpiSummary: KPISummary; demandIsDaily: boolean }> {
  const body: Record<string, string | boolean> = {
    demandMode,
    previewOnly: true,
  };
  const params = new URLSearchParams({ demandMode, previewOnly: 'true' });
  const url = `${SUPABASE_URL}/functions/v1/aim2026-calc-kpis-v2?${params.toString()}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`aim2026-calc-kpis-v2 failed (${response.status}): ${errorText}`);
  }
  const result = await response.json() as {
    success: boolean;
    data: Array<{ sku: string; kpi_data: any }>;
    skusProcessed: number;
    demandIsDaily?: boolean;
  };

  const kpiData = result.data ?? [];
  const rows: SKURow[] = kpiData.map((row) => kpiDataToRow(row.sku, row.kpi_data));

  const totalInventoryValue = rows.reduce((s, r) => s + r.sohMainWH * r.landedCostAUD, 0);
  const itemsAtRisk = rows.filter(
    (r) => r.status === 'CRITICAL' || r.status === 'LOW STOCK'
  ).length;
  const rowsWithSellingPrice = rows.filter((r) => (r.avgSellingPrice ?? 0) > 0);
  const exchangeRate = 1.54;

  const kpiSummary: KPISummary = {
    totalInventoryValueAUD: Math.round(totalInventoryValue),
    totalInventoryValueUSD: Math.round(totalInventoryValue / exchangeRate),
    itemsAtRisk,
    avgTurnover: rows.length > 0 ? rows.reduce((s, r) => s + r.turnover, 0) / rows.length : 0,
    avgTurnoverTrend: 'stable',
    avgGMROI: rows.length > 0 ? rows.reduce((s, r) => s + r.gmroi, 0) / rows.length : 0,
    avgMarginPercent: rowsWithSellingPrice.length > 0 ? rowsWithSellingPrice.reduce((s, r) => s + r.marginPercent, 0) / rowsWithSellingPrice.length : 0,
    avgMarginTrend: 'stable',
    avgDaysOfCover: rows.length > 0 ? rows.reduce((s, r) => s + r.daysOfCover, 0) / rows.length : 0,
    totalProducts: rows.length,
    lastSyncAt: null,
    inventoryValueHistory: [],
  };

  return { rows, kpiSummary, demandIsDaily: result.demandIsDaily ?? false };
}

// ─── Valuation History ────────────────────────────────────────────────────

export async function fetchValuationHistory(
  limit = 50
): Promise<StockValuationHistoryRecord[]> {
  try {
    const data = await callFunction<{
      success: boolean;
      data: any[];
    }>('aim2026-get-dashboard', { action: 'valuation_history', limit });

    return (data.data ?? []).map((r: any) => ({
      id: r.id,
      snapshotDate: r.snapshot_date,
      mainWarehouse: Number(r.main_warehouse),
      china: Number(r.china),
      container: Number(r.container),
      dhl: Number(r.dhl),
      onProduction: Number(r.on_production),
      pesadoKorea: Number(r.pesado_korea),
      totalInventory: Number(r.total_inventory),
    }));
  } catch {
    return [];
  }
}

// ─── Xero Costs (from parse-xero-costs) ──────────────────────────────────

export interface XeroCostItem {
  name: string;
  monthly: number[];
  totalAnnual: number;
}

export interface XeroCostsData {
  months: { index: number; label: string; year: number; month: number }[];
  items: XeroCostItem[];
  periodEnd?: string;
}

/** Fetch Xero P&L cost data from the parse-xero-costs edge function */
export async function fetchXeroCosts(): Promise<XeroCostsData> {
  const url = `${SUPABASE_URL}/functions/v1/parse-xero-costs`;
  const response = await fetch(url, {
    method: 'GET',
    headers: headers(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`parse-xero-costs failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Add totalAnnual to each item
  const items: XeroCostItem[] = (data.items ?? []).map((item: any) => ({
    name: item.name,
    monthly: item.monthly ?? [],
    totalAnnual: (item.monthly ?? []).reduce((s: number, v: number) => s + v, 0),
  }));

  return {
    months: data.months ?? [],
    items,
    periodEnd: data.periodEnd,
  };
}

/** Auto-categorize Xero cost items into freight/duty/insurance/other */
export interface CostCategorization {
  freight: { items: XeroCostItem[]; total: number };
  duty: { items: XeroCostItem[]; total: number };
  insurance: { items: XeroCostItem[]; total: number };
  other: { items: XeroCostItem[]; total: number };
  totalCOGS: number;
}

const FREIGHT_PATTERNS = [
  'freight', 'shipping', 'container', 'sea freight', 'ocean freight',
  'port', 'customs clearance', 'domestic freight', 'local delivery',
  'cartage', 'transport', 'logistics', 'haulage', 'warehousing fee',
  'wharfage', 'stevedoring', 'demurrage', 'detention',
];

const DUTY_PATTERNS = [
  'duty', 'tariff', 'import duty', 'customs duty', 'gst on import',
  'import tax', 'excise',
];

const INSURANCE_PATTERNS = [
  'insurance', 'cargo insurance', 'marine insurance', 'transit insurance',
  'goods in transit',
];

export function categorizeXeroCosts(items: XeroCostItem[]): CostCategorization {
  const freight: XeroCostItem[] = [];
  const duty: XeroCostItem[] = [];
  const insurance: XeroCostItem[] = [];
  const other: XeroCostItem[] = [];

  for (const item of items) {
    if (item.totalAnnual === 0) continue; // Skip zero items

    const nameLower = item.name.toLowerCase();

    if (FREIGHT_PATTERNS.some((p) => nameLower.includes(p))) {
      freight.push(item);
    } else if (DUTY_PATTERNS.some((p) => nameLower.includes(p))) {
      duty.push(item);
    } else if (INSURANCE_PATTERNS.some((p) => nameLower.includes(p))) {
      insurance.push(item);
    } else {
      other.push(item);
    }
  }

  const sum = (arr: XeroCostItem[]) => arr.reduce((s, i) => s + Math.abs(i.totalAnnual), 0);
  const totalAll = items.reduce((s, i) => s + Math.abs(i.totalAnnual), 0);

  return {
    freight: { items: freight, total: sum(freight) },
    duty: { items: duty, total: sum(duty) },
    insurance: { items: insurance, total: sum(insurance) },
    other: { items: other, total: sum(other) },
    totalCOGS: totalAll,
  };
}

// ─── Recent Orders for SKU popup ──────────────────────────────────────────

export interface RecentOrder {
  orderType: 'purchase' | 'sales';
  orderNumber?: string;
  date: string;
  deliveryDate?: string;
  customer?: string;
  supplier?: string;
  quantity: number;
  amount: number;
  status: string;
  warehouse?: string;
}

export async function fetchRecentOrders(sku: string): Promise<RecentOrder[]> {
  try {
    const data = await callFunction<{ success: boolean; data: any[] }>(
      'aim2026-get-dashboard',
      { action: 'recent_orders', sku }
    );
    return (data.data ?? []).map((r: any) => ({
      orderType: (r.order_type ?? 'sales') as 'purchase' | 'sales',
      orderNumber: r.order_number ?? undefined,
      date: r.order_date ?? '',
      deliveryDate: r.delivery_date ?? undefined,
      customer: r.customer ?? undefined,
      supplier: r.supplier ?? undefined,
      quantity: Number(r.quantity ?? 0),
      amount: Number(r.amount ?? 0),
      status: r.status ?? '',
      warehouse: r.warehouse ?? undefined,
    }));
  } catch (e) {
    console.error('Failed to fetch recent orders:', e);
    return [];
  }
}

// ─── AI Insights (Claude) ─────────────────────────────────────────────────

export async function fetchAIInsights(
  skus: Array<Record<string, unknown>>,
  kpiSummary: Record<string, unknown>,
  options?: {
    assembledProductSKUs?: string[];
    customPrompt?: string;
    excludedSKUs?: string[];
  }
): Promise<{
  success: boolean;
  insights: Array<{
    category: string;
    severity: string;
    title: string;
    description: string;
    confidence: number;
    actionLabel?: string;
    relatedSKUs?: string[];
  }>;
  generatedAt?: string;
  model?: string;
  message?: string;
}> {
  return callFunction('aim2026-ai-insights', {
    skus,
    kpiSummary,
    assembledProductSKUs: options?.assembledProductSKUs ?? [],
    customPrompt: options?.customPrompt ?? '',
    excludedSKUs: options?.excludedSKUs ?? [],
  });
}

// ─── Create Purchase Order in Unleashed ───────────────────────────────────

export async function createPurchaseOrder(request: {
  items: Array<{ productCode: string; orderQuantity: number; unitPrice: number; deliveryDate?: string }>;
  supplierCode: string;
  warehouseCode: string;
  customOrderStatus: string;
  /** ISO date string para el header DeliveryDate. Container: projectionDate + 30d.
   *  Production: max(today + leadTime). Default backend = +45d si no se manda. */
  deliveryDate?: string;
}): Promise<{ success: boolean; orderNumber?: string; orderGuid?: string; message: string; excludedProductCodes?: string[] }> {
  const url = `${SUPABASE_URL}/functions/v1/aim2026-create-purchase-order`;
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(request),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) {
    return data as { success: boolean; orderNumber?: string; orderGuid?: string; message: string; excludedProductCodes?: string[] };
  }
  // 400: validation error (e.g. non-purchasable products) — return parsed body so UI can show message
  if (response.status === 400) {
    return { success: false, message: data?.message ?? 'Invalid request' };
  }
  throw new Error(`aim2026-create-purchase-order failed (${response.status}): ${data.message ?? JSON.stringify(data)}`);
}

// ─── Debug: check warehouse names & sync results ─────────────────────────

export async function debugData(): Promise<any> {
  return callFunction('aim2026-get-dashboard', { action: 'debug_data' });
}

// ─── Config ───────────────────────────────────────────────────────────────

export async function loadConfig(): Promise<AIM2026Config | null> {
  try {
    const result = await callFunction<{ success: boolean; data: any }>('aim2026-get-dashboard', {
      action: 'config',
    });
    return result.data ?? null;
  } catch {
    return null;
  }
}

export async function saveConfig(config: AIM2026Config): Promise<void> {
  await callFunction('aim2026-get-dashboard', { action: 'save_config', config });
}

// ─── Warehouse Valuation Detail (for CSV download) ────────────────────────

export interface WarehouseDetailRow {
  sku: string;
  product: string;
  productGroup: string;
  warehouse: string;
  quantity: number;
  allocated: number;
  available: number;
  unitCostChina: number;
  landedCostAUD: number;
  unitCostUsed: number;
  totalValue: number;
  valuationMethod: string;
}

export interface WarehouseDetailResult {
  success: boolean;
  data: WarehouseDetailRow[];
  snapshotDate: string | null;
  warehouse: string;
  grandTotal: number;
  exchangeRate: number;
  skuCount: number;
}

export async function fetchWarehouseDetail(warehouseKey: string): Promise<WarehouseDetailResult> {
  return callFunction<WarehouseDetailResult>('aim2026-get-dashboard', {
    action: 'warehouse_detail',
    warehouse: warehouseKey,
  });
}

// ─── Demand Transactions (for CSV download) ───────────────────────────────

export interface DemandTransaction {
  type: string;
  date: string;
  customer: string;
  quantity: number;
  amount: number;
  status: string;
  warehouse: string;
  productGroup: string;
  customerType: string;
}

export interface DemandTransactionsResult {
  success: boolean;
  data: DemandTransaction[];
  sku: string;
  month: string;
  totalQuantity: number;
  totalAmount: number;
  transactionCount: number;
}

export async function fetchDemandTransactions(
  sku: string,
  month: string
): Promise<DemandTransactionsResult> {
  const result = await callFunction<DemandTransactionsResult>('aim2026-get-dashboard', {
    action: 'demand_transactions',
    sku,
    month,
  });
  return result;
}

// ─── Generate Purchase Enquiry CSV from Unleashed API ─────────────────────

export interface GeneratePurchaseCsvResult {
  success: boolean;
  version?: string;
  generatedAt?: string;
  totalOrders: number;
  totalRows: number;
  totalQty: number;
  totalCost: number;
  csvSizeBytes: number;
  csvBase64?: string;
  upload: { success: boolean; bucket?: string; file?: string; error?: string } | null;
  debug?: Record<string, any>;
  sampleRows: Array<{
    orderNo: string;
    orderDate?: string;
    deliveryDate?: string;
    productCode: string;
    orderStatus: string;
    qty: number;
    cost: number;
  }>;
  error?: string;
}

export async function generatePurchaseCSV(options?: {
  dateFrom?: string;
  dateTo?: string;
}): Promise<GeneratePurchaseCsvResult> {
  return callFunction<GeneratePurchaseCsvResult>(
    'aim2026-generate-purchase-csv',
    {
      dateFrom: options?.dateFrom ?? '2025-01-01',
      dateTo: options?.dateTo ?? '2026-06-30',
      uploadToBucket: true,
    }
  );
}

// ─── Generate Sales Enquiry CSV from Unleashed API ────────────────────────

export interface SalesFetchResult {
  success: boolean;
  version?: string;
  status?: string;
  cutoffDate?: string;
  cutoffDateAU?: string;
  ordersCount?: number;
  linesCount?: number;
  csvLines?: string[];
  error?: string;
}

export async function fetchSalesForStatus(
  status: string,
  latestDate?: string
): Promise<SalesFetchResult> {
  return callFunction<SalesFetchResult>(
    'aim2026-generate-sales-csv',
    { status, latestDate: latestDate ?? null }
  );
}

export interface UploadSalesCsvResult {
  success: boolean;
  bucket?: string;
  file?: string;
  sizeBytes?: number;
  error?: string;
}

/** Upload merged Sales CSV to Storage via Edge Function (uses service role) */
export async function uploadSalesCSV(csvContent: string): Promise<UploadSalesCsvResult> {
  const url = `${SUPABASE_URL}/functions/v1/aim2026-upload-sales-csv`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'text/csv',
    },
    body: csvContent,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      success: false,
      error: data.error ?? `HTTP ${response.status}`,
    };
  }
  return data;
}

// ─── Generate SOH CSV from Unleashed API ──────────────────────────────────

export interface SOHFetchResult {
  success: boolean;
  version?: string;
  totalRows?: number;
  csvLines?: string[];
  error?: string;
}

export async function fetchSOHCSV(): Promise<SOHFetchResult> {
  return callFunction<SOHFetchResult>('aim2026-generate-soh-csv', {});
}

export interface UploadSOHCsvResult {
  success: boolean;
  bucket?: string;
  file?: string;
  sizeBytes?: number;
  error?: string;
}

/** Upload SOH CSV to Storage via Edge Function */
export async function uploadSOHCSV(csvContent: string): Promise<UploadSOHCsvResult> {
  const url = `${SUPABASE_URL}/functions/v1/aim2026-upload-soh-csv`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'text/csv',
    },
    body: csvContent,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      success: false,
      error: data.error ?? `HTTP ${response.status}`,
    };
  }
  return data;
}

// ─── Generate Production Enquiry CSV from Unleashed API ────────────────────

export interface ProductionFetchResult {
  success: boolean;
  version?: string;
  status?: string;
  assembliesCount?: number;
  linesCount?: number;
  csvLines?: string[];
  error?: string;
}

export async function fetchProductionForStatus(
  status: string,
  startDate?: string,
  endDate?: string
): Promise<ProductionFetchResult> {
  return callFunction<ProductionFetchResult>(
    'aim2026-generate-production-csv',
    { status, startDate: startDate ?? '2025-01-01', endDate: endDate ?? '2026-06-30' }
  );
}

export interface UploadProductionCsvResult {
  success: boolean;
  bucket?: string;
  file?: string;
  sizeBytes?: number;
  error?: string;
}

export async function uploadProductionCSV(csvContent: string): Promise<UploadProductionCsvResult> {
  const url = `${SUPABASE_URL}/functions/v1/aim2026-upload-production-csv`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'text/csv',
    },
    body: csvContent,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { success: false, error: data.error ?? `HTTP ${response.status}` };
  }
  return data;
}

// ─── Demand Channel Split (B2B / B2C per SKU) ────────────────────────────

export interface DemandChannelSplitItem {
  sku: string;
  b2b: number;
  b2c: number;
}

/**
 * Fetches B2B / B2C completed-sales totals per SKU from aim2026_demand_detail.
 * Pass date strings as YYYY-MM-DD to restrict to a specific date range.
 */
export async function fetchDemandChannelSplit(
  from?: string,
  to?: string
): Promise<DemandChannelSplitItem[]> {
  try {
    const result = await callFunction<{ success: boolean; data: DemandChannelSplitItem[] }>(
      'aim2026-get-dashboard',
      { action: 'demand_channel_split', from, to }
    );
    return result.data ?? [];
  } catch {
    return [];
  }
}

// ─── Demand Warehouse Split (per SKU, per warehouse) ──────────────────────

export interface DemandWarehouseSplitItem {
  sku: string;
  warehouse: string;
  qty: number;
}

export interface DemandWarehouseSplitResult {
  data: DemandWarehouseSplitItem[];
  warehouses: string[];
}

/**
 * Fetches demand totals per SKU per warehouse from aim2026_demand_history.
 * quantity_sold is per-warehouse; component_usage comes from "All" aggregate
 * so component demand is visible regardless of assembly warehouse.
 */
export async function fetchDemandWarehouseSplit(
  from?: string,
  to?: string,
): Promise<DemandWarehouseSplitResult> {
  try {
    const result = await callFunction<{
      success: boolean;
      data: DemandWarehouseSplitItem[];
      warehouses: string[];
    }>('aim2026-get-dashboard', { action: 'demand_warehouse_split', from, to });
    return {
      data: result.data ?? [],
      warehouses: result.warehouses ?? [],
    };
  } catch {
    return { data: [], warehouses: [] };
  }
}

/**
 * Fetches per-warehouse per-month demand detail rows for a single SKU
 * (for CSV download).
 */
export async function fetchWhDemandDetail(
  sku: string,
  from?: string,
  to?: string,
): Promise<Record<string, unknown>[]> {
  try {
    const result = await callFunction<{
      success: boolean;
      data: Record<string, unknown>[];
    }>('aim2026-get-dashboard', { action: 'wh_demand_detail', sku, from, to });
    return result.data ?? [];
  } catch {
    return [];
  }
}

// ─── Container Feasibility (Storage bucket `container`) ─────────────────

export interface ContainerFeasibilityManifest {
  csvPath: string;
  csvSignedUrl: string;
  pdfs: { path: string; signedUrl: string }[];
}

/**
 * Lists `container` via Edge Function (service role) and returns signed read URLs.
 * Use this when direct Storage list/download fails (RLS). Deploy: `aim2026-container-bucket`.
 */
export async function fetchContainerFeasibilityManifest(): Promise<
  | { ok: true; manifest: ContainerFeasibilityManifest }
  | { ok: false; message: string }
> {
  try {
    const result = await callFunction<{
      success: boolean;
      message?: string;
      csvPath?: string;
      csvSignedUrl?: string;
      pdfs?: { path: string; signedUrl: string }[];
    }>('aim2026-container-bucket', {});
    if (!result.success || !result.csvSignedUrl || !result.csvPath) {
      return { ok: false, message: result.message ?? 'Manifest unavailable' };
    }
    return {
      ok: true,
      manifest: {
        csvPath: result.csvPath,
        csvSignedUrl: result.csvSignedUrl,
        pdfs: result.pdfs ?? [],
      },
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── CSV Download Helper ──────────────────────────────────────────────────

export function downloadAsCSV(rows: Record<string, any>[], filename: string): void {
  if (rows.length === 0) return;

  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const val = row[h] ?? '';
          const str = String(val);
          // Escape commas, quotes, newlines
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(',')
    ),
  ];

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
