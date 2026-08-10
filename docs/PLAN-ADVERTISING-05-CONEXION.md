# Advertising Tab — Plan 5: Wire the Tab to Real Data

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Advertising tab stops rendering the mock and renders `advertising_dashboard` — real Meta + Google numbers, with a date range, loading/error states, and Juan's Google spend form.

**Architecture:** The mock's interfaces ARE the contract and the RPC already returns that shape, so wiring is a swap: types move to their own module, `AdvertisingTab` fetches via `supabase.rpc('advertising_dashboard', { p_from, p_to })` and passes the result into the same presentational components. The mock stays in the repo as a fixture (empty-state/dev fallback), not as the source. Nothing outside `src/components/advertising*` and `App.tsx` is touched.

**Tech Stack:** React + TS, `supabase.rpc` (house pattern: `WebUpgradeTab.tsx:307`), date presets from `@/lib/storeDate` (`STORE_DATE_PRESETS`, `storeToday` — Brisbane calendar, same as the B2C explorer), shadcn/ui + recharts already in the tab.

**Branch:** `feat/advertising-tab`.

**Facts the implementer needs (verified 2026-08-10):**
- RPC live: `advertising_dashboard(p_from date, p_to date) returns jsonb`, SECURITY DEFINER, granted to `authenticated` (NOT anon — the tab is behind login, fine).
- Runtime: ~0.1s for 5 days, ~1.2s for 30 days, ~15s for 12 months. The tab must default to a SHORT window and warn before long ones.
- Real data coverage: store journeys from 2025-07; Google spend from **2026-06-25**; Google paid/organic separable only from **2026-08-06** (date gate). Meta spend: all 13 months.
- A day whose spend is incomplete (either platform missing) returns `mer: null, spendAud: null` — the chart already renders that as a gap (`connectNulls={false}`).

---

### Task 1: Extract the contract types

**Files:**
- Create: `src/components/advertising/types.ts`
- Modify: `src/components/advertising/mockData.ts` (import the types, keep the fixture)
- Modify: `src/components/AdvertisingTab.tsx` (import types from the new module)

- [ ] **Step 1.1:** Move every `export interface` (`MerPoint`, `ChannelCampaign`, `ChannelView`, `GoogleBucketRow`, `AdvertisingMock`) verbatim from `mockData.ts` into `types.ts`, renaming ONLY `AdvertisingMock` → `AdvertisingDashboard` (it is no longer a mock — it is the RPC's return type). Add at the top the comment: `// The contract with public.advertising_dashboard(p_from, p_to). Changing a field here means changing that RPC.`
- [ ] **Step 1.2:** `mockData.ts` keeps only `ADVERTISING_MOCK` and imports its type: `import type { AdvertisingDashboard } from './types';` + `export const ADVERTISING_MOCK: AdvertisingDashboard = {...}` unchanged.
- [ ] **Step 1.3:** `npx tsc -b --noEmit` → exit 0. Commit: `refactor(advertising): extract the RPC contract types from the mock`.

---

### Task 2: Fetch real data in the tab

**Files:**
- Modify: `src/components/AdvertisingTab.tsx`

- [ ] **Step 2.1: Range state + presets.** Add at the top of `AdvertisingTab`:

```tsx
const PRESETS = STORE_DATE_PRESETS;                    // from '@/lib/storeDate'
const DEFAULT = PRESETS.find((p) => p.label === '30 days')!.range();
const [range, setRange] = useState<{ from: string; to: string }>(DEFAULT);
const [data, setData] = useState<AdvertisingDashboard | null>(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | null>(null);
```
(If `STORE_DATE_PRESETS` has no exact `'30 days'` label, use the closest and say so in the commit message — do not invent a preset.)

- [ ] **Step 2.2: The fetch** (house pattern, cancel-safe like `B2CSalesPanel`):

```tsx
useEffect(() => {
  let cancelled = false;
  setLoading(true); setError(null);
  supabase.rpc('advertising_dashboard', { p_from: range.from, p_to: range.to })
    .then(({ data: res, error: err }) => {
      if (cancelled) return;
      if (err) { setError(err.message); setData(null); }
      else setData(res as AdvertisingDashboard);
      setLoading(false);
    });
  return () => { cancelled = true; };
}, [range.from, range.to]);
```

- [ ] **Step 2.3: Replace the mock banner with the real controls.** Delete the amber "MAQUETA · números falsos" pill and the `ADVERTISING_MOCK` import from the component. In its place, the preset buttons + two `<input type="date">` (copy the markup from `B2CSalesPanel.tsx`'s controls block, same classes), and to the right a small muted line: `{data ? `${data.from} → ${data.to}` : ''}`.

- [ ] **Step 2.4: States.** While `loading && !data`: `<p className="text-sm text-muted-foreground animate-pulse">Cargando…</p>`. On `error`: the red Card pattern from `B2CSalesPanel.tsx`. When `data` exists and `loading` is true, wrap the content in `className={cn('space-y-4', loading && 'opacity-60')}` (same as the B2C panel). Replace every `m.` reference with `data.`; the three view branches stay as they are.

- [ ] **Step 2.5: Long-window guard.** If the selected window is > 92 days, show above the content: `<p className="text-[11px] text-amber-700 …">Rangos largos tardan (12 meses ≈ 15 s).</p>` — do not block, just warn.

- [ ] **Step 2.6:** `npx tsc -b --noEmit` and `npm run build` → both exit 0. Commit: `feat(advertising): tab reads advertising_dashboard instead of the mock`.

---

### Task 3: Honest-data notes in the UI

**Files:** `src/components/AdvertisingTab.tsx`

The tab must not let a reader mistake a coverage boundary for a business fact (spec §2 principio 3 and §5).

- [ ] **Step 3.1:** In the **Google** view, above `GoogleBuckets`, when `range.from < '2026-08-06'`: a muted line — `Antes del 6-ago Google pago y orgánico eran indistinguibles (sin UTMs): ese tramo aparece como “google mixto”, no como orgánico.`
- [ ] **Step 3.2:** In the **Google** view, when `range.from < '2026-06-25'`: `Google no gastó nada antes del 25-jun-2026.`
- [ ] **Step 3.3:** In the **Dirección** view, under the MER chart, keep the existing "días sin gasto cargado" line and add: `Las órdenes de los últimos 2-3 días pueden aparecer sin recorrido: Shopify tarda en procesarlo. El contador “sin journey” lo muestra.`
- [ ] **Step 3.4:** Typecheck + build + commit: `feat(advertising): coverage caveats visible in the tab`.

---

### Task 4: Google spend form (Juan's manual load)

**Files:**
- Create: `src/components/advertising/GoogleSpendForm.tsx`
- Modify: `src/components/AdvertisingTab.tsx` (render it in the Google view)

- [ ] **Step 4.1:** A compact form: date (`<input type="date">`, default `storeToday()`), three number inputs (one per campaign: brand-search / non-brand / shopping — labels exactly those enum values), optional claimed conversions + claimed value per campaign, and a Save button. It posts ONE call per non-empty campaign row to the edge function:

```ts
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-ads-load`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${session?.access_token}`,   // REAL session — the function rejects the anon key
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ rows }),                        // no `actor`: the function derives it from the session
});
```
- [ ] **Step 4.2:** On success show `Guardado (N filas)` and call the tab's refetch; on 4xx render the function's `errors[]` list verbatim (they are already row-specific and human-readable); on 401 show `Tu sesión expiró — recargá la página.`
- [ ] **Step 4.3:** Empty campaign inputs are OMITTED from `rows` (not sent as 0) — the null-never-0 rule reaches the UI.
- [ ] **Step 4.4:** Typecheck + build + commit: `feat(advertising): Google spend entry form wired to google-ads-load`.

---

### Task 5: Visual validation (the gate)

- [ ] **Step 5.1:** `preview_start` with `aim2026-dev`; Mario logs in (the assistant cannot type passwords) and opens **Advertising**.
- [ ] **Step 5.2:** Check against these known-good figures for **2026-08-06 → 2026-08-10** (measured 2026-08-10, they will drift as data syncs — the shape is what matters): MER 3.04 · gasto A$25.763,59 · ventas A$78.200,45 · doble conteo 1,74 · overlap 12 · CAC A$43,82. Meta: gasto 23.650,02 / reclama 52.548,72 / tienda 29.699,80. Google: gasto 2.113,57 / reclama 11.261,81 / tienda 6.999,54.
- [ ] **Step 5.3:** Switch views, change presets, confirm the MER chart shows the gap on days with incomplete spend, and that a long range warns.
- [ ] **Step 5.4:** Screenshot the three views for the record; fix whatever Mario flags; final commit.

**Exit criterion:** Mario says the tab is right. Then: `superpowers:finishing-a-development-branch` for the merge decision (this branch has carried Plans 1-5).

---

## Self-review (done at write time)

- **Coverage:** every mock-rendered block gets real data; the caveats the spec demands are on screen; Juan's write path is wired to the authenticated loader built in Plan 3.
- **Placeholders:** none — each step has its code or an exact instruction plus the file to copy the pattern from.
- **Type consistency:** `AdvertisingDashboard` is the single name after Task 1; the RPC's keys are unchanged, so no renames ripple into the presentational components.
- **Out of scope (v2, per spec §6):** AI panel, first-click UI beyond the existing columns, Shopify Analytics manual reconciliation (a checkpoint with Mario, recorded in Plan 4).
