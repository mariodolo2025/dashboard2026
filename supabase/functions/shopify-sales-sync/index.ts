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

    // ── Mode: incremental by updated_at, or a historical backfill chunk by created_at ──
    // backfill { from, to } re-pulls a created_at window (e.g. one month) with native
    // amounts so the whole history is on the same market basis — the dashboard then
    // shows native AUD with no USD round-trip. It does NOT advance the watermark.
    const backfill: { from: string; to: string } | null =
      body?.backfill?.from && body?.backfill?.to ? { from: body.backfill.from, to: body.backfill.to } : null;
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
    // Backfill: widen the UTC window ±1 day so shop-local month-boundary orders
    // (whose UTC instant falls in the adjacent day) are fetched; the shop-local
    // `day` filter below still keeps only [from, to].
    const dShift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
    let nextUrl: string | null = backfill
      ? `${base}?${new URLSearchParams({ limit: '250', status: 'any', order: 'created_at asc', created_at_min: `${dShift(backfill.from, -1)}T00:00:00Z`, created_at_max: `${dShift(backfill.to, 1)}T23:59:59Z` })}`
      : `${base}?${new URLSearchParams({ limit: '250', status: 'any', order: 'updated_at asc', updated_at_min: updatedSince })}`;

    const rows: any[] = [];
    const orderIds = new Set<string>();
    // Web Upgrade performance: order-side attribution, captured additively without
    // touching the sales pipeline. Shopify returns properties/note_attributes as
    // arrays of {name, value}.
    const upgradeRows: any[] = [];
    // Robust to both the Admin API array form [{name,value}] and a plain object;
    // never throws, so it can't affect the sales pipeline.
    const propsToObj = (v: any): Record<string, any> => {
      const m: Record<string, any> = {};
      if (Array.isArray(v)) { for (const p of v) if (p && p.name != null) m[p.name] = p.value; }
      else if (v && typeof v === 'object') { for (const k of Object.keys(v)) m[k] = v[k]; }
      return m;
    };
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
        if (backfill && (day < backfill.from || day > backfill.to)) continue;
        // Incremental (updated_at) maintains ALL synced history — a refund/edit on
        // any past order bumps its updated_at, so it's re-pulled and its row replaced.
        orderCount++;
        const oid = String(o.id);
        orderIds.add(oid);
        const cur = o.presentment_currency || o.currency || 'USD';
        const month = day.slice(0, 7);
        const country = norm2(o.shipping_address?.country_code ?? o.billing_address?.country_code ?? 'NA');
        const conv = (pres: number, shop: number) => toUsd(cur, month, pres, shop);

        // ── Upgrade attribution — read-only extraction of _pesado_* line props +
        //    __pesado_* order note_attributes. Direct = a line carries _pesado_source.
        //    Wrapped so a malformed order can never break the sales sync. ──
        try {
        const na = propsToObj(o.note_attributes);
        for (const li of (o.line_items || [])) {
          const pp = propsToObj(li.properties);
          if (!pp['_pesado_source']) continue;
          upgradeRows.push({
            order_id: oid, order_date: day, sku: li.sku || '(no sku)', quantity: li.quantity || 0,
            pesado_source: pp['_pesado_source'] ?? null,
            pesado_attribution_id: pp['_pesado_attribution_id'] ?? null,
            pesado_machine: pp['_pesado_machine'] ?? null,
            pesado_reason: pp['_pesado_recommendation_reason'] ?? null,
            pesado_rank: pp['_pesado_recommendation_rank'] != null ? String(pp['_pesado_recommendation_rank']) : null,
            pesado_target_tier: pp['_pesado_target_tier'] || null,
            pesado_gap_before: pp['_pesado_gap_before'] || null,
            pesado_parent_product: pp['_pesado_parent_product'] || null,
            pesado_environment: pp['_pesado_environment'] ?? null,
            order_attribution_id: na['__pesado_attribution_id'] ?? null,
            order_environment: na['__pesado_environment'] ?? null,
          });
        }
        } catch (_) { /* skip this order's attribution; never affect sales */ }

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

    // ── Upgrade attribution write — isolated + best-effort: an error here must NEVER
    //    fail the sales sync or hold back the watermark. ──
    let upgradeErr: string | null = null;
    try {
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await supabase.from('upgrade_order_attribution').delete().in('order_id', ids.slice(i, i + 200));
        if (error) throw new Error(error.message);
      }
      for (let i = 0; i < upgradeRows.length; i += 500) {
        const { error } = await supabase.from('upgrade_order_attribution').insert(upgradeRows.slice(i, i + 500));
        if (error) throw new Error(error.message);
      }
    } catch (e) { upgradeErr = e instanceof Error ? e.message : 'failed'; }

    const { count: liveRows } = await supabase.from('shopify_sales_lines').select('*', { count: 'exact', head: true }).eq('source', 'api');
    // A backfill chunk must not move the live updated_at cursor.
    await supabase.from('shopify_sales_sync_state').upsert({
      id: 1, last_run_at: new Date().toISOString(),
      last_run_status: capped ? 'partial-capped' : 'ok', rows_live: liveRows ?? null,
      ...(backfill ? {} : { last_updated_at: maxUpdated }),
    });

    return json({ success: !capped, mode: backfill ? 'backfill' : 'incremental', ordersProcessed: orderCount, skippedFrozen, pages, capped, rowsUpserted: rows.length, ordersReplaced: ids.length, liveRowsTotal: liveRows ?? null, upgradeAttributed: upgradeRows.length, upgradeErr, cursorTo: backfill ? `${backfill.from}..${backfill.to}` : maxUpdated });
  } catch (e) {
    // Mark the run failed so shopify-export-csv won't publish a partial CSV.
    try {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await sb.from('shopify_sales_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: 'error' });
    } catch { /* best effort */ }
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
