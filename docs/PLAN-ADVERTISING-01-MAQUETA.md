# Advertising Tab — Plan 1: Static Mockup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete Advertising tab rendered with realistic fake numbers, registered in the dashboard, so Mario and Juan approve every screen BEFORE any pipeline is built (spec §8 paso 2).

**Architecture:** Two new files (mock data module + tab component) plus three small edits to register the tab in App.tsx. The mock data module's TypeScript interfaces ARE the contract: the future RPC (Plan 4) must return exactly this shape, so wiring later means swapping one import. No DB, no edge functions, no new deps.

**Tech Stack:** React + TypeScript + Vite, shadcn/ui (Card, Button, Dialog), recharts (already in the repo), Tailwind. Spec: `docs/DESIGN-ADVERTISING-TAB.md` (v2.1). Verification: `npx tsc -b --noEmit` + visual check in the dev server (`.claude/launch.json` → `aim2026-dev`). The repo has no unit-test runner; executable acceptance tests start in Plan 2 (SQL, per spec §9).

**Branch:** all work on `feat/advertising-tab` (Task 0). Nothing existing may break: this plan only ADDS files and three additive edits to App.tsx (spec §2 principio 0).

---

### Task 0: Branch

**Files:** none (git only)

- [ ] **Step 0.1: Create the branch from the current one**

```bash
cd "C:/PROYECTS/AIM 2026"
git checkout -b feat/advertising-tab
git branch --show-current
```
Expected output: `feat/advertising-tab`

---

### Task 1: Mock data module (the future RPC contract)

**Files:**
- Create: `src/components/advertising/mockData.ts`

- [ ] **Step 1.1: Write the module**

Numbers are realistic, taken from the handover facts (budgets 50/170/345 AUD/day, Meta ~$46.93 CPA, google-total baseline ~USD 2.1k/day ≈ AUD 3.0k). Every figure the tab shows comes from here — nothing hardcoded in the component.

```ts
// =============================================================================
// Advertising tab — mock data & types
// =============================================================================
// These interfaces are the CONTRACT with the future advertising RPC (Plan 4):
// it must return exactly this shape. The numbers are fake but realistic, for
// the visual-approval stage (spec §8 paso 2). Money is AUD, dates Brisbane.

export interface MerPoint {
  d: string;                 // 'YYYY-MM-DD'
  revenueAud: number;        // Net sales ex tax (same figure as E-commerce tab)
  spendAud: number | null;   // null = Google spend not loaded that day
  mer: number | null;        // null when spendAud is null/incomplete — never 0
}

export interface ChannelCampaign {
  campaign: string;          // Meta: campaign name · Google: brand-search | non-brand | shopping
  spendAud: number;
  claimedValueAud: number;   // what the platform's panel claims
  storeLastClickAud: number; // what the store recognises (last non-direct)
  storeFirstClickAud: number;// sales this campaign INITIATED
  note?: string;             // e.g. shopping proxy caveat
}

export interface ChannelView {
  key: 'meta' | 'google';
  label: string;
  spendAud: number;
  claimedAud: number;
  storeLastAud: number;
  storeFirstAud: number;
  campaigns: ChannelCampaign[];
}

export interface GoogleBucketRow {
  bucket: string;
  orders: number;
  revenueAud: number;
  note?: string;
}

export interface AdvertisingMock {
  from: string;
  to: string;
  blended: {
    spendAud: number;
    revenueAud: number;
    mer: number;
    claimedTotalAud: number;     // Meta claims + Google claims, summed
    doubleCountRatio: number;    // claimedTotal / real attributed revenue
    overlapOrders: number;       // journeys touched by BOTH paid platforms
    cacBlended: number;          // spend ÷ first-time-customer orders
    newCustomerOrders: number;
    unclassifiedOrders: number;  // UTM drift alarm (spec §7)
    noJourneyOrders: number;     // ready=false aged out (spec Bloque 1)
  };
  merSeries: MerPoint[];
  channels: ChannelView[];
  googleBuckets: GoogleBucketRow[];
}

const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 7, 6 + n)); // 2026-08-06 + n
  return d.toISOString().slice(0, 10);
};

// 14 days, 6–19 Aug. Revenue ~16-18k/day, Meta ~1.9k/day, Google ~0.6k/day.
export const ADVERTISING_MOCK: AdvertisingMock = {
  from: day(0),
  to: day(13),
  blended: {
    spendAud: 34_820,
    revenueAud: 236_400,
    mer: 6.79,
    claimedTotalAud: 97_300,
    doubleCountRatio: 1.42,
    overlapOrders: 31,
    cacBlended: 38.9,
    newCustomerOrders: 895,
    unclassifiedOrders: 12,
    noJourneyOrders: 4,
  },
  merSeries: Array.from({ length: 14 }, (_, i) => {
    const revenue = 15_500 + Math.round(3_000 * Math.sin(i / 2.1)) + i * 120;
    // Day 12-13: Google spend not loaded yet -> MER null, chart shows the gap
    const spend = i >= 12 ? null : 2_380 + Math.round(260 * Math.sin(i / 1.7));
    return {
      d: day(i),
      revenueAud: revenue,
      spendAud: spend,
      mer: spend === null ? null : Math.round((revenue / spend) * 100) / 100,
    };
  }),
  channels: [
    {
      key: 'meta',
      label: 'Meta',
      spendAud: 26_900,
      claimedAud: 78_400,
      storeLastAud: 52_300,
      storeFirstAud: 68_900,
      campaigns: [
        { campaign: 'HD Shower Screen — Campaign NEW Videos', spendAud: 11_200, claimedValueAud: 36_800, storeLastClickAud: 24_100, storeFirstClickAud: 31_500 },
        { campaign: 'AUS De\u2019Longhi Sales Campaign — Video', spendAud: 8_400, claimedValueAud: 24_300, storeLastClickAud: 16_800, storeFirstClickAud: 21_200 },
        { campaign: 'US Prospecting — Broad', spendAud: 7_300, claimedValueAud: 17_300, storeLastClickAud: 11_400, storeFirstClickAud: 16_200 },
      ],
    },
    {
      key: 'google',
      label: 'Google',
      spendAud: 7_920,
      claimedAud: 18_900,
      storeLastAud: 14_600,
      storeFirstAud: 6_100,
      campaigns: [
        { campaign: 'brand-search', spendAud: 700, claimedValueAud: 6_200, storeLastClickAud: 5_900, storeFirstClickAud: 1_200 },
        { campaign: 'non-brand', spendAud: 4_830, claimedValueAud: 7_400, storeLastClickAud: 5_100, storeFirstClickAud: 3_600 },
        { campaign: 'shopping', spendAud: 2_390, claimedValueAud: 5_300, storeLastClickAud: 3_600, storeFirstClickAud: 1_300, note: 'proxy product_sync/sag_organic — mezcla free listings hasta el tagueo limpio' },
      ],
    },
  ],
  googleBuckets: [
    { bucket: 'Google brand (pago)', orders: 58, revenueAud: 5_900 },
    { bucket: 'Google non-brand (pago)', orders: 49, revenueAud: 5_100 },
    { bucket: 'Google Shopping (proxy)', orders: 34, revenueAud: 3_600, note: 'incluye free listings' },
    { bucket: 'Google orgánico (SEO)', orders: 412, revenueAud: 41_800, note: 'baseline bucket google total jul-2026: ~AUD 3,0k/día (pago sin tag + orgánico, convertido de USD)' },
  ],
};
```

- [ ] **Step 1.2: Typecheck**

```bash
cd "C:/PROYECTS/AIM 2026" && npx tsc -b --noEmit
```
Expected: exit 0, no output.

- [ ] **Step 1.3: Commit**

```bash
git add src/components/advertising/mockData.ts
git commit -m "feat(advertising): mock data module — the future RPC contract"
```

---

### Task 2: AdvertisingTab component — vista dirección (blended)

**Files:**
- Create: `src/components/AdvertisingTab.tsx`

- [ ] **Step 2.1: Write the component with the blended view**

Follows the house style of `B2CSalesPanel.tsx` (local StatCard, recharts ComposedChart, fmtAud helpers). Every stat card carries its definition in `sub` — spec principle 5. The MER chart must show the day-12/13 gap (null spend ⇒ no MER line), proving the "incomplete day" rule visually.

```tsx
// =============================================================================
// Advertising tab — mini Triple Whale (STATIC MOCKUP)
// =============================================================================
// Spec: docs/DESIGN-ADVERTISING-TAB.md (v2.1). This stage renders MOCK data
// only (spec §8 paso 2): the screens get approved before any pipeline exists.
// The data shape is the RPC contract — see advertising/mockData.ts.

import { useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip as RTooltip, CartesianGrid,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  ADVERTISING_MOCK, type ChannelView, type MerPoint,
} from '@/components/advertising/mockData';

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');
const fmtX = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(2)}×`;

function StatCard({ label, value, sub, accent, warn }: {
  label: string; value: string; sub: string; accent?: string; warn?: boolean;
}) {
  return (
    <Card className="relative overflow-hidden p-4 border border-border/60">
      {accent && (
        <div className="absolute inset-x-0 top-0 h-[2px] opacity-70"
             style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
      )}
      <p className="text-xs font-medium tracking-wide uppercase text-muted-foreground mb-2 truncate">{label}</p>
      <p className={cn('text-2xl font-semibold tracking-tight tabular-nums leading-none',
                       warn && 'text-amber-600 dark:text-amber-400')}>{value}</p>
      {/* The definition lives ON the card (spec §2.5) — no hidden formulas. */}
      <p className="text-[11px] text-muted-foreground/70 leading-tight mt-1.5">{sub}</p>
    </Card>
  );
}

function MerChart({ series }: { series: MerPoint[] }) {
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
          <XAxis dataKey="d" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }}
                 axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis yAxisId="money" tick={{ fontSize: 11 }} axisLine={false} tickLine={false}
                 width={56} tickFormatter={(v: number) => fmtAud(v)} />
          <YAxis yAxisId="mer" orientation="right" tick={{ fontSize: 11 }} axisLine={false}
                 tickLine={false} width={40} tickFormatter={(v: number) => `${v}×`} />
          <RTooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as MerPoint;
              return (
                <div className="rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md space-y-0.5">
                  <div className="font-medium">{String(label)}</div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Revenue</span><span className="tabular-nums">{fmtAud(p.revenueAud)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Spend</span><span className="tabular-nums">{p.spendAud === null ? 'incompleto' : fmtAud(p.spendAud)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">MER</span><span className="tabular-nums font-medium" style={{ color: '#f59e0b' }}>{p.mer === null ? '— (gasto sin cargar)' : fmtX(p.mer)}</span></div>
                </div>
              );
            }}
          />
          <Bar yAxisId="money" dataKey="revenueAud" fill="#3b82f6" radius={[4, 4, 0, 0]} name="revenue" />
          <Bar yAxisId="money" dataKey="spendAud" fill="#94a3b8" radius={[4, 4, 0, 0]} name="spend" />
          {/* connectNulls=false ON PURPOSE: a day without loaded spend must show
              a hole, never a fake MER (spec Bloque 2: null, nunca 0). */}
          <Line yAxisId="mer" type="monotone" dataKey="mer" stroke="#f59e0b" strokeWidth={2}
                dot={false} connectNulls={false} name="mer" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function AdvertisingTab() {
  const [view, setView] = useState<'direccion' | 'meta' | 'google'>('direccion');
  const m = ADVERTISING_MOCK;

  return (
    <div className="space-y-4">
      {/* ── Mock banner + view switch (surfaces, not toggles per metric) ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          {([['direccion', 'Dirección'], ['meta', 'Meta'], ['google', 'Google']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={cn('rounded-md px-3 py-1 text-xs font-medium transition-colors',
                view === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300/60 rounded-full px-2.5 py-0.5">
          MAQUETA · números falsos · {m.from} → {m.to}
        </span>
      </div>

      {view === 'direccion' && (
        <div className="space-y-4">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="MER" value={fmtX(m.blended.mer)} accent="#f59e0b"
              sub="Ventas netas ÷ gasto total (Meta+Google). No depende de ninguna atribución: es el árbitro." />
            <StatCard label="Gasto total" value={fmtAud(m.blended.spendAud)} accent="#94a3b8"
              sub="Meta (API) + Google (carga de Juan). AUD." />
            <StatCard label="Ventas netas" value={fmtAud(m.blended.revenueAud)} accent="#3b82f6"
              sub="Mismo número que el tab E-commerce (net ex tax, AUD, día Brisbane)." />
            <StatCard label="Doble conteo" value={`${m.blended.doubleCountRatio.toFixed(2)}×`} warn accent="#ef4444"
              sub={`Las plataformas reclaman ${fmtAud(m.blended.claimedTotalAud)} — se pisan entre sí. Reclamado ÷ reconocido.`} />
            <StatCard label="Overlap" value={fmtNum(m.blended.overlapOrders)} accent="#8b5cf6"
              sub="Órdenes con Meta Y Google pagos en el mismo recorrido — el corazón de la discusión." />
            <StatCard label="CAC blended" value={fmtAud(m.blended.cacBlended)} accent="#10b981"
              sub={`Gasto ÷ ${fmtNum(m.blended.newCustomerOrders)} clientes nuevos (1ª compra).`} />
          </div>

          <Card className="p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              MER diario · revenue vs spend
            </h3>
            <MerChart series={m.merSeries} />
            <p className="text-[11px] text-muted-foreground/70 mt-2">
              Los días sin gasto de Google cargado no calculan MER (hueco en la línea) — nunca un cero falso.
            </p>
          </Card>

          <p className="text-[11px] text-muted-foreground/70">
            Regla de lectura: nuestra medición <b>subcuenta</b> (no ve view-through ni cross-device),
            las plataformas <b>sobrecuentan</b> (se pisan). La verdad queda acotada entre ambas.
            {' '}Sin clasificar: {fmtNum(m.blended.unclassifiedOrders)} órdenes (drift de UTM) ·
            sin journey: {fmtNum(m.blended.noJourneyOrders)}.
          </p>
        </div>
      )}

      {view === 'meta' && <ChannelPanel ch={m.channels[0]} />}
      {view === 'google' && (
        <div className="space-y-4">
          <ChannelPanel ch={m.channels[1]} />
          <GoogleBuckets rows={m.googleBuckets} />
        </div>
      )}
    </div>
  );
}
```

(`ChannelPanel` and `GoogleBuckets` are Task 3 — the file will not compile until Task 3 is done; Tasks 2 and 3 commit together.)

---

### Task 3: Channel view + Google buckets (same file)

**Files:**
- Modify: `src/components/AdvertisingTab.tsx` (append below `AdvertisingTab`)

- [ ] **Step 3.1: Append the two section components**

```tsx
/** One paid channel: what it spent, what it claims, what the store recognises.
 *  The two ROAS side by side ARE the product — never show only one. */
function ChannelPanel({ ch }: { ch: ChannelView }) {
  const gap = ch.claimedAud - ch.storeLastAud;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
      <StatCard label="Gasto" value={fmtAud(ch.spendAud)} accent="#94a3b8"
        sub={ch.key === 'google' ? 'Carga manual de Juan hasta que llegue la API.' : 'API de Meta, por campaña.'} />
      <StatCard label={`${ch.label} reclama`} value={fmtAud(ch.claimedAud)} accent="#ef4444"
        sub="Lo que declara el panel de la plataforma (su pixel, sus ventanas, view-through incluido)." />
      <StatCard label="La tienda le reconoce" value={fmtAud(ch.storeLastAud)} accent="#3b82f6"
        sub="Last click no-directo medido en las órdenes reales — la vara común." />
      <StatCard label="Brecha" value={fmtAud(gap)} warn accent="#f59e0b"
        sub="Reclamado − reconocido. No es error: es view-through + pisadas con el otro canal." />
      <StatCard label="Inició" value={fmtAud(ch.storeFirstAud)} accent="#8b5cf6"
        sub="First click: ventas cuyo PRIMER contacto fue este canal, las cierre quien las cierre." />
      </div>

      <Card className="p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Por campaña · dos varas lado a lado
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Campaña</th>
              <th className="text-right font-medium pb-1.5">Gasto</th>
              <th className="text-right font-medium pb-1.5">Reclama</th>
              <th className="text-right font-medium pb-1.5">ROAS panel</th>
              <th className="text-right font-medium pb-1.5">Tienda (cerró)</th>
              <th className="text-right font-medium pb-1.5">ROAS tienda</th>
              <th className="text-right font-medium pb-1.5">Inició</th>
            </tr>
          </thead>
          <tbody>
            {ch.campaigns.map((c) => (
              <tr key={c.campaign} className="border-t border-border/40">
                <td className="py-1.5">
                  <span className="font-medium">{c.campaign}</span>
                  {c.note && <span className="block text-[10px] text-amber-700 dark:text-amber-400">{c.note}</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtAud(c.claimedValueAud)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtX(c.claimedValueAud / c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(c.storeLastClickAud)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtX(c.storeLastClickAud / c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.storeFirstClickAud)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Google split by bucket — only meaningful from 6-Aug-2026 (spec date-gate). */
function GoogleBuckets({ rows }: { rows: { bucket: string; orders: number; revenueAud: number; note?: string }[] }) {
  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Google por bucket · desde el 6-ago
      </h3>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Antes del 6-ago Google pago y orgánico eran un solo bucket (sin UTMs): esa historia se
        muestra aparte como “google mixto”, nunca como orgánico.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium pb-1.5">Bucket</th>
            <th className="text-right font-medium pb-1.5">Órdenes</th>
            <th className="text-right font-medium pb-1.5">Net AUD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bucket} className="border-t border-border/40">
              <td className="py-1.5">
                {r.bucket}
                {r.note && <span className="block text-[10px] text-muted-foreground/70">{r.note}</span>}
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmtNum(r.orders)}</td>
              <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(r.revenueAud)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
```

- [ ] **Step 3.2: Typecheck**

```bash
cd "C:/PROYECTS/AIM 2026" && npx tsc -b --noEmit
```
Expected: exit 0. If `ChannelView` import errors, confirm Task 1 exported it.

- [ ] **Step 3.3: Commit (Tasks 2+3 together — the file only compiles complete)**

```bash
git add src/components/AdvertisingTab.tsx
git commit -m "feat(advertising): static mockup tab — direccion/meta/google views"
```

---

### Task 4: Register the tab in App.tsx (three additive edits)

**Files:**
- Modify: `src/App.tsx:146` (modal union type)
- Modify: `src/App.tsx:~2012` (nav button, after the Web Upgrade button)
- Modify: `src/App.tsx:~3485` (Dialog, after the Web Upgrade Dialog)

- [ ] **Step 4.1: Add `'advertising'` to the union at line 146**

Before:
```tsx
const [activeModal, setActiveModal] = useState<'channel' | 'brand' | 'top-skus' | 'sales-evolution' | 'aim' | 'aim-2026' | 'ecommerce' | 'web-upgrade' | 'b2c-explorer' | 'fy-report' | null>(null);
```
After:
```tsx
const [activeModal, setActiveModal] = useState<'channel' | 'brand' | 'top-skus' | 'sales-evolution' | 'aim' | 'aim-2026' | 'ecommerce' | 'web-upgrade' | 'b2c-explorer' | 'fy-report' | 'advertising' | null>(null);
```

- [ ] **Step 4.2: Add the import next to the other tab imports (~line 32)**

```tsx
import AdvertisingTab from '@/components/AdvertisingTab';
```

- [ ] **Step 4.3: Add the nav button immediately AFTER the Web Upgrade button (closes ~line 2012)**

Same pattern as its siblings:
```tsx
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'advertising' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'advertising' ? null : 'advertising')}
              >
                Advertising
              </Button>
```

- [ ] **Step 4.4: Add the Dialog immediately AFTER the Web Upgrade Dialog (closes ~line 3485)**

```tsx
        {/* Advertising modal (Meta vs Google, own attribution) */}
        <Dialog open={activeModal === 'advertising'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Advertising</DialogTitle>
              <DialogDescription>Meta vs Google — medición propia (maqueta)</DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              <AdvertisingTab />
            </div>
          </DialogContent>
        </Dialog>
```

- [ ] **Step 4.5: Typecheck + build**

```bash
cd "C:/PROYECTS/AIM 2026" && npx tsc -b --noEmit && npm run build
```
Expected: both exit 0.

- [ ] **Step 4.6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(advertising): register the Advertising tab in the dashboard nav"
```

---

### Task 5: Visual validation (the gate)

**Files:** none

- [ ] **Step 5.1: Start the dev server** (`preview_start` with name `aim2026-dev`, from `.claude/launch.json`).

- [ ] **Step 5.2: Mario logs in** (his credentials; the assistant cannot type passwords) and opens the **Advertising** button in the nav.

- [ ] **Step 5.3: Checklist to review with Mario/Juan** — each view against the spec:
  - Dirección: MER + 6 tarjetas con definición legible · hueco de MER en los días 18-19 (gasto sin cargar) · contadores de sin-clasificar/sin-journey.
  - Meta: 5 tarjetas + tabla con DOS ROAS lado a lado.
  - Google: ídem + buckets con la nota del date-gate y el proxy de Shopping.
  - ¿Falta una vista/número que el review mensual necesite? ¿Sobra algo?

- [ ] **Step 5.4: Iterate on feedback** (edits to mockData/AdvertisingTab only), re-check, then final commit:

```bash
git add -A src/components/advertising src/components/AdvertisingTab.tsx
git commit -m "feat(advertising): mockup adjustments from Mario/Juan review"
```

**Exit criterion (gates Plan 2):** Mario dice "maqueta aprobada". Recién ahí se
diseñan las migraciones del Bloque 1 (Plan 2: captura de atribución), porque la
maqueta define qué números hacen falta de verdad.

---

## Self-review (done at write time)

- **Spec coverage (this stage):** §8 paso 2 completo; principios 0 (solo archivos nuevos + 3 edits aditivos), 2 (claimed al lado de reconocido), 3 (regla de lectura en pantalla), 5 (definición en cada tarjeta) representados en la maqueta. Los bloques 1-3 NO son de este plan (Planes 2-4).
- **Placeholders:** ninguno — todo el código está completo en los pasos.
- **Type consistency:** `ChannelView`/`MerPoint` exportados en Task 1, importados en Task 2; `ChannelPanel`/`GoogleBuckets` definidos en Task 3 y usados en Task 2 (mismo archivo, compila al cierre de Task 3 — por eso commitean juntos.
