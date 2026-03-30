// =============================================================================
// AIM 2026 — Dashboard Data Endpoint
// =============================================================================
// Single endpoint that serves all read operations for the AIM 2026 dashboard:
//   - Default (no action): returns KPI cache data
//   - action: "valuation_history": returns stock valuation history
//   - action: "config": returns cost/settings config
//   - action: "save_config": saves config updates
//   - action: "demand_history": returns demand history for a specific SKU
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parse as parseCsv } from "https://deno.land/std@0.224.0/csv/parse.ts";
import {
  downloadBOMFromBucket,
  insertBomComponentsBatched,
  parseBomCsv,
} from "../_shared/bom.ts";

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

// ─── Unleashed API Helpers (for live PO data in popups) ─────────────────

const UNLEASHED_BASE = "https://api.unleashedsoftware.com";

async function hmacSign(apiKey: string, queryString: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(queryString));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function unleashedGet(
  endpoint: string, queryString: string, creds: { api_id: string; api_key: string }
): Promise<any> {
  const url = `${UNLEASHED_BASE}/${endpoint}${queryString ? "?" + queryString : ""}`;
  const signature = await hmacSign(creds.api_key, queryString);
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-auth-id": creds.api_id,
      "api-auth-signature": signature,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Unleashed ${endpoint}: ${res.status} ${res.statusText}`);
  return res.json();
}

function parseUnleashedDate(dateVal: any): string {
  if (!dateVal) return "";
  const dateMatch = String(dateVal).match(/\/Date\((\d+)\)\//);
  if (dateMatch) return new Date(Number(dateMatch[1])).toISOString().slice(0, 10);
  try { return new Date(dateVal).toISOString().slice(0, 10); } catch { return ""; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request body (may not exist for GET)
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // No body is fine
    }

    const action = body?.action ?? "kpi_cache";

    // ─── KPI Cache (default) ──────────────────────────────────────
    if (action === "kpi_cache") {
      // PostgREST max_rows caps at 1000 regardless of .limit() — must paginate
      const allData: any[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from("aim2026_kpi_cache")
          .select("sku, kpi_data, calculated_at")
          .order("sku", { ascending: true })
          .range(offset, offset + 999);

        if (error) {
          return jsonResponse({ success: false, message: error.message }, 500);
        }

        allData.push(...(data ?? []));
        hasMore = (data?.length ?? 0) === 1000;
        offset += 1000;
      }

      console.log(`KPI cache: returned ${allData.length} rows (paginated)`);

      let assembledProductSKUs: string[] = [];
      const { data: assembledRows, error: assembledErr } = await supabase
        .from("aim2026_assembled_products")
        .select("sku");
      if (!assembledErr && assembledRows && assembledRows.length > 0) {
        assembledProductSKUs = assembledRows.map((r: { sku: string }) => r.sku);
      }

      let bomComponents: Array<{
        assembly_sku: string;
        component_sku: string;
        quantity_per_assembly: number;
      }> = [];
      const { data: bomRows } = await supabase
        .from("aim2026_bom_components")
        .select("assembly_sku, component_sku, quantity_per_assembly");
      if (bomRows && bomRows.length > 0) {
        bomComponents = bomRows as typeof bomComponents;
      }

      const needAssembled = assembledProductSKUs.length === 0;
      const needBomComponents = bomComponents.length === 0;
      if (needAssembled || needBomComponents) {
        const blob = await downloadBOMFromBucket(supabase);
        if (blob) {
          const { assembledSKUs, components } = parseBomCsv(await blob.text());

          if (needAssembled && assembledSKUs.size > 0) {
            await supabase.from("aim2026_assembled_products").delete().gte("sku", "");
            const { error: insAsmErr } = await supabase
              .from("aim2026_assembled_products")
              .insert(Array.from(assembledSKUs, (sku) => ({ sku })));
            if (insAsmErr) {
              console.error("aim2026_assembled_products insert (BOM backfill):", insAsmErr);
            } else {
              assembledProductSKUs = Array.from(assembledSKUs);
              console.log(`BOM backfill: ${assembledProductSKUs.length} assembled SKUs`);
            }
          }

          if (needBomComponents && components.length > 0) {
            const { error: delBomErr } = await supabase
              .from("aim2026_bom_components")
              .delete()
              .gte("assembly_sku", "");
            if (delBomErr) {
              console.error("aim2026_bom_components delete (backfill):", delBomErr);
            } else {
              await insertBomComponentsBatched(supabase, components);
              bomComponents = components.map((c) => ({
                assembly_sku: c.assembly_sku,
                component_sku: c.component_sku,
                quantity_per_assembly: c.quantity_per_assembly,
              }));
              console.log(`BOM backfill: ${bomComponents.length} component rows`);
            }
          }
        }
      }

      return jsonResponse({
        success: true,
        data: allData,
        assembledProductSKUs,
        bomComponents,
      });
    }

    // ─── Valuation History ────────────────────────────────────────
    if (action === "valuation_history") {
      const limit = body?.limit ?? 50;

      const { data, error } = await supabase
        .from("aim2026_stock_valuation_history")
        .select("*")
        .order("snapshot_date", { ascending: false })
        .limit(limit);

      if (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
      }

      return jsonResponse({ success: true, data: data ?? [] });
    }

    // ─── Config (read) ────────────────────────────────────────────
    if (action === "config") {
      const { data, error } = await supabase
        .from("aim2026_cost_config")
        .select("config_type, config_data");

      if (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
      }

      // Assemble config object
      const configs: Record<string, any> = {};
      for (const row of data ?? []) {
        configs[row.config_type] = row.config_data;
      }

      const landed = configs["landed_cost_rates"] ?? { default: {} };
      const holding = configs["holding_cost"] ?? {};
      const general = configs["general"] ?? {};

      return jsonResponse({
        success: true,
        data: {
          landedCost: {
            default: landed.default ?? {
              freightRate: 0.0592,
              dutyRate: 0.05,
              insuranceRate: 0.0132,
            },
            byGroup: landed.byGroup ?? {},
          },
          landedCostNotes: landed.notes ?? "",
          holdingCost: {
            warehouseItems: holding.warehouseItems ?? [],
            capitalRatePercent: holding.capitalRatePercent ?? 10,
            riskRatePercent: holding.riskRatePercent ?? 4,
          },
          defaultLeadTimeDays: general.defaultLeadTimeDays ?? 45,
          defaultServiceLevelZ: general.defaultServiceLevelZ ?? 1.65,
          exchangeRateUSDToAUD: general.exchangeRateUSDToAUD ?? 1.54,
        },
      });
    }

    // ─── Config (save) ────────────────────────────────────────────
    if (action === "save_config") {
      const config = body?.config;
      if (!config) {
        return jsonResponse(
          { success: false, message: "Missing config in body" },
          400
        );
      }

      // Update each config type
      const updates = [
        {
          config_type: "landed_cost_rates",
          config_data: {
            ...(config.landedCost ?? {}),
            notes: config.landedCostNotes ?? "",
          },
        },
        {
          config_type: "holding_cost",
          config_data: config.holdingCost ?? {},
        },
        {
          config_type: "general",
          config_data: {
            defaultLeadTimeDays: config.defaultLeadTimeDays ?? 45,
            defaultServiceLevelZ: config.defaultServiceLevelZ ?? 1.65,
            exchangeRateUSDToAUD: config.exchangeRateUSDToAUD ?? 1.54,
          },
        },
      ];

      for (const update of updates) {
        const { error } = await supabase
          .from("aim2026_cost_config")
          .upsert(
            {
              ...update,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "config_type" }
          );

        if (error) {
          console.error(`Error saving config ${update.config_type}:`, error);
        }
      }

      return jsonResponse({ success: true, message: "Config saved" });
    }

    // ─── Demand History (for popup chart) ─────────────────────────
    // Returns demand_history rows enriched with quantity breakdown (completed, placed, parked) from demand_detail.
    if (action === "demand_history") {
      const sku = body?.sku;
      const warehouse = body?.warehouse ?? "all";

      if (!sku) {
        return jsonResponse(
          { success: false, message: "Missing sku parameter" },
          400
        );
      }

      const warehouseValue = warehouse === "all" ? "All" : warehouse;

      const { data: histData, error: histErr } = await supabase
        .from("aim2026_demand_history")
        .select("period_date, sku, quantity_sold, revenue, component_usage")
        .eq("sku", sku)
        .eq("warehouse", warehouseValue)
        .order("period_date", { ascending: true });

      if (histErr) {
        return jsonResponse({ success: false, message: histErr.message }, 500);
      }

      // Demand detail may exceed PostgREST default page size — paginate.
      const detailRows: any[] = [];
      const pageSize = 1000;
      let offset = 0;
      while (true) {
        let query = supabase
          .from("aim2026_demand_detail")
          .select("period_date, status, quantity, warehouse, customer_type")
          .eq("sku", sku)
          .eq("type", "sale")
          .order("period_date", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (warehouse !== "all") {
          query = query.eq("warehouse", warehouseValue);
        }
        const { data: page, error: detailErr } = await query;
        if (detailErr) {
          return jsonResponse({ success: false, message: detailErr.message }, 500);
        }
        if (!page || page.length === 0) break;
        detailRows.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }

      // Normalize period_date to month (YYYY-MM-01) so daily dates from sync match monthly from csv-load
      function toMonthKey(d: string): string {
        const s = String(d ?? "").slice(0, 7);
        return s.length >= 7 ? `${s}-01` : d;
      }

      // B2C = Shopify / Web / B2C customer types; everything else is B2B
      function isB2C(customerType: string): boolean {
        const ct = String(customerType ?? "").toLowerCase().trim();
        return ct === "shopify" || ct === "b2c" || ct === "web" || ct.includes("shopify");
      }

      const breakdownMap = new Map<string, {
        completed: number; placed: number; parked: number; backordered: number;
        b2b: number; b2c: number;
      }>();
      for (const row of detailRows) {
        const key = toMonthKey(row.period_date);
        const existing = breakdownMap.get(key) ?? { completed: 0, placed: 0, parked: 0, backordered: 0, b2b: 0, b2c: 0 };
        const status = String(row.status ?? "").toLowerCase();
        const qty = Number(row.quantity ?? 0);
        if (status === "completed") {
          existing.completed += qty;
          if (isB2C(row.customer_type)) {
            existing.b2c += qty;
          } else {
            existing.b2b += qty;
          }
        } else if (status === "placed") {
          existing.placed += qty;
        } else if (status === "parked") {
          existing.parked += qty;
        } else if (status === "backordered") {
          existing.backordered += qty;
        }
        breakdownMap.set(key, existing);
      }

      // Aggregate hist by month (handles both monthly csv-load and daily sync-unleashed)
      const histMap = new Map<string, { quantity_sold: number; revenue: number; component_usage: number }>();
      for (const row of histData ?? []) {
        const key = toMonthKey(row.period_date);
        const existing = histMap.get(key) ?? { quantity_sold: 0, revenue: 0, component_usage: 0 };
        existing.quantity_sold += Number(row.quantity_sold ?? 0);
        existing.revenue += Number(row.revenue ?? 0);
        existing.component_usage += Number(row.component_usage ?? 0);
        histMap.set(key, existing);
      }
      const periods = new Set<string>([...histMap.keys(), ...breakdownMap.keys()]);

      const enriched = [...periods].sort().map((period) => {
        const h = histMap.get(period);
        const b = breakdownMap.get(period);
        const quantitySold = Number(h?.quantity_sold ?? 0);
        return {
          period_date: period,
          sku,
          quantity_sold: quantitySold,
          revenue: Number(h?.revenue ?? 0),
          component_usage: Number(h?.component_usage ?? 0),
          quantity_completed: b?.completed ?? quantitySold,
          quantity_placed: b?.placed ?? 0,
          quantity_parked: b?.parked ?? 0,
          quantity_backordered: b?.backordered ?? 0,
          quantity_b2b: b?.b2b ?? 0,
          quantity_b2c: b?.b2c ?? 0,
        };
      });

      return jsonResponse({ success: true, data: enriched, warehouse });
    }

    // ─── SOH History (for SKU detail popup) ───────────────────────
    if (action === "soh_history") {
      const sku = body?.sku;
      if (!sku) {
        return jsonResponse(
          { success: false, message: "Missing sku parameter" },
          400
        );
      }

      const { data, error } = await supabase
        .from("aim2026_soh_snapshots")
        .select("snapshot_date, warehouse, quantity, allocated, available")
        .eq("sku", sku)
        .order("snapshot_date", { ascending: true })
        .limit(365);

      if (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
      }

      return jsonResponse({ success: true, data: data ?? [] });
    }

    // ─── Sync Log ─────────────────────────────────────────────────
    if (action === "sync_log") {
      const limit = body?.limit ?? 10;

      const { data, error } = await supabase
        .from("aim2026_sync_log")
        .select("*")
        .order("synced_at", { ascending: false })
        .limit(limit);

      if (error) {
        return jsonResponse({ success: false, message: error.message }, 500);
      }

      return jsonResponse({ success: true, data: data ?? [] });
    }

    // ─── Warehouse Detail (for CSV download) ────────────────────
    if (action === "warehouse_detail") {
      const warehouseKey = body?.warehouse; // e.g. "mainWarehouse", "china", etc.
      if (!warehouseKey) {
        return jsonResponse({ success: false, message: "Missing warehouse" }, 400);
      }

      // Map frontend keys to DB warehouse name search patterns
      const warehousePatterns: Record<string, string[]> = {
        mainWarehouse: ["main warehouse", "main"],
        china: ["china-w", "china"],
        container: ["container"],
        dhl: ["dhl"],
        onProduction: ["production"],
        pesadoKorea: ["pesado korea", "korea", "pesado"],
      };

      const patterns = warehousePatterns[warehouseKey];
      if (!patterns) {
        return jsonResponse({ success: false, message: `Unknown warehouse key: ${warehouseKey}` }, 400);
      }

      // Valuation uses either landed cost or FOB × exchange rate
      const useFOB = warehouseKey === "china" || warehouseKey === "onProduction";

      // Get config for exchange rate
      const { data: configRows } = await supabase
        .from("aim2026_cost_config")
        .select("config_type, config_data")
        .eq("config_type", "general");
      const generalConfig = configRows?.[0]?.config_data ?? {};
      const exchangeRate = generalConfig.exchangeRateUSDToAUD ?? 1.54;

      // Get latest snapshot date
      const { data: latestDateRow } = await supabase
        .from("aim2026_soh_snapshots")
        .select("snapshot_date")
        .order("snapshot_date", { ascending: false })
        .limit(1);

      const latestDate = latestDateRow?.[0]?.snapshot_date;
      if (!latestDate) {
        return jsonResponse({ success: true, data: [], snapshotDate: null, warehouse: warehouseKey });
      }

      // Get all SOH records for this warehouse on the latest date (paginated)
      const pageSize = 1000;
      let allSOH: any[] = [];
      let offset = 0;
      while (true) {
        const { data: page, error } = await supabase
          .from("aim2026_soh_snapshots")
          .select("sku, warehouse, quantity, allocated, available")
          .eq("snapshot_date", latestDate)
          .range(offset, offset + pageSize - 1);

        if (error) {
          return jsonResponse({ success: false, message: error.message }, 500);
        }
        if (!page || page.length === 0) break;
        allSOH = allSOH.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }

      // Filter to matching warehouse patterns
      const matchedSOH = allSOH.filter((row: any) => {
        const wh = String(row.warehouse || "").toLowerCase();
        return patterns.some((p) => wh.includes(p));
      });

      // Get cost data from KPI cache (which has calculated landed costs)
      let allKPI: any[] = [];
      offset = 0;
      while (true) {
        const { data: page, error } = await supabase
          .from("aim2026_kpi_cache")
          .select("sku, kpi_data")
          .range(offset, offset + pageSize - 1);

        if (error) break;
        if (!page || page.length === 0) break;
        allKPI = allKPI.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }

      const kpiMap = new Map(allKPI.map((k: any) => [k.sku, k.kpi_data ?? {}]));

      // Build detail rows
      const detail = matchedSOH
        .filter((s: any) => s.quantity > 0)
        .map((s: any) => {
          const kpi = kpiMap.get(s.sku) ?? {};
          const costChina = Number(kpi.productCostChina ?? 0);
          const landedAUD = Number(kpi.landedCostAUD ?? 0);
          const unitCost = useFOB ? costChina * exchangeRate : landedAUD;
          const totalValue = s.quantity * unitCost;

          return {
            sku: s.sku,
            product: String(kpi.product ?? ""),
            productGroup: String(kpi.productGroup ?? ""),
            warehouse: s.warehouse,
            quantity: s.quantity,
            allocated: s.allocated,
            available: s.available,
            unitCostChina: costChina,
            landedCostAUD: landedAUD,
            unitCostUsed: Math.round(unitCost * 100) / 100,
            totalValue: Math.round(totalValue * 100) / 100,
            valuationMethod: useFOB ? "FOB × Exchange Rate" : "Landed Cost AUD",
          };
        })
        .sort((a: any, b: any) => b.totalValue - a.totalValue);

      const grandTotal = detail.reduce((sum: number, r: any) => sum + r.totalValue, 0);

      return jsonResponse({
        success: true,
        data: detail,
        snapshotDate: latestDate,
        warehouse: warehouseKey,
        grandTotal: Math.round(grandTotal * 100) / 100,
        exchangeRate,
        skuCount: detail.length,
      });
    }

    // ─── Demand Transactions (for CSV download) ───────────────────
    // Reads directly from aim2026_demand_detail — no API calls needed.
    if (action === "demand_transactions") {
      const sku = body?.sku;
      const month = body?.month; // YYYY-MM format
      if (!sku || !month) {
        return jsonResponse({ success: false, message: "Missing sku or month" }, 400);
      }

      const [y, m] = month.split("-").map(Number);
      const monthStart = `${month}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

      // Fetch detail rows (paginated) — use range to support both monthly and daily period_date
      const pageSize = 1000;
      let allDetails: any[] = [];
      let offset = 0;
      while (true) {
        const { data: page, error } = await supabase
          .from("aim2026_demand_detail")
          .select("*")
          .eq("sku", sku)
          .gte("period_date", monthStart)
          .lte("period_date", monthEnd)
          .order("order_date", { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (error) {
          return jsonResponse({ success: false, message: error.message }, 500);
        }
        if (!page || page.length === 0) break;
        allDetails = allDetails.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }

      // Map to frontend format
      const transactions = allDetails.map((d: any) => ({
        type: d.type === "sale" ? "Sale" : "Component Usage",
        date: d.order_date ?? d.period_date,
        customer: d.customer ?? "",
        quantity: Number(d.quantity ?? 0),
        amount: Math.round(Number(d.amount ?? 0) * 100) / 100,
        status: d.status ?? "",
        warehouse: d.warehouse ?? "",
        orderNumber: d.order_number ?? "",
        productGroup: d.product_group ?? "",
        customerType: d.customer_type ?? "",
      }));

      // DB aggregate for cross-check (demand_history uses month key YYYY-MM-01)
      const { data: dbRow } = await supabase
        .from("aim2026_demand_history")
        .select("quantity_sold, component_usage, revenue")
        .eq("sku", sku)
        .eq("period_date", monthStart)
        .eq("warehouse", "All")
        .limit(1);

      const dbSummary = dbRow?.[0] ?? null;

      return jsonResponse({
        success: true,
        data: transactions,
        sku,
        month,
        totalQuantity: transactions.reduce((s: number, t: any) => s + t.quantity, 0),
        totalAmount: transactions.reduce((s: number, t: any) => s + t.amount, 0),
        transactionCount: transactions.length,
        source: "database",
        dbAggregate: dbSummary ? {
          quantitySold: Number(dbSummary.quantity_sold ?? 0),
          componentUsage: Number(dbSummary.component_usage ?? 0),
          revenue: Number(dbSummary.revenue ?? 0),
        } : null,
      });
    }

    // ─── Demand Channel Split (B2B / B2C per SKU for main table) ───
    // Returns [{sku, b2b, b2c}] aggregated from aim2026_demand_detail
    // completed sales grouped by customer_type, optional date range filter.
    if (action === "demand_channel_split") {
      const from: string | undefined = body?.from;  // YYYY-MM-DD
      const to: string | undefined = body?.to;      // YYYY-MM-DD

      function isB2CSplit(customerType: string): boolean {
        const ct = String(customerType ?? "").toLowerCase().trim();
        return ct === "shopify" || ct === "b2c" || ct === "web" || ct.includes("shopify");
      }

      const perSku = new Map<string, { b2b: number; b2c: number }>();
      const pageSize = 1000;
      let offset = 0;

      while (true) {
        let query = supabase
          .from("aim2026_demand_detail")
          .select("sku, customer_type, quantity")
          .eq("type", "sale")
          .eq("status", "completed")
          .range(offset, offset + pageSize - 1);

        if (from) query = query.gte("period_date", from);
        if (to)   query = query.lte("period_date", to);

        const { data: page, error } = await query;
        if (error) {
          return jsonResponse({ success: false, message: error.message }, 500);
        }
        if (!page || page.length === 0) break;

        for (const row of page) {
          const sku = String(row.sku ?? "").trim();
          if (!sku) continue;
          const qty = Number(row.quantity ?? 0);
          const entry = perSku.get(sku) ?? { b2b: 0, b2c: 0 };
          if (isB2CSplit(row.customer_type)) {
            entry.b2c += qty;
          } else {
            entry.b2b += qty;
          }
          perSku.set(sku, entry);
        }

        if (page.length < pageSize) break;
        offset += pageSize;
      }

      const result = Array.from(perSku.entries()).map(([sku, v]) => ({
        sku,
        b2b: Math.round(v.b2b),
        b2c: Math.round(v.b2c),
      }));

      return jsonResponse({ success: true, data: result, from: from ?? null, to: to ?? null });
    }

    // ─── Demand Warehouse Split (per SKU, per warehouse) ────────
    // Returns [{sku, warehouse, qty}] where qty = quantity_sold + component_usage
    // per warehouse. China-W component_usage is populated by the
    // supplement_assembly_csv step from ProductionEnquiryList.csv.
    if (action === "demand_warehouse_split") {
      const from: string | undefined = body?.from;
      const to: string | undefined = body?.to;

      const perSkuWh = new Map<string, number>();
      const warehouses = new Set<string>();
      const pageSize = 1000;
      let offset = 0;

      while (true) {
        let query = supabase
          .from("aim2026_demand_history")
          .select("sku, warehouse, quantity_sold, component_usage")
          .neq("warehouse", "All")
          .range(offset, offset + pageSize - 1);

        if (from) query = query.gte("period_date", from);
        if (to)   query = query.lte("period_date", to);

        const { data: page, error } = await query;
        if (error) {
          return jsonResponse({ success: false, message: error.message }, 500);
        }
        if (!page || page.length === 0) break;

        for (const row of page) {
          const sku = String(row.sku ?? "").trim();
          const wh  = String(row.warehouse ?? "").trim();
          if (!sku || !wh) continue;
          warehouses.add(wh);
          const qty = Number(row.quantity_sold ?? 0) + Number(row.component_usage ?? 0);
          if (qty > 0) {
            const key = `${sku}|${wh}`;
            perSkuWh.set(key, (perSkuWh.get(key) ?? 0) + qty);
          }
        }

        if (page.length < pageSize) break;
        offset += pageSize;
      }

      const data = Array.from(perSkuWh.entries()).map(([key, qty]) => {
        const [sku, warehouse] = key.split("|");
        return { sku, warehouse, qty: Math.round(qty) };
      });

      return jsonResponse({
        success: true,
        data,
        warehouses: Array.from(warehouses).sort(),
        from: from ?? null,
        to: to ?? null,
      });
    }

    // ─── WH Demand Detail (CSV download per SKU) ──────────────────
    if (action === "wh_demand_detail") {
      const sku: string | undefined = body?.sku;
      const from: string | undefined = body?.from;
      const to: string | undefined = body?.to;
      if (!sku) {
        return jsonResponse({ success: false, message: "Missing sku" }, 400);
      }

      const pageSize = 1000;
      const rows: any[] = [];
      let offset = 0;

      while (true) {
        let query = supabase
          .from("aim2026_demand_history")
          .select("sku, warehouse, period_date, quantity_sold, component_usage, revenue")
          .eq("sku", sku)
          .order("period_date", { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (from) query = query.gte("period_date", from);
        if (to) query = query.lte("period_date", to);

        const { data: page, error } = await query;
        if (error) {
          return jsonResponse({ success: false, message: error.message }, 500);
        }
        if (!page || page.length === 0) break;
        rows.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }

      return jsonResponse({ success: true, data: rows, sku });
    }

    // ─── Recent Orders (for SKU detail popup) ───────────────────
    if (action === "recent_orders") {
      const sku = body?.sku;
      if (!sku) {
        return jsonResponse({ success: false, message: "Missing sku" }, 400);
      }

      const orders: any[] = [];

      // Helper: download CSV from buckets
      async function downloadCSV(name: string): Promise<string | null> {
        for (const bucket of ["aim-csv-files", "csv-files"]) {
          const { data, error } = await supabase.storage.from(bucket).download(name);
          if (!error && data) return await data.text();
        }
        return null;
      }

      // Helper: parse date
      function smartDate(v: string): string {
        if (!v) return "";
        const s = v.trim();
        const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
        if (m) {
          let y = parseInt(m[3]); if (y < 100) y += 2000;
          const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
          return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
        }
        const d = new Date(s);
        return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
      }

      // Helper: find header row and map columns
      function findHeaders(
        rows: string[][],
        keywords: Record<string, string[]>
      ): { idx: number; map: Record<string, number> } {
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const vals = rows[i].map((v) => String(v || "").toLowerCase().trim());
          if (vals.some((v) => v.includes("enquiry") || v.includes("report"))) continue;
          if (vals.filter((v) => v).length < 3) continue;

          const headerMap: Record<string, number> = {};
          let matched = 0;
          for (const [key, kwList] of Object.entries(keywords)) {
            for (let c = 0; c < vals.length; c++) {
              if (kwList.some((kw) => vals[c].includes(kw))) {
                headerMap[key] = c;
                matched++;
                break;
              }
            }
          }
          if (matched >= 3) return { idx: i, map: headerMap };
        }
        return { idx: -1, map: {} };
      }

      const toNum = (v: any) => Math.abs(parseFloat(String(v || "0").replace(/,/g, "")) || 0);

      // Read Sales CSV
      // Cols: Order Date, Product Code, Product, Customer, Product Group, Warehouse, Status, Quantity, Sub Total, Customer Type
      try {
        const salesText = await downloadCSV("SalesEnquiryList.csv");
        if (salesText) {
          const rawRows: string[][] = parseCsv(salesText, { skipFirstRow: false });
          const { idx, map } = findHeaders(rawRows, {
            sku: ["product code", "productcode"],
            customer: ["customer"],
            date: ["order date", "date"],
            qty: ["quantity", "qty", "order qty"],
            status: ["status", "order status", "sales order status"],
            subtotal: ["sub total", "subtotal", "total"],
            warehouse: ["warehouse"],
          });

          if (idx >= 0 && map.sku !== undefined) {
            const dataRows = rawRows.slice(idx + 1);
            for (const row of dataRows) {
              if (String(row[map.sku] || "").trim() !== sku) continue;
              orders.push({
                order_type: "sales",
                order_date: smartDate(String(row[map.date] ?? "")),
                customer: String(row[map.customer] ?? "").trim() || "",
                quantity: toNum(row[map.qty]),
                amount: toNum(row[map.subtotal]),
                status: String(row[map.status] ?? "").trim() || "Unknown",
                warehouse: String(row[map.warehouse] ?? "").trim() || "",
              });
            }
          }
        }
      } catch (e) {
        console.error("Error reading sales CSV for orders:", e);
      }

      // Read Purchase Orders from Unleashed API (live data)
      try {
        const { data: credsRow } = await supabase
          .from("unleashed_credentials")
          .select("api_id, api_key")
          .eq("is_active", true)
          .maybeSingle();

        if (credsRow) {
          const creds = { api_id: credsRow.api_id, api_key: credsRow.api_key };
          const statusesToFetch = ["Placed", "Container", "DHL", "Production"];

          for (const status of statusesToFetch) {
            try {
              const data = await unleashedGet(
                "PurchaseOrders/1",
                `orderStatus=${status}&pageSize=200`,
                creds
              );
              const poItems = data.Items ?? [];
              for (const po of poItems) {
                const lines = po.PurchaseOrderLines ?? [];
                for (const line of lines) {
                  const productCode = (line.Product?.ProductCode ?? "").trim();
                  if (productCode !== sku) continue;
                  orders.push({
                    order_type: "purchase",
                    order_number: po.OrderNumber ?? "PO-?",
                    order_date: parseUnleashedDate(po.OrderDate),
                    delivery_date: parseUnleashedDate(line.DeliveryDate || po.DeliveryDate),
                    supplier: po.Supplier?.SupplierName ?? "",
                    quantity: Math.abs(Number(line.OrderQuantity ?? 0)),
                    amount: Math.abs(Number(line.LineTotal ?? 0)),
                    status: String(po.OrderStatus ?? po.CustomOrderStatus ?? "Unknown"),
                    warehouse: po.Warehouse?.WarehouseName ?? po.Warehouse?.WarehouseCode ?? "",
                  });
                }
              }
            } catch (e) {
              console.warn(`PO status=${status} fetch failed:`, e);
            }
          }
        }
      } catch (e) {
        console.error("Error fetching purchase orders from Unleashed:", e);
      }

      // Split by type, sort each by date descending, limit each to 10
      const salesOrders = orders
        .filter((o) => o.order_type === "sales")
        .sort((a, b) => b.order_date.localeCompare(a.order_date))
        .slice(0, 10);
      const purchaseOrders = orders
        .filter((o) => o.order_type === "purchase")
        .sort((a, b) => b.order_date.localeCompare(a.order_date))
        .slice(0, 10);
      const recentOrders = [...salesOrders, ...purchaseOrders];

      return jsonResponse({ success: true, data: recentOrders });
    }

    // ─── Debug: warehouse names & counts ─────────────────────────
    if (action === "debug_data") {
      const [sohSample, syncLog, skuCount, demandCount] = await Promise.all([
        supabase
          .from("aim2026_soh_snapshots")
          .select("sku, warehouse, quantity, allocated, available")
          .limit(30),
        supabase
          .from("aim2026_sync_log")
          .select("*")
          .order("synced_at", { ascending: false })
          .limit(3),
        supabase
          .from("aim2026_sku_parameters")
          .select("sku", { count: "exact", head: true }),
        supabase
          .from("aim2026_demand_history")
          .select("sku", { count: "exact", head: true }),
      ]);

      // Get unique warehouse names
      const { data: warehouseNames } = await supabase
        .from("aim2026_soh_snapshots")
        .select("warehouse")
        .limit(1000);

      const uniqueWarehouses = [...new Set((warehouseNames ?? []).map((r: any) => r.warehouse))];

      return jsonResponse({
        success: true,
        sohSample: sohSample.data ?? [],
        sohCount: sohSample.data?.length ?? 0,
        syncLog: syncLog.data ?? [],
        skuCount: skuCount.count ?? 0,
        demandCount: demandCount.count ?? 0,
        uniqueWarehouses,
      });
    }

    return jsonResponse(
      { success: false, message: `Unknown action: ${action}` },
      400
    );
  } catch (error) {
    console.error("Error in aim2026-get-dashboard:", error);
    return jsonResponse(
      {
        success: false,
        message: `Error: ${error instanceof Error ? error.message : "Unknown"}`,
      },
      500
    );
  }
});
