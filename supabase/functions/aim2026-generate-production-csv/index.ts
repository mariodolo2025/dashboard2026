// =============================================================================
// AIM 2026 — Fetch Production Enquiry (Assemblies) from Unleashed API
//
// Fetches Assemblies for Main Warehouse and China-W only.
// Returns CSV lines in ProductionEnquiryList format.
// Fetches one assemblyStatus at a time (Completed, Parked) to avoid timeout.
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_VERSION = "v1-2026-02-23";

const WAREHOUSE_NAMES = ["Main Warehouse", "China-W"];
const ASSEMBLY_STATUSES = ["Completed", "Parked"];
const DEFAULT_START = "2025-01-01";
const DEFAULT_END = "2026-06-30";

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
  ep: string, extra: string, c: Creds, pageSize = 200, maxPages = 150
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

function parseMsDate(v: any): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (m) return new Date(parseInt(m[1], 10));
  try {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
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

function fmtNum(n: number): string {
  return String(Math.round(n));
}

function fmtCur(n: number): string {
  return n === 0 ? "0.00" : Number(n).toFixed(2);
}

// ─── Main ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return jsonResponse(null, 200);
  console.log(`=== aim2026-generate-production-csv ${FUNCTION_VERSION} ===`);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    let body: any = {};
    try { body = await req.json(); } catch { /* defaults */ }

    const statusToFetch: string = body.status ?? "Completed";
    const startDate: string = body.startDate ?? DEFAULT_START;
    const endDate: string = body.endDate ?? DEFAULT_END;

    const { data: cr, error: crErr } = await supabase
      .from("unleashed_credentials").select("api_id, api_key").single();
    if (crErr || !cr?.api_id) throw new Error("Unleashed credentials not found.");
    const creds: Creds = { api_id: cr.api_id, api_key: cr.api_key };

    const qs = `startDate=${startDate}&endDate=${endDate}&assemblyStatus=${statusToFetch}`;
    const assemblies = await unleashedGetAll("Assemblies", qs, creds, 200, 50);

    const csvLines: string[] = [];

    for (const asm of assemblies) {
      const assemblyNumber = (asm.AssemblyNumber ?? "").trim();
      const assemblyType = (asm.AssemblyType ?? "").trim().toLowerCase();
      if (assemblyNumber.toUpperCase().startsWith("DSM") || assemblyType === "disassembly") continue;

      const wh = asm.Warehouse ?? asm.DestinationWarehouse ?? asm.SourceWarehouse;
      const warehouseName = (wh?.WarehouseName ?? "").trim() || "Unknown";
      if (!WAREHOUSE_NAMES.includes(warehouseName)) continue;

      const assemblyStatus = (asm.AssemblyStatus ?? statusToFetch).trim();

      const rawAsmDate = asm.AssemblyDate ?? asm.CompletedDate ?? asm.CreatedOn;
      const rawAssembleBy = asm.AssembleBy ?? rawAsmDate;
      const asmDate = parseMsDate(rawAsmDate);
      const assembleBy = parseMsDate(rawAssembleBy);
      const asmDateAU = formatDateAU(asmDate);
      const assembleByAU = formatDateAU(assembleBy);

      const asmProductCode = (asm.Product?.ProductCode ?? "").trim();
      for (const line of asm.AssemblyLines ?? []) {
        const productCode = (line.Product?.ProductCode ?? "").trim();
        const productDesc = (line.Product?.ProductDescription ?? "").trim();
        const productGroup = (line.Product?.ProductGroup?.GroupName ?? "").trim();
        const rawQty = Number(line.Quantity ?? 0);
        const rawCost = Number(line.TotalCost ?? 0);
        // Componentes: negativos. Output (producto ensamblado): positivos (formato Unleashed)
        const isOutput = productCode && productCode === asmProductCode;
        const qty = isOutput ? Math.abs(rawQty) : -Math.abs(rawQty);
        const totalCost = isOutput ? Math.abs(rawCost) : -Math.abs(rawCost);

        csvLines.push([
          esc(assemblyNumber),
          asmDateAU,
          assembleByAU,
          esc(productCode),
          esc(productDesc),
          esc(productGroup),
          esc(warehouseName),
          fmtNum(qty),
          fmtCur(totalCost),
          esc(assemblyStatus),
        ].join(","));
      }
    }

    console.log(`Assemblies ${statusToFetch}: ${assemblies.length} → ${csvLines.length} lines`);

    return jsonResponse({
      success: true,
      version: FUNCTION_VERSION,
      status: statusToFetch,
      assembliesCount: assemblies.length,
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
