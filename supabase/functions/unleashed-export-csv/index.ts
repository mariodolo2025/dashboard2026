// =============================================================================
// Unleashed export CSV — assembles SalesEnquiryList.csv from the DB so the
// dashboard (parse-csv-data) keeps reading a plain CSV, now generated instead of
// manually uploaded.
//
//   SalesEnquiryList.frozen.csv (static, <= 2026-06-30)   ← preamble + header + history
//   + live rows (source='api', OrderDate >= 2026-07-01)   ← appended from the table
//   → dest (default a validation path; the real switch writes SalesEnquiryList.csv)
//
// Only the live rows are read from the DB (a few thousand, growing slowly), so
// this stays light — the 20MB frozen base is copied through as-is.
//
//   POST { dest?: "SalesEnquiryList.csv" }   (default: "SalesEnquiryList.from-db.csv")
// Service-role only.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const BUCKET = 'csv-files';
const FROZEN = 'SalesEnquiryList.frozen.csv';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
// CSV field: quote if it contains comma, quote or newline; double inner quotes.
function csvField(v: any): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// 'YYYY-MM-DD' → 'DD/MM/YYYY'
function toDMY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function numStr(n: any): string {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(v);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const dest = typeof body?.dest === 'string' && body.dest.trim() ? body.dest.trim() : 'SalesEnquiryList.from-db.csv';

    // Frozen base (preamble + header + history rows).
    const { data: frozenBlob, error: dlErr } = await supabase.storage.from(BUCKET).download(FROZEN);
    if (dlErr || !frozenBlob) throw new Error(`frozen base missing: ${dlErr?.message}`);
    let frozenText = await frozenBlob.text();
    if (!frozenText.endsWith('\r\n')) frozenText += '\r\n';

    // Live rows (source='api') — paginate past the 1000-row cap.
    const live: string[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('unleashed_sales_lines')
        .select('order_date, product_code, product, customer, product_group, warehouse, status, quantity, sub_total, customer_type')
        .eq('source', 'api')
        .order('order_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`live read: ${error.message}`);
      for (const r of data ?? []) {
        live.push([
          toDMY(r.order_date), r.product_code, r.product, r.customer, r.product_group,
          r.warehouse, r.status, numStr(r.quantity), numStr(r.sub_total), r.customer_type,
        ].map(csvField).join(','));
      }
      if (!data || data.length < pageSize) break;
    }

    const csv = frozenText + live.join('\r\n') + (live.length ? '\r\n' : '');
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(dest, new Blob([csv], { type: 'text/csv' }), {
      upsert: true, contentType: 'text/csv',
    });
    if (upErr) throw new Error(`upload ${dest}: ${upErr.message}`);

    return json({ success: true, dest, liveRows: live.length, bytes: csv.length });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
