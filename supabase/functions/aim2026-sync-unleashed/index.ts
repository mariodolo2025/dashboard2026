// =============================================================================
// AIM 2026 — Sync Unleashed Data (Incremental)
// =============================================================================
// Fetches data from the Unleashed API and stores it in aim2026_* tables.
// Designed for incremental syncs — only fetches new/changed data.
// Initial data should be loaded via aim2026-csv-load from CSV files.
//
// Endpoints fetched:
//   1. Products          → aim2026_sku_parameters (product info, cost)
//   2. StockOnHand       → aim2026_soh_snapshots  (per-warehouse stock)
//   3. SalesOrders       → aim2026_demand_history  (demand / revenue)
//   4. PurchaseOrders    → (in-transit, on-production data)
//
// Warehouse mapping (Unleashed codes → names):
//   MAIN      → Main Warehouse
//   China     → China-W
//   CONTAINER → Container
//   DHL       → DHL
//   Korea     → Pesado Korea
//
// The function reads Unleashed credentials from the unleashed_credentials table.
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

// ─── Unleashed API Helper ──────────────────────────────────────────────────

const UNLEASHED_BASE = "https://api.unleashedsoftware.com";

async function hmacSign(apiKey: string, queryString: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(queryString));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

interface UnleashedCreds {
  api_id: string;
  api_key: string;
}

async function unleashedGet(
  endpoint: string,
  queryString: string,
  creds: UnleashedCreds
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
    signal: AbortSignal.timeout(55000), // 55s timeout (Pro plan allows up to 300s)
  });

  if (!res.ok) {
    throw new Error(`Unleashed ${endpoint}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Fetch all pages from a paginated Unleashed endpoint.
 * Unleashed uses path-based pagination: /Products/1, /Products/2, etc. */
async function unleashedGetAll(
  endpoint: string,
  extraParams: string,
  creds: UnleashedCreds,
  pageSize = 200,
  maxPages = 100
): Promise<any[]> {
  let page = 1;
  let allItems: any[] = [];
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const pageEndpoint = `${endpoint}/${page}`;
    const qs = `${extraParams ? extraParams + "&" : ""}pageSize=${pageSize}`;
    const data = await unleashedGet(pageEndpoint, qs, creds);
    const items = data.Items ?? [];
    allItems = allItems.concat(items);

    const pagination = data.Pagination ?? {};
    const totalPages = pagination.NumberOfPages ?? 1;
    console.log(
      `${endpoint} page ${page}/${totalPages}: ${items.length} items`
    );
    hasMore = page < totalPages;
    page++;
  }

  return allItems;
}

// ─── Warehouse Configuration ───────────────────────────────────────────────
// These are the known warehouses in Unleashed.
// The sync fetches SOH per-warehouse using the warehouseCode filter.

const WAREHOUSES = [
  { code: "MAIN", name: "Main Warehouse" },
  { code: "China", name: "China-W" },
  // Uncomment as needed:
  // { code: "CONTAINER", name: "Container" },
  // { code: "DHL", name: "DHL" },
  // { code: "Korea", name: "Pesado Korea" },
];

// ─── Sync Steps ────────────────────────────────────────────────────────────

interface SyncResult {
  products: number;
  soh: number;
  sales: number;
  purchase: number;
  assemblies: number;
}

/** Step 1: Sync Products → aim2026_sku_parameters
 * Syncs product metadata (description, group, supplier) and cost for new SKUs.
 * Does NOT touch lead_time_days — that is loaded exclusively from ProductList.csv
 * via Settings → "Load Lead Times from CSV". */
async function syncProducts(
  supabase: any,
  creds: UnleashedCreds
): Promise<number> {
  const products = await unleashedGetAll("Products", "", creds);
  console.log(`Products API returned ${products.length} products`);

  // Load existing SKUs to know which already have cost from CSV
  const { data: existingRows } = await supabase
    .from("aim2026_sku_parameters")
    .select("sku, product_cost_china");
  const existingMap = new Map<string, { cost: number }>();
  for (const r of existingRows ?? []) {
    existingMap.set(r.sku, {
      cost: Number(r.product_cost_china) || 0,
    });
  }

  // Filter out products without a valid SKU and deduplicate
  const seenSkus = new Set<string>();
  const rows: any[] = [];

  for (const p of products) {
    const sku = (p.ProductCode ?? "").trim();
    if (!sku || seenSkus.has(sku)) continue;
    seenSkus.add(sku);

    const existing = existingMap.get(sku);
    const row: any = {
      sku,
      product_description: p.ProductDescription ?? "",
      product_group: p.ProductGroup?.GroupName ?? "Other",
      supplier: p.Supplier?.SupplierName ?? "Unknown",
      updated_at: new Date().toISOString(),
    };

    // Only set cost if the SKU doesn't already have one from costs.csv
    if (!existing || existing.cost === 0) {
      row.product_cost_china = Number(p.LastCost ?? p.DefaultPurchasePrice ?? 0);
    }

    // NOTE: lead_time_days is NOT set here. The Products list endpoint does not
    // include per-supplier lead times. Lead times are loaded from ProductList.csv
    // via Settings → "Load Lead Times from CSV". This avoids overwriting CSV values.

    rows.push(row);
  }

  console.log(`Products: ${rows.length} unique valid SKUs`);
  if (rows.length === 0) return 0;

  // Upsert in batches — ignoreDuplicates: false so it updates existing rows
  let inserted = 0;
  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from("aim2026_sku_parameters")
      .upsert(batch, { onConflict: "sku", ignoreDuplicates: false });

    if (error) {
      console.error(
        `Error upserting products batch ${i}-${i + batch.length}:`,
        error
      );
    } else {
      inserted += batch.length;
    }
  }

  console.log(`Products: ${inserted} of ${rows.length} upserted successfully`);
  return rows.length;
}

/** Step 2: Sync Stock on Hand → aim2026_soh_snapshots
 * Always fetches per-warehouse using warehouseCode filter to get proper breakdown.
 * The Unleashed /StockOnHand aggregate endpoint does NOT return warehouse names,
 * so we must query each warehouse individually.
 * Known warehouses: Main Warehouse (MAIN), China-W (China). */
async function syncStockOnHand(
  supabase: any,
  creds: UnleashedCreds
): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const allRows: any[] = [];

  // Log the API structure for debugging (one-time sample)
  try {
    const sampleData = await unleashedGet("StockOnHand/1", "pageSize=2", creds);
    const sampleItems = sampleData.Items ?? [];
    if (sampleItems.length > 0) {
      console.log(
        `StockOnHand sample keys: ${JSON.stringify(Object.keys(sampleItems[0]))}`
      );
      console.log(
        `StockOnHand sample item: ${JSON.stringify(sampleItems[0]).slice(0, 500)}`
      );
    }
  } catch (e) {
    console.warn("StockOnHand sample check failed:", e);
  }

  // Always fetch per-warehouse — the aggregate endpoint returns empty warehouse names
  console.log(
    `Fetching StockOnHand per-warehouse for: ${WAREHOUSES.map((w) => `${w.code} → ${w.name}`).join(", ")}`
  );

  for (const wh of WAREHOUSES) {
    console.log(`Fetching StockOnHand for warehouse: ${wh.code} (${wh.name})...`);
    try {
      const sohData = await unleashedGetAll(
        "StockOnHand",
        `warehouseCode=${wh.code}`,
        creds
      );
      console.log(
        `StockOnHand ${wh.code}: ${sohData.length} items returned`
      );

      for (const item of sohData) {
        const sku = (item.ProductCode ?? "").trim();
        if (!sku) continue;

        const qtyOnHand = Math.round(Number(item.QtyOnHand ?? 0));
        const allocated = Math.round(Number(item.AllocatedQty ?? 0));
        const available = Math.round(
          Number(item.AvailableQty ?? qtyOnHand - allocated)
        );

        if (qtyOnHand === 0 && allocated === 0) continue;

        allRows.push({
          snapshot_date: today,
          sku,
          warehouse: wh.name, // Use the known warehouse name
          quantity: qtyOnHand,
          allocated,
          available,
        });
      }
    } catch (e) {
      console.error(`StockOnHand ${wh.code} failed:`, e);
      // Continue with other warehouses
    }
  }

  console.log(`StockOnHand: ${allRows.length} total non-zero rows`);
  if (allRows.length > 0) {
    const warehouses = [
      ...new Set(allRows.map((r) => r.warehouse || "(aggregate)")),
    ];
    console.log(`StockOnHand warehouses: ${JSON.stringify(warehouses)}`);
  }

  if (allRows.length === 0) return 0;

  // Delete today's snapshots ONLY for warehouses we're replacing
  // (preserve PO-based entries: Container, DHL, On Production)
  const warehouseNames = WAREHOUSES.map((w) => w.name);
  for (const wh of warehouseNames) {
    await supabase
      .from("aim2026_soh_snapshots")
      .delete()
      .eq("snapshot_date", today)
      .eq("warehouse", wh);
  }

  // Insert in batches
  const batchSize = 200;
  for (let i = 0; i < allRows.length; i += batchSize) {
    const batch = allRows.slice(i, i + batchSize);
    const { error } = await supabase
      .from("aim2026_soh_snapshots")
      .insert(batch);

    if (error) {
      console.error(`Error inserting SOH batch ${i}:`, error);
    }
  }

  return allRows.length;
}

/** Step 3: Sync Sales Orders → aim2026_demand_history + aim2026_demand_detail
 * Incremental: re-aggregates the last 2 full months to catch retroactive changes.
 * Accepts an optional salesStatus param to process one status at a time
 * (Completed, Placed, Backordered, Parked) — the frontend calls this step once per status
 * to stay within edge function compute limits.
 * When isFirstSalesStatus=true, zeroes out quantity_sold/revenue for affected periods
 * so subsequent status calls can ADD to it without overwriting. */
async function syncSalesOrders(
  supabase: any,
  creds: UnleashedCreds,
  salesStatus?: string | null,
  isFirstSalesStatus?: boolean
): Promise<number> {
  const { data: lastSyncLog } = await supabase
    .from("aim2026_sync_log")
    .select("synced_at, records_synced")
    .eq("status", "success")
    .order("synced_at", { ascending: false })
    .limit(5);

  let lastSyncDate: Date | null = null;
  for (const log of lastSyncLog ?? []) {
    const records = log.records_synced;
    if (records?.sales > 0 || records?.source === "csv") {
      lastSyncDate = new Date(log.synced_at);
      break;
    }
  }

  // Incremental: re-sync last 2 full months. Full: last 12 months.
  let startDate: Date;
  let maxPages: number;
  if (lastSyncDate) {
    const now = new Date();
    startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    maxPages = 30;
    console.log(
      `Incremental sales sync: re-aggregating from ${startDate.toISOString().slice(0, 10)} (last sync: ${lastSyncDate.toISOString().slice(0, 10)})`
    );
  } else {
    startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);
    startDate.setDate(1);
    maxPages = 80;
    console.log(
      `Full sales sync: fetching last 12 months from ${startDate.toISOString().slice(0, 10)}`
    );
  }

  const startStr = startDate.toISOString().slice(0, 10);
  const statusToFetch = salesStatus ?? "Completed";
  const qs = `startDate=${startStr}&orderStatus=${statusToFetch}`;

  // CRITICAL: zero-out MUST happen BEFORE fetching/early-returns.
  // If the first status has no orders for some reason, we still need clean slate.
  if (isFirstSalesStatus) {
    console.log(`SalesOrders: zeroing quantity_sold/revenue from ${startStr} onwards (first status)`);
    const { error: zeroErr } = await supabase
      .from("aim2026_demand_history")
      .update({ quantity_sold: 0, revenue: 0 })
      .gte("period_date", startStr);
    if (zeroErr) console.error(`Sales zero-out error: ${JSON.stringify(zeroErr)}`);
  }

  console.log(`Fetching SalesOrders with: ${qs} (maxPages=${maxPages})`);
  const orders = await unleashedGetAll("SalesOrders", qs, creds, 200, maxPages);
  console.log(`SalesOrders status=${statusToFetch}: received ${orders.length} orders`);

  // Per-warehouse: key = "period|sku|warehouse", "All": key = "period|sku"
  const whMap = new Map<string, { qty: number; revenue: number }>();
  const allMap = new Map<string, { qty: number; revenue: number }>();
  const detailRows: any[] = [];

  for (const order of orders) {
    let orderDateStr: string | null = null;
    let orderDateFull: string | null = null;
    if (order.OrderDate) {
      const dateMatch = String(order.OrderDate).match(/\/Date\((\d+)\)\//);
      if (dateMatch) {
        const d = new Date(Number(dateMatch[1]));
        orderDateStr = d.toISOString().slice(0, 7) + "-01";
        orderDateFull = d.toISOString().slice(0, 10);
      } else {
        const d = new Date(order.OrderDate);
        orderDateStr = d.toISOString().slice(0, 7) + "-01";
        orderDateFull = d.toISOString().slice(0, 10);
      }
    }
    if (!orderDateStr) continue;

    const warehouse = String(order.Warehouse?.WarehouseName ?? "").trim() || "Unknown";
    const customerName = String(order.Customer?.CustomerName ?? "").trim();
    const orderNumber = String(order.OrderNumber ?? "").trim();
    const customerType = String(order.CustomerType ?? "").trim();

    for (const line of order.SalesOrderLines ?? []) {
      const sku = (line.Product?.ProductCode ?? "").trim();
      if (!sku) continue;

      const qty = Number(line.OrderQuantity ?? 0);
      const revenue = qty * Number(line.UnitPrice ?? 0);
      const productGroup = String(line.Product?.ProductGroup?.GroupName ?? "").trim();

      // Per-warehouse
      const whKey = `${orderDateStr}|${sku}|${warehouse}`;
      const whExisting = whMap.get(whKey) ?? { qty: 0, revenue: 0 };
      whExisting.qty += qty;
      whExisting.revenue += revenue;
      whMap.set(whKey, whExisting);

      // All
      const allKey = `${orderDateStr}|${sku}`;
      const allExisting = allMap.get(allKey) ?? { qty: 0, revenue: 0 };
      allExisting.qty += qty;
      allExisting.revenue += revenue;
      allMap.set(allKey, allExisting);

      detailRows.push({
        period_date: orderDateStr,
        sku,
        type: "sale",
        order_date: orderDateFull,
        order_number: orderNumber || null,
        customer: customerName,
        quantity: Math.round(Math.abs(qty) * 100) / 100,
        amount: Math.round(Math.abs(revenue) * 100) / 100,
        status: statusToFetch,
        warehouse,
        product_group: productGroup,
        customer_type: customerType,
      });
    }
  }

  console.log(`SalesOrders: ${allMap.size} All, ${whMap.size} per-wh, ${detailRows.length} detail`);

  const allKeys = allMap.size > 0 ? Array.from(allMap.keys()) : [];
  const uniqueSkus = [...new Set(allKeys.map((k) => k.split("|")[1]))];
  const uniquePeriods = [...new Set([
    ...allKeys.map((k) => k.split("|")[0]),
    ...detailRows.map((r: any) => r.period_date),
  ])];

  const isCompleted = statusToFetch === "Completed";
  const batchSize = 200;

  // ── demand_history: ONLY update for Completed status ──────────────────
  // quantity_sold must contain ONLY Completed sales. Placed/Parked/Backordered
  // go exclusively into demand_detail where calc-kpis-v2 reads them by status.
  if (isCompleted && allMap.size > 0) {
    const existingMap = new Map<string, { id: number; quantity_sold: number; revenue: number; component_usage: number }>();
    for (let i = 0; i < uniqueSkus.length; i += 50) {
      const skuBatch = uniqueSkus.slice(i, i + 50);
      const { data: existing } = await supabase
        .from("aim2026_demand_history")
        .select("id, period_date, sku, warehouse, quantity_sold, revenue, component_usage")
        .in("sku", skuBatch)
        .in("period_date", uniquePeriods)
        .limit(10000);

      for (const row of existing ?? []) {
        existingMap.set(`${row.period_date}|${row.sku}|${row.warehouse}`, {
          id: row.id,
          quantity_sold: Number(row.quantity_sold ?? 0),
          revenue: Number(row.revenue ?? 0),
          component_usage: Number(row.component_usage ?? 0),
        });
      }
    }

    console.log(`Sales existingMap: ${existingMap.size} rows loaded (Completed only)`);

    const updates: { id: number; quantity_sold: number; revenue: number }[] = [];
    const inserts: any[] = [];

    for (const [key, val] of allMap) {
      const [periodDate, sku] = key.split("|");
      const dbKey = `${periodDate}|${sku}|All`;
      const existing = existingMap.get(dbKey);
      const newQty = Math.round(val.qty * 100) / 100;
      const newRev = Math.round(val.revenue * 100) / 100;

      if (existing) {
        updates.push({
          id: existing.id,
          quantity_sold: existing.quantity_sold + newQty,
          revenue: existing.revenue + newRev,
        });
      } else {
        inserts.push({
          period_date: periodDate, sku, warehouse: "All",
          quantity_sold: newQty, revenue: newRev, component_usage: 0,
        });
      }
    }

    for (const [key, val] of whMap) {
      const parts = key.split("|");
      const existing = existingMap.get(key);
      const newQty = Math.round(val.qty * 100) / 100;
      const newRev = Math.round(val.revenue * 100) / 100;

      if (existing) {
        updates.push({
          id: existing.id,
          quantity_sold: existing.quantity_sold + newQty,
          revenue: existing.revenue + newRev,
        });
      } else {
        inserts.push({
          period_date: parts[0], sku: parts[1], warehouse: parts[2],
          quantity_sold: newQty, revenue: newRev, component_usage: 0,
        });
      }
    }

    console.log(`SalesOrders [Completed]: ${updates.length} updates, ${inserts.length} inserts`);

    for (let i = 0; i < updates.length; i += 50) {
      const chunk = updates.slice(i, i + 50);
      await Promise.all(
        chunk.map((u) =>
          supabase.from("aim2026_demand_history")
            .update({ quantity_sold: u.quantity_sold, revenue: u.revenue })
            .eq("id", u.id)
        )
      );
    }

    for (let i = 0; i < inserts.length; i += batchSize) {
      const batch = inserts.slice(i, i + batchSize);
      const { error } = await supabase.from("aim2026_demand_history").insert(batch);
      if (error) {
        console.warn(`Sales insert batch ${i} failed (${error.code}), falling back to individual updates`);
        for (const row of batch) {
          const { data: existing } = await supabase
            .from("aim2026_demand_history")
            .select("id, quantity_sold, revenue")
            .eq("period_date", row.period_date)
            .eq("sku", row.sku)
            .eq("warehouse", row.warehouse)
            .limit(1);
          if (existing?.[0]) {
            await supabase.from("aim2026_demand_history")
              .update({
                quantity_sold: Number(existing[0].quantity_sold ?? 0) + row.quantity_sold,
                revenue: Number(existing[0].revenue ?? 0) + row.revenue,
              })
              .eq("id", existing[0].id);
          } else {
            await supabase.from("aim2026_demand_history").insert(row);
          }
        }
      }
    }
  } else if (!isCompleted) {
    console.log(`SalesOrders [${statusToFetch}]: skipping demand_history (only detail rows)`);
  }

  // ── demand_detail: ALWAYS insert for every status ─────────────────────
  for (const period of uniquePeriods) {
    await supabase
      .from("aim2026_demand_detail")
      .delete()
      .eq("type", "sale")
      .eq("period_date", period)
      .eq("status", statusToFetch);
  }

  for (let i = 0; i < detailRows.length; i += batchSize) {
    const batch = detailRows.slice(i, i + batchSize);
    const { error } = await supabase.from("aim2026_demand_detail").insert(batch);
    if (error) console.error("Error inserting sale detail batch:", error);
  }

  const totalAgg = isCompleted ? allMap.size : 0;
  console.log(`SalesOrders [${statusToFetch}]: ${totalAgg} demand_history rows + ${detailRows.length} detail rows`);
  return detailRows.length;
}

/** Step 4: Sync Purchase Orders → Container/DHL/On Production data
 * Fetches POs from Unleashed API and maps Order Status to in-transit categories.
 * The Unleashed API uses custom statuses: Container, DHL, DHL Inbounds, Production.
 * Data is stored in aim2026_soh_snapshots with pseudo-warehouse names. */
async function syncPurchaseOrders(
  supabase: any,
  creds: UnleashedCreds
): Promise<number> {
  // Fetch all non-completed POs. Custom statuses (Container, DHL, Production)
  // are used by this business to track in-transit goods.
  // Try multiple status queries since Unleashed may not support "all"
  const statusesToFetch = ["Placed", "Container", "DHL", "Production"];
  let allOrders: any[] = [];

  for (const status of statusesToFetch) {
    try {
      const orders = await unleashedGetAll(
        "PurchaseOrders",
        `orderStatus=${status}`,
        creds,
        200,
        10
      );
      console.log(`PurchaseOrders status=${status}: ${orders.length} orders`);
      allOrders = allOrders.concat(orders);
    } catch (e) {
      console.warn(`PurchaseOrders status=${status} failed:`, e);
      // Continue with other statuses
    }
  }

  console.log(`PurchaseOrders: total ${allOrders.length} orders across all statuses`);

  // Debug: log all unique order statuses returned by the API
  const uniqueStatuses = new Set(allOrders.map((o: any) => String(o.OrderStatus ?? "").trim()));
  console.log(`PurchaseOrders unique statuses from API: ${JSON.stringify([...uniqueStatuses])}`);
  if (allOrders.length > 0) {
    const sample = allOrders[0];
    console.log(`PurchaseOrders sample keys: ${Object.keys(sample).join(", ")}`);
    const lineKey = sample.PurchaseOrderLines ? "PurchaseOrderLines" : sample.Lines ? "Lines" : "unknown";
    console.log(`PurchaseOrders line field: ${lineKey} (count: ${(sample.PurchaseOrderLines ?? sample.Lines ?? []).length})`);
  }

  const validStatuses = [
    "placed",
    "container",
    "dhl",
    "dhl inbounds",
    "dhl-inbounds",
    "production",
  ];

  const containerMap = new Map<string, number>();
  const dhlMap = new Map<string, number>();
  const onProdMap = new Map<string, number>();

  for (const order of allOrders) {
    const status = String(order.OrderStatus ?? "").trim().toLowerCase();
    if (!validStatuses.includes(status)) continue;

    const warehouse = String(
      order.Warehouse?.WarehouseName ?? order.Warehouse?.WarehouseCode ?? ""
    ).trim().toLowerCase();

    const lines = order.PurchaseOrderLines ?? [];

    for (const line of lines) {
      const sku = (line.Product?.ProductCode ?? "").trim();
      if (!sku) continue;

      const qty = Math.abs(Number(line.OrderQuantity ?? 0));
      if (qty === 0) continue;

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
  }

  console.log(
    `PO parsed: Container ${containerMap.size} SKUs, DHL ${dhlMap.size} SKUs, Production ${onProdMap.size} SKUs`
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

  if (poRows.length > 0) {
    // Delete today's PO-based snapshots only
    for (const wh of ["Container", "DHL", "On Production"]) {
      await supabase
        .from("aim2026_soh_snapshots")
        .delete()
        .eq("snapshot_date", today)
        .eq("warehouse", wh);
    }

    // Insert in batches
    const batchSize = 200;
    for (let i = 0; i < poRows.length; i += batchSize) {
      const batch = poRows.slice(i, i + batchSize);
      const { error } = await supabase
        .from("aim2026_soh_snapshots")
        .insert(batch);
      if (error) console.error(`PO SOH insert batch ${i}:`, error);
    }
  }

  return poRows.length;
}

/** Step 5: Sync Assemblies → component_usage in aim2026_demand_history + aim2026_demand_detail
 * Each Assembly.AssemblyLines contains the components consumed.
 * Aggregates component qty by SKU + month + warehouse → upserts demand_history.
 * Also inserts individual detail rows for CSV downloads.
 * Skips disassemblies (DSM prefix or AssemblyType = "Disassembly").
 * When isFirstAssemblyChunk=true, zeroes out component_usage for affected periods
 * so subsequent chunks can ADD to it without overwriting. */
async function syncAssemblies(
  supabase: any,
  creds: UnleashedCreds,
  overrideStart?: string | null,
  overrideEnd?: string | null,
  isFirstAssemblyChunk?: boolean
): Promise<number> {
  let startStr: string;
  let endStr: string | null = null;

  if (overrideStart) {
    startStr = overrideStart;
    endStr = overrideEnd ?? null;
  } else {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    d.setDate(1);
    startStr = d.toISOString().slice(0, 10);
  }

  let qs = `startDate=${startStr}&assemblyStatus=Completed`;
  if (endStr) qs += `&endDate=${endStr}`;
  const maxPages = 15;

  // CRITICAL: zero-out MUST happen BEFORE fetching/early-returns.
  // The first chunk (e.g. Feb 2025) may have no assemblies, but we still need
  // to zero existing component_usage so subsequent chunks don't double-add.
  if (isFirstAssemblyChunk) {
    const zeroStart = overrideStart ?? startStr;
    console.log(`Assemblies: zeroing component_usage from ${zeroStart} onwards (first chunk)`);
    const { error: zeroErr } = await supabase
      .from("aim2026_demand_history")
      .update({ component_usage: 0 })
      .gte("period_date", zeroStart);
    if (zeroErr) console.error(`Assemblies zero-out error: ${JSON.stringify(zeroErr)}`);

    await supabase
      .from("aim2026_demand_detail")
      .delete()
      .eq("type", "component_usage")
      .gte("period_date", zeroStart);
  }

  console.log(`Assembly sync: ${startStr} → ${endStr ?? "now"} (maxPages=${maxPages})`);

  const assemblies = await unleashedGetAll("Assemblies", qs, creds, 200, maxPages);
  console.log(`Assemblies: received ${assemblies.length} completed assemblies`);

  if (assemblies.length === 0) return 0;

  // Per-warehouse: key = "period|sku|warehouse", "All": key = "period|sku"
  const whMap = new Map<string, number>();
  const allMap = new Map<string, number>();
  const detailRows: any[] = [];
  let totalLines = 0;
  let skippedDSM = 0;

  for (const asm of assemblies) {
    const assemblyNumber = (asm.AssemblyNumber ?? "").trim();
    const assemblyType = (asm.AssemblyType ?? "").trim().toLowerCase();

    if (assemblyNumber.toUpperCase().startsWith("DSM") || assemblyType === "disassembly") {
      skippedDSM++;
      continue;
    }

    // Use CompletedDate for month bucketing
    let asmPeriod: string | null = null;
    let asmDateFull: string | null = null;
    const rawDate = asm.CompletedDate ?? asm.AssemblyDate ?? asm.CreatedOn;
    if (rawDate) {
      const dateMatch = String(rawDate).match(/\/Date\((\d+)\)\//);
      if (dateMatch) {
        const d = new Date(Number(dateMatch[1]));
        asmPeriod = d.toISOString().slice(0, 7) + "-01";
        asmDateFull = d.toISOString().slice(0, 10);
      } else {
        try {
          const d = new Date(rawDate);
          asmPeriod = d.toISOString().slice(0, 7) + "-01";
          asmDateFull = d.toISOString().slice(0, 10);
        } catch { /* skip */ }
      }
    }
    if (!asmPeriod) continue;

    const warehouse = String(asm.Warehouse?.WarehouseName ?? "").trim() || "Unknown";

    for (const line of asm.AssemblyLines ?? []) {
      const componentCode = (line.Product?.ProductCode ?? "").trim();
      if (!componentCode) continue;

      const qty = Math.abs(Number(line.Quantity ?? 0));
      if (qty === 0) continue;

      // Per-warehouse aggregate
      const whKey = `${asmPeriod}|${componentCode}|${warehouse}`;
      whMap.set(whKey, (whMap.get(whKey) ?? 0) + qty);

      // "All" aggregate
      const allKey = `${asmPeriod}|${componentCode}`;
      allMap.set(allKey, (allMap.get(allKey) ?? 0) + qty);

      detailRows.push({
        period_date: asmPeriod,
        sku: componentCode,
        type: "component_usage",
        order_date: asmDateFull,
        order_number: assemblyNumber,
        customer: `Assembly ${assemblyNumber}`,
        quantity: Math.round(qty * 100) / 100,
        amount: 0,
        status: "Completed",
        warehouse,
        product_group: "",
        customer_type: "",
      });

      totalLines++;
    }
  }

  console.log(
    `Assemblies: ${totalLines} component lines → ${allMap.size} All, ${whMap.size} per-wh ` +
    `(skipped ${skippedDSM} disassemblies)`
  );

  if (allMap.size === 0) return 0;

  const allEntries = Array.from(allMap.entries());
  const allSkus = [...new Set(allEntries.map(([k]) => k.split("|")[1]))];
  const allPeriods = [...new Set(allEntries.map(([k]) => k.split("|")[0]))];

  // Load existing rows so we can ADD component_usage (preserving quantity_sold/revenue).
  // CRITICAL: must set .limit() to avoid PostgREST's default 1000-row cap which silently
  // truncates results, causing missed rows → failed inserts → data loss.
  const existingMap = new Map<string, { id: number; quantity_sold: number; revenue: number; component_usage: number }>();
  for (let i = 0; i < allSkus.length; i += 50) {
    const skuBatch = allSkus.slice(i, i + 50);
    const { data } = await supabase
      .from("aim2026_demand_history")
      .select("id, period_date, sku, warehouse, quantity_sold, revenue, component_usage")
      .in("sku", skuBatch)
      .in("period_date", allPeriods)
      .limit(10000);

    for (const row of data ?? []) {
      existingMap.set(`${row.period_date}|${row.sku}|${row.warehouse}`, {
        id: row.id,
        quantity_sold: Number(row.quantity_sold ?? 0),
        revenue: Number(row.revenue ?? 0),
        component_usage: Number(row.component_usage ?? 0),
      });
    }
  }

  console.log(`Assemblies existingMap: ${existingMap.size} rows loaded (${allSkus.length} SKUs × ${allPeriods.length} periods)`);

  // Build update + insert lists (additive: existing component_usage + new)
  const updates: { id: number; component_usage: number }[] = [];
  const inserts: any[] = [];

  for (const [key, compQty] of allMap) {
    const [periodDate, sku] = key.split("|");
    const dbKey = `${periodDate}|${sku}|All`;
    const existing = existingMap.get(dbKey);
    const newCU = Math.round(compQty * 100) / 100;

    if (existing) {
      updates.push({
        id: existing.id,
        component_usage: existing.component_usage + newCU,
      });
    } else {
      inserts.push({
        period_date: periodDate, sku, warehouse: "All",
        quantity_sold: 0, revenue: 0, component_usage: newCU,
      });
    }
  }

  for (const [key, compQty] of whMap) {
    const parts = key.split("|");
    const existing = existingMap.get(key);
    const newCU = Math.round(compQty * 100) / 100;

    if (existing) {
      updates.push({
        id: existing.id,
        component_usage: existing.component_usage + newCU,
      });
    } else {
      inserts.push({
        period_date: parts[0], sku: parts[1], warehouse: parts[2],
        quantity_sold: 0, revenue: 0, component_usage: newCU,
      });
    }
  }

  console.log(`Assemblies: ${updates.length} additive updates, ${inserts.length} new inserts`);

  // Batch updates (add to existing component_usage)
  const batchSize = 200;
  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50);
    await Promise.all(
      chunk.map((u) =>
        supabase.from("aim2026_demand_history")
          .update({ component_usage: u.component_usage })
          .eq("id", u.id)
      )
    );
  }

  // Batch inserts for new rows — if insert fails (row exists but wasn't found by
  // existingMap query), fall back to individual additive updates.
  for (let i = 0; i < inserts.length; i += batchSize) {
    const batch = inserts.slice(i, i + batchSize);
    const { error } = await supabase.from("aim2026_demand_history").insert(batch);
    if (error) {
      console.warn(`Assemblies insert batch ${i} failed (${error.code}), falling back to individual updates`);
      for (const row of batch) {
        const { data: existing } = await supabase
          .from("aim2026_demand_history")
          .select("id, component_usage")
          .eq("period_date", row.period_date)
          .eq("sku", row.sku)
          .eq("warehouse", row.warehouse)
          .limit(1);
        if (existing?.[0]) {
          await supabase.from("aim2026_demand_history")
            .update({ component_usage: Number(existing[0].component_usage ?? 0) + row.component_usage })
            .eq("id", existing[0].id);
        } else {
          await supabase.from("aim2026_demand_history").insert(row);
        }
      }
    }
  }

  // Insert detail rows (no delete needed here — first chunk already cleared them)
  for (let i = 0; i < detailRows.length; i += batchSize) {
    const batch = detailRows.slice(i, i + batchSize);
    const { error } = await supabase.from("aim2026_demand_detail").insert(batch);
    if (error) console.error("Error inserting assembly detail batch:", error);
  }

  const totalAgg = updates.length + inserts.length;
  console.log(`Assemblies [${startStr}→${endStr ?? "now"}]: ${updates.length} updated + ${inserts.length} inserted + ${detailRows.length} detail rows`);
  return totalAgg;
}

// ─── Main Handler ──────────────────────────────────────────────────────────
// Accepts JSON body with optional `step` parameter:
//   step = "products" | "soh" | "sales" | "purchase" | "assemblies" | "all" (default)
// The frontend calls each step sequentially for reliability.

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  const startTime = Date.now();

  try {
    let step = "all";
    let assemblyStartDate: string | null = null;
    let assemblyEndDate: string | null = null;
    let salesStatus: string | null = null;
    let isFirstSalesStatus = false;
    let isFirstAssemblyChunk = false;
    try {
      const body = await req.json();
      step = body?.step ?? "all";
      assemblyStartDate = body?.assemblyStartDate ?? null;
      assemblyEndDate = body?.assemblyEndDate ?? null;
      salesStatus = body?.salesStatus ?? null;
      isFirstSalesStatus = body?.isFirstSalesStatus === true || body?.isFirstSalesStatus === "true";
      isFirstAssemblyChunk = body?.isFirstAssemblyChunk === true || body?.isFirstAssemblyChunk === "true";
    } catch {
      // No body = run all
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── Get Unleashed credentials ────────────────────────────────
    const { data: credsRow, error: credsError } = await supabase
      .from("unleashed_credentials")
      .select("api_id, api_key")
      .eq("is_active", true)
      .maybeSingle();

    if (credsError || !credsRow) {
      return jsonResponse(
        {
          success: false,
          message:
            "No Unleashed credentials found. Please save your API credentials in Settings first.",
        },
        400
      );
    }

    const creds: UnleashedCreds = {
      api_id: credsRow.api_id,
      api_key: credsRow.api_key,
    };

    // ── Run sync step(s) ─────────────────────────────────────────
    const errors: string[] = [];
    const result: SyncResult = { products: 0, soh: 0, sales: 0, purchase: 0, assemblies: 0 };

    if (step === "products" || step === "all") {
      try {
        result.products = await syncProducts(supabase, creds);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Products sync failed: ${msg}`);
        console.error("Products sync error:", e);
      }
    }

    if (step === "soh" || step === "all") {
      try {
        result.soh = await syncStockOnHand(supabase, creds);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`SOH sync failed: ${msg}`);
        console.error("SOH sync error:", e);
      }
    }

    if (step === "sales" || step === "all") {
      try {
        // When running "all" steps at once, always treat as first status (clean slate)
        const firstFlag = step === "all" ? true : isFirstSalesStatus;
        result.sales = await syncSalesOrders(supabase, creds, salesStatus, firstFlag);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Sales sync failed: ${msg}`);
        console.error("Sales sync error:", e);
      }
    }

    if (step === "purchase" || step === "all") {
      try {
        result.purchase = await syncPurchaseOrders(supabase, creds);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Purchase sync failed: ${msg}`);
        console.error("Purchase sync error:", e);
      }
    }

    if (step === "assemblies" || step === "all") {
      try {
        // When running "all" steps at once, always treat as first chunk (clean slate)
        const firstFlag = step === "all" ? true : isFirstAssemblyChunk;
        result.assemblies = await syncAssemblies(supabase, creds, assemblyStartDate, assemblyEndDate, firstFlag);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Assemblies sync failed: ${msg}`);
        console.error("Assemblies sync error:", e);
      }
    }

    // ── Log the sync ─────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    const totalSteps = step === "all" ? 5 : 1;
    const status =
      errors.length === 0
        ? "success"
        : errors.length < totalSteps
        ? "partial"
        : "failed";

    const { data: logEntry } = await supabase
      .from("aim2026_sync_log")
      .insert({
        status,
        records_synced: { ...result, step },
        errors,
        duration_ms: durationMs,
      })
      .select("id")
      .single();

    return jsonResponse({
      success: status !== "failed",
      status,
      step,
      syncId: logEntry?.id ?? null,
      recordsSynced: result,
      errors,
      durationMs,
      message:
        status === "success"
          ? `Sync step "${step}" completed in ${(durationMs / 1000).toFixed(1)}s. ` +
            `Products: ${result.products}, SOH: ${result.soh}, ` +
            `Sales: ${result.sales}, PO: ${result.purchase}, Assemblies: ${result.assemblies}.`
          : status === "partial"
          ? `Sync step "${step}" partially completed with ${errors.length} error(s).`
          : `Sync step "${step}" failed: ${errors.join("; ")}`,
    });
  } catch (error) {
    console.error("Fatal error in aim2026-sync-unleashed:", error);
    const durationMs = Date.now() - startTime;
    return jsonResponse(
      {
        success: false,
        message: `Fatal sync error: ${error instanceof Error ? error.message : "Unknown"}`,
        durationMs,
      },
      500
    );
  }
});
