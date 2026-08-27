// =============================================================================
// DDP Markets — are the DDP European markets (Germany, Denmark, Switzerland)
// charging enough to cover what they really cost?
//
// One order, three sources, reconciled server-side by ddp_markets_dashboard:
//   charged  — Shopify checkout (shipping + duties + taxes)
//   freight  — Starshipit label cost
//   ZONOS    — duties/taxes/fees ZONOS bills Dolo (DE and DK; CH ships
//              without ZONOS by design and is complete with freight alone)
//
// Everything shown is AUD. Layout follows the approved mockup: KPI strip,
// component gaps + weekly trend, needs-attention, and the per-order ledger
// collapsed at the bottom.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { STORE_DATE_PRESETS, storeToday } from '@/lib/storeDate';
import { cn } from '@/lib/utils';

const DDP_START = '2026-08-01'; // the markets opened here; nothing exists before

// ── shapes returned by ddp_markets_dashboard ─────────────────────────────────
interface Kpis {
  orders: number; matchedOrders: number; byCountry: Record<string, number>;
  revenue: number; chargedTotal: number; chargedShipping: number; chargedDuties: number;
  chargedTaxes: number; paidTotal: number; paidFreight: number; paidZonosDT: number;
  paidZonosFees: number; netAbsorbed: number; netPerOrder: number; recoveryPct: number | null;
}
interface Component { key: string; charged: number; paid: number; gap: number; perOrder: number; orders: number }
interface Week { weekStart: string; charged: number; paid: number; orders: number }
interface Country {
  code: string; orders: number; matchedOrders: number; revenue: number;
  charged: number; paid: number; net: number; netPerOrder: number | null; recoveryPct: number | null;
}
interface LedgerRow {
  order: string; date: string; country: string;
  chargedShipping: number; chargedDuties: number; chargedTaxes: number; chargedTotal: number;
  freight: number | null; zonosDT: number | null; zonosFees: number | null; zonosExpected: boolean;
  paidTotal: number | null; net: number | null; tracking: string | null; carrier: string | null; matched: boolean;
}
interface Payload {
  kpis: Kpis; components: Component[]; weekly: Week[]; countries: Country[]; ledger: LedgerRow[];
  exceptions: { awaitingZonos: string[]; awaitingFreight: string[]; zonosUnmatched: { tracking: string; country: string; amount: number }[] };
}

const COUNTRY_NAME: Record<string, string> = { DE: 'Germany', DK: 'Denmark', CH: 'Switzerland' };

// Real SVG flags: Windows renders emoji flags as bare letters, which is what
// made the markets read as "just the code" in the first place.
function Flag({ cc, className }: { cc: string; className?: string }) {
  const cls = cn('inline-block h-[13px] w-[19px] shrink-0 rounded-[2px] border border-black/10 align-[-1.5px]', className);
  if (cc === 'DE') return (
    <svg viewBox="0 0 3 2" className={cls} aria-hidden>
      <rect width="3" height="2" fill="#000" /><rect y="0.667" width="3" height="1.333" fill="#DD0000" /><rect y="1.333" width="3" height="0.667" fill="#FFCE00" />
    </svg>
  );
  if (cc === 'DK') return (
    <svg viewBox="0 0 37 28" className={cls} aria-hidden>
      <rect width="37" height="28" fill="#C8102E" /><rect x="12" width="4" height="28" fill="#fff" /><rect y="12" width="37" height="4" fill="#fff" />
    </svg>
  );
  if (cc === 'CH') return (
    <svg viewBox="0 0 32 32" className={cls} aria-hidden>
      <rect width="32" height="32" fill="#DA291C" /><rect x="13" y="6" width="6" height="20" fill="#fff" /><rect x="6" y="13" width="20" height="6" fill="#fff" />
    </svg>
  );
  return null;
}
const aud = (v: number | null | undefined, dec = 0) =>
  v === null || v === undefined ? '—'
    : `${v < 0 ? '−' : ''}A$${Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
const n2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Presets that make sense for a window that starts 1 Aug 2026: the module-wide
// long presets collapse onto "since launch" anyway.
const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: 'Since launch', range: () => ({ from: DDP_START, to: storeToday() }) },
  { label: '30 days', range: STORE_DATE_PRESETS.find((p) => p.label === '30 days')!.range },
  { label: 'This FY', range: STORE_DATE_PRESETS.find((p) => p.label === 'This FY')!.range },
];
const clampFrom = (d: string) => (d < DDP_START ? DDP_START : d);

// Every number on this screen names its source on hover.
const T = {
  orders: 'Shopify orders shipped to Germany, Denmark or Switzerland in the window (store days, Australia/Brisbane). Source: ddp_shipments, filled by ddp-sync.',
  charged: 'What customers paid at checkout for shipping + duties + taxes, in AUD (Shopify shop_money USD × the monthly USD→AUD rate the whole dashboard uses). Merchandise is NOT included.',
  paid: 'What Dolo actually paid: Starshipit label cost + everything ZONOS billed (duties, taxes, fees). AUD as billed.',
  net: 'Charged − paid, summed over MATCHED orders only (both legs present; CH needs freight only). Negative = Dolo absorbs the difference.',
  recovery: 'Charged ÷ paid over matched orders. 100% = customers cover exactly what the orders cost to land.',
  compShipping: 'Shipping charged at checkout vs the Starshipit label cost, over matched orders in the window.',
  compDT: 'Duties + taxes charged at checkout vs what ZONOS billed. DE + DK only — Switzerland has no ZONOS leg by design.',
  compFees: 'ZONOS per-order service fees. Never charged to the customer — a structural cost of selling DDP.',
  weekly: 'Charged vs paid per week (matched orders, store days). The vertical gap is what Dolo absorbs that week.',
  ledger: 'One row per order, three sources side by side. Net only appears when the order is fully matched.',
  colShip: 'Shipping charged at checkout (AUD, monthly FX). Source: Shopify total_shipping_price_set.',
  colDuties: 'Duties charged at checkout. Source: Shopify current_total_duties_set.',
  colTaxes: 'Taxes charged at checkout. Source: Shopify total_tax_set.',
  colChargedTotal: 'Shipping + duties + taxes charged, AUD.',
  colFreight: 'What the label cost, AUD. Source: Starshipit total_shipping_price.',
  colZonosDT: 'Duties + taxes ZONOS billed for this tracking, AUD. CH: not applicable by design.',
  colZonosFees: 'ZONOS per-order service fee, AUD.',
  colPaidTotal: 'Freight + ZONOS duties/taxes/fees, AUD.',
  colNet: 'Charged − paid for this order. Blank until every expected leg is matched.',
};

export default function DDPMarketsTab() {
  const [from, setFrom] = useState(DDP_START);
  const [to, setTo] = useState(storeToday());
  const [preset, setPreset] = useState('Since launch');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null);
    const { data: d, error: e } = await supabase.rpc('ddp_markets_dashboard', { p_from: f, p_to: t });
    if (e) setError(e.message); else setData(d as unknown as Payload);
    setLoading(false);
  }, []);

  useEffect(() => { void load(from, to); }, [load, from, to]);

  const runSync = useCallback(async () => {
    setSyncing(true); setSyncNote(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ddp-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({}),
      });
      const j = await res.json();
      setSyncNote(j?.success
        ? `Synced — ${j.shopify?.ddpOrders ?? 0} orders · freight +${j.starshipit?.matched ?? 0} · ZONOS +${j.zonos?.matched ?? 0}`
        : `Sync failed: ${j?.message ?? res.status}`);
      await load(from, to);
    } catch (e) {
      setSyncNote(`Sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [from, to, load]);

  const k = data?.kpis;
  const weekly = useMemo(() => (data?.weekly ?? []).map((w) => ({
    ...w, label: new Date(`${w.weekStart}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
  })), [data]);
  const maxComp = useMemo(() => Math.max(1, ...(data?.components ?? []).flatMap((c) => [c.charged, c.paid])), [data]);
  const totals = useMemo(() => {
    const rows = data?.ledger ?? [];
    const sum = (f: (r: LedgerRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
    return {
      ship: sum((r) => r.chargedShipping), duties: sum((r) => r.chargedDuties), taxes: sum((r) => r.chargedTaxes),
      charged: sum((r) => r.chargedTotal), freight: sum((r) => r.freight), zonosDT: sum((r) => r.zonosDT),
      zonosFees: sum((r) => r.zonosFees), paid: sum((r) => r.paidTotal), net: sum((r) => r.net),
    };
  }, [data]);

  const compMeta: Record<string, { label: string; tip: string; note: (c: Component) => string }> = {
    shipping: {
      label: 'Shipping', tip: T.compShipping,
      note: (c) => `free-shipping thresholds absorb ${aud(Math.abs(c.perOrder), 2)} per order`,
    },
    duties_taxes: {
      label: 'Duties + taxes', tip: T.compDT,
      note: (c) => Math.abs(c.gap) <= Math.max(5, c.paid * 0.05)
        ? 'checkout tracks ZONOS closely — charging is calibrated'
        : c.gap < 0 ? 'checkout charges LESS than ZONOS bills — undercharging'
        : 'checkout charges more than ZONOS bills',
    },
    fees: {
      label: 'ZONOS fees', tip: T.compFees,
      note: (c) => `never charged to the customer — ${aud(Math.abs(c.perOrder), 2)} per order, structural`,
    },
  };

  return (
    <div className="space-y-4">
      {/* ── header: window, sources, refresh ─────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold leading-tight">DDP Markets</h2>
          <p className="text-[13px] text-muted-foreground">
            Germany · Denmark · Switzerland — checkout vs real landed cost, order by order.
            Sources: <b className="text-foreground">Shopify</b> · <b className="text-foreground">Starshipit</b> · <b className="text-foreground">ZONOS</b>.
            All amounts in <b className="text-foreground">AUD</b>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p.label} size="sm" variant={preset === p.label ? 'default' : 'outline'} className="h-8 text-[13px]"
              onClick={() => { const r = p.range(); setPreset(p.label); setFrom(clampFrom(r.from)); setTo(r.to); }}
            >
              {p.label}
            </Button>
          ))}
          <input
            type="date" value={from} min={DDP_START} max={to}
            onChange={(e) => { setPreset(''); setFrom(clampFrom(e.target.value)); }}
            className="h-8 rounded-md border bg-background px-2 text-[13px]"
            title={`Window start (store days). Nothing exists before ${DDP_START} — the markets opened then.`}
          />
          <input
            type="date" value={to} min={from} max={storeToday()}
            onChange={(e) => { setPreset(''); setTo(e.target.value); }}
            className="h-8 rounded-md border bg-background px-2 text-[13px]"
            title="Window end (store days)."
          />
          <Button size="sm" variant="outline" className="h-8 text-[13px]" onClick={runSync} disabled={syncing}
            title="Re-runs ddp-sync now: re-reads Shopify, looks up pending freight in Starshipit and pending duties in ZONOS.">
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Refresh'}
          </Button>
        </div>
      </div>
      {syncNote && <div className="text-[13px] text-muted-foreground">{syncNote}</div>}
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[13px]">{error}</div>}

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="cursor-help rounded-xl border bg-card p-3.5" title={T.orders}>
          <div className="text-[13px] text-muted-foreground">DDP orders</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? k.orders : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? ['DE', 'DK', 'CH'].filter((c) => k.byCountry[c]).map((c) => `${c} ${k.byCountry[c]}`).join(' · ') : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border bg-card p-3.5"
          title="Merchandise revenue of these orders: Shopify subtotal (before shipping, duties and taxes), shop_money USD converted to AUD with the monthly rate the whole dashboard uses.">
          <div className="text-[13px] text-muted-foreground">Revenue</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? aud(k.revenue) : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {data ? data.countries.map((c) => `${c.code} ${aud(c.revenue)}`).join(' · ') : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border bg-card p-3.5" title={T.charged}>
          <div className="text-[13px] text-muted-foreground">Charged to customers</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? aud(k.chargedTotal) : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? `ship ${aud(k.chargedShipping)} · duties ${aud(k.chargedDuties)} · taxes ${aud(k.chargedTaxes)}` : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border bg-card p-3.5" title={T.paid}>
          <div className="text-[13px] text-muted-foreground">Paid by Dolo</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? aud(k.paidTotal) : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? `freight ${aud(k.paidFreight)} · ZONOS ${aud(k.paidZonosDT)} · fees ${aud(k.paidZonosFees)}` : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border bg-card p-3.5" title={`${T.net} ${T.recovery}`}>
          <div className="text-[13px] text-muted-foreground">Net absorbed</div>
          <div className={cn('mt-0.5 text-2xl font-bold tabular-nums', (k?.netAbsorbed ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700')}>
            {k ? aud(k.netAbsorbed) : '…'}
          </div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? `${aud(k.netPerOrder, 2)}/order · recovery ${k.recoveryPct ?? '—'}% · ${k.matchedOrders}/${k.orders} matched` : ''}
          </div>
        </div>
      </div>

      {/* ── per-country line ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(data?.countries ?? []).map((c) => (
          <div key={c.code} className="cursor-help rounded-xl border bg-card px-3.5 py-2.5"
            title={`${c.code}: ${c.orders} orders (${c.matchedOrders} matched), ${aud(c.revenue)} merchandise revenue. Charged ${aud(c.charged)} vs paid ${aud(c.paid)} over matched orders.${c.code === 'CH' ? ' Switzerland ships without ZONOS by design — matched with freight alone.' : ''}`}>
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold"><Flag cc={c.code} /> {COUNTRY_NAME[c.code]} · {c.orders} orders</span>
              <span className={cn('text-sm font-bold tabular-nums', (c.net ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700')}>
                {c.matchedOrders ? `${aud(c.netPerOrder, 2)}/order` : 'no matched orders'}
              </span>
            </div>
            <div className="text-[13px] text-muted-foreground tabular-nums">
              revenue {aud(c.revenue)} · recovery {c.recoveryPct ?? '—'}%{c.code === 'CH' ? ' · no ZONOS (by design)' : ''}
            </div>
          </div>
        ))}
      </div>

      {/* ── components + weekly ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <div className="cursor-help text-sm font-bold" title="Each pair: what checkout charged (dark) vs what it really cost (teal), matched orders only.">
            Charged vs paid, by component
          </div>
          <div className="mb-3 mt-1 flex gap-4 text-[13px] text-muted-foreground">
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-slate-700" />Charged to customer</span>
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-teal-600" />Paid by Dolo</span>
          </div>
          {(data?.components ?? []).map((c) => {
            const meta = compMeta[c.key];
            if (!meta) return null;
            return (
              <div key={c.key} className="mb-4 cursor-help last:mb-0" title={meta.tip}>
                <div className="flex items-baseline justify-between text-[13px]">
                  <span className="font-medium">{meta.label} <span className="text-muted-foreground">({c.orders} orders)</span></span>
                  <b className={cn('tabular-nums', c.gap < 0 ? 'text-red-600' : 'text-emerald-700')}>gap {aud(c.gap)}</b>
                </div>
                <div className="mt-1 space-y-0.5">
                  <div className="flex h-3.5 items-center rounded bg-slate-700 text-[11px] font-semibold text-white"
                    style={{ width: `${Math.max(2, (c.charged / maxComp) * 100)}%` }}>
                    <span className="pl-1.5">{c.charged > 0 ? aud(c.charged) : ''}</span>
                  </div>
                  <div className="flex h-3.5 items-center rounded bg-teal-600 text-[11px] font-semibold text-white"
                    style={{ width: `${Math.max(2, (c.paid / maxComp) * 100)}%` }}>
                    <span className="pl-1.5">{c.paid > 0 ? aud(c.paid) : ''}</span>
                  </div>
                </div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">{meta.note(c)}</div>
              </div>
            );
          })}
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="cursor-help text-sm font-bold" title={T.weekly}>Weekly: charged vs paid</div>
          <div className="mb-2 mt-1 text-[13px] text-muted-foreground">Matched orders, store weeks — the vertical distance is what Dolo absorbs</div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weekly} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fontSize: 13 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 13 }} tickLine={false} axisLine={false} width={52}
                  tickFormatter={(v: number) => `$${v}`} />
                <ChartTooltip
                  formatter={(v: number, name: string) => [aud(v), name === 'charged' ? 'Charged to customers' : 'Paid by Dolo']}
                  labelFormatter={(l, p) => `Week of ${l}${p?.[0]?.payload?.orders ? ` · ${p[0].payload.orders} orders` : ''}`}
                  contentStyle={{ fontSize: 13 }}
                />
                <Line dataKey="charged" stroke="#334155" strokeWidth={2.5} dot={{ r: 3.5 }} />
                <Line dataKey="paid" stroke="#0d9488" strokeWidth={2.5} dot={{ r: 3.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 border-t pt-2.5">
            <div className="text-[13px] font-bold">Needs attention</div>
            {data && (
              <div className="mt-1 space-y-1 text-[13px] text-muted-foreground">
                {data.exceptions.awaitingZonos.length > 0 && (
                  <div title="DE/DK orders with no ZONOS record yet. ZONOS creates its order when the label goes through the Starshipit integration (live since 25 Aug); older orders may never appear there.">
                    <b className="text-foreground">{data.exceptions.awaitingZonos.length} orders</b> awaiting ZONOS
                    {' '}({data.exceptions.awaitingZonos.slice(0, 4).join(', ')}{data.exceptions.awaitingZonos.length > 4 ? '…' : ''})
                  </div>
                )}
                {data.exceptions.awaitingFreight.length > 0 && (
                  <div title="Orders with no Starshipit label. The 1–19 Aug ones shipped outside Starshipit (DHL Express booked directly) — their per-order freight is not recoverable from any connected API.">
                    <b className="text-foreground">{data.exceptions.awaitingFreight.length} orders</b> without freight cost
                    {' '}({data.exceptions.awaitingFreight.slice(0, 4).join(', ')}{data.exceptions.awaitingFreight.length > 4 ? '…' : ''})
                  </div>
                )}
                {data.exceptions.zonosUnmatched.length > 0 && (
                  <div title="ZONOS billed these trackings but no local order carries them — check the tracking numbers.">
                    <b className="text-foreground">{data.exceptions.zonosUnmatched.length} ZONOS charges</b> with no matching order
                  </div>
                )}
                {!data.exceptions.awaitingZonos.length && !data.exceptions.awaitingFreight.length && !data.exceptions.zonosUnmatched.length && (
                  <div>Every order in the window is fully matched.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── collapsible order ledger ─────────────────────────────────────── */}
      <div className="rounded-xl border bg-card">
        <button
          type="button"
          onClick={() => setLedgerOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-bold"
          title={T.ledger}
        >
          {ledgerOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Order ledger{data ? ` (${data.ledger.length})` : ''}
          <span className="ml-1 font-normal text-muted-foreground text-[13px]">one row per order, three sources side by side</span>
        </button>
        {ledgerOpen && (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[980px] border-collapse text-[13px] tabular-nums">
              <thead>
                <tr className="text-[13px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1 pr-2 text-left" colSpan={3}></th>
                  <th className="border-l pb-1 text-center text-slate-700" colSpan={4}
                    title="What the customer paid at checkout. Source: Shopify, AUD (monthly FX).">Charged — Shopify</th>
                  <th className="border-l pb-1 text-center text-teal-700" colSpan={4}
                    title="What Dolo paid. Sources: Starshipit (freight) + ZONOS (duties, taxes, fees). AUD.">Paid — Starshipit + ZONOS</th>
                  <th className="border-l pb-1 text-center" title={T.colNet}>Net</th>
                </tr>
                <tr className="border-b text-left">
                  <th className="py-1.5 pr-2 font-semibold">Order</th>
                  <th className="py-1.5 pr-2 font-semibold">Date</th>
                  <th className="py-1.5 pr-2 font-semibold">Mkt</th>
                  <th className="cursor-help border-l py-1.5 pl-2 text-right font-semibold" title={T.colShip}>Ship</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colDuties}>Duties</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colTaxes}>Taxes</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colChargedTotal}>Total</th>
                  <th className="cursor-help border-l py-1.5 pl-2 text-right font-semibold" title={T.colFreight}>Freight</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colZonosDT}>ZONOS D+T</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colZonosFees}>Fees</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colPaidTotal}>Total</th>
                  <th className="cursor-help border-l py-1.5 pl-2 text-right font-semibold" title={T.colNet}>Per order</th>
                </tr>
              </thead>
              <tbody>
                {(data?.ledger ?? []).map((r) => (
                  <tr key={r.order} className={cn('border-b border-border/60', !r.matched && 'text-muted-foreground')}
                    title={r.tracking ? `${r.tracking}${r.carrier ? ` · ${r.carrier}` : ''}` : 'no tracking yet'}>
                    <td className="py-1.5 pr-2 font-semibold text-foreground">{r.order}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">{new Date(`${r.date}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap"><span className="flex items-center gap-1.5"><Flag cc={r.country} /> {COUNTRY_NAME[r.country]}</span></td>
                    <td className="border-l py-1.5 pl-2 text-right">{n2(r.chargedShipping)}</td>
                    <td className="py-1.5 pl-2 text-right">{n2(r.chargedDuties)}</td>
                    <td className="py-1.5 pl-2 text-right">{n2(r.chargedTaxes)}</td>
                    <td className="py-1.5 pl-2 text-right font-semibold text-foreground">{n2(r.chargedTotal)}</td>
                    <td className="border-l py-1.5 pl-2 text-right">
                      {r.freight === null
                        ? <span className="rounded bg-muted px-1.5 py-0.5 text-[12px]" title="Shipped outside Starshipit (DHL Express booked directly) or no label yet.">no label</span>
                        : n2(r.freight)}
                    </td>
                    <td className="py-1.5 pl-2 text-right">
                      {!r.zonosExpected
                        ? <span title="Switzerland ships without ZONOS by design.">n/a</span>
                        : r.zonosDT === null
                          ? <span className="rounded bg-muted px-1.5 py-0.5 text-[12px]" title="No ZONOS record yet — they appear once the label goes through the integration (live since 25 Aug).">awaiting</span>
                          : n2(r.zonosDT)}
                    </td>
                    <td className="py-1.5 pl-2 text-right">{!r.zonosExpected ? '—' : r.zonosFees === null ? '' : n2(r.zonosFees)}</td>
                    <td className="py-1.5 pl-2 text-right font-semibold text-foreground">{r.paidTotal === null ? '—' : n2(r.paidTotal)}</td>
                    <td className="border-l py-1.5 pl-2 text-right">
                      {r.net === null ? '—' : (
                        <span className={cn('rounded px-1.5 py-0.5 font-semibold', r.net < 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700')}>
                          {n2(r.net)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-bold">
                  <td className="py-2 pr-2" colSpan={3}>{data?.ledger.length ?? 0} orders</td>
                  <td className="border-l py-2 pl-2 text-right">{n2(totals.ship)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.duties)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.taxes)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.charged)}</td>
                  <td className="border-l py-2 pl-2 text-right">{n2(totals.freight)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.zonosDT)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.zonosFees)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.paid)}</td>
                  <td className={cn('border-l py-2 pl-2 text-right', totals.net < 0 ? 'text-red-600' : 'text-emerald-700')}
                    title="Sum over matched orders only.">{n2(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="mt-2 text-[13px] text-muted-foreground">
              Grey rows are not fully matched yet and stay out of Net absorbed. Hover any row for its tracking number.
            </div>
          </div>
        )}
      </div>

      {loading && <div className="text-[13px] text-muted-foreground">Loading…</div>}
    </div>
  );
}
