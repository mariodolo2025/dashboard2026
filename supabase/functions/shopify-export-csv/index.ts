// =============================================================================
// Shopify export CSV — rebuilds the "Total sales by product variant" CSV from the
// DB so parse-csv-data keeps reading a plain CSV, now generated instead of
// manually uploaded (mirrors unleashed-export-csv).
//
//   shopify.frozen.csv (static, <= 2026-06-30)     ← header + history
//   + live rows (source='api', order_date >= 2026-07-01) from shopify_sales_lines
//   → dest (default a validation path; the real switch writes the dashboard's file)
//
// Columns (Shopify's report order): Product title, Product variant title, SKU,
// Month, Shipping country, Day, Net items sold, Gross sales, Discounts, Returns,
// Net sales, Taxes, Total sales, Shipping charges. Discounts/Returns are negative.
//
//   POST { dest?: "MARIO Total sales by product variant.csv" }
// Service-role only.
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { parse } from 'https://deno.land/std@0.224.0/csv/parse.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const BUCKET = 'csv-files';
const FROZEN = 'shopify.frozen.csv';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const field = (v: any) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const n2 = (v: any) => { const x = Number(v) || 0; return String(Math.round(x * 100) / 100); };

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

    // Frozen base (header + history).
    const { data: frozenBlob, error: dlErr } = await supabase.storage.from(BUCKET).download(FROZEN);
    if (dlErr || !frozenBlob) throw new Error(`frozen base missing: ${dlErr?.message}`);
    let frozenText = await frozenBlob.text();
    if (!frozenText.endsWith('\r\n')) frozenText += '\r\n';

    // Live rows (source='api'), paginated.
    const live: string[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('shopify_sales_by_variant')
        .select('order_date, sku, product_title, variant_title, country, quantity, gross_usd, discounts_usd, returns_usd, net_usd, taxes_usd, shipping_usd')
        .order('order_date', { ascending: true })
        .order('sku', { ascending: true })
        .order('country', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`live read: ${error.message}`);
      for (const r of data ?? []) {
        const total = (Number(r.net_usd) || 0) + (Number(r.taxes_usd) || 0) + (Number(r.shipping_usd) || 0);
        live.push([
          r.product_title ?? '', r.variant_title ?? '', r.sku,
          String(r.order_date).slice(0, 7),          // Month
          r.country,                                  // Shipping country
          String(r.order_date).slice(0, 10),          // Day
          n2(r.quantity),                             // Net items sold
          n2(r.gross_usd),                            // Gross sales
          n2(-Math.abs(Number(r.discounts_usd) || 0)),// Discounts (negative)
          n2(-Math.abs(Number(r.returns_usd) || 0)),  // Returns (negative)
          n2(r.net_usd),                              // Net sales
          n2(r.taxes_usd),                            // Taxes
          n2(total),                                  // Total sales
          n2(r.shipping_usd),                         // Shipping charges
        ].map(field).join(','));
      }
      if (!data || data.length < pageSize) break;
    }

    const csv = frozenText + live.join('\r\n') + (live.length ? '\r\n' : '');
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(dest, new Blob([csv], { type: 'text/csv' }), { upsert: true, contentType: 'text/csv' });
    if (upErr) throw new Error(`upload ${dest}: ${upErr.message}`);

    // Optional: reconcile the rebuilt CSV against the original manual export, by month.
    let compare: any = undefined;
    if (body?.compare === true) {
      const sumByMonth = (rows: string[][]) => {
        const m: Record<string, number> = {};
        for (const r of rows.slice(1)) {
          const day = r[5]; if (!day) continue;
          const k = String(day).slice(0, 7);
          m[k] = (m[k] ?? 0) + (Number(r[10]) || 0); // col K net sales
        }
        return m;
      };
      const rebuilt = sumByMonth(parse(csv, { skipFirstRow: false }) as string[][]);
      const { data: files } = await supabase.storage.from(BUCKET).list();
      const origName = files?.find((f: any) => f.name.startsWith('MARIO Total sales by product variant -'))?.name;
      let orig: Record<string, number> = {};
      if (origName) {
        const { data: ob } = await supabase.storage.from(BUCKET).download(origName);
        if (ob) orig = sumByMonth(parse(await ob.text(), { skipFirstRow: false }) as string[][]);
      }
      const months = [...new Set([...Object.keys(rebuilt), ...Object.keys(orig)])].sort();
      // per-day for the latest month (to spot partial-export boundary days)
      const sumByDay = (rows: string[][], mon: string) => {
        const m: Record<string, number> = {};
        for (const r of rows.slice(1)) { const day = String(r[5] ?? '').slice(0, 10); if (day.slice(0, 7) !== mon) continue; m[day] = (m[day] ?? 0) + (Number(r[10]) || 0); }
        return m;
      };
      const lastMon = months[months.length - 1];
      const rDay = sumByDay(parse(csv, { skipFirstRow: false }) as string[][], lastMon);
      const oDayRows = origName ? (await supabase.storage.from(BUCKET).download(origName)).data : null;
      const oDay = oDayRows ? sumByDay(parse(await oDayRows.text(), { skipFirstRow: false }) as string[][], lastMon) : {};
      const days = [...new Set([...Object.keys(rDay), ...Object.keys(oDay)])].sort();
      compare = {
        origName,
        byMonth: months.map((k) => ({ month: k, rebuilt: Math.round(rebuilt[k] ?? 0), original: Math.round(orig[k] ?? 0), deltaPct: orig[k] ? Math.round(((rebuilt[k] - orig[k]) / orig[k]) * 1000) / 10 : null })),
        byDay: days.map((k) => ({ day: k, rebuilt: Math.round(rDay[k] ?? 0), original: Math.round(oDay[k] ?? 0) })),
      };
    }

    return json({ success: true, dest, liveRows: live.length, bytes: csv.length, compare });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
