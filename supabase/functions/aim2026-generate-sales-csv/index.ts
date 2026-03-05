// =============================================================================
// AIM 2026 — Fetch Sales Orders from Unleashed API  (v5)
//
// Lightweight function: fetches ONE status at a time from the API.
// The frontend orchestrates: calls once per status, collects all deltas,
// merges with existing CSV, uploads, and downloads for verification.
//
// Body params:
//   latestDate  — DD/MM/YYYY or YYYY-MM-DD: latest date found in existing CSV
//   status      — order status to fetch (Completed | Placed | Backordered | Parked)
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_VERSION = "v5-2026-02-23";
const BUFFER_DAYS = 3;

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

async function unleashedGet(ep: string, qs: string, c: Creds) {
  const url = `${UNLEASHED_BASE}/${ep}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-auth-id": c.api_id,
      "api-auth-signature": await hmacSign(c.api_key, qs),
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Unleashed ${ep}: ${res.status}`);
  return res.json();
}

async function unleashedGetAll(
  ep: string, extra: string, c: Creds, pageSize = 200, maxPages = 50
): Promise<any[]> {
  let page = 1, all: any[] = [], more = true;
  while (more && page <= maxPages) {
    const qs = `${extra ? extra + "&" : ""}pageSize=${pageSize}`;
    const data = await unleashedGet(`${ep}/${page}`, qs, c);
    const items = data.Items ?? [];
    all = all.concat(items);
    const pages = data.Pagination?.NumberOfPages ?? 1;
    console.log(`${ep} p${page}/${pages}: ${items.length} items`);
    more = page < pages;
    page++;
  }
  return all;
}

// ─── Date helpers ──────────────────────────────────────────────────────────

function parseMsDate(v: any): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (m) return new Date(parseInt(m[1], 10));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateAU(d: Date | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    timeZone: "Australia/Sydney",
  }).format(d);
}

function esc(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n"))
    return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function fmtCur(n: number): string {
  return n === 0 ? "0.00" : n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── Main ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return jsonResponse(null, 200);
  console.log(`=== aim2026-generate-sales-csv ${FUNCTION_VERSION} ===`);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    let body: any = {};
    try { body = await req.json(); } catch { /* defaults */ }

    const latestDateStr: string | null = body.latestDate ?? null;
    const statusToFetch: string = body.status ?? "Completed";

    // ─── 1. Credentials ─────────────────────────────────────────────
    const { data: cr, error: crErr } = await supabase
      .from("unleashed_credentials").select("api_id, api_key").single();
    if (crErr || !cr?.api_id) throw new Error("Unleashed credentials not found.");
    const creds: Creds = { api_id: cr.api_id, api_key: cr.api_key };

    // ─── 2. Compute cutoff ──────────────────────────────────────────
    let cutoffDate: Date;
    if (latestDateStr) {
      let d: Date | null = null;
      if (latestDateStr.includes("/")) {
        const p = latestDateStr.split("/");
        d = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00Z`);
      } else {
        d = new Date(latestDateStr + "T00:00:00Z");
      }
      cutoffDate = d && !isNaN(d.getTime())
        ? new Date(d.getTime() - BUFFER_DAYS * 86_400_000)
        : new Date("2025-07-01T00:00:00Z");
    } else {
      cutoffDate = new Date("2025-07-01T00:00:00Z");
    }
    const cutoffISO = cutoffDate.toISOString().slice(0, 10);
    console.log(`Status: ${statusToFetch}, Cutoff: ${cutoffISO}`);

    // ─── 3. Fetch ───────────────────────────────────────────────────
    const qs = `startDate=${cutoffISO}&orderStatus=${statusToFetch}`;
    const orders = await unleashedGetAll("SalesOrders", qs, creds, 200, 10);

    const csvLines: string[] = [];
    for (const o of orders) {
      const od = parseMsDate(o.OrderDate);
      if (!od) continue;
      const odAU = formatDateAU(od);
      const wh = (o.Warehouse?.WarehouseName ?? "").trim() || "Unknown";
      const cust = (o.Customer?.CustomerName ?? "").trim();
      const ct = (o.CustomerType ?? "").trim();
      const st = (o.OrderStatus ?? statusToFetch).trim();

      for (const ln of o.SalesOrderLines ?? []) {
        const qty = Number(ln.OrderQuantity ?? 0);
        const sub = Number(ln.LineTotal ?? qty * Number(ln.UnitPrice ?? 0));
        csvLines.push([
          odAU,
          esc((ln.Product?.ProductCode ?? "").trim()),
          esc((ln.Product?.ProductDescription ?? "").trim()),
          esc(cust),
          esc((ln.Product?.ProductGroup?.GroupName ?? "").trim()),
          esc(wh),
          esc(st),
          String(Math.abs(qty)),
          fmtCur(Math.round(Math.abs(sub) * 100) / 100),
          esc(ct),
        ].join(","));
      }
    }

    console.log(`${statusToFetch}: ${orders.length} orders → ${csvLines.length} CSV lines`);

    // ─── 4. Return CSV lines ────────────────────────────────────────
    return jsonResponse({
      success: true,
      version: FUNCTION_VERSION,
      status: statusToFetch,
      cutoffDate: cutoffISO,
      cutoffDateAU: formatDateAU(cutoffDate),
      ordersCount: orders.length,
      linesCount: csvLines.length,
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
