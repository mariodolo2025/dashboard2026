// =============================================================================
// Growth forecast — ad budget → demand → production plan.
//
// Answers one question: if we raise the advertising budget, what has to be in
// production, in which month, to supply the demand that budget creates.
//
// Three rules this report is built on, each of them a correction of how the
// question is usually asked:
//
//  1. SPEND AND SALES ARE NOT PROPORTIONAL. Revenue follows spend^b with b
//     fitted from 12 months of our own data (0.74, R² 0.89). Assuming a straight
//     line would have us produce roughly twice what we need.
//  2. THE ANSWER IS A DATE, NOT A QUANTITY. The 54mm screen takes 45 days, so
//     stock wanted in November has to start in September. Every quantity here
//     carries the month it must start.
//  3. MEASURED AND PROJECTED NEVER SHARE A TABLE. Each block is tagged, because
//     the whole point is knowing which numbers are facts.
//
// Data comes from ONE call to growth_forecast_report(); the projection itself
// (elasticity dial, horizon, ramp, production runs) is computed here because it
// is interactive. Thresholds (break-even 1.42 / target 2.77) are READ from the
// Advertising tab's unit economics, never recalculated, so the two screens can
// never disagree.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot,
} from 'recharts';
import {
  RefreshCw, HelpCircle, Download, TrendingUp, Factory, CalendarClock,
  Truck, FileText, BookOpen, AlertTriangle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { cn, downloadCSV } from '@/lib/utils';

// ─── Payload ────────────────────────────────────────────────────────────────

interface Product {
  sku: string; name: string; share: number; price: number;
  stock: number; lead: number; cost: number; assembled: boolean;
}
interface Payload {
  baselineMonths: number; lookbackDays: number;
  baseline: { spend: number; revenue: number; mer: number };
  fit: { b: number; r2: number; n: number; excluded: string[] };
  history: { month: string; spend: number; revenue: number; mer: number; excluded: boolean }[];
  unitEconomics: { cm1: number; breakevenMer: number; targetMer: number; month: string; source: string } | null;
  products: Product[];
  us: {
    orders: number; aov: number; windowDays: number;
    thresholds: { threshold: number; orders: number; giveUp: number }[];
    nudge: { orders: number; avgGap: number };
  };
  shipping: { market: string; orders: number; costPerParcel: number; chargedPerParcel: number }[];
}

type Tab = 'now' | 'proj' | 'prod' | 'cal' | 'ship' | 'memo' | 'help';

const TABS: { id: Tab; label: string; icon: any }[] = [
  { id: 'now',  label: 'Where we are',    icon: FileText },
  { id: 'proj', label: 'The projection',  icon: TrendingUp },
  { id: 'prod', label: 'Production plan', icon: Factory },
  { id: 'cal',  label: 'Calendar',        icon: CalendarClock },
  { id: 'ship', label: 'Shipping',        icon: Truck },
  { id: 'memo', label: 'Memo',            icon: FileText },
  { id: 'help', label: 'Help',            icon: BookOpen },
];

// ─── Formatting ─────────────────────────────────────────────────────────────

const aud  = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;
const audk = (v: number) =>
  Math.abs(v) >= 10000 ? `$${Math.round(v / 1000)}k`
  : Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : aud(v);
const usd  = (v: number) => `US$${Math.round(v).toLocaleString('en-AU')}`;
const usdk = (v: number) => (Math.abs(v) >= 1000 ? `US$${Math.round(v / 1000)}k` : usd(v));
const num  = (v: number) => Math.round(v).toLocaleString('en-AU');
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Label for month `i` ahead of today. */
function monthLabel(i: number) {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() + i);
  return `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

// ─── Small pieces ───────────────────────────────────────────────────────────

/** Every figure states whether it was measured or projected. Mixing the two
 *  silently is what makes a forecast impossible to argue with. */
function Prov({ kind }: { kind: 'measured' | 'projected' }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider',
      kind === 'measured'
        ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
        : 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
    )}>{kind}</span>
  );
}

function Stat({ label, value, sub, tone, tip }: {
  label: string; value: string; sub?: string;
  tone?: 'ok' | 'warn' | 'risk' | 'accent'; tip?: string;
}) {
  const toneCls = tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'risk' ? 'text-red-600 dark:text-red-400'
    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'accent' ? 'text-amber-700 dark:text-amber-400' : '';
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-mono uppercase tracking-wider text-muted-foreground">{label}</span>
        {tip && <HelpCircle size={11} className="text-muted-foreground/50 shrink-0" aria-label={tip}><title>{tip}</title></HelpCircle>}
      </div>
      <div className={cn('mt-1.5 font-mono text-2xl font-semibold tabular-nums tracking-tight', toneCls)}>{value}</div>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

/** Dotted-underline label carrying its definition. Used on every column header
 *  and figure that would otherwise need explaining in a footnote. */
function T({ tip, children }: { tip: string; children: React.ReactNode }) {
  return <span title={tip} className="cursor-help border-b border-dotted border-muted-foreground/50">{children}</span>;
}

// ─── Model ──────────────────────────────────────────────────────────────────

interface Row { i: number; label: string; opening: number; sells: number; arrives: number; closing: number; started: number }
interface Start { month: number; label: string; qty: number; cost: number; leadM: number }
interface Plan extends Product {
  leadM: number; rows: Row[]; starts: Start[];
  totalQty: number; totalCost: number; minCover: number; coverNow: number; coverAfter: number;
}

export function GrowthForecastContent() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('now');
  const [spend, setSpend] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [linear, setLinear] = useState(false);
  const [horizon, setHorizon] = useState(6);
  const [topN, setTopN] = useState(10);
  const [openSku, setOpenSku] = useState<string | null>(null);
  const [thr, setThr] = useState(100);
  const [nudgePct, setNudgePct] = useState(0);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { data: d, error: e } = await supabase.rpc('growth_forecast_report', {});
      if (e) throw new Error(e.message);
      const p = d as Payload;
      setData(p);
      // Seed the controls once, from the data itself — a 50% step is the
      // question people actually arrive with.
      setSpend((s) => s ?? Math.round((p.baseline.spend * 1.5) / 1000) * 1000);
      setB((v) => v ?? p.fit.b);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const S = useMemo(() => {
    if (!data || spend === null || b === null) return null;
    const bb = linear ? 1 : b;
    const base = data.baseline;
    const ratio = spend / base.spend;
    const revenue = base.revenue * Math.pow(ratio, bb);
    const extraSpend = spend - base.spend;
    const extraRev = revenue - base.revenue;
    const cm1 = data.unitEconomics?.cm1 ?? 0.706;
    return {
      bb, ratio, revenue, extraSpend, extraRev, cm1,
      mer: revenue / spend,
      // Return on the LAST dollar, not the average. This is the number that
      // says when to stop; the average always looks better than the margin.
      marginal: extraSpend !== 0 ? extraRev / extraSpend : (bb * revenue) / spend,
      contribution: extraRev * cm1 - extraSpend,
      list: data.products.slice(0, topN),
    };
  }, [data, spend, b, linear, topN]);

  const months = useMemo(() => {
    if (!S || !data) return [];
    const out: { i: number; label: string; spend: number; rev: number }[] = [];
    for (let i = 1; i <= horizon; i++) {
      const sp = data.baseline.spend + (spend! - data.baseline.spend) * (i / horizon);
      out.push({ i, label: monthLabel(i), spend: sp,
                 rev: data.baseline.revenue * Math.pow(sp / data.baseline.spend, S.bb) });
    }
    return out;
  }, [S, data, spend, horizon]);

  /** Running balance per product, and the runs that keep it above water.
   *
   *  The decision looks FORWARD: a run started now only lands in `leadM`
   *  months, so what matters is whether stock plus what is already in transit
   *  covers consumption until then, plus a month of buffer. Judging on today's
   *  closing balance starts the run a month late and lets stock bottom out
   *  while it is still in production. */
  const plans = useMemo<Plan[]>(() => {
    if (!S || !data) return [];
    return S.list.map((s) => {
      const leadM = Math.max(1, Math.round(s.lead / 30));
      const arriving: Record<number, number> = {};
      const rows: Row[] = []; const starts: Start[] = [];
      let stock = s.stock;
      for (const p of months) {
        const opening = stock;
        const sells = (p.rev * s.share) / s.price;
        const arrives = arriving[p.i] ?? 0;
        const closing = opening + arrives - sells;
        let inbound = 0;
        for (let j = p.i + 1; j <= p.i + leadM; j++) inbound += arriving[j] ?? 0;
        let started = 0;
        if (closing + inbound < sells * (leadM + 1)) {
          started = Math.ceil((sells * 3 - closing - inbound) / 50) * 50;
          if (started > 0) {
            arriving[p.i + leadM] = (arriving[p.i + leadM] ?? 0) + started;
            starts.push({ month: p.i, label: p.label, qty: started, cost: started * s.cost, leadM });
          } else started = 0;
        }
        rows.push({ i: p.i, label: p.label, opening, sells, arrives, closing, started });
        stock = closing;
      }
      const totalQty = starts.reduce((a, o) => a + o.qty, 0);
      const sellsNow   = (data.baseline.revenue * s.share) / s.price;
      const sellsAfter = (S.revenue * s.share) / s.price;
      return {
        ...s, leadM, rows, starts, totalQty, totalCost: totalQty * s.cost,
        minCover: Math.min(...rows.map((r) => r.closing / Math.max(r.sells, 1e-9))),
        coverNow: s.stock / Math.max(sellsNow, 1e-9),
        coverAfter: s.stock / Math.max(sellsAfter, 1e-9),
      };
    });
  }, [S, data, months]);

  // ── Loading / error ───────────────────────────────────────────────────────
  if (error) return (
    <div className="p-8">
      <Card className="p-6 border-red-200 dark:border-red-900">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <Button onClick={load} size="sm" variant="outline" className="mt-3">Retry</Button>
      </Card>
    </div>
  );
  if (!data || !S) return (
    <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
      <RefreshCw size={16} className="animate-spin" /> Loading forecast…
    </div>
  );

  const ue = data.unitEconomics;
  const BE = ue?.breakevenMer ?? 1.42;
  const TG = ue?.targetMer ?? 2.77;
  const totalQty  = plans.reduce((a, p) => a + p.totalQty, 0);
  const totalCost = plans.reduce((a, p) => a + p.totalCost, 0);
  const firstStart = plans.flatMap((p) => p.starts.map((o) => ({ ...o, sku: p.sku })))
    .sort((a, b2) => a.month - b2.month)[0];

  // ── Shipping threshold: interpolate the measured table ────────────────────
  const thrSorted = [...data.us.thresholds].sort((a, b2) => a.threshold - b2.threshold);
  const exact = thrSorted.find((x) => x.threshold === thr);
  let giveUp: number, freeOrders: number;
  if (exact) { giveUp = exact.giveUp; freeOrders = exact.orders; }
  else {
    const lo = [...thrSorted].reverse().find((x) => x.threshold <= thr) ?? thrSorted[0];
    const hi = thrSorted.find((x) => x.threshold >= thr) ?? thrSorted[thrSorted.length - 1];
    const f = hi.threshold === lo.threshold ? 0 : (thr - lo.threshold) / (hi.threshold - lo.threshold);
    giveUp = lo.giveUp + (hi.giveUp - lo.giveUp) * f;
    freeOrders = lo.orders + (hi.orders - lo.orders) * f;
  }
  const yearFactor = 365 / data.us.windowDays;
  const nudgeLifted = data.us.nudge.orders * (nudgePct / 100);
  const nudgeGain = nudgeLifted * data.us.nudge.avgGap * S.cm1 * yearFactor;

  const curveData = (() => {
    const maxX = Math.max(spend! * 1.3, data.baseline.spend * 1.8);
    const pts: any[] = [];
    for (let i = 0; i <= 40; i++) {
      const sp = (maxX * i) / 40;
      pts.push({
        spend: Math.round(sp),
        fitted: sp > 0 ? data.baseline.revenue * Math.pow(sp / data.baseline.spend, S.bb) : 0,
        straight: data.baseline.mer * sp,
      });
    }
    return pts;
  })();

  const exportPlan = () => downloadCSV(
    plans.flatMap((p) => p.starts.map((o) => ({
      sku: p.sku, name: p.name, month: o.label, qty: o.qty, cost: o.cost, lead: p.lead,
    }))),
    'production-plan.csv',
    [
      { header: 'SKU', key: 'sku' }, { header: 'Product', key: 'name' },
      { header: 'Start month', key: 'month' },
      { header: 'Units', key: 'qty', formatter: (v) => String(v) },
      { header: 'Cost AUD', key: 'cost', formatter: (v) => (v as number).toFixed(2) },
      { header: 'Lead days', key: 'lead', formatter: (v) => String(v) },
    ]
  );

  return (
    <div className="mx-auto max-w-[1180px] px-6 pb-16">
      {/* ── Masthead ───────────────────────────────────────────────────── */}
      <header className="pt-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-400">
          Reports · Growth &amp; Supply
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Spend to Stock</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
          Move the ad budget and see what it takes to supply the demand it creates — what to put
          into production, in which month, and what it costs.
        </p>
      </header>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <Card className="mt-6 overflow-hidden reports-no-print">
        <div className="border-b px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground">
          Inputs
        </div>
        <div className="grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-5 lg:divide-x">
          <div className="p-4">
            <label htmlFor="gf-spend" className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              New ad spend / month
            </label>
            <input id="gf-spend" type="number" step={5000} min={20000} value={spend!}
              onChange={(e) => setSpend(Math.max(1, +e.target.value || 0))}
              className="w-full rounded border bg-muted/40 px-2.5 py-1.5 font-mono text-base font-semibold tabular-nums" />
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {S.extraSpend === 0 ? 'Same as today'
                : `${S.extraSpend > 0 ? '+' : '−'}${audk(Math.abs(S.extraSpend))} (${S.extraSpend > 0 ? '+' : ''}${((S.ratio - 1) * 100).toFixed(0)}%)`}
            </p>
          </div>
          <div className="p-4">
            <label htmlFor="gf-method" className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Sales response
            </label>
            <select id="gf-method" value={linear ? 'linear' : 'fit'}
              onChange={(e) => setLinear(e.target.value === 'linear')}
              className="w-full rounded border bg-muted/40 px-2.5 py-1.5 text-[13px]">
              <option value="fit">Fitted curve</option>
              <option value="linear">Straight line</option>
            </select>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {linear ? 'Assumes MER never drops. Our data disagrees.' : 'Diminishing returns, fitted to our months.'}
            </p>
          </div>
          <div className={cn('p-4', linear && 'opacity-40')}>
            <label htmlFor="gf-b" className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              <T tip="How much sales respond to budget. 0.74 means every 10% more spend returns 7.4% more revenue. Fitted from 12 months of our own data.">Elasticity (b)</T>
            </label>
            <div className="font-mono text-base font-semibold tabular-nums">{S.bb.toFixed(2)}</div>
            <input id="gf-b" type="range" min={0.3} max={1} step={0.01} value={b!} disabled={linear}
              onChange={(e) => setB(+e.target.value)} className="mt-1 w-full accent-amber-600" />
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Fitted {data.fit.b.toFixed(2)} · R² {data.fit.r2.toFixed(2)} · {data.fit.n} months
            </p>
          </div>
          <div className="p-4">
            <label htmlFor="gf-h" className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Horizon</label>
            <select id="gf-h" value={horizon} onChange={(e) => setHorizon(+e.target.value)}
              className="w-full rounded border bg-muted/40 px-2.5 py-1.5 text-[13px]">
              <option value={3}>3 months</option><option value={6}>6 months</option><option value={12}>12 months</option>
            </select>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">Budget ramps evenly.</p>
          </div>
          <div className="p-4">
            <span className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Products covered</span>
            <div className="flex overflow-hidden rounded border">
              {[10, 25, 50].map((n) => (
                <button key={n} onClick={() => { setTopN(n); setOpenSku(null); }}
                  aria-pressed={topN === n}
                  className={cn('flex-1 border-r px-2 py-1.5 font-mono text-xs last:border-r-0',
                    topN === n ? 'bg-amber-600 font-semibold text-white' : 'bg-muted/40 text-muted-foreground hover:text-foreground')}>
                  {n}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              = {(S.list.reduce((a, s) => a + s.share, 0) * 100).toFixed(0)}% of revenue
            </p>
          </div>
        </div>
      </Card>

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <nav className="mt-7 flex flex-wrap border-b reports-no-print" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 font-mono text-[11.5px] uppercase tracking-wider',
              tab === t.id ? 'border-amber-600 text-amber-700 dark:text-amber-400'
                           : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </nav>

      {/* ══ WHERE WE ARE ══════════════════════════════════════════════ */}
      {tab === 'now' && (
        <section className="pt-6">
          <div className="mb-1 flex items-baseline gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Where we are</h2><Prov kind="measured" />
          </div>
          <p className="mb-5 max-w-3xl text-[13px] text-muted-foreground">
            Nothing on this screen is a forecast. These are the numbers the projection starts from.
          </p>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ad spend / month" value={audk(data.baseline.spend)}
              sub={`AUD · Meta · avg of ${data.baselineMonths} months`}
              tip="Average Meta spend over the last complete months. USD accounts converted at the month's rate." />
            <Stat label="Store revenue / month" value={audk(data.baseline.revenue)} sub="AUD · ex tax"
              tip="Shopify net revenue over the same months, excluding sales tax." />
            <Stat label="MER" value={`${data.baseline.mer.toFixed(2)}×`} sub="Revenue per ad dollar"
              tip="Total store revenue ÷ total ad spend. Unlike Meta's ROAS it counts every sale, not only the ones Meta can claim." />
            <Stat label="Break-even MER" value={`${BE.toFixed(2)}×`}
              sub={ue ? `CM1 ${(ue.cm1 * 100).toFixed(1)}% · ${ue.month}` : '—'}
              tone={data.baseline.mer >= BE ? 'ok' : 'risk'}
              tip="Below this MER each sale loses money. 1 ÷ contribution margin, read from the Advertising tab's unit economics — never recalculated here." />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Spend and revenue by month</span>
                <Prov kind="measured" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b">
                    {['Month','Ad spend','Revenue','MER',''].map((h, i) => (
                      <th key={h + i} className={cn('px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
                        i === 0 ? 'text-left' : 'text-right')}>{h}</th>))}
                  </tr></thead>
                  <tbody>
                    {data.history.map((h) => (
                      <tr key={h.month} className="border-b last:border-0">
                        <td className="px-3 py-1.5">{h.month}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{audk(h.spend)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{audk(h.revenue)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{h.mer.toFixed(2)}×</td>
                        <td className="px-3 py-1.5 text-right">
                          {h.excluded && (
                            <span title="Excluded from the elasticity fit: that month was the product changeover, not saturation."
                              className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                              excluded
                            </span>)}
                        </td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Shipping · cost vs recovery</span>
                <Prov kind="measured" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b">
                    {['Market','Cost / parcel','Charged','Net'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
                        i === 0 ? 'text-left' : 'text-right')}>{h}</th>))}
                  </tr></thead>
                  <tbody>
                    {data.shipping.map((s) => {
                      const net = s.chargedPerParcel - s.costPerParcel;
                      return (
                        <tr key={s.market} className="border-b last:border-0">
                          <td className="px-3 py-1.5">{s.market}<span className="block text-[11px] text-muted-foreground">{num(s.orders)} parcels</span></td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums">{aud(s.costPerParcel)}</td>
                          <td className="px-3 py-1.5 text-right font-mono tabular-nums">{aud(s.chargedPerParcel)}</td>
                          <td className={cn('px-3 py-1.5 text-right font-mono tabular-nums',
                            net < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                            {net < 0 ? '−' : '+'}{aud(Math.abs(net))}
                          </td>
                        </tr>);
                    })}
                  </tbody>
                </table>
              </div>
              <p className="border-t px-4 py-2.5 text-[11.5px] text-muted-foreground">
                Cost is real Xero spend split by destination with Starshipit ratios — Starshipit's own
                freight figure under-captured DHL eCommerce by $105k and is not used for money.
              </p>
            </Card>
          </div>
        </section>
      )}

      {/* ══ PROJECTION ════════════════════════════════════════════════ */}
      {tab === 'proj' && (
        <section className="pt-6">
          <div className="mb-1 flex items-baseline gap-3">
            <h2 className="text-lg font-semibold tracking-tight">The projection</h2><Prov kind="projected" />
          </div>
          <p className="mb-5 max-w-3xl text-[13px] text-muted-foreground">
            What the new budget returns, and whether the last dollar of it still pays.
          </p>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Revenue / month" value={audk(S.revenue)} tone="accent"
              sub={`${((S.revenue / data.baseline.revenue - 1) * 100).toFixed(1)}% vs today`}
              tip="Today's revenue × (new spend ÷ today's spend) ^ elasticity." />
            <Stat label="MER after" value={`${S.mer.toFixed(2)}×`}
              tone={S.mer >= TG ? 'ok' : S.mer >= BE ? 'warn' : 'risk'}
              sub={`${data.baseline.mer.toFixed(2)}× today`}
              tip="Projected revenue ÷ new spend. Falls as budget rises: that is what an elasticity below 1.00 means." />
            <Stat label="Return on the extra spend" value={`$${S.marginal.toFixed(2)}`}
              tone={S.marginal >= TG ? 'ok' : S.marginal >= BE ? 'warn' : 'risk'}
              sub={S.marginal >= BE ? `Clears break-even (${BE.toFixed(2)})` : `BELOW break-even (${BE.toFixed(2)})`}
              tip="Extra revenue ÷ extra spend — what the last dollar returns, not the average. This is the number that says when to stop." />
            <Stat label="Extra contribution / month"
              value={`${S.contribution < 0 ? '−' : ''}${audk(Math.abs(S.contribution))}`}
              tone={S.contribution >= 0 ? 'ok' : 'risk'} sub="After ad spend and variable cost"
              tip="Extra revenue × contribution margin − extra ad spend. What reaches the bottom line each month, before fixed costs." />
          </div>

          <Card className="mb-4 p-4">
            <div className="mb-3 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Efficiency against the two thresholds
            </div>
            <div className="relative h-7 overflow-hidden rounded border bg-muted/40">
              <div className="absolute inset-y-0 left-0 bg-amber-500/20" style={{ width: `${Math.min(100, (S.mer / 4) * 100)}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-red-500" style={{ left: `${(BE / 4) * 100}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-amber-500" style={{ left: `${(TG / 4) * 100}%` }} />
              <div className="absolute -inset-y-1 w-1 rounded bg-foreground" style={{ left: `${Math.min(99, (S.mer / 4) * 100)}%` }} />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>0</span><span>break-even {BE.toFixed(2)}</span><span>target {TG.toFixed(2)}</span><span>4.0</span>
            </div>
            <p className="mt-3 max-w-3xl text-[12.5px] text-muted-foreground">
              {S.mer < BE ? <><b className="text-red-600 dark:text-red-400">Below break-even.</b> At this budget the store loses money on the marginal sale.</>
              : S.mer < TG ? <><b className="text-amber-600 dark:text-amber-400">Between the two lines.</b> Each sale contributes, but at this efficiency the business is not covering fixed costs plus the target margin.</>
              : <><b className="text-emerald-600 dark:text-emerald-400">Above target.</b> This budget clears both thresholds.</>}
            </p>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Revenue response to spend</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">b = {S.bb.toFixed(2)}</span>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={curveData} margin={{ top: 6, right: 10, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.28} />
                <XAxis dataKey="spend" type="number" domain={['dataMin', 'dataMax']}
                  tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11 }} width={52} />
                <Tooltip formatter={(v: any, n: any) => [aud(v), n === 'fitted' ? 'Fitted' : 'Straight line']}
                  labelFormatter={(v) => `Spend ${aud(v as number)}`} />
                <Line dataKey="straight" stroke="#94a3b8" strokeDasharray="4 4" dot={false} strokeWidth={1.4} name="straight" />
                <Line dataKey="fitted" stroke="#b45309" dot={false} strokeWidth={2.2} name="fitted" />
                <Scatter data={data.history.map((h) => ({ spend: h.spend, fitted: h.revenue, ex: h.excluded }))}
                  dataKey="fitted" fill="#475569" />
                <ReferenceDot x={spend!} y={S.revenue} r={5} fill="#b45309" stroke="#fff" strokeWidth={2} />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              Dots are actual months. The dashed line is what a constant MER would give; the gap
              between the two at your chosen budget is what the elasticity is costing you.
            </p>
          </Card>
        </section>
      )}

      {/* ══ PRODUCTION ════════════════════════════════════════════════ */}
      {tab === 'prod' && (
        <section className="pt-6">
          <div className="mb-1 flex items-baseline gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Production plan</h2><Prov kind="projected" />
            <Button size="sm" variant="outline" onClick={exportPlan} className="ml-auto reports-no-print">
              <Download size={13} className="mr-1.5" /> CSV
            </Button>
          </div>
          <p className="mb-5 max-w-3xl text-[13px] text-muted-foreground">
            Units to put into production each month. Click any product to open its running balance.
          </p>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Units to produce" value={num(totalQty)} tone="accent"
              sub={`Across ${plans.filter((p) => p.totalQty > 0).length} of ${plans.length} products`}
              tip="Total units to start across the selected products over the horizon." />
            <Stat label="Production cost" value={audk(totalCost)} sub="AUD · ex freight and duty"
              tip="Units × China factory cost. Freight, duty and insurance add roughly 12.4% on landing." />
            <Stat label="Products at risk" value={String(plans.filter((p) => p.minCover < p.leadM).length)}
              tone={plans.some((p) => p.minCover < p.leadM) ? 'risk' : 'ok'}
              sub="Run below their lead time"
              tip="Products whose cover drops below their lead time at some point — they would go out of stock if nothing is started." />
            <Stat label="Nothing needed" value={String(plans.filter((p) => p.totalQty === 0).length)}
              sub="Covered by current stock" tip="Products whose current stock covers the whole horizon." />
          </div>
          <Card className="overflow-hidden">
            <div className="border-b px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Units to start producing, by month
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="border-b">
                  <th className="px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Product</th>
                  {months.map((m) => (
                    <th key={m.i} className="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{m.label}</th>))}
                  <th className="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total</th>
                  <th className="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Cost</th>
                </tr></thead>
                <tbody>
                  {plans.map((p) => (
                    <>
                      <tr key={p.sku} onClick={() => setOpenSku(openSku === p.sku ? null : p.sku)}
                        className={cn('cursor-pointer border-b hover:bg-muted/40', openSku === p.sku && 'bg-muted/40')}>
                        <td className="px-3 py-2">
                          <span className="text-[13px] font-semibold">{p.sku}</span>
                          {p.assembled && (
                            <span title="Built from components — the plan shows a quantity but the lead time belongs to its parts."
                              className="ml-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">assembled</span>)}
                          <span className="block text-[11px] text-muted-foreground">{p.name}</span>
                        </td>
                        {months.map((m) => {
                          const st = p.starts.find((o) => o.month === m.i);
                          return (
                            <td key={m.i} className={cn('px-3 py-2 text-right font-mono tabular-nums',
                              st ? 'bg-amber-50 font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' : 'text-muted-foreground/40')}>
                              {st ? <span title={`Start ${num(st.qty)} units in ${m.label} — lands about ${st.leadM} month${st.leadM > 1 ? 's' : ''} later.`}>{num(st.qty)}</span> : '·'}
                            </td>);
                        })}
                        <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{p.totalQty ? num(p.totalQty) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{p.totalCost ? audk(p.totalCost) : '—'}</td>
                      </tr>
                      {openSku === p.sku && (
                        <tr key={`${p.sku}-d`} className="border-b bg-muted/30">
                          <td colSpan={months.length + 3} className="p-3">
                            <div className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                              {p.sku} · running balance · lead {p.lead} days
                            </div>
                            <table className="w-full text-[12.5px]">
                              <thead><tr className="border-b">
                                {['Month','Opening','Sells','Arrives','Closing','Start now'].map((h, i) => (
                                  <th key={h} className={cn('px-2 py-1.5 font-mono text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground',
                                    i === 0 ? 'text-left' : 'text-right')}>{h}</th>))}
                              </tr></thead>
                              <tbody>
                                {p.rows.map((r) => (
                                  <tr key={r.i} className="border-b last:border-0">
                                    <td className="px-2 py-1.5">{r.label}</td>
                                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{num(r.opening)}</td>
                                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-red-600 dark:text-red-400">−{num(r.sells)}</td>
                                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.arrives ? `+${num(r.arrives)}` : '·'}</td>
                                    <td className={cn('px-2 py-1.5 text-right font-mono font-semibold tabular-nums',
                                      r.closing < r.sells * p.leadM && 'text-red-600 dark:text-red-400')}>{num(r.closing)}</td>
                                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                                      {r.started ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-400">{num(r.started)}</span> : '·'}
                                    </td>
                                  </tr>))}
                              </tbody>
                            </table>
                          </td>
                        </tr>)}
                    </>
                  ))}
                  <tr className="border-t bg-muted/50 font-semibold">
                    <td className="px-3 py-2">Total</td>
                    {months.map((m) => {
                      const v = plans.reduce((a, p) => a + (p.starts.find((o) => o.month === m.i)?.cost ?? 0), 0);
                      return <td key={m.i} className="px-3 py-2 text-right font-mono tabular-nums">{v ? audk(v) : '·'}</td>;
                    })}
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{num(totalQty)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{audk(totalCost)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </section>
      )}

      {/* ══ CALENDAR ══════════════════════════════════════════════════ */}
      {tab === 'cal' && (
        <section className="pt-6">
          <div className="mb-1 flex items-baseline gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Calendar</h2><Prov kind="projected" />
          </div>
          <p className="mb-5 max-w-3xl text-[13px] text-muted-foreground">
            The same plan read as deadlines. A run started in one month only lands after its lead
            time, so this is the month the order has to leave — not the month it is needed.
          </p>
          <div className="relative space-y-3 pl-7 before:absolute before:bottom-2 before:left-2 before:top-2 before:w-px before:bg-border">
            {months.map((m) => {
              const due = plans.flatMap((p) => p.starts.filter((o) => o.month === m.i)
                .map((o) => ({ sku: p.sku, qty: o.qty, cost: o.cost, lead: p.lead, land: monthLabel(m.i + o.leadM) })));
              const cost = due.reduce((a, o) => a + o.cost, 0);
              return (
                <div key={m.i} className="relative">
                  <span className={cn('absolute -left-[22px] top-4 h-2.5 w-2.5 rounded-full border-2',
                    due.length ? 'border-amber-600 bg-amber-600' : 'border-border bg-background')} />
                  <Card className={cn('p-3.5', due.length && 'border-amber-600/60')}>
                    <div className="mb-2 flex flex-wrap items-baseline gap-2.5">
                      <span className="font-mono text-xs font-semibold uppercase tracking-wider">{m.label}</span>
                      <span className={cn('rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase',
                        due.length ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                                   : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400')}>
                        {due.length ? `${due.length} to start` : 'clear'}
                      </span>
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                        Ad {audk(m.spend)} → Rev {audk(m.rev)}{cost ? ` · Production ${audk(cost)}` : ''}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {due.length ? due.map((o) => (
                        <span key={o.sku} title={`${o.lead}-day lead — lands ${o.land}.`}
                          className="rounded bg-amber-50 px-2 py-1 font-mono text-[11px] tabular-nums text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
                          <b>{num(o.qty)}</b> × {o.sku} <span className="opacity-70">· {audk(o.cost)} · lands {o.land}</span>
                        </span>)) : (
                        <span className="rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">Nothing to start</span>)}
                    </div>
                  </Card>
                </div>);
            })}
          </div>
        </section>
      )}

      {/* ══ SHIPPING ══════════════════════════════════════════════════ */}
      {tab === 'ship' && (
        <section className="pt-6">
          <div className="mb-1 flex items-baseline gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Shipping · the free-shipping threshold</h2>
            <Prov kind="measured" />
          </div>
          <p className="mb-5 max-w-3xl text-[13px] text-muted-foreground">
            US orders over US${data.us.thresholds[0]?.threshold ?? 100} already ship free. This is
            what moving that line costs, and what the orders sitting just below it are worth.
          </p>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4 reports-no-print">
              <label htmlFor="gf-thr" className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Threshold (USD)</label>
              <input id="gf-thr" type="number" min={0} max={200} step={5} value={thr}
                onChange={(e) => setThr(Math.max(0, +e.target.value || 0))}
                className="w-full rounded border bg-muted/40 px-2.5 py-1.5 font-mono text-base font-semibold tabular-nums" />
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">Today: US$100</p>
            </Card>
            <Card className="p-4 reports-no-print">
              <label htmlFor="gf-nudge" className="mb-2 block font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">Nudge conversion</label>
              <div className="font-mono text-base font-semibold tabular-nums">{nudgePct}%</div>
              <input id="gf-nudge" type="range" min={0} max={60} step={5} value={nudgePct}
                onChange={(e) => setNudgePct(+e.target.value)} className="mt-1 w-full accent-amber-600" />
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                <T tip="Share of the orders sitting just below the line that add an item to qualify, if you show them a prompt in the cart.">Of orders just below</T>
              </p>
            </Card>
            <Stat label="Shipping given up" value={usdk(giveUp * yearFactor)}
              tone={giveUp * yearFactor > 60000 ? 'risk' : 'accent'}
              sub={`${num(freeOrders)} orders · ${((100 * freeOrders) / data.us.orders).toFixed(1)}% of US`}
              tip="Shipping revenue given up per year at this threshold, from the measured distribution of US orders." />
            <Stat label="Margin from the nudge" value={nudgePct ? usdk(nudgeGain) : '—'}
              tone={nudgePct ? 'ok' : undefined}
              sub={nudgePct ? `${num(nudgeLifted * yearFactor)} orders lifted / year` : 'Move the dial'}
              tip="Extra margin from orders that lift their basket to reach the threshold, at the contribution margin." />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">What each threshold costs</span>
                <Prov kind="measured" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b">
                    {['Threshold','Orders free','Share','Given up / year'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
                        i === 0 ? 'text-left' : 'text-right')}>{h}</th>))}
                  </tr></thead>
                  <tbody>
                    {data.us.thresholds.map((t) => (
                      <tr key={t.threshold} className={cn('border-b last:border-0', t.threshold === 100 && 'bg-amber-50/60 dark:bg-amber-950/30')}>
                        <td className="px-3 py-1.5">{t.threshold ? `US$${t.threshold}` : 'All free'}
                          {t.threshold === 100 && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[9px] uppercase text-amber-800 dark:bg-amber-900 dark:text-amber-300">today</span>}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(t.orders)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{((100 * t.orders) / data.us.orders).toFixed(1)}%</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums">{usdk(t.giveUp * yearFactor)}</td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card className="p-4">
              <div className="mb-3 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">The orders one step away</div>
              <p className="mb-3 text-sm">
                <b>{num(data.us.nudge.orders)} orders</b> landed between US$75 and US$100 in the last
                {' '}{data.us.windowDays} days — <b>{((100 * data.us.nudge.orders) / data.us.orders).toFixed(1)}%</b> of
                all US orders. They were an average of <b>{usd(data.us.nudge.avgGap)}</b> short of free shipping.
              </p>
              <p className="mb-3 text-[13px] text-muted-foreground">
                An EP basket sells for about US$20. They are one product away from qualifying.
              </p>
              <p className="text-[13px] text-muted-foreground">
                The threshold sits at US$100 against an AOV of <b>{usd(data.us.aov)}</b>. That gap is
                what makes it work as an incentive — lower it and you stop selling the extra item,
                you just stop charging for shipping.
              </p>
            </Card>
          </div>
        </section>
      )}

      {/* ══ MEMO ══════════════════════════════════════════════════════ */}
      {tab === 'memo' && (
        <section className="pt-6">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">Memo</h2>
          <p className="mb-5 text-[13px] text-muted-foreground">One page, ready to send.</p>
          <Card className="p-7">
            <p className="max-w-3xl text-[16px] leading-relaxed">
              Raising ad spend from <b>{audk(data.baseline.spend)}</b> to <b>{audk(spend!)}</b> a month
              projects revenue of <b>{audk(S.revenue)}</b>, up <b>{((S.revenue / data.baseline.revenue - 1) * 100).toFixed(0)}%</b>.
              The gap between those two percentages is the point: the return is real but not
              proportional, and MER falls from {data.baseline.mer.toFixed(2)}× to {S.mer.toFixed(2)}× —
              {S.mer >= TG ? ' still above' : ' below'} the {TG.toFixed(2)}× operating target.
              Supplying it needs <b>{num(totalQty)} units</b> into production across
              {' '}{plans.filter((p) => p.totalQty > 0).length} products, <b>{audk(totalCost)}</b> at
              factory cost, with the first run starting <b>{firstStart ? firstStart.label : '—'}</b>.
            </p>

            <h3 className="mb-3 mt-7 border-b pb-1.5 font-mono text-[11px] uppercase tracking-widest text-amber-700 dark:text-amber-400">What it takes</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="border-b">
                  {['Product','Cover now','Cover after','Produce','Cost','Start by'].map((h, i) => (
                    <th key={h} className={cn('px-3 py-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
                      i === 0 ? 'text-left' : 'text-right')}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {plans.filter((p) => p.totalQty > 0).slice(0, 8).map((p) => (
                    <tr key={p.sku} className="border-b last:border-0">
                      <td className="px-3 py-1.5 font-semibold">{p.sku}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{p.coverNow.toFixed(1)} mo</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        <span className={cn('rounded px-1.5 py-0.5',
                          p.minCover < p.leadM ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400'
                          : p.minCover < 2 ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400')}>
                          {p.coverAfter.toFixed(1)} mo
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{num(p.totalQty)}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{audk(p.totalCost)}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">{p.starts[0]?.label ?? '—'}</td>
                    </tr>))}
                </tbody>
              </table>
            </div>

            <h3 className="mb-3 mt-7 border-b pb-1.5 font-mono text-[11px] uppercase tracking-widest text-amber-700 dark:text-amber-400">What has to be true</h3>
            <ul className="space-y-0">
              {[
                <>
                  <b>The next dollar still pays.</b> At this budget each extra advertising dollar
                  returns ${S.marginal.toFixed(2)} of revenue, against a break-even of ${BE.toFixed(2)} and
                  an operating target of ${TG.toFixed(2)}.
                </>,
                <>
                  <b>Elasticity holds near {S.bb.toFixed(2)}.</b> Fitted across {data.fit.n} months
                  (R² {data.fit.r2.toFixed(2)}), excluding {data.fit.excluded.join(', ')} — the product
                  changeover, which says nothing about saturation. Lower and this over-produces;
                  higher and it under-produces.
                </>,
                <><b>Creative keeps up.</b> More budget against tired creative moves the curve down, not along it.</>,
                <>
                  <b>The cash is available early.</b> {audk(totalCost)} of production is paid before
                  any of it sells, on top of {audk(S.extraSpend)} a month more in ads.
                </>,
                <>
                  <b>One product carries it.</b> {data.products[0]?.sku} is{' '}
                  {((data.products[0]?.share ?? 0) * 100).toFixed(0)}% of revenue and has no substitute
                  if it goes out of stock.
                </>,
              ].map((t, i) => (
                <li key={i} className="relative border-b py-2.5 pl-4 last:border-0 max-w-3xl text-[14px]
                  before:absolute before:left-0 before:top-[18px] before:h-1 before:w-1 before:rounded-full before:bg-amber-600">
                  {t}
                </li>))}
            </ul>
          </Card>
        </section>
      )}

      {/* ══ HELP ══════════════════════════════════════════════════════ */}
      {tab === 'help' && (
        <section className="pt-6">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">Help</h2>
          <p className="mb-5 text-[13px] text-muted-foreground">
            What each concept means, how to read it, and where every number comes from.
          </p>

          <Card className="mb-4 p-6">
            <h3 className="mb-2 text-[17px] font-semibold">Elasticity — the dial marked “b”</h3>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              It is how much sales respond when you move the budget.
              <b className="text-foreground"> At {data.fit.b.toFixed(2)}, every 10% more spend returns
              {' '}{(data.fit.b * 10).toFixed(1)}% more revenue.</b>
            </p>
            <ul className="mb-2.5 max-w-3xl list-disc space-y-1 pl-5 text-muted-foreground">
              <li><b className="text-foreground">1.00</b> — spend twice, sell twice</li>
              <li><b className="text-foreground">{data.fit.b.toFixed(2)}</b> — spend twice, sell {((Math.pow(2, data.fit.b) - 1) * 100).toFixed(0)}% more <i>(fitted to our data)</i></li>
              <li><b className="text-foreground">0.30</b> — spend twice, sell 23% more</li>
            </ul>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              To use it: take the % you want to raise the budget by and multiply by {data.fit.b.toFixed(2)}.
              Up 50% → expect around {((Math.pow(1.5, data.fit.b) - 1) * 100).toFixed(0)}% more sales. Never 50%.
            </p>
            <p className="max-w-3xl text-muted-foreground">
              <b className="text-foreground">Where it comes from:</b> a fit across {data.fit.n} complete
              months of our own spend and revenue. <b className="text-foreground">{data.fit.excluded.join(', ')} is
              deliberately excluded</b> — that month was the product changeover, with no new creative
              and no new budget, so it says nothing about saturation. Including it drags the figure
              down and the fit quality collapses, which is the statistical way of saying that month
              does not belong to the same pattern.
            </p>
          </Card>

          <Card className="mb-4 p-6">
            <h3 className="mb-2 text-[17px] font-semibold">Why spend and sales are not proportional</h3>
            <ul className="mb-2.5 max-w-3xl list-disc space-y-1.5 pl-5 text-muted-foreground">
              <li><b className="text-foreground">Meta shows the ads to the easiest people first.</b> It starts with
                those who already visited or search for coffee gear. They buy cheaply. Give it more
                money and it has to find less interested people, who cost more.</li>
              <li><b className="text-foreground">The same person sees the ad more often.</b> The first time works. The fifth annoys.</li>
              <li><b className="text-foreground">You bid against yourself.</b> More budget in the same auction raises your own CPM.</li>
              <li><b className="text-foreground">The market has a size.</b> There is a finite number of people with a
                Breville who need a shower screen this month.</li>
            </ul>
            <p className="max-w-3xl text-muted-foreground">
              It is like squeezing an orange: the first press gives a lot of juice, the second much
              less, the third almost none. Same orange.
            </p>
          </Card>

          <Card className="mb-4 p-6">
            <h3 className="mb-2 text-[17px] font-semibold">Return on the extra spend — and why the average lies</h3>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              Think of the ads as salespeople. The first one serves the customers already in the shop —
              sells a lot, no effort. The tenth has to go out into the street. Sells far less.
            </p>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              To see how the team is doing you look at the <b className="text-foreground">average</b>. But to decide
              whether to hire the eleventh, the average is useless — you need to know what
              <b className="text-foreground"> that one</b> will sell.
            </p>
            <p className="mb-2.5 rounded border-l-2 border-amber-600 bg-muted/50 px-3.5 py-2.5 font-mono text-[13px]">
              Return on the extra spend = extra revenue ÷ extra spend
            </p>
            <p className="max-w-3xl text-muted-foreground">
              It falls every time you raise the budget. <b className="text-foreground">When it approaches
              break-even, stop.</b>
            </p>
          </Card>

          <Card className="mb-4 p-6">
            <h3 className="mb-2 text-[17px] font-semibold">The two thresholds: {BE.toFixed(2)} and {TG.toFixed(2)}</h3>
            <p className="mb-2.5 rounded border-l-2 border-amber-600 bg-muted/50 px-3.5 py-2.5 font-mono text-[13px]">
              Break-even MER = 1 ÷ contribution margin = 1 ÷ {(ue?.cm1 ?? 0.706).toFixed(3)} = {BE.toFixed(2)}
            </p>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              <b className="text-foreground">Contribution margin</b> is what is left of the price after the costs
              that only exist because you sold one more unit: product landed in Australia, shipping to
              the customer, payment fees, packaging and refunds. Fixed costs — salaries, rent,
              software — are not in here.
            </p>
            <ul className="mb-2.5 max-w-3xl list-disc space-y-1 pl-5 text-muted-foreground">
              <li><b className="text-foreground">{BE.toFixed(2)} — break-even.</b> Below this you lose money on each sale.</li>
              <li><b className="text-foreground">{TG.toFixed(2)} — target.</b> Here you also cover fixed costs and keep the target margin.</li>
            </ul>
            <p className="max-w-3xl text-muted-foreground">
              Both are read straight from the Advertising tab's unit economics
              {ue ? ` (${ue.month})` : ''}. <b className="text-foreground">This report never recalculates them</b>,
              so the two screens can never disagree.
            </p>
          </Card>

          <Card className="mb-4 p-6">
            <h3 className="mb-2 text-[17px] font-semibold">The production plan</h3>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">Each product carries a running balance, month by month:</p>
            <p className="mb-2.5 rounded border-l-2 border-amber-600 bg-muted/50 px-3.5 py-2.5 font-mono text-[13px]">
              opening stock − what sells + what arrives = closing stock
            </p>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              A run starts as soon as stock plus what is already in transit would no longer cover
              consumption until it lands, and it is sized to restore about three months of cover.
              <b className="text-foreground"> What matters is the month it starts, not the month it is
              needed</b> — a 45-day product wanted in November has to be launched in September.
            </p>
            <p className="max-w-3xl text-muted-foreground">
              Products marked <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase">assembled</span> are
              built from components rather than produced: the plan shows the quantity, but the lead
              time belongs to their parts.
            </p>
          </Card>

          <Card className="mb-4 p-6">
            <h3 className="mb-2 text-[17px] font-semibold">Shipping and the free-shipping line</h3>
            <p className="mb-2.5 max-w-3xl text-muted-foreground">
              Costs come from <b className="text-foreground">Xero</b> (what each carrier actually invoiced), split
              across markets using Starshipit, which knows each parcel's destination. Starshipit's own
              freight figure is <b className="text-foreground">not</b> used for money — it under-captured DHL
              eCommerce by $105k.
            </p>
            <ul className="mb-2.5 max-w-3xl list-disc space-y-1 pl-5 text-muted-foreground">
              {data.shipping.map((s) => (
                <li key={s.market}><b className="text-foreground">{s.market}: {aud(s.costPerParcel)} per parcel</b>,
                  {' '}{aud(s.chargedPerParcel)} charged — {s.chargedPerParcel >= s.costPerParcel ? 'recovered' : `${aud(s.costPerParcel - s.chargedPerParcel)} absorbed`} per parcel.</li>))}
              <li>Across the year the USA absorbs about <b className="text-foreground">$242k</b>: unrecovered shipping
                plus ZONOS import taxes that carry no revenue.</li>
            </ul>
            <p className="max-w-3xl text-muted-foreground">
              All amounts are <b className="text-foreground">AUD</b>, except the threshold simulator, which is in
              USD because that is the currency US customers are charged in.
            </p>
          </Card>

          <Card className="p-6">
            <h3 className="mb-3 text-[17px] font-semibold">Where every number comes from</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="border-b">
                  {['Figure','Source','Currency'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{h}</th>))}
                </tr></thead>
                <tbody className="text-muted-foreground">
                  {[
                    ['Ad spend', 'meta_ads_daily', 'AUD'],
                    ['Store revenue, product mix', 'shopify_sales_lines', 'AUD ex tax'],
                    ['Stock, lead time, factory cost', 'aim2026_kpi_cache · aim2026_sku_parameters', 'AUD'],
                    ['Contribution margin, thresholds', 'advertising_unit_economics (Juan)', '—'],
                    ['Shipping paid', 'xero_account_lines · Freight & Courier', 'AUD'],
                    ['Shipping destination split', 'starshipit_market_monthly', '—'],
                    ['Shipping charged', 'shopify_shipping_revenue_monthly', 'AUD ex GST'],
                    ['US order distribution', 'shopify_sales_lines · country = US', 'USD'],
                  ].map((r) => (
                    <tr key={r[0]} className="border-b last:border-0">
                      <td className="px-3 py-1.5">{r[0]}</td>
                      <td className="px-3 py-1.5 font-mono text-[12px]">{r[1]}</td>
                      <td className="px-3 py-1.5">{r[2]}</td>
                    </tr>))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 max-w-3xl text-muted-foreground">
              The product mix uses the last {data.lookbackDays} days. SKUs renamed in July 2026 are
              consolidated — <b className="text-foreground">PSD-HD-EX54 and PSD-HD-54 count as PSD-HD-BR54</b>, and
              PSD-HD-MV58 as PSD-HD-BR58 — otherwise the same physical product appears three times,
              each copy looks small, and the plan builds stock for codes that no longer sell.
            </p>
            <div className="mt-4 flex items-start gap-2 rounded border border-amber-600/40 bg-amber-50/60 p-3 dark:bg-amber-950/30">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
              <p className="text-[13px] text-muted-foreground">
                <b className="text-foreground">Demand here is not the AIM 2026 demand column.</b> This report
                projects the Shopify B2C mix, because that is what advertising drives. The AIM tab
                measures total Unleashed demand, which also includes wholesale and assembly
                consumption. Both are correct for their own question; they are not the same number.
              </p>
            </div>
          </Card>
        </section>
      )}

      <footer className="mt-10 border-t pt-4 text-[11.5px] text-muted-foreground">
        Elasticity fitted over {data.fit.n} months (R² {data.fit.r2.toFixed(2)}).
        Unit economics {ue ? `from ${ue.month}` : 'unavailable'}. Product mix over the last
        {' '}{data.lookbackDays} days. <button onClick={load} disabled={loading}
          className="ml-1 underline hover:text-foreground reports-no-print">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </footer>
    </div>
  );
}
