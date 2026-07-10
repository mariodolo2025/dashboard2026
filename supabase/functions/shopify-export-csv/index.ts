// =============================================================================
// Shopify export CSV — rebuilds the "Total sales by product variant" CSV the
// dashboard reads, now entirely from the DB (shopify_sales_by_variant), in AUD.
//
// The whole Shopify history is synced from the API with native amounts, so this
// emits native AUD (AU = exactly what customers paid; US/other converted at the
// month's market rate) — no USD round-trip, no FX double-conversion artifact.
// parse-csv-data reads the Net sales / Taxes / Shipping columns as AUD directly.
//
//   POST { dest?: "MARIO Total sales by product variant.csv" }
// Refuses to publish if the last Shopify sync failed. Service-role only.
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const BUCKET = 'csv-files';
const HEADER = ['Product title', 'Product variant title', 'Product variant SKU', 'Month', 'Shipping country', 'Day', 'Net items sold', 'Gross sales', 'Discounts', 'Returns', 'Net sales', 'Taxes', 'Total sales', 'Shipping charges'];

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const field = (v: any) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const n2 = (v: any) => String(Math.round((Number(v) || 0) * 100) / 100);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const dest = typeof body?.dest === 'string' && body.dest.trim() ? body.dest.trim() : 'MARIO Total sales by product variant.from-db.csv';

    // Don't publish on top of a failed/partial sync — keep the last good CSV.
    if (body?.force !== true) {
      const { data: st } = await supabase.from('shopify_sales_sync_state').select('last_run_status').eq('id', 1).maybeSingle();
      if (st && st.last_run_status && st.last_run_status !== 'ok') {
        return json({ success: false, skipped: true, reason: `last sync status='${st.last_run_status}', not publishing`, dest });
      }
    }

    const lines: string[] = [HEADER.map(field).join(',')];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('shopify_sales_by_variant')
        .select('order_date, sku, product_title, variant_title, country, quantity, gross_aud, discounts_aud, returns_aud, net_aud, taxes_aud, shipping_aud')
        .order('order_date', { ascending: true })
        .order('sku', { ascending: true })
        .order('country', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`view read: ${error.message}`);
      for (const r of data ?? []) {
        const total = (Number(r.net_aud) || 0) + (Number(r.taxes_aud) || 0) + (Number(r.shipping_aud) || 0);
        lines.push([
          r.product_title ?? '', r.variant_title ?? '', r.sku,
          String(r.order_date).slice(0, 7),           // Month
          r.country,                                   // Shipping country
          String(r.order_date).slice(0, 10),           // Day
          n2(r.quantity),
          n2(r.gross_aud),
          n2(-Math.abs(Number(r.discounts_aud) || 0)), // Discounts (negative)
          n2(-Math.abs(Number(r.returns_aud) || 0)),   // Returns (negative)
          n2(r.net_aud),
          n2(r.taxes_aud),
          n2(total),
          n2(r.shipping_aud),
        ].map(field).join(','));
      }
      if (!data || data.length < pageSize) break;
    }

    const csv = lines.join('\r\n') + '\r\n';
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(dest, new Blob([csv], { type: 'text/csv' }), { upsert: true, contentType: 'text/csv' });
    if (upErr) throw new Error(`upload ${dest}: ${upErr.message}`);

    return json({ success: true, dest, rows: lines.length - 1, bytes: csv.length, currency: 'AUD' });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
