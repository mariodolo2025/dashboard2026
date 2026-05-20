// =============================================================================
// AIM 2026 — Fetch Stock On Hand from Unleashed API
//
// Fetches StockOnHand for Main Warehouse and China-W only.
// Returns CSV lines in SOHList format for frontend merge/upload.
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_VERSION = "v1-2026-02-23";

const WAREHOUSES = [
  { code: "MAIN", name: "Main Warehouse" },
  { code: "China", name: "China-W" },
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function hmacSign(apiKey: string, qs: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(qs));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

interface Creds { api_id: string; api_key: string; }

async function unleashedGet(ep: string, qs: string, c: Creds, attempt = 1): Promise<any> {
  const url = `${UNLEASHED_BASE}/${ep}${qs ? "?" + qs : ""}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "api-auth-id": c.api_id,
        "api-auth-signature": await hmacSign(c.api_key, qs),
      },
      // Smaller per-request budget: a slow page is retried, not fatal.
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 || res.status >= 500)
      throw new Error(`Unleashed ${ep}: ${res.status}`);
    if (!res.ok) throw new Error(`Unleashed ${ep}: ${res.status}`);
    return res.json();
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 400 * attempt));
      return unleashedGet(ep, qs, c, attempt + 1);
    }
    throw e;
  }
}

// Paginate with bounded parallelism: fetch page 1 to learn the page count,
// then fetch the rest in concurrent batches. Cuts wall-clock vs. sequential.
async function unleashedGetAll(
  ep: string, extra: string, c: Creds, pageSize = 200, maxPages = 50, concurrency = 4
): Promise<any[]> {
  const qs = `${extra ? extra + "&" : ""}pageSize=${pageSize}`;
  const first = await unleashedGet(`${ep}/1`, qs, c);
  let all: any[] = first.Items ?? [];
  const totalPages = Math.min(first.Pagination?.NumberOfPages ?? 1, maxPages);
  console.log(`${ep}: ${totalPages} page(s), ${all.length} on p1`);

  for (let start = 2; start <= totalPages; start += concurrency) {
    const batch: Promise<any>[] = [];
    for (let p = start; p < start + concurrency && p <= totalPages; p++) {
      batch.push(unleashedGet(`${ep}/${p}`, qs, c));
    }
    const results = await Promise.all(batch);
    for (const r of results) all = all.concat(r.Items ?? []);
  }
  return all;
}

function esc(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n"))
    return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// Cache Intl formatters at module scope. Re-creating them per row (via
// toLocaleString with options) is a major CPU sink that trips the edge
// runtime's CPU limit (WORKER_RESOURCE_LIMIT) on large datasets.
const NUM_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const CUR_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmtNum(n: number): string {
  if (n === 0) return "0";
  const s = NUM_FMT.format(Math.round(n));
  return s.includes(",") ? esc(s) : s;
}

function fmtCur(n: number): string {
  if (n === 0) return "0.00";
  const s = CUR_FMT.format(Number(n));
  return s.includes(",") ? esc(s) : s;
}

// ─── Main ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return jsonResponse(null, 200);
  console.log(`=== aim2026-generate-soh-csv ${FUNCTION_VERSION} ===`);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: cr, error: crErr } = await supabase
      .from("unleashed_credentials").select("api_id, api_key").single();
    if (crErr || !cr?.api_id) throw new Error("Unleashed credentials not found.");
    const creds: Creds = { api_id: cr.api_id, api_key: cr.api_key };

    const csvLines: string[] = [];
    let totalItems = 0;

    for (const wh of WAREHOUSES) {
      try {
        const items = await unleashedGetAll(
          "StockOnHand", `warehouseCode=${wh.code}`, creds, 200, 50
        );
        totalItems += items.length;

        for (const item of items) {
          const productCode = (item.ProductCode ?? "").trim();
          const productDesc = (item.ProductDescription ?? "").trim();
          const saleDays = item.DaysSinceLastSale != null ? String(item.DaysSinceLastSale) : "";
          const onPurchase = Number(item.OnPurchase ?? 0);
          const qtyOnHand = Number(item.QtyOnHand ?? 0);
          const allocated = Number(item.AllocatedQty ?? 0);
          const available = Number(item.AvailableQty ?? qtyOnHand - allocated);
          const avgCost = Number(item.AvgCost ?? 0);
          const totalCost = Number(item.TotalCost ?? 0);
          const productGroup = (item.ProductGroupName ?? "").trim();

          csvLines.push([
            esc(productCode),
            esc(productDesc),
            esc(wh.name),
            saleDays,
            fmtNum(onPurchase),
            fmtNum(qtyOnHand),
            fmtNum(allocated),
            fmtNum(available),
            fmtCur(avgCost),
            fmtCur(totalCost),
            esc(productGroup),
          ].join(","));
        }
        console.log(`StockOnHand ${wh.code}: ${items.length} rows`);
      } catch (e) {
        console.error(`StockOnHand ${wh.code} failed:`, e);
      }
    }

    console.log(`Total: ${csvLines.length} CSV lines`);

    return jsonResponse({
      success: true,
      version: FUNCTION_VERSION,
      totalRows: csvLines.length,
      csvLines,
    });
  } catch (error) {
    console.error("Error:", error);
    return jsonResponse({
      success: false,
      version: FUNCTION_VERSION,
      error: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});
