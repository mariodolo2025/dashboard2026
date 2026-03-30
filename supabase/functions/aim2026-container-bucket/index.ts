/**
 * Lists the `container` Storage bucket using the service role (bypasses RLS) and
 * returns signed read URLs so the browser can download CSV/PDF without Storage SELECT on anon.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "container";
const SIGNED_URL_SECS = 3600;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** AIM export CSV — matches `AIM_2026_Export…`, `…Export_filtered…`, etc. */
function isAimCsvExport(pathOrName: string): boolean {
  const n = basename(pathOrName).toLowerCase();
  if (!n.endsWith(".csv")) return false;
  if (n.startsWith("aim_2026_export")) return true;
  if (n.includes("aim") && n.includes("export")) return true;
  return /^aim[_\s-]*2026/i.test(n);
}

/** Any Unleashed-style PO PDF (filename contains PO-…). */
function isPoPdf(pathOrName: string): boolean {
  const n = basename(pathOrName);
  if (!/\.pdf$/i.test(n)) return false;
  return /PO-\d/.test(n);
}

async function listAllFiles(
  supabase: SupabaseClient,
  prefix = "",
): Promise<string[]> {
  const out: string[] = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const batch = data ?? [];
    if (batch.length === 0) break;
    for (const item of batch) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      const looksLikeFile = /\.(pdf|csv)$/i.test(item.name);
      const isFolder = item.metadata === null && !looksLikeFile;
      if (isFolder) {
        out.push(...await listAllFiles(supabase, path));
      } else {
        out.push(path);
      }
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const allPaths = await listAllFiles(supabase, "");
    if (allPaths.length === 0) {
      return jsonResponse({
        success: false,
        message:
          'No files in bucket "container". Upload AIM CSV + PO PDFs, or check the bucket name.',
      });
    }

    const csvPaths = allPaths.filter(isAimCsvExport).sort((a, b) =>
      basename(a).localeCompare(basename(b))
    );
    const poPaths = allPaths.filter(isPoPdf);

    if (csvPaths.length === 0) {
      return jsonResponse({
        success: false,
        message:
          'No AIM CSV export found. Upload a .csv whose name includes both "aim" and "export" (e.g. AIM_2026_Export_filtered_….csv).',
      });
    }

    const csvPath = csvPaths[0];
    const { data: csvSigned, error: csvErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(csvPath, SIGNED_URL_SECS);
    if (csvErr || !csvSigned?.signedUrl) {
      return jsonResponse({
        success: false,
        message: `Signed URL for CSV failed: ${csvErr?.message ?? "unknown"}`,
      });
    }

    const pdfs: { path: string; signedUrl: string }[] = [];
    for (const p of poPaths) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(p, SIGNED_URL_SECS);
      if (!error && data?.signedUrl) {
        pdfs.push({ path: p, signedUrl: data.signedUrl });
      }
    }

    return jsonResponse({
      success: true,
      csvPath,
      csvSignedUrl: csvSigned.signedUrl,
      pdfs,
    });
  } catch (e) {
    console.error("aim2026-container-bucket:", e);
    return jsonResponse({
      success: false,
      message: e instanceof Error ? e.message : String(e),
    });
  }
});
