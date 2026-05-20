// =============================================================================
// AIM 2026 — Generate Purchase Enquiry CSV from Unleashed API  (v4)
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_VERSION = "v4-2026-02-23";

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

// ─── Unleashed API ─────────────────────────────────────────────────────────

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
  creds: UnleashedCreds,
  attempt = 1
): Promise<any> {
  const url = `${UNLEASHED_BASE}/${endpoint}${queryString ? "?" + queryString : ""}`;
  try {
    const signature = await hmacSign(creds.api_key, queryString);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "api-auth-id": creds.api_id,
        "api-auth-signature": signature,
      },
      // Smaller per-request budget: a slow page is retried, not fatal.
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 || res.status >= 500)
      throw new Error(`Unleashed ${endpoint}: ${res.status} ${res.statusText}`);
    if (!res.ok) {
      throw new Error(`Unleashed ${endpoint}: ${res.status} ${res.statusText}`);
    }
    return res.json();
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return unleashedGet(endpoint, queryString, creds, attempt + 1);
    }
    throw e;
  }
}

// Paginate with bounded parallelism: fetch page 1 to learn the page count,
// then fetch the rest in concurrent batches. Cuts wall-clock vs. sequential
// page-by-page, which is what trips the per-request timeout under load.
async function unleashedGetAll(
  endpoint: string,
  extraParams: string,
  creds: UnleashedCreds,
  pageSize = 200,
  maxPages = 50,
  concurrency = 4
): Promise<any[]> {
  const qs = `${extraParams ? extraParams + "&" : ""}pageSize=${pageSize}`;
  const first = await unleashedGet(`${endpoint}/1`, qs, creds);
  let allItems: any[] = first.Items ?? [];
  const totalPages = Math.min(first.Pagination?.NumberOfPages ?? 1, maxPages);
  console.log(`${endpoint}: ${totalPages} page(s), ${allItems.length} on p1`);

  for (let start = 2; start <= totalPages; start += concurrency) {
    const batch: Promise<any>[] = [];
    for (let p = start; p < start + concurrency && p <= totalPages; p++) {
      batch.push(unleashedGet(`${endpoint}/${p}`, qs, creds));
    }
    const results = await Promise.all(batch);
    for (const r of results) allItems = allItems.concat(r.Items ?? []);
  }

  return allItems;
}

// ─── Date Helpers ──────────────────────────────────────────────────────────

function parseMsDate(dateValue: any): Date | null {
  if (!dateValue) return null;
  const dateStr = String(dateValue).trim();

  // Microsoft JSON date: /Date(1234567890000+1100)/ or /Date(1234567890000)/
  const msMatch = dateStr.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (msMatch) {
    return new Date(parseInt(msMatch[1], 10));
  }

  // ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return new Date(dateStr);
  }

  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

// Cache Intl formatters at module scope. Building a new Intl.DateTimeFormat
// (and toLocaleString-with-options below) per CSV row is a major CPU sink
// that trips the edge runtime's CPU limit (WORKER_RESOURCE_LIMIT) on large
// datasets. Create once, reuse for every row.
const DATE_FMT_AU = new Intl.DateTimeFormat("en-AU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

// Format a Date in Australian timezone as DD/MM/YYYY
function formatDateAU(date: Date | null): string {
  if (!date) return "";
  // en-AU gives "DD/MM/YYYY" natively
  return DATE_FMT_AU.format(date);
}

// ─── CSV Helpers ───────────────────────────────────────────────────────────

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const NUM_FMT_AU = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const CUR_FMT_AU = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatNumber(n: number): string {
  if (n === 0) return "0";
  return NUM_FMT_AU.format(n);
}

function formatCurrency(n: number): string {
  if (n === 0) return "0.00";
  return CUR_FMT_AU.format(n);
}

// ─── Allowed Custom Statuses ───────────────────────────────────────────────

const ALLOWED_CUSTOM_STATUSES = new Set([
  "placed",
  "container",
  "dhl-inbounds",
  "dhl inbounds",
  "dhl",
  "production",
]);

function isAllowedStatus(order: any): boolean {
  const custom = (order.CustomOrderStatus ?? "").trim().toLowerCase();
  const standard = (order.OrderStatus ?? "").trim().toLowerCase();

  // If the order has a custom status, it must be in our allowed list
  if (custom) {
    return ALLOWED_CUSTOM_STATUSES.has(custom);
  }
  // If no custom status, allow standard "placed"
  return standard === "placed";
}

// ─── Main Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  console.log(`=== aim2026-generate-purchase-csv ${FUNCTION_VERSION} ===`);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // No body — use defaults
    }

    const dateFrom = body.dateFrom ?? "2025-01-01";
    const dateTo = body.dateTo ?? "2026-06-30";
    const uploadToBucket = body.uploadToBucket !== false;

    // ─── 1. Load Unleashed credentials ──────────────────────────────
    const { data: credsRow, error: credsError } = await supabase
      .from("unleashed_credentials")
      .select("api_id, api_key")
      .single();

    if (credsError || !credsRow?.api_id || !credsRow?.api_key) {
      throw new Error("Unleashed credentials not found.");
    }

    const creds: UnleashedCreds = {
      api_id: credsRow.api_id,
      api_key: credsRow.api_key,
    };

    // ─── 2. Fetch Products for ProductGroup lookup ──────────────────
    console.log("Fetching Products for ProductGroup mapping...");
    const products = await unleashedGetAll("Products", "", creds, 200, 50);
    const productGroupMap = new Map<string, string>();
    for (const p of products) {
      const code = (p.ProductCode ?? "").trim();
      if (code) {
        productGroupMap.set(code, p.ProductGroup?.GroupName ?? "");
      }
    }
    console.log(`Products: ${productGroupMap.size} product groups mapped`);

    // ─── 3. Fetch Purchase Orders ───────────────────────────────────
    // Fetch by standard status + custom status queries.
    // Then post-filter to only keep allowed statuses.
    const queries = [
      "orderStatus=Placed",
      "orderStatus=Container",
      "orderStatus=DHL",
      "orderStatus=Production",
      `customOrderStatus=${encodeURIComponent("CONTAINER")}`,
      `customOrderStatus=${encodeURIComponent("DHL-INBOUNDS")}`,
      `customOrderStatus=${encodeURIComponent("PRODUCTION")}`,
    ];

    let allOrders: any[] = [];
    const seenOrderGuids = new Set<string>();

    for (const qs of queries) {
      try {
        // Smaller pages: PO records carry nested lines, so a 200-row page is
        // a huge payload that can blow the per-request timeout. 50/page keeps
        // each request fast; parallel pagination keeps total wall-clock low.
        const orders = await unleashedGetAll("PurchaseOrders", qs, creds, 50, 40);
        let added = 0;
        for (const o of orders) {
          const guid = o.Guid ?? o.OrderNumber;
          if (!seenOrderGuids.has(guid)) {
            seenOrderGuids.add(guid);
            allOrders.push(o);
            added++;
          }
        }
        console.log(`PO ${qs}: ${orders.length} fetched, ${added} new`);
      } catch (e) {
        console.warn(`PO ${qs} failed:`, e);
      }
    }

    console.log(`Total unique orders before filtering: ${allOrders.length}`);

    // Post-filter: only keep orders with allowed custom statuses
    const beforeFilter = allOrders.length;
    allOrders = allOrders.filter(isAllowedStatus);
    console.log(`After status filter: ${allOrders.length} (removed ${beforeFilter - allOrders.length})`);

    // ─── Debug: log sample order structure ──────────────────────────
    const debugInfo: any = { version: FUNCTION_VERSION };
    if (allOrders.length > 0) {
      const s = allOrders[0];
      const sKeys = Object.keys(s);
      console.log("Sample order keys:", sKeys.join(", "));
      console.log("Sample OrderDate raw:", JSON.stringify(s.OrderDate));
      console.log("Sample RequiredDate raw:", JSON.stringify(s.RequiredDate));
      console.log("Sample OrderStatus:", s.OrderStatus);
      console.log("Sample CustomOrderStatus:", s.CustomOrderStatus);

      // Check ALL date-like fields on the order
      const dateFields: Record<string, any> = {};
      for (const k of sKeys) {
        const v = s[k];
        if (typeof v === "string" && (v.includes("/Date(") || /^\d{4}-\d{2}/.test(v))) {
          dateFields[k] = v;
        }
      }
      console.log("Sample date fields:", JSON.stringify(dateFields));

      // Check line-level fields
      if (s.PurchaseOrderLines?.[0]) {
        const lineKeys = Object.keys(s.PurchaseOrderLines[0]);
        console.log("Sample line keys:", lineKeys.join(", "));
        const lineDateFields: Record<string, any> = {};
        for (const k of lineKeys) {
          const v = s.PurchaseOrderLines[0][k];
          if (typeof v === "string" && (v.includes("/Date(") || /^\d{4}-\d{2}/.test(v))) {
            lineDateFields[k] = v;
          }
        }
        console.log("Sample line date fields:", JSON.stringify(lineDateFields));
      }

      debugInfo.sampleOrderDate = s.OrderDate;
      debugInfo.sampleRequiredDate = s.RequiredDate;
      debugInfo.sampleOrderStatus = s.OrderStatus;
      debugInfo.sampleCustomOrderStatus = s.CustomOrderStatus;
      debugInfo.sampleDateFields = dateFields;
      debugInfo.sampleOrderKeys = sKeys;
    }

    // ─── 4. Build CSV rows ──────────────────────────────────────────
    const dateFromMs = new Date(dateFrom).getTime();
    const dateToMs = new Date(dateTo + "T23:59:59Z").getTime();

    const validWarehouses = ["china-w", "main warehouse"];

    interface CSVRow {
      orderNo: string;
      orderDate: string;
      deliveryDate: string;
      receiptDate: string;
      warehouse: string;
      supplier: string;
      productCode: string;
      productDescription: string;
      productGroup: string;
      salesOrderNumber: string;
      orderStatus: string;
      baseUnitQty: number;
      landedCost: number;
    }

    const csvRows: CSVRow[] = [];

    for (const order of allOrders) {
      const orderDate = parseMsDate(order.OrderDate);
      if (!orderDate) continue;

      // Date filter (generous — we compare in UTC)
      if (orderDate.getTime() < dateFromMs || orderDate.getTime() > dateToMs) continue;

      const warehouseName = (
        order.Warehouse?.WarehouseName ?? order.Warehouse?.WarehouseCode ?? ""
      ).trim();

      if (warehouseName && !validWarehouses.includes(warehouseName.toLowerCase())) {
        continue;
      }

      // Try multiple possible date fields for delivery/receipt
      const deliveryDate = parseMsDate(
        order.RequiredDate ?? order.DeliveryDate ?? order.EstimatedDeliveryDate
      );
      const receiptDate = parseMsDate(
        order.ReceivedDate ?? order.ReceiptDate ?? order.CompletedDate
      );

      const supplierName = order.Supplier?.SupplierName ?? "";
      const displayStatus = (
        order.CustomOrderStatus || order.OrderStatus || ""
      ).trim().toUpperCase();

      const lines = order.PurchaseOrderLines ?? [];

      for (const line of lines) {
        const productCode = (line.Product?.ProductCode ?? "").trim();
        if (!productCode) continue;

        // Line-level delivery date can override order-level
        const lineDeliveryDate = parseMsDate(
          line.DueDate ?? line.DeliveryDate ?? line.RequiredDate
        );

        csvRows.push({
          orderNo: order.OrderNumber ?? "",
          orderDate: formatDateAU(orderDate),
          deliveryDate: formatDateAU(lineDeliveryDate ?? deliveryDate),
          receiptDate: formatDateAU(receiptDate),
          warehouse: warehouseName,
          supplier: supplierName,
          productCode,
          productDescription: line.Product?.ProductDescription ?? "",
          productGroup: productGroupMap.get(productCode) ?? "",
          salesOrderNumber: line.SalesOrderNumber ?? order.SalesOrderNumber ?? "",
          orderStatus: displayStatus,
          baseUnitQty: Math.abs(Number(line.OrderQuantity ?? 0)),
          landedCost: Math.abs(Number(line.LineTotal ?? 0)),
        });
      }
    }

    // Sort by Order No descending
    csvRows.sort((a, b) => b.orderNo.localeCompare(a.orderNo));

    console.log(`CSV rows generated: ${csvRows.length}`);

    // ─── 5. Build CSV string ────────────────────────────────────────
    const today = new Date();
    const generatedAt = today.toISOString();
    const buildId = `${FUNCTION_VERSION} @ ${generatedAt}`;
    const headerLine = `Purchase Enquiry as of ${formatDateAU(today)},,,,,${escapeCSV(buildId)},,,,,,,,`;

    const columnHeaders = [
      "Order No.", "Order Date", "Delivery Date", "Receipt Date",
      "Warehouse", "Supplier", "Product Code", "Product Description",
      "Product Group", "Sales Order Number", "Order Status",
      "Base Unit Qty", "Landed Cost (AUD)",
    ].join(",");

    const dataLines = csvRows.map((row) =>
      [
        escapeCSV(row.orderNo), row.orderDate, row.deliveryDate, row.receiptDate,
        escapeCSV(row.warehouse), escapeCSV(row.supplier),
        escapeCSV(row.productCode), escapeCSV(row.productDescription),
        escapeCSV(row.productGroup), escapeCSV(row.salesOrderNumber),
        escapeCSV(row.orderStatus),
        escapeCSV(formatNumber(row.baseUnitQty)),
        escapeCSV(formatCurrency(row.landedCost)),
      ].join(",")
    );

    const totalQty = csvRows.reduce((s, r) => s + r.baseUnitQty, 0);
    const totalCost = csvRows.reduce((s, r) => s + r.landedCost, 0);
    const totalsLine = `,,,,,,,,,,,"${formatNumber(totalQty)}","${formatCurrency(totalCost)}"`;

    const csvContent = [headerLine, columnHeaders, ...dataLines, totalsLine, ""].join("\n");

    // ─── 6. Upload to Supabase Storage ──────────────────────────────
    let uploadResult = null;
    if (uploadToBucket) {
      const bucketName = "aim-csv-files";
      const fileName = "PurchaseEnquiryList.csv";
      const csvBytes = new TextEncoder().encode(csvContent);

      const { error: uploadError } = await supabase.storage
        .from(bucketName)
        .upload(fileName, csvBytes, { contentType: "text/csv", upsert: true });

      if (uploadError) {
        console.error(`Upload to ${bucketName}/${fileName} failed:`, uploadError);
        const { error: fallbackError } = await supabase.storage
          .from("csv-files")
          .upload(fileName, csvBytes, { contentType: "text/csv", upsert: true });

        uploadResult = fallbackError
          ? { success: false, error: uploadError.message }
          : { success: true, bucket: "csv-files", file: fileName };
      } else {
        uploadResult = { success: true, bucket: bucketName, file: fileName };
      }
    }

    // ─── 7. Response (include CSV as base64 for direct download) ────
    const csvBase64 = btoa(
      new Uint8Array(new TextEncoder().encode(csvContent))
        .reduce((s, b) => s + String.fromCharCode(b), "")
    );

    return jsonResponse({
      success: true,
      version: FUNCTION_VERSION,
      generatedAt,
      totalOrders: allOrders.length,
      totalRows: csvRows.length,
      totalQty,
      totalCost: Math.round(totalCost * 100) / 100,
      csvSizeBytes: csvContent.length,
      csvBase64,
      upload: uploadResult,
      debug: debugInfo,
      sampleRows: csvRows.slice(0, 3).map((r) => ({
        orderNo: r.orderNo,
        orderDate: r.orderDate,
        deliveryDate: r.deliveryDate,
        productCode: r.productCode,
        orderStatus: r.orderStatus,
        qty: r.baseUnitQty,
        cost: r.landedCost,
      })),
    });
  } catch (error) {
    console.error("Error generating purchase CSV:", error);
    return jsonResponse(
      {
        success: false,
        version: FUNCTION_VERSION,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});
