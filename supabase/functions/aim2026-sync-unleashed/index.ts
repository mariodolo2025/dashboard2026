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
import { parse as parseCsv } from "https://deno.land/std@0.224.0/csv/parse.ts";

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
  let totalPages = 1;

  while (hasMore && page <= maxPages) {
    const pageEndpoint = `${endpoint}/${page}`;
    const qs = `${extraParams ? extraParams + "&" : ""}pageSize=${pageSize}`;
    const data = await unleashedGet(pageEndpoint, qs, creds);
    const items = data.Items ?? [];
    allItems = allItems.concat(items);

    const pageCount = Number(data.Pagination?.NumberOfPages ?? 0);
    if (!pageCount) {
      // No pagination metadata. A short page means we genuinely reached the end;
      // a full page means there may be more and we cannot tell — never guess,
      // because the caller deletes data before refilling from this array.
      if (items.length >= pageSize) {
        throw new Error(
          `Unleashed ${endpoint}: page ${page} returned ${items.length} items with no Pagination ` +
            `metadata — cannot tell whether more pages exist. Aborting so no data is deleted.`
        );
      }
      console.log(`${endpoint} page ${page}: ${items.length} items (no pagination metadata, treating as last page)`);
      hasMore = false;
    } else {
      totalPages = Math.max(totalPages, pageCount);
      console.log(`${endpoint} page ${page}/${pageCount}: ${items.length} items`);
      hasMore = page < pageCount;
    }
    page++;
  }

  // Never hand back a truncated page set as if it were complete. Callers wipe
  // whole periods before refilling them from this array, so a silent short read
  // deletes real data and replaces it with nothing. Fail loudly instead.
  if (totalPages > maxPages) {
    throw new Error(
      `Unleashed ${endpoint}: TRUNCATED fetch — API reports ${totalPages} pages, maxPages=${maxPages} ` +
        `(only ${allItems.length} items retrieved). Raise maxPages or narrow the date range. ` +
        `Aborting so no data is deleted.`
    );
  }

  return allItems;
}

// ─── Period helpers ────────────────────────────────────────────────────────
// aim2026_demand_history / _detail store period_date as a MONTH START. Any
// window used to clear data must therefore be expressed in whole months, or the
// clear and the refill cover different row sets and the totals stop adding up.

/** Parse a strict YYYY-MM-DD date, rejecting malformed and non-existent dates
 * (JS silently rolls "2026-02-31" over to March). */
function parseIsoDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD, got "${value}"`);
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real date: "${value}"`);
  }
  return d;
}

/** First day of the month containing `iso` (YYYY-MM-DD). */
function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** First day of the month AFTER the one containing `iso` — an exclusive bound. */
function nextMonthStartOf(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
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

  // Filter out products without a valid SKU and deduplicate.
  //
  // Two payloads, deliberately. PostgREST builds ONE statement per batch using
  // the UNION of the keys present across the array, and any row missing a key
  // is sent as NULL for it — so a batch where some rows carry
  // product_cost_china and others omit it does not leave the others alone: it
  // WIPES them. On 2026-08-03 that erased the cost of 753 SKUs, took landed
  // cost to zero across the board, and dropped reported inventory value from
  // AUD 1.13M to 529K. The old code omitting the key for SKUs that already had
  // a cost is exactly what selected them for deletion.
  //
  // rows      -> metadata only, identical keys for every SKU, safe to upsert.
  // costRows  -> cost only, and only for SKUs that have none. Written
  //              separately so a cost from costs.csv can never be in a payload
  //              that might null it.
  const seenSkus = new Set<string>();
  const rows: any[] = [];
  const costRows: any[] = [];

  for (const p of products) {
    const sku = (p.ProductCode ?? "").trim();
    if (!sku || seenSkus.has(sku)) continue;
    seenSkus.add(sku);

    const existing = existingMap.get(sku);
    rows.push({
      sku,
      product_description: p.ProductDescription ?? "",
      product_group: p.ProductGroup?.GroupName ?? "Other",
      supplier: p.Supplier?.SupplierName ?? "Unknown",
      updated_at: new Date().toISOString(),
    });

    // Seed a cost only where there is none. Never overwrite costs.csv.
    if (!existing || existing.cost === 0) {
      const seed = Number(p.LastCost ?? p.DefaultPurchasePrice ?? 0);
      if (seed > 0) costRows.push({ sku, product_cost_china: seed });
    }

    // NOTE: lead_time_days is NOT set here. The Products list endpoint does not
    // include per-supplier lead times. Lead times are loaded from ProductList.csv
    // via Settings → "Load Lead Times from CSV". This avoids overwriting CSV values.
  }

  console.log(`Products: ${rows.length} unique valid SKUs, ${costRows.length} needing a seed cost`);
  if (rows.length === 0) return 0;

  // Costs first, as targeted UPDATEs. An update touches only the column named,
  // so nothing else on the row can be disturbed, and a SKU that already has a
  // cost is never in this list at all.
  for (const c of costRows) {
    const { error } = await supabase
      .from("aim2026_sku_parameters")
      .update({ product_cost_china: c.product_cost_china })
      .eq("sku", c.sku)
      .or("product_cost_china.is.null,product_cost_china.eq.0");
    if (error) console.error(`Error seeding cost for ${c.sku}:`, error.message);
  }

  // Upsert in batches — ignoreDuplicates: false so it updates existing rows.
  // Every row here carries exactly the same keys, so the UNION-of-keys
  // behaviour above cannot null anything.
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

/** Step 3: Sync Sales Orders → aim2026_demand_detail (+ derived demand_history)
 *
 * Incremental by watermark, never by window wipe. This mirrors the pattern that
 * already works in `unleashed-sales-sync`:
 *   1. read the watermark (how far the last run read Unleashed's LastModifiedOn)
 *   2. ask Unleashed only for orders modified since then
 *   3. replace each fetched ORDER's lines as a unit, keyed by its Unleashed Guid
 *   4. recompute aim2026_demand_history for the touched months from the detail rows
 *   5. advance the watermark
 *
 * What this deliberately does NOT do: delete a date window before fetching. The
 * previous design zeroed and deleted 3 months up front, then refilled from a fetch
 * that silently truncated at 6,000 orders — which destroyed 34,317 units of 2026
 * demand, three times a day. Here a short or failed read simply means some orders
 * were not refreshed; nothing is removed that is not immediately rewritten.
 *
 * One fetch covers every status. The old code ran four passes (Completed, Placed,
 * Backordered, Parked) filtered server-side, which also meant an order moving from
 * Placed to Completed left its stale Placed row behind unless both passes ran.
 * Here the order's current OrderStatus is stored and its old lines are replaced.
 *
 * Backfill mode (salesStartDate/salesEndDate, whole months) re-reads a closed date
 * range by order date. It is idempotent and does not move the watermark. */
async function syncSalesOrders(
  supabase: any,
  creds: UnleashedCreds,
  salesStartDate?: string | null,
  salesEndDate?: string | null
): Promise<number> {
  const runStart = new Date();

  const { data: state } = await supabase
    .from("aim2026_sales_sync_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  // ── Window ────────────────────────────────────────────────────────────────
  let mode: "backfill" | "incremental" | "bootstrap";
  let qsWindow: string;
  let periodFrom: string | null = null;      // inclusive month start
  let periodToExclusive: string | null = null; // exclusive month start

  if (salesStartDate) {
    const from = parseIsoDate(salesStartDate, "salesStartDate");
    const to = salesEndDate ? parseIsoDate(salesEndDate, "salesEndDate") : from;
    if (to < from) {
      throw new Error(`salesEndDate (${salesEndDate}) is before salesStartDate (${salesStartDate})`);
    }
    // The fetch window is taken literally, so a heavy month can be split into
    // several smaller calls that each fit the worker's compute budget. That is
    // safe here in a way it never was before: orders are replaced one by one by
    // Guid, and demand_history is recomputed from EVERY detail row in the months
    // involved — not from this batch alone. A partial range therefore yields a
    // correct aggregate for whatever has been loaded so far.
    const fetchFrom = salesStartDate;
    const fetchTo = to.toISOString().slice(0, 10);
    periodFrom = monthStartOf(fetchFrom);
    periodToExclusive = nextMonthStartOf(fetchTo);
    mode = "backfill";
    qsWindow = `startDate=${fetchFrom}&endDate=${fetchTo}`;
    console.log(`Sales backfill: fetching ${fetchFrom}→${fetchTo}, rebuilding periods ${periodFrom}→before ${periodToExclusive}`);
  } else if (state?.last_modified_watermark) {
    const since = new Date(state.last_modified_watermark);
    since.setUTCDate(since.getUTCDate() - 1); // 1-day overlap, same as unleashed-sales-sync
    mode = "incremental";
    qsWindow = `modifiedSince=${since.toISOString().slice(0, 10)}`;
    console.log(`Sales incremental: modifiedSince=${since.toISOString().slice(0, 10)}`);
  } else {
    // No watermark yet. Read a short recent window rather than the whole history:
    // upserts are never destructive, so history is filled in by explicit backfills
    // while the scheduled run stays small and green.
    const since = new Date(runStart);
    since.setUTCDate(since.getUTCDate() - 7);
    mode = "bootstrap";
    qsWindow = `modifiedSince=${since.toISOString().slice(0, 10)}`;
    console.log(`Sales bootstrap (no watermark): modifiedSince=${since.toISOString().slice(0, 10)}`);
  }

  // ── Customer type lookup ──────────────────────────────────────────────────
  // CustomerType lives on the Customer record, NOT on the order — reading
  // order.CustomerType is why aim2026_demand_detail.customer_type has been blank
  // since 2026-04, and why the dashboard reports Shopify sales as B2B.
  const typeByCustomer = new Map<string, string>();
  const customers = await unleashedGetAll("Customers", "", creds, 200, 150);
  for (const c of customers) {
    const t = typeof c.CustomerType === "string" ? c.CustomerType : (c.CustomerType?.CustomerType ?? "");
    if (c.CustomerName) typeByCustomer.set(String(c.CustomerName), t);
    if (c.CustomerCode) typeByCustomer.set(String(c.CustomerCode), t);
  }
  console.log(`Sales: ${typeByCustomer.size} customer keys for channel lookup`);

  // ── Fetch ─────────────────────────────────────────────────────────────────
  // No orderStatus filter: one pass returns every status, and each order carries
  // its current one. unleashedGetAll throws rather than truncating.
  const orders = await unleashedGetAll("SalesOrders", `${qsWindow}`, creds, 200, 150);
  console.log(`Sales [${mode}]: received ${orders.length} orders`);

  // ── Build rows, grouped by order ──────────────────────────────────────────
  const byOrder = new Map<string, any[]>();
  const orderNumbers = new Set<string>();
  const touchedPeriods = new Set<string>();
  let maxModified: Date | null = state?.last_modified_watermark
    ? new Date(state.last_modified_watermark)
    : null;
  let skippedNoGuid = 0;

  for (const order of orders) {
    const guid = order.Guid ? String(order.Guid) : null;
    if (!guid) { skippedNoGuid++; continue; }

    const orderDateFull = parseUnleashedDate(order.OrderDate);
    if (!orderDateFull) continue;
    const periodDate = `${orderDateFull.slice(0, 7)}-01`;

    // A backfill must not write outside its own range: those months were not
    // scheduled for a rebuild, and Unleashed's date filters are applied server
    // side where we cannot audit them.
    if (periodFrom && periodDate < periodFrom) continue;
    if (periodToExclusive && periodDate >= periodToExclusive) continue;

    const lm = parseUnleashedDate(order.LastModifiedOn);
    if (lm) {
      const lmDate = new Date(`${lm}T00:00:00Z`);
      if (!maxModified || lmDate > maxModified) maxModified = lmDate;
    }

    const warehouse = String(order.Warehouse?.WarehouseName ?? "").trim() || "Unknown";
    const customerName = String(order.Customer?.CustomerName ?? "").trim();
    const customerCode = String(order.Customer?.CustomerCode ?? "").trim();
    const orderNumber = String(order.OrderNumber ?? "").trim();
    const status = String(order.OrderStatus ?? "").trim() || "Unknown";
    const customerType =
      typeByCustomer.get(customerName) ?? typeByCustomer.get(customerCode) ?? "";

    if (orderNumber) orderNumbers.add(orderNumber);
    touchedPeriods.add(periodDate);

    const rows: any[] = [];
    for (const line of order.SalesOrderLines ?? []) {
      const sku = String(line.Product?.ProductCode ?? "").trim();
      if (!sku) continue; // freight / rounding / fee lines carry no product code

      const qty = Number(line.OrderQuantity ?? 0);
      const revenue = qty * Number(line.UnitPrice ?? 0);

      rows.push({
        period_date: periodDate,
        sku,
        type: "sale",
        order_date: orderDateFull,
        order_number: orderNumber || null,
        customer: customerName,
        quantity: Math.round(Math.abs(qty) * 100) / 100,
        amount: Math.round(Math.abs(revenue) * 100) / 100,
        status,
        warehouse,
        product_group: String(line.Product?.ProductGroup?.GroupName ?? "").trim(),
        customer_type: customerType,
        line_guid: line.Guid ? String(line.Guid) : null,
        order_guid: guid,
      });
    }
    byOrder.set(guid, rows);
  }

  if (skippedNoGuid > 0) console.warn(`Sales: ${skippedNoGuid} orders had no Guid and were skipped`);

  const orderGuids = [...byOrder.keys()];
  const detailRows = [...byOrder.values()].flat();
  console.log(
    `Sales [${mode}]: ${orderGuids.length} orders → ${detailRows.length} lines, ${touchedPeriods.size} periods`
  );

  if (orderGuids.length === 0) {
    await writeSalesSyncState(supabase, { mode, runStart, maxModified, orders: 0, lines: 0, advanceWatermark: mode !== "backfill" });
    return 0;
  }

  // ── Replace each order's lines ────────────────────────────────────────────
  // Scoped to the orders we just read, so nothing outside this set can be lost.
  // The legacy pass also clears pre-migration rows (no guid) for the same order
  // numbers, so the table converges as orders are re-synced instead of doubling.
  const legacyPeriods = await collectLegacyPeriods(supabase, [...orderNumbers]);
  for (const p of legacyPeriods) touchedPeriods.add(p);

  for (let i = 0; i < orderGuids.length; i += 100) {
    const batch = orderGuids.slice(i, i + 100);
    const { error } = await supabase
      .from("aim2026_demand_detail")
      .delete()
      .eq("type", "sale")
      .in("order_guid", batch);
    if (error) throw new Error(`demand_detail delete by order_guid failed: ${JSON.stringify(error)}`);
  }

  const orderNumberList = [...orderNumbers];
  for (let i = 0; i < orderNumberList.length; i += 100) {
    const batch = orderNumberList.slice(i, i + 100);
    const { error } = await supabase
      .from("aim2026_demand_detail")
      .delete()
      .eq("type", "sale")
      .is("order_guid", null)
      .in("order_number", batch);
    if (error) throw new Error(`demand_detail legacy delete failed: ${JSON.stringify(error)}`);
  }

  for (let i = 0; i < detailRows.length; i += 200) {
    const batch = detailRows.slice(i, i + 200);
    const { error } = await supabase.from("aim2026_demand_detail").insert(batch);
    if (error) {
      throw new Error(
        `demand_detail insert failed at batch ${i}/${detailRows.length}: ${JSON.stringify(error)}`
      );
    }
  }

  // ── Rebuild the aggregate ─────────────────────────────────────────────────
  // demand_history is derived, never accumulated, so this is safe to repeat.
  const periods = [...touchedPeriods].sort();
  const { error: rebuildErr } = await supabase.rpc("aim2026_rebuild_demand_history", {
    p_periods: periods,
  });
  if (rebuildErr) {
    throw new Error(`aim2026_rebuild_demand_history failed for ${periods.join(",")}: ${JSON.stringify(rebuildErr)}`);
  }
  console.log(`Sales: demand_history rebuilt for ${periods.join(", ")}`);

  await writeSalesSyncState(supabase, {
    mode,
    runStart,
    maxModified,
    orders: orderGuids.length,
    lines: detailRows.length,
    advanceWatermark: mode !== "backfill",
  });

  return detailRows.length;
}

/** Unleashed serves dates as "/Date(1750000000000)/" or plain ISO. Returns YYYY-MM-DD. */
function parseUnleashedDate(value: unknown): string | null {
  if (!value) return null;
  const raw = String(value);
  const epoch = raw.match(/\/Date\((\d+)\)\//);
  const d = epoch ? new Date(Number(epoch[1])) : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Periods held by pre-migration rows for these order numbers. They are about to
 * be deleted, so their months need rebuilding even if no new row lands there. */
async function collectLegacyPeriods(supabase: any, orderNumbers: string[]): Promise<string[]> {
  const periods = new Set<string>();
  for (let i = 0; i < orderNumbers.length; i += 100) {
    const batch = orderNumbers.slice(i, i + 100);
    const { data, error } = await supabase
      .from("aim2026_demand_detail")
      .select("period_date")
      .eq("type", "sale")
      .is("order_guid", null)
      .in("order_number", batch);
    if (error) throw new Error(`legacy period lookup failed: ${JSON.stringify(error)}`);
    for (const r of data ?? []) periods.add(String(r.period_date).slice(0, 10));
  }
  return [...periods];
}

async function writeSalesSyncState(
  supabase: any,
  opts: {
    mode: string;
    runStart: Date;
    maxModified: Date | null;
    orders: number;
    lines: number;
    advanceWatermark: boolean;
  }
): Promise<void> {
  const row: any = {
    id: 1,
    last_run_at: opts.runStart.toISOString(),
    last_mode: opts.mode,
    orders_seen: opts.orders,
    lines_upserted: opts.lines,
    updated_at: new Date().toISOString(),
  };
  // A backfill reads a closed historical range; letting it move the watermark
  // would skip everything modified since.
  if (opts.advanceWatermark) {
    row.last_modified_watermark = (opts.maxModified ?? opts.runStart).toISOString();
  }
  const { error } = await supabase.from("aim2026_sales_sync_state").upsert(row, { onConflict: "id" });
  if (error) throw new Error(`sales sync state write failed: ${JSON.stringify(error)}`);
}

/** Step 4: Sync Purchase Orders → Container/DHL/On Production data
 * Fetches POs from Unleashed API and maps Order Status to in-transit categories.
 * The Unleashed API uses custom statuses: Container, DHL, DHL Inbounds, Production.
 * Data is stored in aim2026_soh_snapshots with pseudo-warehouse names. */
async function syncPurchaseOrders(
  supabase: any,
  creds: UnleashedCreds
): Promise<number> {
  // Fetch all non-completed POs. In Unleashed, OrderStatus and
  // CustomOrderStatus are orthogonal: every in-transit PO keeps
  // OrderStatus=Placed while the operational stage (CONTAINER,
  // DHL-INBOUNDS, PRODUCTION, CUSTOM-PROYECTS) lives in
  // CustomOrderStatus. The API's orderStatus filter only accepts fixed
  // statuses — querying orderStatus=Container/DHL/Production returns 0
  // rows — so fetching Placed covers the whole in-transit pipeline.
  const statusesToFetch = ["Placed"];
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
    // Effective operational status: the custom status when set (CONTAINER,
    // DHL-INBOUNDS, PRODUCTION, ...), else the fixed OrderStatus. Same
    // criterion as the PurchaseEnquiryList CSV loader, whose Order Status
    // column carries the custom status.
    const status = String(order.CustomOrderStatus ?? order.OrderStatus ?? "").trim().toLowerCase();
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
    // Delete today's PO-based snapshots only — and only for warehouses this
    // sync actually produced data for. Never wipe a pseudo-warehouse whose
    // map came back empty: that would replace CSV-loaded rows with nothing.
    const mapsByWarehouse: Record<string, Map<string, number>> = {
      "Container": containerMap,
      "DHL": dhlMap,
      "On Production": onProdMap,
    };
    for (const wh of ["Container", "DHL", "On Production"]) {
      if (mapsByWarehouse[wh].size === 0) continue;
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
  // Was 15 (= 3,000 assemblies), which the live data shows this window already
  // exceeds: April and May 2026 component_usage are empty and the June+July rows
  // land on exactly 3,000. Now that unleashedGetAll refuses to truncate, this cap
  // has to clear the real page count or every scheduled run would fail.
  const maxPages = 150;

  console.log(`Assembly sync: ${startStr} → ${endStr ?? "now"} (maxPages=${maxPages})`);

  // Fetch FIRST. If this throws, the orchestrator's try/catch skips this chunk
  // and we never touch the DB — so a failed month preserves its existing data.
  const assemblies = await unleashedGetAll("Assemblies", qs, creds, 200, maxPages);
  console.log(`Assemblies: received ${assemblies.length} completed assemblies`);

  // Non-destructive per-month replace: now that the fetch succeeded, wipe ONLY
  // this chunk's month range and rewrite it below. Other months are never
  // touched, so a single failed/incomplete month can't wipe historical data.
  // (Replaces the old global zero-out gated on isFirstAssemblyChunk, which left
  // a month permanently zeroed if its chunk failed after the global wipe.)
  const monthStart = overrideStart ?? startStr;
  const monthEnd = endStr; // exclusive: first day of next month
  console.log(`Assemblies: clearing component_usage for ${monthStart} → ${monthEnd ?? "now"} (scoped per-month)`);
  {
    let zeroQuery = supabase
      .from("aim2026_demand_history")
      .update({ component_usage: 0 })
      .gte("period_date", monthStart);
    if (monthEnd) zeroQuery = zeroQuery.lt("period_date", monthEnd);
    const { error: zeroErr } = await zeroQuery;
    if (zeroErr) console.error(`Assemblies zero-out error: ${JSON.stringify(zeroErr)}`);

    let delQuery = supabase
      .from("aim2026_demand_detail")
      .delete()
      .eq("type", "component_usage")
      .gte("period_date", monthStart);
    if (monthEnd) delQuery = delQuery.lt("period_date", monthEnd);
    await delQuery;
  }

  if (assemblies.length === 0) return 0;

  // Per-warehouse: key = "period|sku|warehouse", "All": key = "period|sku"
  const whMap = new Map<string, number>();
  const allMap = new Map<string, number>();
  const detailRows: any[] = [];
  const assembledProductSKUs = new Set<string>();
  let totalLines = 0;
  let skippedDSM = 0;

  for (const asm of assemblies) {
    const assemblyNumber = (asm.AssemblyNumber ?? "").trim();
    const assemblyType = (asm.AssemblyType ?? "").trim().toLowerCase();

    if (assemblyNumber.toUpperCase().startsWith("DSM") || assemblyType === "disassembly") {
      skippedDSM++;
      continue;
    }

    const assembledSku = (asm.Product?.ProductCode ?? "").trim();
    if (assembledSku) assembledProductSKUs.add(assembledSku);

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

    const wh = asm.Warehouse ?? asm.DestinationWarehouse ?? asm.SourceWarehouse;
    const warehouse = String(wh?.WarehouseName ?? "").trim() || "Unknown";

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

  // Persist assembled product SKUs for dashboard filter (exclude-by-default)
  if (assembledProductSKUs.size > 0) {
    const { error: delErr } = await supabase.from("aim2026_assembled_products").delete().gte("sku", "");
    if (delErr) console.error("aim2026_assembled_products delete error:", delErr);
    const insertRows = Array.from(assembledProductSKUs).map((sku) => ({ sku }));
    const { error: insErr } = await supabase.from("aim2026_assembled_products").insert(insertRows);
    if (insErr) console.error("aim2026_assembled_products insert error:", insErr);
    else console.log(`Assembled products: ${assembledProductSKUs.size} SKUs saved`);
  }

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

  // Build full upsert rows. This month's component_usage was already zeroed
  // above, so the value to write is exactly the freshly aggregated qty (no
  // additive read needed). We carry quantity_sold/revenue from existing rows
  // so the upsert — which replaces the whole row — preserves them.
  const upsertRows: any[] = [];

  for (const [key, compQty] of allMap) {
    const [periodDate, sku] = key.split("|");
    const existing = existingMap.get(`${periodDate}|${sku}|All`);
    upsertRows.push({
      period_date: periodDate, sku, warehouse: "All",
      quantity_sold: existing?.quantity_sold ?? 0,
      revenue: existing?.revenue ?? 0,
      component_usage: Math.round(compQty * 100) / 100,
    });
  }

  for (const [key, compQty] of whMap) {
    const parts = key.split("|");
    const existing = existingMap.get(key);
    upsertRows.push({
      period_date: parts[0], sku: parts[1], warehouse: parts[2],
      quantity_sold: existing?.quantity_sold ?? 0,
      revenue: existing?.revenue ?? 0,
      component_usage: Math.round(compQty * 100) / 100,
    });
  }

  console.log(`Assemblies: upserting ${upsertRows.length} demand_history rows (batched)`);

  // Batched upsert by the (period_date, sku, warehouse) unique constraint:
  // ONE request per ~500 rows instead of one UPDATE per row. The old per-row
  // update loop issued thousands of HTTP calls and blew the edge function
  // CPU/time limit on heavy months (the "not enough resources" failure).
  const batchSize = 500;
  for (let i = 0; i < upsertRows.length; i += batchSize) {
    const batch = upsertRows.slice(i, i + batchSize);
    const { error } = await supabase
      .from("aim2026_demand_history")
      .upsert(batch, { onConflict: "period_date,sku,warehouse" });
    if (error) console.error(`Assemblies upsert batch ${i} error: ${JSON.stringify(error)}`);
  }

  // Insert detail rows (this month's component_usage detail was cleared above)
  for (let i = 0; i < detailRows.length; i += batchSize) {
    const batch = detailRows.slice(i, i + batchSize);
    const { error } = await supabase.from("aim2026_demand_detail").insert(batch);
    if (error) console.error("Error inserting assembly detail batch:", error);
  }

  console.log(`Assemblies [${startStr}→${endStr ?? "now"}]: ${upsertRows.length} upserted + ${detailRows.length} detail rows`);
  return upsertRows.length;
}

/** Step 6: Supplement assembly component_usage from ProductionEnquiryList.csv.
 * Runs AFTER all API assembly chunks. Fills in component_usage for warehouses
 * that the Unleashed API didn't cover (e.g., China-W assemblies only in CSV).
 * Only writes where DB currently has component_usage = 0. */
async function supplementAssemblyCSV(supabase: any): Promise<number> {
  const rangeStart = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    d.setDate(1);
    return d.toISOString().slice(0, 7) + "-01";
  })();

  let csvBlob: Blob | null = null;
  for (const bucket of ["aim-csv-files", "csv-files"]) {
    const { data, error } = await supabase.storage.from(bucket).download("ProductionEnquiryList.csv");
    if (!error && data) { csvBlob = data; break; }
  }
  if (!csvBlob) {
    console.log("supplement_assembly_csv: ProductionEnquiryList.csv not found");
    return 0;
  }

  const text = await csvBlob.text();
  const rawData: string[][] = parseCsv(text, { skipFirstRow: false, lazyQuotes: true });

  // Simple header finder for production CSV
  const PROD_KEYWORDS: Record<string, string[]> = {
    "Product Code": ["product code", "productcode", "sku"],
    "Quantity": ["quantity", "qty"],
    "Assembly Number": ["assembly number", "assembly no"],
    "Assembly Date": ["assembly date"],
    "Warehouse": ["warehouse", "location"],
    "Assembly Status": ["assembly status"],
  };
  let headerIdx = 0;
  const hMap: Record<string, number> = {};
  for (let i = 0; i < Math.min(10, rawData.length); i++) {
    const vals = rawData[i].map(v => String(v || "").toLowerCase().trim());
    if (vals.some(v => v.includes("enquiry") || v.includes("report"))) continue;
    let matched = 0;
    for (const [key, kws] of Object.entries(PROD_KEYWORDS)) {
      for (let c = 0; c < vals.length; c++) {
        if (kws.some(kw => vals[c].includes(kw))) { hMap[key] = c; matched++; break; }
      }
    }
    if (matched >= 3) { headerIdx = i; break; }
  }

  const { data: asmSkuRows } = await supabase.from("aim2026_assembled_products").select("sku");
  const assembledSKUs = new Set((asmSkuRows ?? []).map((r: any) => r.sku));

  // Aggregate component_usage by (period, sku, warehouse) and (period, sku) for All
  const whAgg = new Map<string, number>();
  const allAgg = new Map<string, number>();
  const detailRows: any[] = [];
  let parsed = 0;

  const dataRows = rawData.slice(headerIdx + 1);
  const toNum = (v: any): number => {
    if (!v) return 0;
    let s = String(v).replace(/,/g, "").trim();
    if (/^\s*\(.*\)\s*$/.test(s)) s = "-" + s.replace(/[()]/g, "");
    s = s.replace(/[^0-9.-]/g, "");
    return parseFloat(s) || 0;
  };
  const parseDate = (v: any): Date | null => {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/^([0-3]?\d)[\/.-]([0-1]?\d)[\/.-](\d{2,4})$/);
    if (m) {
      let y = parseInt(m[3], 10); if (y < 100) y += 2000;
      const dt = new Date(Date.UTC(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10)));
      return isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  };

  for (const row of dataRows) {
    const sku = String(row[hMap["Product Code"]] ?? "").trim();
    if (!sku) continue;

    const asmNum = String(row[hMap["Assembly Number"]] ?? "").trim();
    const rawQty = toNum(row[hMap["Quantity"]]);
    if (!asmNum || asmNum.toUpperCase().startsWith("DSM") || rawQty >= 0) continue;

    if (hMap["Assembly Status"] !== undefined) {
      const st = String(row[hMap["Assembly Status"]] ?? "").trim().toLowerCase();
      if (st && st !== "completed") continue;
    }

    if (assembledSKUs.has(sku)) continue;

    const qty = Math.abs(rawQty);
    let orderDate: Date | null = null;
    if (hMap["Assembly Date"] !== undefined) orderDate = parseDate(row[hMap["Assembly Date"]]);
    if (!orderDate) continue;

    const periodDate = orderDate.toISOString().slice(0, 7) + "-01";
    if (periodDate < rangeStart) continue;

    const warehouse = hMap["Warehouse"] !== undefined
      ? String(row[hMap["Warehouse"]] ?? "").trim() || "Unknown"
      : "Unknown";

    whAgg.set(`${periodDate}|${sku}|${warehouse}`, (whAgg.get(`${periodDate}|${sku}|${warehouse}`) ?? 0) + qty);
    allAgg.set(`${periodDate}|${sku}`, (allAgg.get(`${periodDate}|${sku}`) ?? 0) + qty);

    detailRows.push({
      period_date: periodDate, sku, type: "component_usage",
      order_date: orderDate.toISOString().slice(0, 10),
      order_number: asmNum, customer: `Assembly ${asmNum}`,
      quantity: Math.round(qty * 100) / 100, amount: 0,
      status: "Completed", warehouse, product_group: "", customer_type: "",
    });
    parsed++;
  }

  console.log(`supplement_assembly_csv: parsed ${parsed} CSV rows → ${whAgg.size} per-wh, ${allAgg.size} All aggregates`);
  if (whAgg.size === 0) return 0;

  // Load existing DB rows to check which ones still have component_usage = 0
  const uniqueSkus = [...new Set([...whAgg.keys()].map(k => k.split("|")[1]))];
  const uniquePeriods = [...new Set([...whAgg.keys()].map(k => k.split("|")[0]))];

  const existingMap = new Map<string, { id: number; component_usage: number }>();
  for (let i = 0; i < uniqueSkus.length; i += 50) {
    const batch = uniqueSkus.slice(i, i + 50);
    const { data } = await supabase
      .from("aim2026_demand_history")
      .select("id, period_date, sku, warehouse, component_usage")
      .in("sku", batch)
      .in("period_date", uniquePeriods)
      .limit(10000);
    for (const r of data ?? []) {
      existingMap.set(`${r.period_date}|${r.sku}|${r.warehouse}`, {
        id: r.id,
        component_usage: Number(r.component_usage ?? 0),
      });
    }
  }

  const updates: { id: number; component_usage: number }[] = [];
  const inserts: any[] = [];
  let skippedApi = 0;

  // Per-warehouse: only fill where DB has 0
  for (const [key, compQty] of whAgg) {
    const [periodDate, sku, warehouse] = key.split("|");
    const rounded = Math.round(compQty * 100) / 100;
    const existing = existingMap.get(key);

    if (existing) {
      if (existing.component_usage > 0) { skippedApi++; continue; }
      updates.push({ id: existing.id, component_usage: rounded });
    } else {
      inserts.push({
        period_date: periodDate, sku, warehouse,
        quantity_sold: 0, revenue: 0, component_usage: rounded,
      });
    }
  }

  // "All" aggregate: ADD CSV values for warehouses that were supplemented
  // (the API may have partially populated "All" — we add the missing portion)
  const supplementedSkuPeriods = new Set<string>();
  for (const [key] of whAgg) {
    const parts = key.split("|");
    const dbKey = key;
    const existing = existingMap.get(dbKey);
    if (!existing || existing.component_usage === 0) {
      supplementedSkuPeriods.add(`${parts[0]}|${parts[1]}`);
    }
  }
  for (const skuPeriod of supplementedSkuPeriods) {
    const csvAllQty = allAgg.get(skuPeriod);
    if (!csvAllQty) continue;
    const [periodDate, sku] = skuPeriod.split("|");
    const allKey = `${periodDate}|${sku}|All`;
    const existing = existingMap.get(allKey);
    const rounded = Math.round(csvAllQty * 100) / 100;

    if (existing) {
      updates.push({ id: existing.id, component_usage: existing.component_usage + rounded });
    } else {
      inserts.push({
        period_date: periodDate, sku, warehouse: "All",
        quantity_sold: 0, revenue: 0, component_usage: rounded,
      });
    }
  }

  console.log(`supplement_assembly_csv: ${updates.length} updates, ${inserts.length} inserts (skipped ${skippedApi} API-populated rows)`);

  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50);
    await Promise.all(chunk.map(u =>
      supabase.from("aim2026_demand_history")
        .update({ component_usage: u.component_usage })
        .eq("id", u.id)
    ));
  }

  for (let i = 0; i < inserts.length; i += 200) {
    const batch = inserts.slice(i, i + 200);
    const { error } = await supabase.from("aim2026_demand_history").insert(batch);
    if (error) {
      for (const row of batch) {
        const { data: ex } = await supabase.from("aim2026_demand_history")
          .select("id, component_usage")
          .eq("period_date", row.period_date).eq("sku", row.sku).eq("warehouse", row.warehouse)
          .limit(1);
        if (ex?.[0]) {
          if (Number(ex[0].component_usage ?? 0) === 0) {
            await supabase.from("aim2026_demand_history")
              .update({ component_usage: row.component_usage })
              .eq("id", ex[0].id);
          }
        } else {
          await supabase.from("aim2026_demand_history").insert(row);
        }
      }
    }
  }

  // Insert detail rows (only for supplemented warehouses)
  const supplementedWarehouses = new Set<string>();
  for (const [key] of whAgg) {
    const parts = key.split("|");
    const existing = existingMap.get(key);
    if (!existing || existing.component_usage === 0) {
      supplementedWarehouses.add(parts[2]);
    }
  }

  if (supplementedWarehouses.size > 0) {
    const filteredDetails = detailRows.filter(d => supplementedWarehouses.has(d.warehouse));
    for (let i = 0; i < filteredDetails.length; i += 200) {
      const batch = filteredDetails.slice(i, i + 200);
      const { error } = await supabase.from("aim2026_demand_detail").insert(batch);
      if (error) console.error("supplement detail insert error:", error);
    }
    console.log(`supplement_assembly_csv: inserted ${filteredDetails.length} detail rows for warehouses: ${[...supplementedWarehouses].join(', ')}`);
  }

  return updates.length + inserts.length;
}

// ─── Main Handler ──────────────────────────────────────────────────────────
// Accepts JSON body with optional `step` parameter:
//   step = "products" | "soh" | "sales" | "purchase" | "assemblies" | "supplement_assembly_csv" | "all" (default)
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
    let salesStartDate: string | null = null;
    let salesEndDate: string | null = null;
    let isFirstSalesStatus = false;
    let isFirstAssemblyChunk = false;
    try {
      const body = await req.json();
      step = body?.step ?? "all";
      assemblyStartDate = body?.assemblyStartDate ?? null;
      assemblyEndDate = body?.assemblyEndDate ?? null;
      salesStatus = body?.salesStatus ?? null;
      // Optional explicit window for backfills (YYYY-MM-DD). Omitted = normal
      // rolling window, so the scheduled sync is unaffected.
      salesStartDate = body?.salesStartDate ?? null;
      salesEndDate = body?.salesEndDate ?? null;
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
        // salesStatus / isFirstSalesStatus are accepted but ignored: one fetch now
        // covers every status and demand_history is derived, so there is no
        // "first pass" that has to clear anything. Old callers keep working.
        if (salesStatus || isFirstSalesStatus) {
          console.log(`sales: ignoring legacy params (salesStatus=${salesStatus}, isFirstSalesStatus=${isFirstSalesStatus})`);
        }
        result.sales = await syncSalesOrders(supabase, creds, salesStartDate, salesEndDate);
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

    if (step === "supplement_assembly_csv" || step === "all") {
      try {
        const supplemented = await supplementAssemblyCSV(supabase);
        if (supplemented > 0) {
          console.log(`CSV supplement: ${supplemented} rows filled from ProductionEnquiryList.csv`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Assembly CSV supplement failed: ${msg}`);
        console.error("Assembly CSV supplement error:", e);
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
