// =============================================================================
// AIM 2026 — CSV Initial Load
// =============================================================================
// Reads CSV files from Supabase storage buckets and populates aim2026_* tables.
// This provides the initial data load from existing Unleashed CSV exports,
// avoiding heavy API calls for historical data.
//
// Files read:
//   - SOHList.csv               → aim2026_soh_snapshots + aim2026_sku_parameters
//   - SalesEnquiryList.csv      → aim2026_demand_history (sales demand)
//   - ProductionEnquiryList.csv → aim2026_demand_history (component usage)
//   - costs.csv                 → aim2026_sku_parameters (product_cost_china)
//   - PurchaseEnquiryList.csv   → aim2026_soh_snapshots (Container/DHL/On Production)
//   - ProductList.csv           → aim2026_sku_parameters (lead_time_days)
//   - BOM*.csv / BillOfMaterialsList.csv → aim2026_assembled_products + aim2026_bom_components (shared _shared/bom.ts)
//   - step "bom" only → refresh those two tables from latest BOM CSV (no ProductionEnquiryList)
//
// Bucket strategy: tries 'aim-csv-files' first, falls back to 'csv-files'.
// After loading, the sync button only needs to fetch incremental updates.
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";
import {
  downloadBOMFromBucket,
  insertBomComponentsBatched,
  parseBomCsv,
} from "../_shared/bom.ts";

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

// ─── Bucket Download (try both buckets) ─────────────────────────────────────

async function downloadFromBucket(
  supabase: any,
  fileName: string,
  alternateNames?: string[]
): Promise<Blob | null> {
  const namesToTry = [fileName, ...(alternateNames ?? [])];
  const buckets = ["aim-csv-files", "csv-files"];

  // Pick the NEWEST copy, not the first bucket that happens to hold one.
  //
  // The same file name lives in both buckets, and returning the first hit meant
  // bucket order silently decided which data won. On 2026-08-03 a cost uploaded
  // to csv-files/costs.csv was ignored for hours because
  // aim-csv-files/costs.csv — last touched in January — was found first, and the
  // load reported success with stale numbers. SalesEnquiryList.csv had the same
  // split. Reading the older file and calling it a success is worse than
  // failing: nothing looks wrong.
  const candidates: { name: string; bucket: string; updatedAt: number }[] = [];

  for (const name of namesToTry) {
    const slash = name.lastIndexOf("/");
    const dir = slash === -1 ? "" : name.slice(0, slash);
    const base = slash === -1 ? name : name.slice(slash + 1);

    for (const bucket of buckets) {
      const { data: listed, error } = await supabase.storage
        .from(bucket)
        .list(dir, { search: base, limit: 100 });
      if (error || !listed) continue;

      const hit = listed.find((f: any) => f.name === base);
      if (!hit) continue;

      const stamp = hit.updated_at ?? hit.created_at ?? null;
      candidates.push({
        name,
        bucket,
        updatedAt: stamp ? Date.parse(stamp) : 0,
      });
    }
  }

  if (candidates.length === 0) {
    console.error(`✗ ${fileName} not found in any bucket (tried: ${namesToTry.join(", ")})`);
    return null;
  }

  // Preferred name wins over an alternate; among equals, the newest file wins.
  candidates.sort((a, b) =>
    namesToTry.indexOf(a.name) - namesToTry.indexOf(b.name) || b.updatedAt - a.updatedAt
  );
  const pick = candidates[0];

  if (candidates.length > 1) {
    console.log(
      `Multiple copies of "${pick.name}": ` +
      candidates.map((c) => `${c.bucket}@${new Date(c.updatedAt).toISOString()}`).join(", ") +
      ` → using ${pick.bucket}`
    );
  }

  const { data, error } = await supabase.storage.from(pick.bucket).download(pick.name);
  if (error || !data) {
    console.error(`✗ Failed to download "${pick.name}" from ${pick.bucket}: ${error?.message}`);
    return null;
  }

  console.log(
    `✓ Downloaded "${pick.name}" from ${pick.bucket} (${data.size} bytes, ` +
    `updated ${new Date(pick.updatedAt).toISOString()})`
  );
  return data;
}

// ─── CSV Parsing Helpers ───────────────────────────────────────────────────

const HEADER_KEYWORDS: Record<string, Record<string, string[]>> = {
  soh: {
    "Product Code": ["product code", "productcode", "sku"],
    "Product Description": ["product description", "description", "product"],
    "Warehouse": ["warehouse", "location"],
    "Qty On Hand": ["qty on hand", "on hand", "stock", "quantity"],
    "Allocated": ["allocated", "allocation"],
    "Available Qty": ["available qty", "available quantity", "available"],
    "Product Group": ["product group", "productgroup", "group"],
  },
  sales: {
    "Product Code": ["product code", "productcode", "sku"],
    "Product": ["product", "product description", "description"],
    "Quantity": ["quantity", "qty", "order qty"],
    "Warehouse": ["warehouse", "location"],
    "Status": ["status", "order status", "estado", "sales order status"],
    "Order Date": ["order date", "date", "required date"],
    "Total": ["total", "line total", "amount", "order total", "sub total"],
    "Customer": ["customer"],
    "Product Group": ["product group", "productgroup", "group"],
    "Customer Type": ["customer type", "customertype"],
  },
  purchase: {
    "Product Code": ["product code", "productcode", "sku"],
    "Quantity": ["quantity", "qty"],
    "Order Status": ["order status", "status", "purchase order status"],
    "Base Unit Qty": ["base unit qty", "base unit quantity", "base qty"],
    "Warehouse": ["warehouse", "location"],
    "Order Number": ["order number", "order no", "purchase order", "po number"],
    "Order Date": ["order date", "date", "purchase date"],
  },
  production: {
    "Product Code": ["product code", "productcode", "sku"],
    "Quantity": ["quantity", "qty"],
    "Assembly Number": ["assembly number", "assembly no"],
    "Assembly Date": ["assembly date"],
    "Warehouse": ["warehouse", "location"],
    "Assembly Status": ["assembly status"],
    "Product Group": ["product group", "productgroup", "group"],
    "Total Cost": ["total cost", "cost"],
  },
};

function findHeaderRow(
  rows: string[][],
  fileType: string
): { headerIndex: number; headerMap: Record<string, number> } {
  const keywords = HEADER_KEYWORDS[fileType];
  if (!keywords) return { headerIndex: 0, headerMap: {} };

  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const values = rows[i].map((v) => String(v || "").toLowerCase().trim());

    // Skip report title rows
    if (
      values.some(
        (v) =>
          v.includes("enquiry as of") ||
          v.includes("report") ||
          v.includes("generated")
      )
    )
      continue;

    const meaningful = values.filter((v) => v && v.trim() !== "");
    if (meaningful.length < 3) continue;

    const headerMap: Record<string, number> = {};
    let matched = 0;

    for (const [stdName, kwList] of Object.entries(keywords)) {
      for (let col = 0; col < values.length; col++) {
        if (kwList.some((kw) => values[col].includes(kw))) {
          headerMap[stdName] = col;
          matched++;
          break;
        }
      }
    }

    const required = Object.keys(keywords).length;
    if (matched >= Math.ceil(required * 0.4)) {
      console.log(
        `Header found at row ${i} for ${fileType}: ${matched}/${required} columns mapped: ${JSON.stringify(headerMap)}`
      );
      return { headerIndex: i, headerMap };
    }
  }

  console.warn(`No header found for ${fileType}, using row 0`);
  return { headerIndex: 0, headerMap: {} };
}

function parseDateSmart(value: any): Date | null {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

  // DD/MM/YYYY or DD-MM-YYYY
  const m1 = s.match(/^([0-3]?\d)[\/.-]([0-1]?\d)[\/.-](\d{2,4})$/);
  if (m1) {
    const d = parseInt(m1[1], 10);
    const mo = parseInt(m1[2], 10) - 1;
    let y = parseInt(m1[3], 10);
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo, d));
    return isNaN(dt.getTime()) ? null : dt;
  }

  const dt2 = new Date(s);
  return isNaN(dt2.getTime()) ? null : dt2;
}

const toNumber = (v: any): number => {
  if (!v) return 0;
  let s = String(v).replace(/,/g, "").trim();
  // Handle (123) as negative
  if (/^\s*\(.*\)\s*$/.test(s)) s = "-" + s.replace(/[()]/g, "");
  s = s.replace(/[^0-9.-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

// ─── SKU Normalization ──────────────────────────────────────────────────────
// Unleashed CSVs sometimes have inconsistent SKU formats (PSD-HD54 vs PSD-HD-54).
// We normalize by uppercasing and removing non-alphanumeric chars for matching.

function normalizeSKU(sku: string): string {
  return sku.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ─── Load SOH from CSV ────────────────────────────────────────────────────

async function loadSOHFromCSV(
  supabase: any,
  sohText: string
): Promise<{ sohRows: number; productRows: number }> {
  const rawData: string[][] = parse(sohText, { skipFirstRow: false, lazyQuotes: true });
  const { headerIndex, headerMap } = findHeaderRow(rawData, "soh");
  const dataRows = rawData.slice(headerIndex + 1);

  console.log(
    `SOH CSV: ${dataRows.length} data rows after header at row ${headerIndex}`
  );

  const today = new Date().toISOString().slice(0, 10);
  const sohInserts: any[] = [];
  const productUpserts: any[] = [];
  const seenSkus = new Set<string>();

  for (const row of dataRows) {
    const sku = String(row[headerMap["Product Code"]] ?? "").trim();
    if (!sku) continue;

    const warehouse = String(row[headerMap["Warehouse"]] ?? "").trim();
    const qtyOnHand = Math.round(toNumber(row[headerMap["Qty On Hand"]]));
    const allocated = Math.round(toNumber(row[headerMap["Allocated"]]));
    const available = Math.round(toNumber(row[headerMap["Available Qty"]]));

    // SOH snapshot (per warehouse)
    if (qtyOnHand !== 0 || allocated !== 0) {
      sohInserts.push({
        snapshot_date: today,
        sku,
        warehouse,
        quantity: qtyOnHand,
        allocated,
        available,
      });
    }

    // SKU parameters (deduplicated by SKU)
    if (!seenSkus.has(sku)) {
      seenSkus.add(sku);
      const desc = String(
        row[headerMap["Product Description"]] ?? ""
      ).trim();
      const group = String(
        row[headerMap["Product Group"]] ?? "Other"
      ).trim();

      productUpserts.push({
        sku,
        product_description: desc,
        product_group: group || "Other",
        updated_at: new Date().toISOString(),
      });
    }
  }

  const warehouses = [
    ...new Set(sohInserts.map((r) => r.warehouse || "(empty)")),
  ];
  console.log(
    `SOH: ${sohInserts.length} rows, warehouses: ${JSON.stringify(warehouses)}`
  );
  console.log(`Products: ${productUpserts.length} unique SKUs from SOH`);

  // Delete today's SOH snapshots ONLY for the warehouses we found in CSV
  // (preserve PO-based entries like Container, DHL, On Production)
  if (warehouses.length > 0) {
    for (const wh of warehouses) {
      await supabase
        .from("aim2026_soh_snapshots")
        .delete()
        .eq("snapshot_date", today)
        .eq("warehouse", wh);
    }
  }

  // Insert SOH in batches
  const batch = 300;
  for (let i = 0; i < sohInserts.length; i += batch) {
    const b = sohInserts.slice(i, i + batch);
    const { error } = await supabase.from("aim2026_soh_snapshots").insert(b);
    if (error) console.error(`SOH insert batch ${i} error:`, error);
  }

  // Upsert products in batches
  for (let i = 0; i < productUpserts.length; i += batch) {
    const b = productUpserts.slice(i, i + batch);
    const { error } = await supabase
      .from("aim2026_sku_parameters")
      .upsert(b, { onConflict: "sku", ignoreDuplicates: false });
    if (error) console.error(`Product upsert batch ${i} error:`, error);
  }

  return { sohRows: sohInserts.length, productRows: productUpserts.length };
}

// ─── Load Sales from CSV → Demand History ─────────────────────────────────
// Replicates the AIM tab's ROD calculation:
//   ROD = (salesQty + compUsage) / monthsFactor
// Where:
//   - salesQty = Main Warehouse sales (excluding "parked" orders)
//   - compUsage = component quantity consumed in production assemblies
//   - monthsFactor = days in range / 30

async function loadSalesFromCSV(
  supabase: any,
  salesText: string
): Promise<number> {
  const rawData: string[][] = parse(salesText, { skipFirstRow: false, lazyQuotes: true });
  const { headerIndex, headerMap } = findHeaderRow(rawData, "sales");
  const dataRows = rawData.slice(headerIndex + 1);

  console.log(`Sales CSV: ${dataRows.length} data rows`);
  console.log(`Sales header map: ${JSON.stringify(headerMap)}`);

  const ALLOWED_STATUSES = new Set(["completed", "placed", "backordered", "parked"]);

  // demand_history aggregates: ONLY Completed sales go into quantity_sold.
  // Per-warehouse: key = "period|sku|warehouse"
  const whMap = new Map<string, { qty: number; revenue: number }>();
  // "All": key = "period|sku"
  const allMap = new Map<string, { qty: number; revenue: number }>();
  // Detail rows for aim2026_demand_detail (ALL statuses)
  const detailRows: any[] = [];

  let droppedNoDate = 0;
  let droppedStatus = 0;

  for (const row of dataRows) {
    const sku = String(row[headerMap["Product Code"]] ?? "").trim();
    if (!sku) continue;

    const rawStatus = String(row[headerMap["Status"]] ?? "").trim();
    const status = rawStatus.toLowerCase();
    if (!ALLOWED_STATUSES.has(status)) {
      droppedStatus++;
      continue;
    }

    const qty = Math.abs(toNumber(row[headerMap["Quantity"]]));
    if (qty === 0) continue;

    const revenue = headerMap["Total"] !== undefined
      ? Math.abs(toNumber(row[headerMap["Total"]]))
      : 0;

    const orderDate = headerMap["Order Date"] !== undefined
      ? parseDateSmart(row[headerMap["Order Date"]])
      : null;

    if (!orderDate) {
      droppedNoDate++;
      continue;
    }

    const periodDate = orderDate.toISOString().slice(0, 7) + "-01";
    const warehouse = String(row[headerMap["Warehouse"]] ?? "").trim() || "Unknown";
    const customer = headerMap["Customer"] !== undefined
      ? String(row[headerMap["Customer"]] ?? "").trim()
      : "";
    const productGroup = headerMap["Product Group"] !== undefined
      ? String(row[headerMap["Product Group"]] ?? "").trim()
      : "";
    const customerType = headerMap["Customer Type"] !== undefined
      ? String(row[headerMap["Customer Type"]] ?? "").trim()
      : "";

    // demand_history aggregate: ONLY Completed
    if (status === "completed") {
      const whKey = `${periodDate}|${sku}|${warehouse}`;
      const whExisting = whMap.get(whKey) ?? { qty: 0, revenue: 0 };
      whExisting.qty += qty;
      whExisting.revenue += revenue;
      whMap.set(whKey, whExisting);

      const allKey = `${periodDate}|${sku}`;
      const allExisting = allMap.get(allKey) ?? { qty: 0, revenue: 0 };
      allExisting.qty += qty;
      allExisting.revenue += revenue;
      allMap.set(allKey, allExisting);
    }

    // Detail row (ALL statuses — Completed, Placed, Backordered, Parked)
    detailRows.push({
      period_date: periodDate,
      sku,
      type: "sale",
      order_date: orderDate.toISOString().slice(0, 10),
      order_number: null,
      customer,
      quantity: Math.round(qty * 100) / 100,
      amount: Math.round(revenue * 100) / 100,
      status: rawStatus,
      warehouse,
      product_group: productGroup,
      customer_type: customerType,
    });
  }

  console.log(
    `Sales: ${allMap.size} All rows, ${whMap.size} per-warehouse rows, ${detailRows.length} detail rows (dropped: ${droppedNoDate} no date, ${droppedStatus} wrong status)`
  );

  if (allMap.size === 0) return 0;

  // Clear existing demand_history and demand_detail sales rows
  const { error: delHistErr } = await supabase.from("aim2026_demand_history").delete().neq("id", 0);
  if (delHistErr) console.error("Failed to clear demand_history:", delHistErr);
  const { error: delDetErr } = await supabase.from("aim2026_demand_detail").delete().eq("type", "sale");
  if (delDetErr) console.error("Failed to clear demand_detail sales:", delDetErr);

  // Build aggregate rows: "All" + per-warehouse
  const aggRows: any[] = [];

  for (const [key, val] of allMap) {
    const [periodDate, sku] = key.split("|");
    aggRows.push({
      period_date: periodDate,
      sku,
      warehouse: "All",
      quantity_sold: Math.round(val.qty * 100) / 100,
      revenue: Math.round(val.revenue * 100) / 100,
      component_usage: 0,
    });
  }

  for (const [key, val] of whMap) {
    const parts = key.split("|");
    aggRows.push({
      period_date: parts[0],
      sku: parts[1],
      warehouse: parts[2],
      quantity_sold: Math.round(val.qty * 100) / 100,
      revenue: Math.round(val.revenue * 100) / 100,
      component_usage: 0,
    });
  }

  // Insert aggregate rows (table was just cleared, no conflicts expected)
  const batch = 300;
  let aggInserted = 0;
  for (let i = 0; i < aggRows.length; i += batch) {
    const b = aggRows.slice(i, i + batch);
    const { error } = await supabase.from("aim2026_demand_history").insert(b);
    if (error) {
      console.error(`Demand insert batch ${i} error: ${JSON.stringify(error)}`);
    } else {
      aggInserted += b.length;
    }
  }

  // Insert detail rows
  let detInserted = 0;
  for (let i = 0; i < detailRows.length; i += batch) {
    const b = detailRows.slice(i, i + batch);
    const { error } = await supabase.from("aim2026_demand_detail").insert(b);
    if (error) {
      console.error(`Detail insert batch ${i} error: ${JSON.stringify(error)}`);
    } else {
      detInserted += b.length;
    }
  }

  console.log(`Sales: inserted ${aggInserted}/${aggRows.length} aggregate + ${detInserted}/${detailRows.length} detail rows`);
  return aggRows.length;
}

// ─── Load Production → Component Usage (for ROD) ─────────────────────────
// The AIM tab's ROD formula:
//   For assembled products: ROD = salesQty / monthsFactor
//   For components: ROD = (salesQty + compUsage) / monthsFactor
//
// compUsage = sum of abs(negative quantities) from production where:
//   - Assembly Number exists and doesn't start with "DSM"
//   - Quantity is negative (means the component was consumed)

async function loadProductionFromCSV(
  supabase: any,
  prodText: string,
  assembledSKUs: Set<string>
): Promise<number> {
  const rawData: string[][] = parse(prodText, { skipFirstRow: false, lazyQuotes: true });
  const { headerIndex, headerMap } = findHeaderRow(rawData, "production");
  const dataRows = rawData.slice(headerIndex + 1);

  console.log(`Production CSV: ${dataRows.length} data rows`);
  console.log(`Production header map: ${JSON.stringify(headerMap)}`);

  // Per-warehouse aggregate: key = "period|sku|warehouse"
  const whMap = new Map<string, number>();
  // "All" aggregate: key = "period|sku"
  const allMap = new Map<string, number>();
  // Detail rows
  const detailRows: any[] = [];

  let processedRows = 0;
  let droppedStatus = 0;

  for (const row of dataRows) {
    const sku = String(row[headerMap["Product Code"]] ?? "").trim();
    if (!sku) continue;

    const assemblyNum = String(row[headerMap["Assembly Number"]] ?? "").trim();
    const rawQty = toNumber(row[headerMap["Quantity"]]);

    // Only negative quantities = component consumed in assembly
    const isComponentUsage =
      assemblyNum &&
      !assemblyNum.toUpperCase().startsWith("DSM") &&
      rawQty < 0;
    if (!isComponentUsage) continue;

    // Filter: only Completed assemblies
    if (headerMap["Assembly Status"] !== undefined) {
      const asmStatus = String(row[headerMap["Assembly Status"]] ?? "").trim().toLowerCase();
      if (asmStatus && asmStatus !== "completed") {
        droppedStatus++;
        continue;
      }
    }

    // Skip if this SKU is itself an assembled product
    if (assembledSKUs.has(sku)) continue;

    const qty = Math.abs(rawQty);

    // Use "Assembly Date" column explicitly (= actual completion date)
    let orderDate: Date | null = null;
    if (headerMap["Assembly Date"] !== undefined) {
      orderDate = parseDateSmart(row[headerMap["Assembly Date"]]);
    }
    if (!orderDate) continue;

    const periodDate = orderDate.toISOString().slice(0, 7) + "-01";
    const warehouse = headerMap["Warehouse"] !== undefined
      ? String(row[headerMap["Warehouse"]] ?? "").trim() || "Unknown"
      : "Unknown";
    const productGroup = headerMap["Product Group"] !== undefined
      ? String(row[headerMap["Product Group"]] ?? "").trim()
      : "";
    const totalCost = headerMap["Total Cost"] !== undefined
      ? Math.abs(toNumber(row[headerMap["Total Cost"]]))
      : 0;

    // Per-warehouse aggregate
    const whKey = `${periodDate}|${sku}|${warehouse}`;
    whMap.set(whKey, (whMap.get(whKey) ?? 0) + qty);

    // "All" aggregate
    const allKey = `${periodDate}|${sku}`;
    allMap.set(allKey, (allMap.get(allKey) ?? 0) + qty);

    // Detail row
    detailRows.push({
      period_date: periodDate,
      sku,
      type: "component_usage",
      order_date: orderDate.toISOString().slice(0, 10),
      order_number: assemblyNum,
      customer: `Assembly ${assemblyNum}`,
      quantity: Math.round(qty * 100) / 100,
      amount: Math.round(totalCost * 100) / 100,
      status: "Completed",
      warehouse,
      product_group: productGroup,
      customer_type: "",
    });

    processedRows++;
  }

  console.log(
    `Production: ${processedRows} component usage rows across ${allMap.size} SKUs, ${whMap.size} per-warehouse (dropped: ${droppedStatus} non-completed)`
  );

  if (allMap.size === 0) return 0;

  // Clear existing component_usage detail rows
  await supabase.from("aim2026_demand_detail").delete().eq("type", "component_usage");

  // Load ALL existing demand_history rows that might need component_usage updates.
  // We fetch in batches to handle large datasets.
  const existingMap = new Map<string, { id: number; quantity_sold: number; revenue: number }>();
  let offset = 0;
  const fetchSize = 1000;
  while (true) {
    const { data: page } = await supabase
      .from("aim2026_demand_history")
      .select("id, period_date, sku, warehouse, quantity_sold, revenue")
      .range(offset, offset + fetchSize - 1);
    if (!page || page.length === 0) break;
    for (const r of page) {
      existingMap.set(`${r.period_date}|${r.sku}|${r.warehouse}`, {
        id: r.id,
        quantity_sold: Number(r.quantity_sold ?? 0),
        revenue: Number(r.revenue ?? 0),
      });
    }
    if (page.length < fetchSize) break;
    offset += fetchSize;
  }
  console.log(`Production: loaded ${existingMap.size} existing demand_history rows for matching`);

  // Build rows to update (existing) and insert (new)
  const updateRows: { id: number; component_usage: number }[] = [];
  const insertRows: any[] = [];

  // Process "All" aggregates
  for (const [key, compQty] of allMap) {
    const [periodDate, sku] = key.split("|");
    const rounded = Math.round(compQty * 100) / 100;
    const existing = existingMap.get(`${periodDate}|${sku}|All`);
    if (existing) {
      updateRows.push({ id: existing.id, component_usage: rounded });
    } else {
      insertRows.push({
        period_date: periodDate,
        sku,
        warehouse: "All",
        quantity_sold: 0,
        revenue: 0,
        component_usage: rounded,
      });
    }
  }

  // Process per-warehouse aggregates
  for (const [key, compQty] of whMap) {
    const parts = key.split("|");
    const rounded = Math.round(compQty * 100) / 100;
    const existing = existingMap.get(key);
    if (existing) {
      updateRows.push({ id: existing.id, component_usage: rounded });
    } else {
      insertRows.push({
        period_date: parts[0],
        sku: parts[1],
        warehouse: parts[2],
        quantity_sold: 0,
        revenue: 0,
        component_usage: rounded,
      });
    }
  }

  console.log(`Production: ${updateRows.length} updates, ${insertRows.length} inserts`);

  // Batch updates using individual update calls (grouped for efficiency)
  const batch = 300;
  for (let i = 0; i < updateRows.length; i += 50) {
    const chunk = updateRows.slice(i, i + 50);
    await Promise.all(
      chunk.map((r) =>
        supabase
          .from("aim2026_demand_history")
          .update({ component_usage: r.component_usage })
          .eq("id", r.id)
      )
    );
  }

  // Batch inserts for new rows
  for (let i = 0; i < insertRows.length; i += batch) {
    const b = insertRows.slice(i, i + batch);
    const { error } = await supabase.from("aim2026_demand_history").insert(b);
    if (error) console.error(`Production aggregate insert batch ${i} error: ${JSON.stringify(error)}`);
  }

  // Insert detail rows
  let detInserted = 0;
  for (let i = 0; i < detailRows.length; i += batch) {
    const b = detailRows.slice(i, i + batch);
    const { error } = await supabase.from("aim2026_demand_detail").insert(b);
    if (error) {
      console.error(`Production detail insert batch ${i} error: ${JSON.stringify(error)}`);
    } else {
      detInserted += b.length;
    }
  }

  const totalAgg = updateRows.length + insertRows.length;
  console.log(`Production: processed ${totalAgg} aggregate + ${detInserted}/${detailRows.length} detail rows`);
  return totalAgg;
}

// ─── Load Costs from CSV ──────────────────────────────────────────────────
// Uses SKU normalization to handle format differences (PSD-HD54 vs PSD-HD-54)

async function loadCostsFromCSV(
  supabase: any,
  costsText: string
): Promise<number> {
  const rawData: string[][] = parse(costsText, { skipFirstRow: false, lazyQuotes: true });
  const dataRows = rawData.slice(1); // Skip header

  console.log(`Costs CSV: ${dataRows.length} data rows`);

  // Load ALL existing SKUs from aim2026_sku_parameters for normalized matching
  const { data: allSkuRows } = await supabase
    .from("aim2026_sku_parameters")
    .select("sku");

  const existingSkus = (allSkuRows ?? []).map((r: any) => r.sku as string);
  const normalizedLookup = new Map<string, string>(); // normalized → actual
  for (const sku of existingSkus) {
    normalizedLookup.set(normalizeSKU(sku), sku);
  }

  console.log(
    `Costs: ${existingSkus.length} existing SKUs loaded for matching`
  );

  const updates: { actualSku: string; cost: number }[] = [];
  let exactMatches = 0;
  let normalizedMatches = 0;
  let noMatch = 0;

  for (const row of dataRows) {
    const csvSku = String(row[0] ?? "").trim();
    const cost = parseFloat(String(row[1] ?? "0"));
    if (!csvSku || isNaN(cost) || cost <= 0) continue;

    // 1. Try exact match
    if (existingSkus.includes(csvSku)) {
      updates.push({ actualSku: csvSku, cost });
      exactMatches++;
      continue;
    }

    // 2. Try normalized match
    const normalizedKey = normalizeSKU(csvSku);
    const actualSku = normalizedLookup.get(normalizedKey);
    if (actualSku) {
      updates.push({ actualSku, cost });
      normalizedMatches++;
      continue;
    }

    // 3. No match — create the SKU record so cost is preserved
    updates.push({ actualSku: csvSku, cost });
    noMatch++;
  }

  console.log(
    `Costs matching: ${exactMatches} exact, ${normalizedMatches} normalized, ${noMatch} new/unmatched`
  );

  let updated = 0;
  for (const { actualSku, cost } of updates) {
    // Use upsert so even new SKUs get created with their cost
    const { error } = await supabase
      .from("aim2026_sku_parameters")
      .upsert(
        {
          sku: actualSku,
          product_cost_china: cost,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sku", ignoreDuplicates: false }
      );

    if (!error) updated++;
    else console.error(`Cost upsert error for ${actualSku}:`, error);
  }

  console.log(`Costs: updated ${updated} of ${updates.length} SKU costs`);
  return updated;
}

// ─── Load Lead Times + Pack Size from ProductList.csv ─────────────────────
// ProductList.csv format:
//   Row 1: comment (file creation date) — skip
//   Row 2+: Column A = SKU, Column B = Lead Time (Days), optional "Pack Size"
//
// Pack Size = units per master carton. Used by Complete Projection's PO
// Builder to round suggested qty to nearest multiple. Optional — falls back
// to existing value or 1 (no rounding) if missing.

async function loadLeadTimesFromCSV(
  supabase: any,
  productListText: string
): Promise<number> {
  const rawData: string[][] = parse(productListText, { skipFirstRow: false, lazyQuotes: true });

  // Row 0 is a comment (file creation date), skip it.
  // Row 1 should be the header row, data starts at row 2.
  if (rawData.length < 3) {
    console.warn("ProductList.csv has fewer than 3 rows, nothing to load");
    return 0;
  }

  // Find header row — look for a row containing "lead time" in any column
  let headerIdx = 1; // default to row 1
  for (let i = 0; i < Math.min(5, rawData.length); i++) {
    const rowLower = rawData[i].map((v) => String(v || "").toLowerCase().trim());
    if (rowLower.some((v) => v.includes("lead time") || v.includes("leadtime"))) {
      headerIdx = i;
      break;
    }
  }

  // Find the column indexes
  const headerRow = rawData[headerIdx].map((v) => String(v || "").toLowerCase().trim());
  let ltColIdx = -1;
  let psColIdx = -1;
  let skuColIdx = 0; // default to column A

  for (let c = 0; c < headerRow.length; c++) {
    const h = headerRow[c];
    if (h.includes("lead time") || h.includes("leadtime")) {
      ltColIdx = c;
    }
    // Pack Size: matches "pack size", "packsize", "carton qty", "units per box",
    // "units per carton", "case pack", "innerpack".
    if (
      h.includes("pack size") ||
      h.includes("packsize") ||
      h.includes("carton qty") ||
      h.includes("carton quantity") ||
      h.includes("units per box") ||
      h.includes("units per carton") ||
      h.includes("case pack") ||
      h.includes("innerpack") ||
      h.includes("inner pack")
    ) {
      psColIdx = c;
    }
    if (h.includes("product code") || h.includes("sku") || h.includes("productcode")) {
      skuColIdx = c;
    }
  }

  // If no "lead time" column found, assume column B (index 1)
  if (ltColIdx === -1) {
    ltColIdx = 1;
    console.warn("ProductList.csv: 'Lead Time' column not found by name, defaulting to column B (index 1)");
  }

  const dataRows = rawData.slice(headerIdx + 1);
  console.log(
    `ProductList CSV: ${dataRows.length} data rows, SKU col=${skuColIdx}, LeadTime col=${ltColIdx}, PackSize col=${psColIdx >= 0 ? psColIdx : "(not present)"}`
  );

  const updates: { sku: string; lead_time_days?: number; pack_size?: number }[] = [];

  for (const row of dataRows) {
    const sku = String(row[skuColIdx] ?? "").trim();
    if (!sku) continue;

    const ltRaw = toNumber(row[ltColIdx]);
    const leadTimeDays = Math.round(ltRaw);
    const ltValid = leadTimeDays > 0 && leadTimeDays <= 365;

    let packSize: number | null = null;
    if (psColIdx >= 0) {
      const psRaw = toNumber(row[psColIdx]);
      const ps = Math.round(psRaw);
      if (ps > 0 && ps <= 100000) packSize = ps;
    }

    // Skip si NO hay nada útil que upsertear (ni LT válido ni pack válido).
    if (!ltValid && packSize == null) continue;

    const update: { sku: string; lead_time_days?: number; pack_size?: number } = { sku };
    if (ltValid) update.lead_time_days = leadTimeDays;
    if (packSize != null) update.pack_size = packSize;

    updates.push(update);
  }

  const withPack = updates.filter((u) => u.pack_size != null).length;
  console.log(`ProductList: ${updates.length} SKUs with valid lead times (${withPack} also with pack size)`);

  if (updates.length === 0) return 0;

  // Upsert in batches, SPLIT so every batch carries identical keys.
  //
  // PostgREST builds one statement per batch from the UNION of the keys present
  // across the array, sending NULL for any row that omits one. Mixing rows that
  // carry pack_size with rows that do not therefore does not leave the latter
  // alone — it wipes their pack_size. The same shape erased 753 product costs on
  // 2026-08-03 in the Unleashed products sync.
  //
  // Splitting by which fields a row actually has keeps each payload homogeneous,
  // so a missing value is simply not written rather than written as NULL.
  let updated = 0;
  const batch = 300;
  const groups = [
    { rows: updates.filter((u) => u.lead_time_days != null && u.pack_size != null), lead: true,  pack: true },
    { rows: updates.filter((u) => u.lead_time_days != null && u.pack_size == null), lead: true,  pack: false },
    { rows: updates.filter((u) => u.lead_time_days == null && u.pack_size != null), lead: false, pack: true },
  ];

  for (const g of groups) {
    if (g.rows.length === 0) continue;
    for (let i = 0; i < g.rows.length; i += batch) {
      const b = g.rows.slice(i, i + batch).map((u) => {
        const row: any = { sku: u.sku, updated_at: new Date().toISOString() };
        if (g.lead) row.lead_time_days = u.lead_time_days;
        if (g.pack) row.pack_size = u.pack_size;
        return row;
      });

      const { error } = await supabase
        .from("aim2026_sku_parameters")
        .upsert(b, { onConflict: "sku", ignoreDuplicates: false });

      if (!error) {
        updated += b.length;
      } else {
        console.error(`LeadTime upsert batch ${i} error:`, error);
      }
    }
  }

  console.log(`ProductList: updated lead times for ${updated} SKUs`);
  return updated;
}

// ─── Load Purchase Orders from CSV → In-Transit Data ──────────────────────
// Maps PO Order Status to warehouse categories:
//   "container"              → Container (in transit by sea)
//   "dhl" / "dhl inbounds"  → DHL (express courier)
//   "production" + China-W  → On Production
//   "placed" + China-W      → On Production (placed orders to China factory)

async function loadPurchaseOrdersFromCSV(
  supabase: any,
  purchaseText: string
): Promise<number> {
  const rawData: string[][] = parse(purchaseText, { skipFirstRow: false, lazyQuotes: true });
  const { headerIndex, headerMap } = findHeaderRow(rawData, "purchase");
  const dataRows = rawData.slice(headerIndex + 1);

  console.log(`Purchase CSV: ${dataRows.length} data rows`);
  console.log(`Purchase header map: ${JSON.stringify(headerMap)}`);

  const containerMap = new Map<string, number>();
  const dhlMap = new Map<string, number>();
  const onProdMap = new Map<string, number>();

  for (const row of dataRows) {
    const sku = String(row[headerMap["Product Code"]] ?? "").trim();
    if (!sku) continue;

    const status = String(row[headerMap["Order Status"]] ?? "")
      .trim()
      .toLowerCase();
    const warehouse = String(row[headerMap["Warehouse"]] ?? "")
      .trim()
      .toLowerCase();

    // Get quantity
    const baseUnitQty = Math.abs(
      toNumber(row[headerMap["Base Unit Qty"]])
    );
    const qty =
      baseUnitQty > 0
        ? baseUnitQty
        : Math.abs(toNumber(row[headerMap["Quantity"]]));
    if (qty === 0) continue;

    // Map status to in-transit category
    if (status === "container" || status.includes("container")) {
      containerMap.set(sku, (containerMap.get(sku) ?? 0) + qty);
    } else if (
      status === "dhl" ||
      status === "dhl inbounds" ||
      status === "dhl-inbounds" ||
      status.includes("dhl")
    ) {
      dhlMap.set(sku, (dhlMap.get(sku) ?? 0) + qty);
    } else if (
      (status === "production" || status === "placed") &&
      (warehouse.includes("china") || warehouse.includes("factory"))
    ) {
      onProdMap.set(sku, (onProdMap.get(sku) ?? 0) + qty);
    }
  }

  console.log(
    `Purchase Orders: Container ${containerMap.size} SKUs, DHL ${dhlMap.size} SKUs, Production ${onProdMap.size} SKUs`
  );

  // Build SOH-style rows for in-transit data
  const today = new Date().toISOString().slice(0, 10);
  const poRows: any[] = [];

  for (const [sku, qty] of containerMap) {
    if (qty > 0)
      poRows.push({
        snapshot_date: today,
        sku,
        warehouse: "Container",
        quantity: qty,
        allocated: 0,
        available: qty,
      });
  }
  for (const [sku, qty] of dhlMap) {
    if (qty > 0)
      poRows.push({
        snapshot_date: today,
        sku,
        warehouse: "DHL",
        quantity: qty,
        allocated: 0,
        available: qty,
      });
  }
  for (const [sku, qty] of onProdMap) {
    if (qty > 0)
      poRows.push({
        snapshot_date: today,
        sku,
        warehouse: "On Production",
        quantity: qty,
        allocated: 0,
        available: qty,
      });
  }

  if (poRows.length === 0) return 0;

  // Delete today's PO-based snapshots (only these warehouse names)
  for (const wh of ["Container", "DHL", "On Production"]) {
    await supabase
      .from("aim2026_soh_snapshots")
      .delete()
      .eq("snapshot_date", today)
      .eq("warehouse", wh);
  }

  // Insert in batches
  const batch = 300;
  for (let i = 0; i < poRows.length; i += batch) {
    const b = poRows.slice(i, i + batch);
    const { error } = await supabase.from("aim2026_soh_snapshots").insert(b);
    if (error) console.error(`PO SOH insert batch ${i} error:`, error);
  }

  return poRows.length;
}

// ─── Main Handler (step-based for memory efficiency) ──────────────────────
// Accepts { step: "soh" | "sales" | "costs" | "purchase" | "production" | "all" }
// When step is omitted or "all", runs all steps sequentially.
// Frontend should call individual steps with delays if "all" fails.

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // no body
    }

    const step = body?.step ?? "all";
    console.log(`=== AIM 2026 CSV Load — step: ${step} ===`);

    const errors: string[] = [];
    const result: Record<string, number> = {};

    // ── BOM only (latest BOM_*.csv — does not touch production/demand) ──
    if (step === "bom") {
      const bomBlob = await downloadBOMFromBucket(supabase);
      if (!bomBlob) {
        return jsonResponse({
          success: false,
          step,
          result: {},
          errors: [
            "No BOM CSV found in aim-csv-files or csv-files (BOM_*.csv, BillOfMaterials*.csv, BillOfMaterialsList.csv, etc.)",
          ],
          durationMs: Date.now() - startTime,
        });
      }
      try {
        const { assembledSKUs, components } = parseBomCsv(await bomBlob.text());
        if (assembledSKUs.size === 0 && components.length === 0) {
          return jsonResponse({
            success: false,
            step,
            result: { bomAssemblies: 0, bomComponents: 0 },
            errors: ["BOM file parsed but no assemblies or components found"],
            durationMs: Date.now() - startTime,
          });
        }
        if (assembledSKUs.size > 0) {
          const { error: delErr } = await supabase.from("aim2026_assembled_products").delete().gte("sku", "");
          if (delErr) console.error("aim2026_assembled_products delete (bom step):", delErr);
          const { error: insErr } = await supabase
            .from("aim2026_assembled_products")
            .insert(Array.from(assembledSKUs, (sku) => ({ sku })));
          if (insErr) {
            return jsonResponse({
              success: false,
              step,
              result: {},
              errors: [`aim2026_assembled_products: ${insErr.message}`],
              durationMs: Date.now() - startTime,
            });
          }
        }
        if (components.length > 0) {
          const { error: delBomErr } = await supabase.from("aim2026_bom_components").delete().gte("assembly_sku", "");
          if (delBomErr) console.error("aim2026_bom_components delete (bom step):", delBomErr);
          await insertBomComponentsBatched(supabase, components);
        }
        return jsonResponse({
          success: true,
          step,
          result: {
            bomAssemblies: assembledSKUs.size,
            bomComponents: components.length,
          },
          errors: [],
          durationMs: Date.now() - startTime,
        });
      } catch (e) {
        return jsonResponse({
          success: false,
          step,
          result: {},
          errors: [`BOM: ${e instanceof Error ? e.message : String(e)}`],
          durationMs: Date.now() - startTime,
        });
      }
    }

    // ── SOH step ──────────────────────────────────────────────────
    if (step === "soh" || step === "all") {
      const blob = await downloadFromBucket(supabase, "SOHList.csv");
      if (blob) {
        try {
          const text = await blob.text();
          const r = await loadSOHFromCSV(supabase, text);
          result.soh = r.sohRows;
          result.products = r.productRows;
        } catch (e) {
          errors.push(`SOH: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        if (step === "soh") errors.push("SOHList.csv not found");
        else console.warn("SOHList.csv not found (may have been loaded via API)");
      }
      if (step !== "all") {
        return jsonResponse({ success: errors.length === 0, step, result, errors, durationMs: Date.now() - startTime });
      }
    }

    // ── Sales step ────────────────────────────────────────────────
    if (step === "sales" || step === "all") {
      const blob = await downloadFromBucket(supabase, "SalesEnquiryList.csv");
      if (blob) {
        try {
          const text = await blob.text();
          result.sales = await loadSalesFromCSV(supabase, text);
        } catch (e) {
          errors.push(`Sales: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        errors.push("SalesEnquiryList.csv not found");
      }
      if (step !== "all") {
        return jsonResponse({ success: errors.length === 0, step, result, errors, durationMs: Date.now() - startTime });
      }
    }

    // ── Costs step ────────────────────────────────────────────────
    if (step === "costs" || step === "all") {
      const blob = await downloadFromBucket(supabase, "costs.csv");
      if (blob) {
        try {
          const text = await blob.text();
          result.costs = await loadCostsFromCSV(supabase, text);
        } catch (e) {
          errors.push(`Costs: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        errors.push("costs.csv not found");
      }
      if (step !== "all") {
        return jsonResponse({ success: errors.length === 0, step, result, errors, durationMs: Date.now() - startTime });
      }
    }

    // ── Purchase Orders step ──────────────────────────────────────
    if (step === "purchase" || step === "all") {
      const blob = await downloadFromBucket(supabase, "PurchaseEnquiryList.csv");
      if (blob) {
        try {
          const text = await blob.text();
          result.purchase = await loadPurchaseOrdersFromCSV(supabase, text);
        } catch (e) {
          errors.push(`Purchase: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.warn("PurchaseEnquiryList.csv not found (PO data will come from API)");
      }
      if (step !== "all") {
        return jsonResponse({ success: errors.length === 0, step, result, errors, durationMs: Date.now() - startTime });
      }
    }

    // ── Lead Times step (from ProductList.csv) ─────────────────────
    if (step === "leadtimes" || step === "all") {
      const blob = await downloadFromBucket(supabase, "ProductList.csv", [
        "productlist.csv",
        "Product List.csv",
      ]);
      if (blob) {
        try {
          const text = await blob.text();
          result.leadtimes = await loadLeadTimesFromCSV(supabase, text);
        } catch (e) {
          errors.push(`LeadTimes: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.warn("ProductList.csv not found (lead times will use defaults)");
      }
      if (step !== "all") {
        return jsonResponse({ success: errors.length === 0, step, result, errors, durationMs: Date.now() - startTime });
      }
    }

    // ── Production step ───────────────────────────────────────────
    if (step === "production" || step === "all") {
      const blob = await downloadFromBucket(supabase, "ProductionEnquiryList.csv");
      const bomBlob = await downloadBOMFromBucket(supabase);

      let assembledSKUs = new Set<string>();
      let bomComponents: Array<{
        assembly_sku: string;
        component_sku: string;
        quantity_per_assembly: number;
      }> = [];

      if (bomBlob) {
        try {
          const bomResult = parseBomCsv(await bomBlob.text());
          assembledSKUs = bomResult.assembledSKUs;
          bomComponents = bomResult.components;
        } catch {
          // non-critical
        }
      }

      if (assembledSKUs.size > 0) {
        const { error: delErr } = await supabase.from("aim2026_assembled_products").delete().gte("sku", "");
        if (delErr) console.error("aim2026_assembled_products delete error:", delErr);
        const insertRows = Array.from(assembledSKUs).map((sku) => ({ sku }));
        const { error: insErr } = await supabase.from("aim2026_assembled_products").insert(insertRows);
        if (insErr) console.error("aim2026_assembled_products insert error:", insErr);
        else console.log(`Assembled products: ${assembledSKUs.size} SKUs saved from BOM`);
      }

      if (bomComponents.length > 0) {
        const { error: delBomErr } = await supabase.from("aim2026_bom_components").delete().gte("assembly_sku", "");
        if (delBomErr) console.error("aim2026_bom_components delete error:", delBomErr);
        await insertBomComponentsBatched(supabase, bomComponents);
        console.log(`BOM components: ${bomComponents.length} rows saved (batched)`);
      }

      if (blob) {
        try {
          const text = await blob.text();
          result.production = await loadProductionFromCSV(supabase, text, assembledSKUs);
        } catch (e) {
          errors.push(`Production: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.warn("ProductionEnquiryList.csv not found (component usage from API)");
      }
      if (step !== "all") {
        return jsonResponse({ success: errors.length === 0, step, result, errors, durationMs: Date.now() - startTime });
      }
    }

    const durationMs = Date.now() - startTime;
    const status =
      errors.length === 0 ? "success" : errors.length < 3 ? "partial" : "failed";

    // Log the load
    await supabase.from("aim2026_sync_log").insert({
      status,
      records_synced: { source: "csv", ...result },
      errors,
      duration_ms: durationMs,
    });

    console.log(`=== CSV Load Complete: ${status} in ${(durationMs / 1000).toFixed(1)}s ===`);

    return jsonResponse({
      success: status !== "failed",
      status,
      step: "all",
      recordsLoaded: result,
      errors,
      durationMs,
      message: `CSV load (${step}): ${JSON.stringify(result)}. ${errors.length ? "Errors: " + errors.join("; ") : ""}`,
    });
  } catch (error) {
    console.error("Fatal error in aim2026-csv-load:", error);
    return jsonResponse(
      {
        success: false,
        message: `Fatal CSV load error: ${error instanceof Error ? error.message : "Unknown"}`,
        durationMs: Date.now() - startTime,
      },
      500
    );
  }
});
