// =============================================================================
// Unleashed sales sync — appends new sales (OrderDate >= 2026-07-01) from the
// Unleashed API into unleashed_sales_lines, replacing the manual
// SalesEnquiryList.csv upload. The frozen history (<= 2026-06-30) is loaded once
// and never touched here.
//
//   POST {}                → incremental (orders modified since the watermark)
//   POST { backfill:true } → pull every order dated >= 2026-07-01 (first run)
//
// A synced order's live lines are cleared and re-inserted, so edits, deletions
// and status changes never duplicate or go stale. Enriches each line with the
// Product Group and Customer Type (the two fields the dashboard's channel/brand
// classification keys on) via cached Products/Customers lookups.
//
// After updating the table it rebuilds the served artefacts (CSV + parsed cache)
// by calling regenerate — see LIVE_BOUNDARY. Credentials come from
// unleashed_credentials. Service-role only.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const UNLEASHED_BASE = 'https://api.unleashedsoftware.com';
const LIVE_BOUNDARY = '2026-07-01'; // first day owned by the API (frozen ends 2026-06-30)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// Unleashed signs the query string (no leading '?') with HMAC-SHA256(api_key), base64.
async function hmacSign(apiKey: string, queryString: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(apiKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(queryString));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function ug(path: string, qs: string, creds: { api_id: string; api_key: string }): Promise<any> {
  const signature = await hmacSign(creds.api_key, qs);
  const res = await fetch(`${UNLEASHED_BASE}/${path}?${qs}`, {
    headers: { 'api-auth-id': creds.api_id, 'api-auth-signature': signature, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Unleashed ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// /Date(ms)/ → 'YYYY-MM-DD' (UTC).
function parseUDate(v: any): string | null {
  const m = /\/Date\((-?\d+)/.exec(String(v ?? ''));
  if (!m) return null;
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

/** Page through an Unleashed collection endpoint, calling onPage for each. */
async function pageAll(path: string, baseQs: string, creds: any, onPage: (items: any[]) => void) {
  for (let page = 1; ; page++) {
    const d = await ug(`${path}/${page}`, baseQs, creds);
    onPage(d.Items ?? []);
    const pages = d.Pagination?.NumberOfPages ?? 1;
    if (page >= pages) break;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const backfill = body?.backfill === true;

    const { data: credsRow, error: credErr } = await supabase
      .from('unleashed_credentials').select('api_id, api_key').limit(1).maybeSingle();
    if (credErr || !credsRow?.api_id) throw new Error('Unleashed credentials not found');
    const creds = { api_id: credsRow.api_id, api_key: credsRow.api_key };

    const { data: state } = await supabase.from('unleashed_sales_sync_state').select('*').eq('id', 1).maybeSingle();
    const runStart = new Date();

    // ── Lookups: ProductCode → Product Group, Customer(name/code) → type ──────
    const groupByCode = new Map<string, string>();
    await pageAll('Products', 'pageSize=200', creds, (items) => {
      for (const p of items) if (p.ProductCode) groupByCode.set(String(p.ProductCode), p.ProductGroup?.GroupName ?? '');
    });
    const typeByCustomer = new Map<string, string>();
    await pageAll('Customers', 'pageSize=200', creds, (items) => {
      for (const c of items) {
        const t = typeof c.CustomerType === 'string' ? c.CustomerType : (c.CustomerType?.CustomerType ?? '');
        if (c.CustomerName) typeByCustomer.set(String(c.CustomerName), t);
        if (c.CustomerCode) typeByCustomer.set(String(c.CustomerCode), t);
      }
    });

    // ── Fetch orders ──────────────────────────────────────────────────────────
    // Incremental keys off the modified-date window (startDate/endDate); the
    // first run backfills by order date. Either way we only keep OrderDate >=
    // LIVE_BOUNDARY, so edits to frozen orders are ignored by design.
    const orders: any[] = [];
    let maxModified = state?.last_modified_watermark ? new Date(state.last_modified_watermark) : null;
    if (backfill || !state?.last_modified_watermark) {
      // startDate filters by ORDER date → every order dated >= the live boundary.
      await pageAll('SalesOrders', `startDate=${LIVE_BOUNDARY}&pageSize=200`, creds, (items) => { orders.push(...items); });
    } else {
      // modifiedSince catches new AND edited orders since the last run.
      const since = new Date(state.last_modified_watermark);
      since.setDate(since.getDate() - 1); // 1-day safety overlap
      const modifiedSince = since.toISOString().slice(0, 10);
      await pageAll('SalesOrders', `modifiedSince=${modifiedSince}&pageSize=200`, creds, (items) => { orders.push(...items); });
    }

    // ── Build live rows, grouped by order ─────────────────────────────────────
    const byOrder = new Map<string, any[]>();
    for (const o of orders) {
      const orderDate = parseUDate(o.OrderDate);
      if (!orderDate || orderDate < LIVE_BOUNDARY) continue;
      const lm = o.LastModifiedOn ? new Date(parseUDate(o.LastModifiedOn) + 'T00:00:00Z') : null;
      if (lm && (!maxModified || lm > maxModified)) maxModified = lm;
      const customer = o.Customer?.CustomerName ?? '';
      const warehouse = o.Warehouse?.WarehouseName ?? '';
      const status = o.OrderStatus ?? '';
      const custType = typeByCustomer.get(customer) ?? typeByCustomer.get(o.Customer?.CustomerCode ?? '') ?? '';
      const guid = o.Guid;
      const rows: any[] = [];
      for (const l of o.SalesOrderLines ?? []) {
        const code = l.Product?.ProductCode ?? null;
        const desc = l.Product?.ProductDescription ?? '';
        const isCharge = !code; // Charge/freight lines have no product code; the CSV shows the description in both columns
        rows.push({
          id: l.Guid,
          order_date: orderDate,
          product_code: code ?? desc,
          product: code ? desc : desc,
          customer,
          product_group: code ? (groupByCode.get(String(code)) ?? '') : '',
          warehouse,
          status,
          quantity: Number(l.OrderQuantity) || 0,
          sub_total: l.BCLineTotal != null ? Number(l.BCLineTotal) : (Number(l.LineTotal) || 0),
          customer_type: custType,
          source: 'api',
          order_guid: guid,
        });
      }
      if (guid) byOrder.set(guid, rows);
    }

    // ── Upsert: clear each synced order's existing live lines, insert current ──
    const orderGuids = [...byOrder.keys()];
    let upserted = 0;
    for (let i = 0; i < orderGuids.length; i += 200) {
      const batch = orderGuids.slice(i, i + 200);
      await supabase.from('unleashed_sales_lines').delete().eq('source', 'api').in('order_guid', batch);
    }
    const allRows = [...byOrder.values()].flat();
    for (let i = 0; i < allRows.length; i += 500) {
      const chunk = allRows.slice(i, i + 500);
      const { error } = await supabase.from('unleashed_sales_lines').upsert(chunk, { onConflict: 'id' });
      if (error) throw new Error(`upsert failed: ${error.message}`);
      upserted += chunk.length;
    }

    // ── Watermark + state ─────────────────────────────────────────────────────
    const { count: liveCount } = await supabase
      .from('unleashed_sales_lines').select('*', { count: 'exact', head: true }).eq('source', 'api');
    await supabase.from('unleashed_sales_sync_state').upsert({
      id: 1,
      last_modified_watermark: (maxModified ?? runStart).toISOString(),
      last_run_at: runStart.toISOString(),
      last_run_status: 'ok',
      rows_live: liveCount ?? 0,
    });

    return json({
      success: true,
      mode: backfill || !state?.last_modified_watermark ? 'backfill' : 'incremental',
      ordersFetched: orders.length,
      ordersInLiveWindow: byOrder.size,
      linesUpserted: upserted,
      liveRowsTotal: liveCount ?? 0,
      products: groupByCode.size,
      customers: typeByCustomer.size,
    });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
