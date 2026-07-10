// =============================================================================
// Shopify sales sync (DB-first, mirrors unleashed-sales-sync).
//
// Pulls Shopify Admin API orders BY updated_at (so edited/refunded orders are
// re-pulled), stores them PER ORDER-LINE in shopify_sales_lines (source='api',
// order_date >= LIVE_BOUNDARY). Because each order's rows are replaced wholesale
// on every re-pull, a late return correctly reduces net sales instead of leaving
// a stale over-count. shopify_sales_by_variant aggregates to (day, SKU, country)
// for shopify-export-csv, which rebuilds the CSV parse-csv-data reads.
//
// USD basis: Shopify's report values foreign sales at MARKET FX, not the order's
// Markets rate — convert the PRESENTMENT (native) amount at the month's market
// rate (currency_exchange_rates; USD=1, AUD=1/rate, others fall back to shop_money).
// net_native + net_usd_orderrate are also stored for a truer basis later.
//
//   POST {}                          → incremental from the updated_at watermark
//   POST { updatedSince }            → explicit updated_at floor (ISO)
//   POST { mode:'freeze', boundary } → build shopify.frozen.csv from the manual CSV (<= boundary)
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
const LIVE_BOUNDARY = '2026-07-01'; // api rows cover this day onward; <= 2026-06-30 is frozen history

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return isNaN(n) ? 0 : n; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const norm2 = (c: string) => {
  const s = String(c ?? '').toLowerCase().trim();
  if (['us', 'usa', 'united states'].includes(s)) return 'US';
  if (['au', 'australia'].includes(s)) return 'AU';
  return (c || 'NA').toString().toUpperCase().slice(0, 2);
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));

    // ── Freeze mode: build the static base from the current manual CSV ──
    if (body?.mode === 'freeze') {
      const boundary: string = body.boundary ?? '2026-06-30';
      const { data: files } = await supabase.storage.from(BUCKET).list();
      const csvName = files?.find((f: any) => f.name.startsWith('MARIO Total sales by product variant -'))?.name
        ?? files?.find((f: any) => f.name.startsWith('MARIO Total sales by product variant'))?.name;
      if (!csvName) return json({ success: false, message: 'manual Shopify CSV not found' }, 404);
      const { data: blob } = await supabase.storage.from(BUCKET).download(csvName);
      const rows = parse(await blob!.text(), { skipFirstRow: false }) as string[][];
      const header = rows[0];
      const kept = rows.slice(1).filter((r) => r[5] && String(r[5]).slice(0, 10) <= boundary); // col F Day <= boundary
      const out = [header, ...kept].map((r) => r.map((v) => /[",\r\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '')).join(',')).join('\r\n') + '\r\n';
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(FROZEN, new Blob([out], { type: 'text/csv' }), { upsert: true, contentType: 'text/csv' });
      if (upErr) throw new Error(`upload frozen: ${upErr.message}`);
      return json({ success: true, mode: 'freeze', source: csvName, boundary, frozenRows: kept.length, bytes: out.length });
    }

    // ── Creds ────────────────────────────────────────────────────────────
    const { data: creds } = await supabase
      .from('api_credentials').select('store_url, access_token').eq('provider', 'shopify').maybeSingle();
    if (!creds?.access_token) return json({ success: false, message: 'no shopify creds' }, 400);
    let store = String(creds.store_url).trim();
    if (!store.includes('.')) store += '.myshopify.com';
    store = store.replace(/^https?:\/\//, '').split('/')[0];
    const token = creds.access_token as string;

    // ── updated_at cursor (incremental) ───────────────────────────────────
    const { data: st } = await supabase.from('shopify_sales_sync_state').select('*').eq('id', 1).maybeSingle();
    let updatedSince: string = body.updatedSince ?? st?.last_updated_at ?? `${LIVE_BOUNDARY}T00:00:00Z`;

    // ── Market FX: month → AUD→USD (currency_exchange_rates holds USD→AUD) ─
    const { data: rateRows } = await supabase.from('currency_exchange_rates').select('year, month, rate');
    const audToUsd = (yyyymm: string) => {
      const [y, m] = yyyymm.split('-').map(Number);
      const row = (rateRows ?? []).find((r: any) => r.year === y && r.month === m);
      const usdToAud = row ? num(row.rate) : 1.54;
      return usdToAud ? 1 / usdToAud : 1 / 1.54;
    };
    const toUsd = (cur: string, month: string, pres: number, shop: number) =>
      cur === 'USD' ? pres : cur === 'AUD' ? pres * audToUsd(month) : shop;

    // ── Pull orders by updated_at ─────────────────────────────────────────
    const base = `https://${store}/admin/api/2024-01/orders.json`;
    let nextUrl: string | null =
      `${base}?${new URLSearchParams({ limit: '250', status: 'any', order: 'updated_at asc', updated_at_min: updatedSince })}`;

    const rows: any[] = [];
    const orderIds = new Set<string>();
    let orderCount = 0, pages = 0, skippedFrozen = 0, maxUpdated = updatedSince, capped = false;

    while (nextUrl) {
      if (pages >= 80) { capped = true; break; }
      const res = await fetch(nextUrl, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return json({ success: false, message: `Shopify ${res.status}`, detail: (await res.text()).slice(0, 200) }, 502);
      const data = await res.json();
      for (const o of (data.orders || [])) {
        const upd = String(o.updated_at || '');
        if (upd > maxUpdated) maxUpdated = upd;
        const day = String(o.created_at || '').slice(0, 10);
        if (day < LIVE_BOUNDARY) { skippedFrozen++; continue; } // its history is frozen
        orderCount++;
        const oid = String(o.id);
        orderIds.add(oid);
        const cur = o.presentment_currency || o.currency || 'USD';
        const month = day.slice(0, 7);
        const country = norm2(o.shipping_address?.country_code ?? o.billing_address?.country_code ?? 'NA');
        const conv = (pres: number, shop: number) => toUsd(cur, month, pres, shop);

        // aggregate this order's lines by sku
        type A = { product: string; variant: string; qty: number; gross: number; disc: number; returns: number; native: number; orderUsd: number };
        const bySku = new Map<string, A>();
        const gA = (sku: string): A => { let a = bySku.get(sku); if (!a) { a = { product: '', variant: '', qty: 0, gross: 0, disc: 0, returns: 0, native: 0, orderUsd: 0 }; bySku.set(sku, a); } return a; };
        for (const li of (o.line_items || [])) {
          const q = li.quantity || 0;
          const a = gA(li.sku || '(no sku)');
          const presPrice = num(li.price_set?.presentment_money?.amount ?? li.price);
          const shopPrice = num(li.price_set?.shop_money?.amount ?? li.price);
          let presDisc = 0, shopDisc = 0;
          for (const da of (li.discount_allocations || [])) {
            presDisc += num(da.amount_set?.presentment_money?.amount ?? da.amount);
            shopDisc += num(da.amount_set?.shop_money?.amount ?? da.amount);
          }
          a.gross += conv(presPrice, shopPrice) * q; a.disc += conv(presDisc, shopDisc); a.qty += q;
          a.native += (presPrice * q - presDisc); a.orderUsd += (shopPrice * q - shopDisc);
          if (!a.product) a.product = li.title ?? '';
          if (!a.variant) a.variant = li.variant_title ?? '';
        }
        for (const rf of (o.refunds || [])) {
          for (const rli of (rf.refund_line_items || [])) {
            const a = gA(rli.line_item?.sku || '(no sku)');
            const presRet = num(rli.subtotal_set?.presentment_money?.amount ?? rli.subtotal);
            const shopRet = num(rli.subtotal_set?.shop_money?.amount ?? rli.subtotal);
            a.returns += conv(presRet, shopRet); a.qty -= (rli.quantity || 0);
            a.native -= presRet; a.orderUsd -= shopRet;
          }
        }
        // order taxes + shipping (net of refunds) → allocate to sku rows by net share
        let taxUsd = conv(num(o.total_tax_set?.presentment_money?.amount ?? o.total_tax), num(o.total_tax_set?.shop_money?.amount ?? o.total_tax));
        let shipUsd = conv(num(o.total_shipping_price_set?.presentment_money?.amount), num(o.total_shipping_price_set?.shop_money?.amount));
        for (const rf of (o.refunds || [])) {
          for (const rli of (rf.refund_line_items || [])) taxUsd -= conv(num(rli.total_tax_set?.presentment_money?.amount ?? rli.total_tax), num(rli.total_tax_set?.shop_money?.amount ?? rli.total_tax));
          for (const adj of (rf.order_adjustments || [])) if (String(adj.kind).includes('shipping')) shipUsd += conv(num(adj.amount_set?.presentment_money?.amount ?? adj.amount), num(adj.amount_set?.shop_money?.amount ?? adj.amount));
        }
        const entries = [...bySku.entries()];
        const totNet = entries.reduce((t, [, a]) => t + (a.gross - a.disc - a.returns), 0);
        for (const [sku, a] of entries) {
          const net = a.gross - a.disc - a.returns;
          const share = totNet !== 0 ? net / totNet : (entries.length ? 1 / entries.length : 0);
          rows.push({
            order_id: oid, order_date: day, order_updated_at: o.updated_at ?? null, sku,
            product_title: a.product || null, variant_title: a.variant || null, country, currency: cur,
            quantity: r2(a.qty), gross_usd: r2(a.gross), discounts_usd: r2(a.disc), returns_usd: r2(a.returns),
            net_usd: r2(net), taxes_usd: r2(taxUsd * share), shipping_usd: r2(shipUsd * share),
            net_native: r2(a.native), net_usd_orderrate: r2(a.orderUsd), source: 'api',
          });
        }
      }
      pages++;
      const link = res.headers.get('Link');
      nextUrl = null;
      if (link) { const mm = link.match(/<([^>]+)>;\s*rel="next"/); if (mm) nextUrl = mm[1]; }
    }

    // ── Replace each re-pulled order's rows wholesale (delete-by-order, then insert) ──
    const ids = [...orderIds];
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from('shopify_sales_lines').delete().eq('source', 'api').in('order_id', ids.slice(i, i + 200));
      if (error) throw new Error(`delete: ${error.message}`); // never advance the watermark on a failed delete
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('shopify_sales_lines').upsert(rows.slice(i, i + 500), { onConflict: 'order_id,sku,country' });
      if (error) throw new Error(`insert: ${error.message}`);
    }

    const { count: liveRows } = await supabase.from('shopify_sales_lines').select('*', { count: 'exact', head: true }).eq('source', 'api');
    await supabase.from('shopify_sales_sync_state').upsert({
      id: 1, last_updated_at: maxUpdated, last_run_at: new Date().toISOString(),
      last_run_status: capped ? 'partial-capped' : 'ok', rows_live: liveRows ?? null,
    });

    return json({ success: !capped, ordersProcessed: orderCount, skippedFrozen, pages, capped, rowsUpserted: rows.length, ordersReplaced: ids.length, liveRowsTotal: liveRows ?? null, cursorTo: maxUpdated });
  } catch (e) {
    // Mark the run failed so shopify-export-csv won't publish a partial CSV.
    try {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await sb.from('shopify_sales_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: 'error' });
    } catch { /* best effort */ }
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
