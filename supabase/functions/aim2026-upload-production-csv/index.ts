// =============================================================================
// AIM 2026 — Upload Production Enquiry CSV to Storage
// Passes through content as-is (frontend sends same format as Delta)
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return jsonResponse(null, 200);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const csvContent = await req.text();
    // #region agent log
    const debugLines = csvContent.split("\n").slice(2, 5);
    console.log("[DEBUG-567404] upload received:", JSON.stringify({ totalChars: csvContent.length, first3DataLines: debugLines }));
    // #endregion
    const csvBytes = new TextEncoder().encode(csvContent);

    const { error } = await supabase.storage
      .from("aim-csv-files")
      .upload("ProductionEnquiryList.csv", csvBytes, {
        contentType: "text/csv",
        upsert: true,
      });

    if (error) {
      console.error("Upload error:", error);
      return jsonResponse({ success: false, error: error.message }, 500);
    }

    return jsonResponse({
      success: true,
      bucket: "aim-csv-files",
      file: "ProductionEnquiryList.csv",
      sizeBytes: csvBytes.length,
    });
  } catch (e) {
    console.error("Error:", e);
    return jsonResponse({
      success: false,
      error: e instanceof Error ? e.message : "Unknown error",
    }, 500);
  }
});
