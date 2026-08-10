// =============================================================================
// Shopify attribution sync (Advertising Bloque 1 — DB-first, mirrors
// shopify-sales-sync). Captures each order's customer journey RAW:
// summary row in shopify_order_attribution + every visit in
// shopify_order_journey_moments. Models/buckets compute at read time.
//
//   POST {}                          → incremental from the updated_at watermark
//                                      + retry of recent ready=false orders
//   POST { backfill: { from, to } }  → created_at window (does NOT move watermark)
// Service-role only. Never advances the watermark on failure.
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const API = '2025-01';
const PAGE = 40;        // orders per page (journeys are query-cost heavy)
const MAX_PAGES = 25;   // stay far under the 150s step budget
const PENDING_DAYS = 7; // ready=false older than this stays "sin journey" (spec)

const JOURNEY_FIELDS = `
  ready
  momentsCount { count }
  daysToConversion
  customerOrderIndex
  firstVisit { occurredAt source referrerUrl landingPage
    utmParameters { source medium campaign content term } }
  lastVisit { occurredAt source referrerUrl landingPage
    utmParameters { source medium campaign content term } }
  moments(first: 50) { pageInfo { hasNextPage endCursor } nodes { __typename
    ... on CustomerVisit { occurredAt source referrerUrl landingPage
      utmParameters { source medium campaign content term } } } }`;

const MOMENTS_PAGE_QUERY = `
  query($id: ID!, $after: String) {
    node(id: $id) { ... on Order { customerJourneySummary {
      moments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename ... on CustomerVisit { occurredAt source referrerUrl landingPage
          utmParameters { source medium campaign content term } } } } } } } }`;

type Visit = {
  occurredAt?: string | null; source?: string | null; referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null; term?: string | null } | null;
};

const numericId = (gid: string) => gid.split('/').pop() ?? gid;

function attrRow(oid: string, name: string | null, createdAt: string, updatedAt: string | null, j: any) {
  const v = (x: Visit | null | undefined, p: 'first' | 'last') => ({
    [`${p}_occurred_at`]: x?.occurredAt ?? null,
    [`${p}_source`]: x?.source ?? null,
    [`${p}_referrer`]: x?.referrerUrl ?? null,
    [`${p}_landing`]: x?.landingPage ?? null,
    [`${p}_utm_source`]: x?.utmParameters?.source ?? null,
    [`${p}_utm_medium`]: x?.utmParameters?.medium ?? null,
    [`${p}_utm_campaign`]: x?.utmParameters?.campaign ?? null,
    [`${p}_utm_content`]: x?.utmParameters?.content ?? null,
    [`${p}_utm_term`]: x?.utmParameters?.term ?? null,
  });
  const createdMs = Date.parse(createdAt);
  return {
    order_id: oid,
    // Visible order number (PSD#65185) for the Live Orders block — v2 2026-08-11.
    order_name: name ?? null,
    order_created_at: createdAt,
    // Brisbane day (+10, no DST) — same calendar as shopify_sales_lines
    order_date: new Date(createdMs + 10 * 3600e3).toISOString().slice(0, 10),
    order_updated_at: updatedAt,
    ready: j?.ready === true,
    moments_count: j?.momentsCount?.count ?? null,
    days_to_conversion: j?.daysToConversion ?? null,
    customer_order_index: j?.customerOrderIndex ?? null,
    ...v(j?.firstVisit, 'first'),
    ...v(j?.lastVisit, 'last'),
    synced_at: new Date().toISOString(),
  };
}

function momentRows(oid: string, visits: any[]) {
  const filtered: Visit[] = (visits ?? []).filter((n: any) => n?.__typename === 'CustomerVisit');
  filtered.sort((a, b) => String(a.occurredAt ?? '').localeCompare(String(b.occurredAt ?? '')));
  return filtered.map((m, i) => ({
    order_id: oid, seq: i,
    occurred_at: m.occurredAt ?? null,
    source: m.source ?? null, referrer: m.referrerUrl ?? null, landing: m.landingPage ?? null,
    utm_source: m.utmParameters?.source ?? null,
    utm_medium: m.utmParameters?.medium ?? null,
    utm_campaign: m.utmParameters?.campaign ?? null,
    utm_content: m.utmParameters?.content ?? null,
    utm_term: m.utmParameters?.term ?? null,
  }));
}

async function fetchAllMoments(gql: (q: string, v: Record<string, unknown>) => Promise<any>, orderGid: string): Promise<any[]> {
  const out: any[] = []; let after: string | null = null;
  do {
    const d = await gql(MOMENTS_PAGE_QUERY, { id: orderGid, after });
    const conn = d?.node?.customerJourneySummary?.moments;
    out.push(...(conn?.nodes ?? []));
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const backfill: { from: string; to: string } | null =
      body?.backfill?.from && body?.backfill?.to ? body.backfill : null;
    if (backfill && !(/^\d{4}-\d{2}-\d{2}$/.test(backfill.from) && /^\d{4}-\d{2}-\d{2}$/.test(backfill.to))) {
      return json({ success: false, message: 'backfill dates must be YYYY-MM-DD' }, 400);
    }

    const { data: creds } = await supabase
      .from('api_credentials').select('store_url, access_token').eq('provider', 'shopify').maybeSingle();
    if (!creds?.access_token) return json({ success: false, message: 'no shopify creds' }, 400);
    let store = String(creds.store_url).trim();
    if (!store.includes('.')) store += '.myshopify.com';
    store = store.replace(/^https?:\/\//, '').split('/')[0];

    const gql = async (query: string, variables: Record<string, unknown>) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(`https://${store}/admin/api/${API}/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': creds.access_token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const throttled = (data.errors ?? []).some((e: any) => e?.extensions?.code === 'THROTTLED');
        if (throttled) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (data.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
        return data.data;
      }
      throw new Error('GraphQL: throttled after 4 attempts');
    };

    // ── Watermark (30-min overlap; replaced-wholesale rows make it idempotent) ──
    const { data: st } = await supabase.from('shopify_attribution_sync_state').select('*').eq('id', 1).maybeSingle();
    const storedWm = st?.last_modified_watermark
      ? new Date(Date.parse(st.last_modified_watermark) - 30 * 60_000).toISOString()
      : null;
    const updatedSince: string = body.updatedSince ?? storedWm ?? '2026-08-08T00:00:00Z';

    // oid -> { attr, moments }. A Map (not two arrays) so that if paging by
    // updated_at returns the same order twice in one run (it gets updated
    // mid-pagination), the LAST copy wins instead of producing a duplicate
    // order_id in the write batch.
    const orders = new Map<string, { attr: Record<string, unknown>; moments: Record<string, unknown>[] }>();
    let pages = 0, capped = false, maxUpdated = updatedSince;

    const searchQ = backfill
      ? `created_at:>='${backfill.from}T00:00:00Z' AND created_at:<='${backfill.to}T23:59:59Z'`
      : `updated_at:>='${updatedSince}'`;
    const listQuery = `
      query($q: String!, $after: String) {
        orders(first: ${PAGE}, query: $q, sortKey: ${backfill ? 'CREATED_AT' : 'UPDATED_AT'}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id name createdAt updatedAt customerJourneySummary { ${JOURNEY_FIELDS} } }
        }
      }`;

    let after: string | null = null;
    do {
      if (pages >= MAX_PAGES) { capped = true; break; }
      const d = await gql(listQuery, { q: searchQ, after });
      for (const o of d.orders.nodes) {
        const oid = numericId(o.id);
        const upd = String(o.updatedAt ?? '');
        if (upd > maxUpdated) maxUpdated = upd;
        const j = o.customerJourneySummary;
        const visits = (j?.momentsCount?.count ?? 0) > 50 ? await fetchAllMoments(gql, o.id) : (j?.moments?.nodes ?? []);
        orders.set(oid, { attr: attrRow(oid, o.name ?? null, String(o.createdAt), o.updatedAt ?? null, j), moments: momentRows(oid, visits) });
      }
      after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
      pages++;
    } while (after);

    // ── Retry recent ready=false (their flip does NOT bump order updated_at) ──
    let retried = 0;
    if (!backfill) {
      const cutoff = new Date(Date.now() - PENDING_DAYS * 86400e3).toISOString().slice(0, 10);
      const { data: pending } = await supabase
        .from('shopify_order_attribution').select('order_id')
        .eq('ready', false).gte('order_date', cutoff)
        .order('order_date', { ascending: true })
        .limit(200);
      const already = new Set(orders.keys());
      const pendingIds = (pending ?? []).map((p) => p.order_id).filter((id) => !already.has(id));
      const nodeQuery = `
        query($ids: [ID!]!) {
          nodes(ids: $ids) { ... on Order { id name createdAt updatedAt customerJourneySummary { ${JOURNEY_FIELDS} } } }
        }`;
      for (let i = 0; i < pendingIds.length; i += 25) {
        const d = await gql(nodeQuery, { ids: pendingIds.slice(i, i + 25).map((id) => `gid://shopify/Order/${id}`) });
        for (const o of (d.nodes ?? [])) {
          if (!o?.id) continue;
          const oid = numericId(o.id);
          const j = o.customerJourneySummary;
          const visits = (j?.momentsCount?.count ?? 0) > 50 ? await fetchAllMoments(gql, o.id) : (j?.moments?.nodes ?? []);
          orders.set(oid, { attr: attrRow(oid, o.name ?? null, String(o.createdAt), o.updatedAt ?? null, j), moments: momentRows(oid, visits) });
          retried++;
        }
      }
    }

    // ── Write: moments delete+insert, attr upsert LAST. Never delete from
    // shopify_order_attribution (upsert overwrites every column anyway) — so a
    // crash mid-run leaves the old ready=false row alive for the next retry
    // to self-heal instead of losing it. ──
    const ids = [...orders.keys()];
    const finalAttr = [...orders.values()].map((o) => o.attr);
    const finalMoments = [...orders.values()].flatMap((o) => o.moments);
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from('shopify_order_journey_moments').delete().in('order_id', ids.slice(i, i + 200));
      if (error) throw new Error(`delete moments: ${error.message}`);
    }
    for (let i = 0; i < finalMoments.length; i += 500) {
      const { error } = await supabase.from('shopify_order_journey_moments').insert(finalMoments.slice(i, i + 500));
      if (error) throw new Error(`insert moments: ${error.message}`);
    }
    for (let i = 0; i < finalAttr.length; i += 500) {
      const { error } = await supabase.from('shopify_order_attribution')
        .upsert(finalAttr.slice(i, i + 500), { onConflict: 'order_id' });
      if (error) throw new Error(`insert attr: ${error.message}`);
    }

    const { count } = await supabase.from('shopify_order_attribution').select('*', { count: 'exact', head: true });
    await supabase.from('shopify_attribution_sync_state').upsert({
      id: 1, last_run_at: new Date().toISOString(),
      last_run_status: capped ? 'partial-capped' : 'ok', rows_total: count ?? null,
      ...(backfill ? {} : { last_modified_watermark: maxUpdated }),
    });

    return json({
      success: !capped, mode: backfill ? 'backfill' : 'incremental',
      ordersProcessed: ids.length, momentsWritten: finalMoments.length,
      pendingRetried: retried, pages, capped,
      cursorTo: backfill ? `${backfill.from}..${backfill.to}` : maxUpdated,
      ...(capped ? { message: `capped at ${MAX_PAGES} pages — run again to continue` } : {}),
    });
  } catch (e) {
    try {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await sb.from('shopify_attribution_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: 'error' });
    } catch { /* best effort */ }
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
