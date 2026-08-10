// =============================================================================
// Advertising tab — mini Triple Whale
// =============================================================================
// Spec: docs/DESIGN-ADVERTISING-TAB.md (v2.1). Reads public.advertising_dashboard
// (Plan 4). The data shape is the RPC contract — see advertising/types.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip as RTooltip, CartesianGrid,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { STORE_DATE_PRESETS, storeToday } from '@/lib/storeDate';
import GoogleSpendForm from '@/components/advertising/GoogleSpendForm';
import type {
  AdvertisingDashboard, ChannelView, MerPoint, GoogleBucketRow, ChannelMixRow,
} from '@/components/advertising/types';

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');
const fmtX = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(2)}×`;
const fmtUsd = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : `(US$${Math.round(v).toLocaleString('en-AU')})`;

/** The USD companion of an AUD figure: same number, source currency, set smaller
 *  so it never competes with the amount it annotates. Copied from B2CSalesPanel's
 *  <Usd> — house convention for every AUD figure in the dashboard. */
function Usd({ value, size = 'card' }: {
  value: number | null | undefined;
  size?: 'card' | 'table';
}) {
  const text = fmtUsd(value);
  if (!text) return null;
  return (
    <span
      className={cn(
        'ml-1 font-normal text-muted-foreground align-baseline',
        size === 'table' ? 'text-[11px]' : 'text-[0.58em]'
      )}
    >
      {text}
    </span>
  );
}

function StatCard({ label, value, usd, sub, accent, warn }: {
  label: string; value: string; usd?: number | null; sub: ReactNode; accent?: string; warn?: boolean;
}) {
  return (
    <Card className="relative overflow-hidden p-4 border border-border/60">
      {accent && (
        <div className="absolute inset-x-0 top-0 h-[2px] opacity-70"
             style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
      )}
      <p className="text-xs font-medium tracking-wide uppercase text-muted-foreground mb-2 truncate">{label}</p>
      <p className={cn('text-2xl font-semibold tracking-tight tabular-nums leading-none',
                       warn && 'text-amber-600 dark:text-amber-400')}>
        {value}
        {usd !== undefined && <Usd value={usd} />}
      </p>
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
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as MerPoint;
              return (
                <div className="rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md space-y-0.5">
                  <div className="font-medium">{String(label)}</div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Revenue</span><span className="tabular-nums">{fmtAud(p.revenueAud)}<Usd value={p.revenueUsd} size="table" /></span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Spend</span><span className="tabular-nums">{p.spendAud === null ? 'incomplete' : <>{fmtAud(p.spendAud)}<Usd value={p.spendUsd} size="table" /></>}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">MER</span><span className="tabular-nums font-medium" style={{ color: '#f59e0b' }}>{p.mer === null ? '— (spend not loaded)' : fmtX(p.mer)}</span></div>
                  {p.spendComplete === false && p.mer !== null && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-400">Meta spend only — Google wasn't spending yet</div>
                  )}
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

// Raw bucket keys from advertising_bucket → English labels. Unknown key falls
// through unchanged rather than crashing (spec Change 3).
const CHANNEL_MIX_LABELS: Record<string, string> = {
  'meta-paid': 'Meta (paid)',
  'google-brand': 'Google Brand (paid)',
  'google-nonbrand': 'Google Non-brand (paid)',
  'google-shopping-proxy': 'Google Shopping (paid, proxy)',
  'google-paid-other': 'Google other (paid)',
  'google-organic': 'Google organic',
  'google-mixto-pre': 'Google mixed (before 6 Aug — paid and organic indistinguishable)',
  direct: 'Direct',
  email: 'Email',
  'social-organic': 'Social organic',
  'search-other': 'Other search engines',
  'referral-other': 'Referrals',
  'other-tagged': 'Other tagged',
  'sin-journey': 'No journey captured yet',
};
const channelMixLabel = (bucket: string) => CHANNEL_MIX_LABELS[bucket] ?? bucket;

/** The reconciliation: paid channels are a SLICE of total net sales, not a rival
 *  figure. sum(rows.revenueAud) === blended.revenueAud (±rounding) by contract. */
function ChannelMix({ rows, totalAud }: { rows: ChannelMixRow[]; totalAud: number }) {
  const paidRows = rows.filter((r) => r.isPaid);
  const paidAud = paidRows.reduce((s, r) => s + r.revenueAud, 0);
  const paidUsd = paidRows.reduce((s, r) => s + r.revenueUsd, 0);
  const paidPct = totalAud > 0 ? (paidAud / totalAud) * 100 : 0;

  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Where the sales came from
      </h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium pb-1.5">Channel</th>
            <th className="text-right font-medium pb-1.5">Orders</th>
            <th className="text-right font-medium pb-1.5">Net AUD</th>
            <th className="text-right font-medium pb-1.5">% of total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = totalAud > 0 ? (r.revenueAud / totalAud) * 100 : 0;
            return (
              <tr key={r.bucket} className="border-t border-border/40">
                <td className="py-1.5">
                  {channelMixLabel(r.bucket)}
                  {r.isPaid && (
                    <span className="ml-1.5 inline-block rounded-full bg-emerald-100 dark:bg-emerald-950/40 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:text-emerald-400 align-middle">
                      paid
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtNum(r.orders)}</td>
                <td className={cn('py-1.5 text-right tabular-nums', r.isPaid && 'font-medium')}>
                  {fmtAud(r.revenueAud)}<Usd value={r.revenueUsd} size="table" />
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground/70 mt-2">
        Paid channels: {fmtAud(paidAud)}<Usd value={paidUsd} size="table" /> ({paidPct.toFixed(1)}% of net sales)
      </p>
    </Card>
  );
}

const PRESETS = STORE_DATE_PRESETS;                    // from '@/lib/storeDate'
const DEFAULT = PRESETS.find((p) => p.label === '30 days')!.range();

export default function AdvertisingTab() {
  const [view, setView] = useState<'leadership' | 'meta' | 'google'>('leadership');
  const [range, setRange] = useState<{ from: string; to: string }>(DEFAULT);
  const [data, setData] = useState<AdvertisingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A sequence number rather than a boolean closure, so `load` can be called
  // both by the range-change effect AND on demand (GoogleSpendForm's
  // onSaved) without the two races stepping on each other — only the result
  // of the most recent call is ever applied.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true); setError(null);
    supabase.rpc('advertising_dashboard', { p_from: range.from, p_to: range.to })
      .then(({ data: res, error: err }) => {
        if (loadSeq.current !== seq) return;
        if (err) { setError(err.message); setData(null); }
        else setData(res as AdvertisingDashboard);
        setLoading(false);
      });
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  // > 92 days: the 90-day preset stays quiet, 12 months (and anything past it)
  // warns — that range measured ~15s.
  const rangeDays = Math.round(
    (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000
  );
  const longRange = rangeDays > 92;

  return (
    <div className="space-y-4">
      {/* ── View switch + date controls ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          {([['leadership', 'Leadership'], ['meta', 'Meta'], ['google', 'Google']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={cn('rounded-md px-3 py-1 text-xs font-medium transition-colors',
                view === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                onClick={() => setRange(p.range())}
                className={cn(
                  'h-8 rounded-lg px-2.5 text-xs',
                  p.range().from === range.from && p.range().to === range.to && 'bg-muted text-foreground font-medium'
                )}
              >
                {p.label}
              </Button>
            ))}
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs ml-1"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              max={storeToday()}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            />
          </div>
          <span className="text-[11px] text-muted-foreground/70 whitespace-nowrap">
            {data ? `${data.from} → ${data.to}` : ''}
          </span>
        </div>
      </div>

      {longRange && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Long ranges are slow (12 months ≈ 15s).
        </p>
      )}

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {loading && !data && <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>}

      {data && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          {view === 'leadership' && (
            <div className="space-y-4">
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                <StatCard label="MER" value={fmtX(data.blended.mer)} accent="#f59e0b"
                  sub="Net sales ÷ total ad spend (Meta + Google). Attribution-independent: this is the arbiter." />
                <StatCard label="Total spend" value={fmtAud(data.blended.spendAud)} usd={data.blended.spendUsd} accent="#94a3b8"
                  sub="Meta (API) + Google (loaded by Juan). AUD." />
                <StatCard label="Net sales" value={fmtAud(data.blended.revenueAud)} usd={data.blended.revenueUsd} accent="#3b82f6"
                  sub="Same figure as the E-commerce tab: AUD, Brisbane day, GST included on AU orders (the B2C explorer strips it — that tab shows ex-tax)." />
                <StatCard label="Double counting" value={`${data.blended.doubleCountRatio.toFixed(2)}×`} warn accent="#ef4444"
                  sub={<>The platforms claim {fmtAud(data.blended.claimedTotalAud)}<Usd value={data.blended.claimedTotalUsd} size="table" /> — they overlap each other. Claimed ÷ recognised.</>} />
                <StatCard label="Overlap" value={fmtNum(data.blended.overlapOrders)} accent="#8b5cf6"
                  sub="Orders with BOTH Meta and Google paid clicks in the same journey — the heart of the argument." />
                <StatCard label="Blended CAC" value={fmtAud(data.blended.cacBlended)} usd={data.blended.cacBlendedUsd} accent="#10b981"
                  sub={`Spend ÷ ${fmtNum(data.blended.newCustomerOrders)} new customers (first purchase).`} />
              </div>

              {range.from < '2026-08-06' && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Note: before 6-Aug the paid Google clicks were not distinguishable from organic, so
                  "double counting" and Google's ROAS for that period under-count the store.
                </p>
              )}

              <Card className="p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Daily MER · revenue vs spend
                </h3>
                <MerChart series={data.merSeries} />
                <p className="text-[11px] text-muted-foreground/70 mt-2">
                  Days without loaded Google spend don't compute a MER (gap in the line) — never a false zero.
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  Orders from the last 2-3 days may show up without a journey: Shopify takes time to
                  process it. The "no journey" counter reflects this.
                </p>
                {data.merSeries.some((p) => p.spendComplete === false && p.mer !== null) && (
                  <p className="text-[11px] text-muted-foreground/70 mt-1">
                    The days flagged in the tooltip are Meta-only MER: Google started spending on
                    25-Jun-2026, before that there was nothing to add.
                  </p>
                )}
              </Card>

              <ChannelMix rows={data.channelMix} totalAud={data.blended.revenueAud} />

              <p className="text-[11px] text-muted-foreground/70">
                Reading rule: our measurement <b>under-counts</b> (it doesn't see view-through or
                cross-device), the platforms <b>over-count</b> (they overlap each other). The truth
                sits bounded between the two.
                {' '}Unclassified: {fmtNum(data.blended.unclassifiedOrders)} orders (UTM drift) ·
                no journey: {fmtNum(data.blended.noJourneyOrders)}.
              </p>
            </div>
          )}

          {view === 'meta' && <ChannelPanel ch={data.channels[0]} />}
          {view === 'google' && (
            <div className="space-y-4">
              <ChannelPanel ch={data.channels[1]} />
              {range.from < '2026-08-06' && (
                <p className="text-[11px] text-muted-foreground/70">
                  Before 6-Aug Google paid and organic were indistinguishable (no UTMs): that period
                  shows as "Google mixed", not organic.
                </p>
              )}
              {range.from < '2026-06-25' && (
                <p className="text-[11px] text-muted-foreground/70">
                  Google spent nothing before 25-Jun-2026.
                </p>
              )}
              <GoogleBuckets rows={data.googleBuckets} />

              <Card className="p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Manual spend entry · Google Ads
                </h3>
                <GoogleSpendForm onSaved={load} />
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One paid channel: what it spent, what it claims, what the store recognises.
 *  The two ROAS side by side ARE the product — never show only one. */
function ChannelPanel({ ch }: { ch: ChannelView }) {
  const gap = ch.claimedAud - ch.storeLastAud;
  const gapUsd = ch.claimedUsd - ch.storeLastUsd;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
        <StatCard label="Spend" value={fmtAud(ch.spendAud)} usd={ch.spendUsd} accent="#94a3b8"
          sub={ch.key === 'google' ? "Manually loaded by Juan until the API arrives." : 'Meta API, by campaign.'} />
        <StatCard label={`${ch.label} claims`} value={fmtAud(ch.claimedAud)} usd={ch.claimedUsd} accent="#ef4444"
          sub="What the platform's dashboard reports (its pixel, its windows, view-through included)." />
        <StatCard label="The store credits it" value={fmtAud(ch.storeLastAud)} usd={ch.storeLastUsd} accent="#3b82f6"
          sub="Non-direct last click measured on real orders — the common yardstick." />
        <StatCard label="Gap" value={fmtAud(gap)} usd={gapUsd} warn accent="#f59e0b"
          sub="Claimed minus recognised. Not an error: it's view-through plus overlap with the other channel." />
        <StatCard label="Initiated" value={fmtAud(ch.storeFirstAud)} usd={ch.storeFirstUsd} accent="#8b5cf6"
          sub="First click: sales whose FIRST touch was this channel, whoever closed them." />
      </div>

      {ch.note && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">{ch.note}</p>
      )}

      <Card className="p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          By campaign · two yardsticks side by side
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Campaign</th>
              <th className="text-right font-medium pb-1.5">Spend</th>
              <th className="text-right font-medium pb-1.5">Claims</th>
              <th className="text-right font-medium pb-1.5">Platform ROAS</th>
              <th className="text-right font-medium pb-1.5">Store (closed)</th>
              <th className="text-right font-medium pb-1.5">Store ROAS</th>
              <th className="text-right font-medium pb-1.5">Initiated</th>
            </tr>
          </thead>
          <tbody>
            {ch.campaigns.map((c) => (
              <tr key={c.campaign} className="border-t border-border/40">
                <td className="py-1.5">
                  <span className="font-medium">{c.campaign}</span>
                  {c.note && <span className="block text-[10px] text-amber-700 dark:text-amber-400">{c.note}</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.spendAud)}<Usd value={c.spendUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtAud(c.claimedValueAud)}<Usd value={c.claimedValueUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtX(c.claimedValueAud / c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(c.storeLastClickAud)}<Usd value={c.storeLastClickUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtX(c.storeLastClickAud / c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.storeFirstClickAud)}<Usd value={c.storeFirstClickUsd} size="table" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Google split by bucket — only meaningful from 6-Aug-2026 (spec date-gate). */
function GoogleBuckets({ rows }: { rows: GoogleBucketRow[] }) {
  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Google by bucket · since 6-Aug
      </h3>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Before 6-Aug Google paid and organic were a single bucket (no UTMs): that history is shown
        separately as "Google mixed", never as organic.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium pb-1.5">Bucket</th>
            <th className="text-right font-medium pb-1.5">Orders</th>
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
              <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(r.revenueAud)}<Usd value={r.revenueUsd} size="table" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
