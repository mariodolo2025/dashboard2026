# Advertising Tab — Plan 3: Spend & Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What each platform spent and claims to have sold, per campaign per day, in new tables — Meta by API (account level exists; campaign level is new), Google by validated manual/CSV load until its API token arrives (spec Bloque 2).

**Architecture:** `meta-ads-campaign-sync` mirrors the proven `meta-ads-sync` (native currency per row, omni_purchase last-wins, UPSERT-never-delete, per-account error isolation) at `level=campaign`, keyed (date, account_id, campaign_id). `google_ads_daily` is written only through a validating loader function (closed campaign enum — never free text). A SQL view `ad_spend_unified` gives the motor one spend series in AUD. Nothing existing is modified except ONE additive orchestrator entry.

**Tech Stack:** Supabase edge functions (Deno TS), Meta Graph API v25.0 insights, migration via MCP `apply_migration`, deploys via `npm run sb -- functions deploy <fn>`.

**Branch:** `feat/advertising-tab`.

**Deferred (not tasks here):** Google Ads API developer-token application (Mario/Juan, external); Juan's historical Google CSV load (the loader from Task 3 is ready whenever the file arrives); the tab's manual-entry form (Plan 5 wires it to the Task 3 loader).

---

### Task 1: Migration — spend tables + unified view

**Files:**
- Create (doc): `supabase/migrations/20260809120000_advertising_spend_tables.sql`
- Apply via MCP `apply_migration`, name `advertising_spend_tables`

- [ ] **Step 1.1: Apply**

```sql
-- Advertising Bloque 2 — spend & claims (spec DESIGN-ADVERTISING-TAB §4).
-- New tables only. meta_ads_daily (account level) stays untouched and remains
-- the authoritative spend total; campaign level is ADDITIVE detail.

create table public.meta_ads_campaign_daily (
  date date not null,
  account_id text not null,
  campaign_id text not null,
  campaign_name text,
  currency text,                      -- native per row, like meta_ads_daily
  spend numeric not null default 0,
  claimed_purchases numeric not null default 0,
  claimed_value numeric not null default 0,   -- omni_purchase value, native currency
  synced_at timestamptz not null default now(),
  primary key (date, account_id, campaign_id)
);
create index meta_ads_campaign_daily_date_idx on public.meta_ads_campaign_daily (date);

create table public.google_ads_daily (
  date date not null,
  -- Closed set, aligned to the store-side buckets. 'shopping' crosses against
  -- the proxy bucket product_sync/sag_organic (spec Bloque 3). NEVER free text.
  campaign text not null check (campaign in ('brand-search', 'non-brand', 'shopping')),
  spend_aud numeric,                  -- null = not loaded (never 0 for missing)
  claimed_conversions numeric,
  claimed_value_aud numeric,          -- AUD, conversion-time date (panel "Conv. value")
  source text not null default 'manual' check (source in ('manual', 'csv', 'api')),
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (date, campaign)
);
-- A DAY WITH NO ROW = "not loaded" -> the motor must render MER as null for
-- that day, never compute with partial spend (regla dura: null nunca 0).

create table public.meta_ads_campaign_sync_state (
  id int primary key default 1 check (id = 1),
  last_run_at timestamptz,
  last_run_status text,
  rows_total bigint
);

alter table public.meta_ads_campaign_daily enable row level security;
alter table public.google_ads_daily enable row level security;
alter table public.meta_ads_campaign_sync_state enable row level security;
-- Service-role writes only; future RPC reads as SECURITY DEFINER (Plan 4).

-- One AUD spend series for the motor. Meta converts USD rows at the month's
-- rate with latest-known fallback (fx_fallback_latest_known_rate convention);
-- AU rows are already AUD. Google is loaded in AUD directly.
create view public.ad_spend_unified as
select m.date, 'meta'::text as platform,
       sum(case when m.currency = 'USD'
                then m.spend * coalesce(r.rate, (select rate from public.currency_exchange_rates
                                                 order by year desc, month desc limit 1))
                else m.spend end) as spend_aud
from public.meta_ads_daily m
left join public.currency_exchange_rates r
       on r.year = extract(year from m.date)::int and r.month = extract(month from m.date)::int
group by m.date
union all
select g.date, 'google'::text, sum(g.spend_aud)
from public.google_ads_daily g
where g.spend_aud is not null
group by g.date;
```

- [ ] **Step 1.2: Verify** — `select * from ad_spend_unified order by date desc limit 5;` returns Meta rows (Google empty until loads). Counts of the three tables = 0, no errors.

- [ ] **Step 1.3: Repo doc file with header (house style, apply date + spec pointer) + commit**

```bash
git add supabase/migrations/20260809120000_advertising_spend_tables.sql
git commit -m "feat(advertising): spend tables — meta campaign level, google manual, unified view"
```

---

### Task 2: Edge function `meta-ads-campaign-sync` + orchestrator step

**Files:**
- Create: `supabase/functions/meta-ads-campaign-sync/index.ts`
- Modify: `supabase/functions/sync-orchestrate/index.ts` (ONE additive entry after `'Meta ads'`)

- [ ] **Step 2.1: Write the function**

```ts
// Meta ads campaign sync (Advertising Bloque 2 — DB-first, mirrors
// meta-ads-sync at level=campaign). Native currency per row; omni_purchase
// last-wins (probe-verified convention); UPSERT never delete; per-account
// error isolation; success:false on any account error so the orchestrator
// flags the step while healthy accounts stay committed.
//
//   {}              -> incremental: trailing LOOKBACK_DAYS re-pull (attribution revisions)
//   {since, until}  -> backfill an explicit range
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const V = 'v25.0';
const LOOKBACK_DAYS = 30;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return isNaN(n) ? 0 : n; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json().catch(() => ({}));
    const today = new Date();
    const until: string = body.until ?? ymd(today);
    const since: string = body.since ?? ymd(new Date(today.getTime() - LOOKBACK_DAYS * 86400000));
    if (since > until) return json({ error: 'since > until' }, 400);

    const { data: creds } = await supabase.from('api_credentials').select('ad_account_ids, access_token').eq('provider', 'meta').maybeSingle();
    if (!creds?.access_token || !creds?.ad_account_ids) throw new Error('Meta credentials not configured');
    const token = creds.access_token as string;
    const accounts = String(creds.ad_account_ids).split(',').map((s) => s.trim()).filter(Boolean);

    type Row = { date: string; account_id: string; campaign_id: string; campaign_name: string | null; currency: string; spend: number; claimed_purchases: number; claimed_value: number };
    const rows: Row[] = [];
    const perAccount: Record<string, { pages: number; rows: number; err: string | null }> = {};

    for (const acct of accounts) {
      let pages = 0, count = 0, err: string | null = null;
      let next: string | null = `https://graph.facebook.com/${V}/${acct}/insights?` + new URLSearchParams({
        access_token: token, level: 'campaign', time_increment: '1',
        time_range: JSON.stringify({ since, until }),
        fields: 'campaign_id,campaign_name,spend,account_currency,actions,action_values', limit: '500',
      });
      while (next && pages < 40) {
        const r = await fetch(next, { signal: AbortSignal.timeout(25000) });
        if (!r.ok) { err = `${r.status}: ${(await r.text()).slice(0, 200)}`; break; }
        const j = await r.json();
        for (const row of (j.data || [])) {
          const date = String(row.date_start || '').slice(0, 10);
          const cid = String(row.campaign_id || '');
          if (!date || !cid) continue;
          // Same convention as the account-level sync: single omni_* entry per
          // action type when no attribution breakdown is requested — last wins,
          // never sum (summing double-counts).
          let value = 0, purchases = 0;
          for (const av of (row.action_values || [])) if (av.action_type === 'omni_purchase') value = num(av.value);
          for (const a of (row.actions || [])) if (a.action_type === 'omni_purchase') purchases = num(a.value);
          rows.push({
            date, account_id: acct, campaign_id: cid,
            campaign_name: row.campaign_name ?? null,
            currency: row.account_currency || 'USD',
            spend: r2(num(row.spend)), claimed_purchases: Math.round(purchases), claimed_value: r2(value),
          });
          count++;
        }
        next = j.paging?.next ?? null; pages++;
      }
      if (next && !err) err = `pagination cap hit at ${pages} pages (truncated)`;
      perAccount[acct] = { pages, rows: count, err };
    }

    const failed = Object.entries(perAccount).filter(([, a]) => a.err).map(([acct, a]) => `${acct}: ${a.err}`);
    const partialErr = failed.length ? failed.join('; ') : null;
    if (rows.length === 0 && partialErr) throw new Error(partialErr);

    // UPSERT, never delete — same reasoning as meta-ads-sync: spend is final,
    // re-pulls only revise attribution, and a failed account must never wipe
    // a healthy account's window.
    for (let i = 0; i < rows.length; i += 500) {
      const { error: upErr } = await supabase.from('meta_ads_campaign_daily').upsert(rows.slice(i, i + 500), { onConflict: 'date,account_id,campaign_id' });
      if (upErr) throw new Error(`upsert: ${upErr.message}`);
    }

    const { count } = await supabase.from('meta_ads_campaign_daily').select('*', { count: 'exact', head: true });
    await supabase.from('meta_ads_campaign_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: partialErr ? `partial: ${partialErr}` : 'ok', rows_total: count ?? null });

    return json({ ok: true, success: !partialErr, since, until, upserted: rows.length, rows_total: count, perAccount, partialError: partialErr });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from('meta_ads_campaign_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: `error: ${msg}` });
    return json({ error: msg }, 500);
  }
});
```

- [ ] **Step 2.2: Orchestrator entry** — in `sync-orchestrate/index.ts`, immediately AFTER `{ name: 'Meta ads', fn: 'meta-ads-sync', body: {} }`:

```ts
  // Advertising: campaign-level Meta detail (claimed vs actual per campaign).
  { name: 'Meta campaigns', fn: 'meta-ads-campaign-sync', body: {} },
```

- [ ] **Step 2.3: Deploy both, run once, acceptance check**

```bash
npm run sb -- functions deploy meta-ads-campaign-sync
npm run sb -- functions deploy sync-orchestrate
```
Invoke `meta-ads-campaign-sync` with `{}` (anon-key curl, same as before). Acceptance (the powerful one): **campaign sums must reconcile with the account-level table**:
```sql
select m.date, m.account_id, m.spend acct_spend, c.spend camp_spend,
       round(abs(m.spend - c.spend), 2) diff
from meta_ads_daily m
join (select date, account_id, sum(spend) spend from meta_ads_campaign_daily group by 1,2) c
  using (date, account_id)
where m.date >= current_date - 30
order by diff desc limit 10;
```
Expected: diffs ≈ 0 (cents of rounding). Record the max diff. Any systematic gap = ISSUE, stop and report.

- [ ] **Step 2.4: Commit** (function + orchestrator, message `feat(advertising): meta campaign-level spend sync + orchestrator step`)

---

### Task 3: Edge function `google-ads-load` (the validated write path)

**Files:**
- Create: `supabase/functions/google-ads-load/index.ts`

- [ ] **Step 3.1: Write the function**

```ts
// Google Ads manual/CSV load (Advertising Bloque 2). The ONLY write path into
// google_ads_daily until the Google Ads API token arrives. Validates hard:
// closed campaign enum, YYYY-MM-DD dates, non-negative numbers. Upsert by
// (date, campaign); missing days are simply absent (motor renders MER null).
//
//   POST { actor: 'juan', rows: [{ date, campaign, spend_aud,
//          claimed_conversions?, claimed_value_aud? }] }
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const CAMPAIGNS = ['brand-search', 'non-brand', 'shopping'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const actor = typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 40) : null;
    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!actor) return json({ success: false, message: 'actor is required' }, 400);
    if (!rows?.length) return json({ success: false, message: 'rows[] is required' }, 400);
    if (rows.length > 500) return json({ success: false, message: 'max 500 rows per call' }, 400);

    const clean: any[] = [];
    const errors: string[] = [];
    rows.forEach((r: any, i: number) => {
      const date = String(r?.date ?? '');
      const campaign = String(r?.campaign ?? '');
      const spend = r?.spend_aud;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errors.push(`row ${i}: bad date '${date}'`);
      if (!CAMPAIGNS.includes(campaign)) return errors.push(`row ${i}: campaign must be one of ${CAMPAIGNS.join('|')}`);
      const nums: Record<string, number | null> = {};
      for (const k of ['spend_aud', 'claimed_conversions', 'claimed_value_aud']) {
        const v = r?.[k];
        if (v === null || v === undefined || v === '') { nums[k] = null; continue; }
        const n = parseFloat(String(v));
        if (isNaN(n) || n < 0) return errors.push(`row ${i}: ${k} must be a number >= 0 or null`);
        nums[k] = Math.round(n * 100) / 100;
      }
      if (spend === null || spend === undefined || spend === '') return errors.push(`row ${i}: spend_aud is required (use 0 for a real zero-spend day)`);
      clean.push({ date, campaign, ...nums, source: 'manual', updated_by: actor, updated_at: new Date().toISOString() });
    });
    if (errors.length) return json({ success: false, message: 'validation failed', errors }, 400);

    const { error } = await supabase.from('google_ads_daily').upsert(clean, { onConflict: 'date,campaign' });
    if (error) return json({ success: false, message: error.message }, 500);
    return json({ success: true, upserted: clean.length, actor });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
```

- [ ] **Step 3.2: Deploy + smoke test + acceptance**

Deploy, then: (a) a valid 2-row load with `actor: 'smoke-test'` → success, rows visible in table and in `ad_spend_unified`; (b) an invalid row (campaign 'Brand Search AU') → 400 with the enum message; (c) re-load same dates with different spend → upsert overwrites, `updated_by`/`updated_at` reflect it. THEN DELETE the smoke rows (`delete from google_ads_daily where updated_by = 'smoke-test'`) — the table must end the task EMPTY of test data.

- [ ] **Step 3.3: Commit** (`feat(advertising): google-ads-load — validated manual spend entry`)

#### Post-review fixes (2026-08-09)

Code review found 2 MEDIUM + 2 LOW issues in the Step 3.1 code; all four applied post-deploy:

- **MEDIUM — auth gate required + server-derived `updated_by`:** the anon key alone was accepted as auth. Now requires a real logged-in user (house pattern from `supabase/functions/invite-user/index.ts`): `Authorization: Bearer <token>` is validated via an anon-key client's `auth.getUser()`; no user → 401 `authentication required`. `updated_by` is derived server-side from the session (`user.email ?? user.id`); the client-supplied `actor` field was removed entirely (validation and response echo both deleted) so the audit trail can no longer be spoofed. DB write still uses the service-role client, unchanged.
- **MEDIUM — payload dedupe, last-wins:** rows are collapsed by `(date, campaign)` with a `Map` before the upsert, last value in the payload wins — consistent with the documented cross-call overwrite semantics. The success response now includes `deduped: <count_removed>`.
- **LOW — real calendar-date validation:** after the `YYYY-MM-DD` regex, each date is re-checked via a `new Date(date + 'T00:00:00Z')` round-trip so overflow/invalid dates (e.g. `2026-13-45`, `2026-02-30`) are rejected instead of silently normalized.
- **LOW — plausible date range:** dates before `2024-01-01` or more than 7 days in the future are rejected.

Note: the smoke tests recorded in Step 3.2 predate the auth gate — they were run with the anon key alone, which the loader no longer accepts. Post-fix, an anon-key call and a call with no `Authorization` header both verified 401 empirically; the success path needs a real dashboard session and will next be exercised when Plan 5's form wires the tab to this loader.

---

### Task 4: Meta campaign backfill (13 months) + verification

- [ ] **Step 4.1:** Backfill month by month, newest first (2026-07 … 2025-07), one `{since, until}` call each (campaign-level rows are ~30-60/day — one page per month; the 40-page cap is far away). Check `success` + `partialError` each call.
- [ ] **Step 4.2: Acceptance** — reconciliation query from Step 2.3 extended to the whole range: max daily |account − Σcampaigns| per month; record the worst month. Also: count of journeys' `last_utm_campaign` (numeric Meta IDs, from `shopify_order_attribution`) that JOIN a `campaign_id` in `meta_ads_campaign_daily` — report the match rate (expected high post-6-ago; lower in the `{{campaign_name}}` minority).
- [ ] **Step 4.3:** Append coverage + reconciliation figures to the migration doc header; commit (`docs(advertising): meta campaign backfill verified`).

---

## Self-review (done at write time)

- **Spec coverage:** Bloque 2 completo salvo lo explícitamente diferido (API Google = trámite externo; form del tab = Plan 5; CSV histórico de Juan = cuando exista el archivo, vía Task 3). `ad_spend_unified` definida. Regla null-nunca-0 encodeada en tabla y loader.
- **Placeholders:** ninguno.
- **Type consistency:** columnas de las tablas = campos que escriben las funciones; onConflict = PKs; enum del loader = check de la tabla = buckets de la spec.
