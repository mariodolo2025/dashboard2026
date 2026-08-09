# Advertising Tab — Plan 2: Attribution Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every order's full customer journey (all visits, with UTMs) captured incrementally into two new tables, backfilled 13 months — the raw material for every attribution model (spec Bloque 1).

**Architecture:** A new edge function `shopify-attribution-sync` mirrors the proven `shopify-sales-sync` pattern: GraphQL Admin API by `updated_at` watermark (30-min overlap), delete-then-insert per order, own state row, never advance the watermark on failure. Registered as ONE additive step in `sync-orchestrate`. Nothing existing is modified beyond that one added array entry (spec §2 principio 0).

**Tech Stack:** Supabase edge function (Deno TS), Shopify GraphQL Admin API `2025-01` (`customerJourneySummary` + `moments`), Postgres migration via MCP `apply_migration`, deploy via `npm run sb -- functions deploy shopify-attribution-sync`.

**Branch:** `feat/advertising-tab`.

**Gate before Task 5 (backfill):** spec §8 paso 0 — Mario confirms the Meta UTM convention with Kieran. Tasks 1–4 don't need it.

---

### Task 1: Migration — the two capture tables + sync state

**Files:**
- Create (doc): `supabase/migrations/20260808100000_advertising_attribution_tables.sql`
- Apply via MCP `apply_migration`, name `advertising_attribution_tables`

- [ ] **Step 1.1: Apply the migration**

```sql
-- Advertising Bloque 1 — raw journey capture (spec DESIGN-ADVERTISING-TAB §4).
-- RAW: exactly what Shopify returns, no interpretation. Buckets/models compute
-- at read time (motor, Plan 4). New tables only — touches nothing existing.

create table public.shopify_order_attribution (
  order_id text primary key,
  order_date date not null,
  order_updated_at timestamptz,
  ready boolean not null default false,
  moments_count int,
  days_to_conversion int,
  customer_order_index int,          -- 1 = first purchase (CAC blended)
  first_occurred_at timestamptz,
  first_source text, first_referrer text, first_landing text,
  first_utm_source text, first_utm_medium text, first_utm_campaign text,
  first_utm_content text, first_utm_term text,
  last_occurred_at timestamptz,
  last_source text, last_referrer text, last_landing text,
  last_utm_source text, last_utm_medium text, last_utm_campaign text,
  last_utm_content text, last_utm_term text,
  synced_at timestamptz not null default now()
);
create index shopify_order_attribution_date_idx
  on public.shopify_order_attribution (order_date);
create index shopify_order_attribution_pending_idx
  on public.shopify_order_attribution (order_date) where not ready;

create table public.shopify_order_journey_moments (
  order_id text not null,
  seq int not null,                  -- 0-based, in occurredAt order
  occurred_at timestamptz,
  source text, referrer text, landing text,
  utm_source text, utm_medium text, utm_campaign text,
  utm_content text, utm_term text,
  primary key (order_id, seq)
);

create table public.shopify_attribution_sync_state (
  id int primary key,
  last_modified_watermark timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  rows_total bigint
);

alter table public.shopify_order_attribution enable row level security;
alter table public.shopify_order_journey_moments enable row level security;
alter table public.shopify_attribution_sync_state enable row level security;
-- No client policies: the edge function writes with service role; the future
-- RPC reads as SECURITY DEFINER (Plan 4). Same posture as the rollup tables.
```

- [ ] **Step 1.2: Verify**

```sql
select count(*) from shopify_order_attribution;   -- 0, no error
select count(*) from shopify_order_journey_moments; -- 0, no error
```

- [ ] **Step 1.3: Write the repo doc file** (`supabase/migrations/20260808100000_advertising_attribution_tables.sql` with the SQL above plus a header comment referencing the spec) **and commit**

```bash
git add supabase/migrations/20260808100000_advertising_attribution_tables.sql
git commit -m "feat(advertising): attribution capture tables — order journey, raw"
```

---

### Task 2: Edge function `shopify-attribution-sync`

**Files:**
- Create: `supabase/functions/shopify-attribution-sync/index.ts`

- [ ] **Step 2.1: Write the function**

```ts
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
  moments(first: 50) { nodes { __typename
    ... on CustomerVisit { occurredAt source referrerUrl landingPage
      utmParameters { source medium campaign content term } } } }`;

type Visit = {
  occurredAt?: string | null; source?: string | null; referrerUrl?: string | null;
  landingPage?: string | null;
  utmParameters?: { source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null; term?: string | null } | null;
};

const numericId = (gid: string) => gid.split('/').pop() ?? gid;

function attrRow(oid: string, createdAt: string, updatedAt: string | null, j: any) {
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
  return {
    order_id: oid,
    order_date: createdAt.slice(0, 10),
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

function momentRows(oid: string, j: any) {
  const visits: Visit[] = (j?.moments?.nodes ?? [])
    .filter((n: any) => n?.__typename === 'CustomerVisit');
  visits.sort((a, b) => String(a.occurredAt ?? '').localeCompare(String(b.occurredAt ?? '')));
  return visits.map((m, i) => ({
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const backfill: { from: string; to: string } | null =
      body?.backfill?.from && body?.backfill?.to ? body.backfill : null;

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

    const attrRows: any[] = [];
    const allMoments: any[] = [];
    let pages = 0, capped = false, maxUpdated = updatedSince;

    const searchQ = backfill
      ? `created_at:>='${backfill.from}T00:00:00Z' AND created_at:<='${backfill.to}T23:59:59Z'`
      : `updated_at:>='${updatedSince}'`;
    const listQuery = `
      query($q: String!, $after: String) {
        orders(first: ${PAGE}, query: $q, sortKey: ${backfill ? 'CREATED_AT' : 'UPDATED_AT'}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id createdAt updatedAt customerJourneySummary { ${JOURNEY_FIELDS} } }
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
        attrRows.push(attrRow(oid, String(o.createdAt), o.updatedAt ?? null, o.customerJourneySummary));
        allMoments.push(...momentRows(oid, o.customerJourneySummary));
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
        .eq('ready', false).gte('order_date', cutoff).limit(200);
      const already = new Set(attrRows.map((r) => r.order_id));
      const ids = (pending ?? []).map((p) => p.order_id).filter((id) => !already.has(id));
      const nodeQuery = `
        query($ids: [ID!]!) {
          nodes(ids: $ids) { ... on Order { id createdAt updatedAt customerJourneySummary { ${JOURNEY_FIELDS} } } }
        }`;
      for (let i = 0; i < ids.length; i += 25) {
        const d = await gql(nodeQuery, { ids: ids.slice(i, i + 25).map((id) => `gid://shopify/Order/${id}`) });
        for (const o of (d.nodes ?? [])) {
          if (!o?.id) continue;
          const oid = numericId(o.id);
          attrRows.push(attrRow(oid, String(o.createdAt), o.updatedAt ?? null, o.customerJourneySummary));
          allMoments.push(...momentRows(oid, o.customerJourneySummary));
          retried++;
        }
      }
    }

    // ── Replace wholesale per order (summary + moments), then advance state ──
    const ids = [...new Set(attrRows.map((r) => r.order_id))];
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      let { error } = await supabase.from('shopify_order_journey_moments').delete().in('order_id', slice);
      if (error) throw new Error(`delete moments: ${error.message}`);
      ({ error } = await supabase.from('shopify_order_attribution').delete().in('order_id', slice));
      if (error) throw new Error(`delete attr: ${error.message}`);
    }
    for (let i = 0; i < attrRows.length; i += 500) {
      const { error } = await supabase.from('shopify_order_attribution')
        .upsert(attrRows.slice(i, i + 500), { onConflict: 'order_id' });
      if (error) throw new Error(`insert attr: ${error.message}`);
    }
    for (let i = 0; i < allMoments.length; i += 500) {
      const { error } = await supabase.from('shopify_order_journey_moments')
        .upsert(allMoments.slice(i, i + 500), { onConflict: 'order_id,seq' });
      if (error) throw new Error(`insert moments: ${error.message}`);
    }

    const { count } = await supabase.from('shopify_order_attribution').select('*', { count: 'exact', head: true });
    await supabase.from('shopify_attribution_sync_state').upsert({
      id: 1, last_run_at: new Date().toISOString(),
      last_run_status: capped ? 'partial-capped' : 'ok', rows_total: count ?? null,
      ...(backfill ? {} : { last_modified_watermark: maxUpdated }),
    });

    return json({
      success: !capped, mode: backfill ? 'backfill' : 'incremental',
      ordersProcessed: ids.length, momentsWritten: allMoments.length,
      pendingRetried: retried, pages, capped,
      cursorTo: backfill ? `${backfill.from}..${backfill.to}` : maxUpdated,
    });
  } catch (e) {
    try {
      const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      await sb.from('shopify_attribution_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: 'error' });
    } catch { /* best effort */ }
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
```

- [ ] **Step 2.2: Deploy**

```bash
cd "C:/PROYECTS/AIM 2026" && npm run sb -- functions deploy shopify-attribution-sync
```
Expected: deploy OK (default verify_jwt fine — invoked service-role by the orchestrator).

- [ ] **Step 2.3: First incremental run + spot-check (acceptance §9 Bloque 1)**

Invoke once with `{}` (via the orchestrator's invoke pattern or curl with the service key from Supabase dashboard — Mario does not run this; the assistant does). Then verify:

```sql
select ready, count(*) from shopify_order_attribution group by 1;
select count(*) from shopify_order_journey_moments;
-- spot-check one order against the API by hand (same fields, same values)
select * from shopify_order_attribution order by order_date desc limit 3;
```
Expected: rows > 0; a manually fetched order (GraphQL) matches its row field-by-field.

- [ ] **Step 2.4: Commit**

```bash
git add supabase/functions/shopify-attribution-sync/index.ts
git commit -m "feat(advertising): shopify-attribution-sync — raw journey capture"
```

---

### Task 3: Register the step in the orchestrator (one additive entry)

**Files:**
- Modify: `supabase/functions/sync-orchestrate/index.ts` (STEPS array, after the `'Shopify sales'` entry at ~line 83)

- [ ] **Step 3.1: Add the step**

```ts
  // Advertising: raw order journeys (first/last visit + moments). Additive and
  // isolated — its failure must never block the sales steps that follow.
  { name: 'Shopify attribution', fn: 'shopify-attribution-sync', body: {} },
```

- [ ] **Step 3.2: Deploy the orchestrator**

```bash
npm run sb -- functions deploy sync-orchestrate
```

- [ ] **Step 3.3: Verify on the next scheduled run** (03:00/10:00/20:00 UTC): `sync_runs.steps` includes `Shopify attribution` with `status: 'ok'`.

```sql
select started_at, steps from sync_runs order by started_at desc limit 1;
```

- [ ] **Step 3.4: Commit**

```bash
git add supabase/functions/sync-orchestrate/index.ts
git commit -m "feat(advertising): register attribution step in the orchestrator"
```

---

### Task 4: Backfill — comparable period first, then history

**GATE: spec §8 paso 0 — Mario confirmed the Meta UTM convention with Kieran.**

- [ ] **Step 4.1: Backfill 6-ago → today** (the comparable period), one call:

`POST { backfill: { from: '2026-08-06', to: '<today>' } }`

- [ ] **Step 4.2: Verify coverage of the comparable period**

```sql
select count(distinct l.order_id) orders_sales, count(distinct a.order_id) orders_attr
from shopify_sales_lines l
left join shopify_order_attribution a using (order_id)
where l.order_date >= '2026-08-06';
```
Expected: orders_attr = orders_sales (± órdenes ready=false recientes).

- [ ] **Step 4.3: Backfill history month by month, newest first** (2026-07, 2026-06, … 2025-07), one call per month, off-peak, watching `pages`/`capped` in each response (a capped month is re-run with a narrower window). During this step, record the exact date where Meta's `utm_campaign` flips from `{{campaign_name}}` to numeric IDs (spec §3) — one query at the end:

```sql
select min(order_date) from shopify_order_attribution
where last_utm_source in ('facebook','fb','ig') and last_utm_campaign ~ '^[0-9]+$';
```

- [ ] **Step 4.4: Final verification (acceptance §9)**

```sql
-- coverage by month: attribution rows vs orders that sold
select to_char(l.order_date, 'YYYY-MM') m,
       count(distinct l.order_id) sales, count(distinct a.order_id) attr
from shopify_sales_lines l left join shopify_order_attribution a using (order_id)
group by 1 order by 1;
-- journey shape sanity
select ready, count(*), round(avg(moments_count),1) avg_moments from shopify_order_attribution group by 1;
```
Expected: attr ≈ sales per month (frozen pre-jul-2026 history lives only as far back as orders exist in Shopify); no month at 0.

- [ ] **Step 4.5: Migration doc update + commit + handover note**

```bash
git add supabase/migrations/20260808100000_advertising_attribution_tables.sql
git commit -m "docs(advertising): backfill verified — coverage figures in the migration doc"
```

**Exit criterion (gates Plan 3):** cobertura por mes verificada y la fecha del flip `{{campaign_name}}`→ID documentada.

---

## Self-review (done at write time)

- **Spec coverage:** Bloque 1 completo (tablas crudas + moments + retry ready=false + backfill + aceptación §9). El date-gate y los buckets NO son de este plan (motor, Plan 4). El gate de gobernancia (paso 0) está delante del backfill, como exige la spec.
- **Placeholders:** ninguno; función y SQL completos.
- **Type consistency:** `attrRow`/`momentRows` producen exactamente las columnas de la migración; `onConflict` coincide con las PKs; el retry usa el índice parcial `pending_idx`.
