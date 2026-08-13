// =============================================================================
// Advertising tab — mini Triple Whale
// =============================================================================
// Spec: ADVERTISING/SPEC.md (v2.1) + ADVERTISING/plans/06-mejoras-post-revision.md
// + ADVERTISING/plans/07-rediseno-pantalla.md (this layout).
//
// Reads public.advertising_dashboard (Plan 4) — twice per range, the second call
// for the immediately preceding window of EQUAL length — and, lazily,
// public.advertising_incrementality (Plan 6 B3). The data shapes are the RPC
// contracts — see advertising/types.ts.
//
// LAYOUT (Plan 7): five workspaces in a left rail, one question each, plus two
// surfaces that are NOT workspaces — Data health (drawer) and Help (modal).
// Measurement diagnostics live in the drawer; methodology prose lives in Help.
// The main screens keep only the short notes that prevent a misreading.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip as RTooltip, CartesianGrid, ReferenceArea, ReferenceLine,
} from 'recharts';
import {
  Activity, BarChart3, Gauge, HelpCircle, Info, Layers3, Target, TrendingUp,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { STORE_DATE_PRESETS, storeToday, storeDay, shiftDays, ymd } from '@/lib/storeDate';
import GoogleSpendForm from '@/components/advertising/GoogleSpendForm';
import type {
  AdvertisingDashboard, AdvertisingIncrementality, ChannelView, MerPoint,
  GoogleBucketRow, ChannelMixRow, OverlapSplit, LiveOrder, UnitEconomics,
  MonthlyPlan,
} from '@/components/advertising/types';

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');
const fmtX = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(2)}×`;
const fmtUsd = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : `(US$${Math.round(v).toLocaleString('en-AU')})`;
const fmtPct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`;

/** Numerator ÷ denominator, null-guarded: a zero divisor renders as '—', never
 *  Infinity/NaN. Every client-side ratio in the tab goes through this. */
const ratio = (num: number | null | undefined, den: number | null | undefined) =>
  num === null || num === undefined || !den || den <= 0 ? null : num / den;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-08-31' → '31 Aug' */
const fmtDay = (iso: string) => `${+iso.slice(8, 10)} ${MONTHS_SHORT[+iso.slice(5, 7) - 1]}`;
/** '2026-08' → 'Aug 26' */
const fmtMonth = (ym: string) => `${MONTHS_SHORT[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;
/** Whole US dollars — the workbook's currency, used only in the Planning surface. */
const fmtUsd0 = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;

/** Calendar-day arithmetic on the store's calendar (UTC-midnight Dates, so no
 *  offset or DST can push a result onto the neighbouring day). */
const addDays = (iso: string, n: number) => {
  const d = storeDay(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
/** Inclusive day count: '01' → '01' is 1 day, not 0. */
const inclusiveDays = (from: string, to: string) =>
  Math.round((storeDay(to).getTime() - storeDay(from).getTime()) / 86_400_000) + 1;

/** Juan's healthy-CAC line (3× LTV:CAC) from the July workbook. LTV is not in the
 *  unit-economics contract, so it travels as a workbook constant, refreshed
 *  monthly with the rest. The ceiling is derived (cm1Pct × revenuePerOrderUsd);
 *  this constant is only the fallback for windows with no unit-economics row. */
const HEALTHY_CAC_USD = 20.93;
const CAC_CEILING_FALLBACK_USD = 55.07;
const DEFAULT_PLANNED_SPEND_USD = 129_939; // workbook Simulators §4 baseline

/** Above this, the second RPC call is skipped: the range is already slow and a
 *  year-vs-year comparison is not what the tab is for. */
const COMPARISON_MAX_DAYS = 92;
/** Share of orders without a captured journey that stops being ordinary lag. */
const NO_JOURNEY_ALERT_SHARE = 0.05;

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
        size === 'table' ? 'text-xs' : 'text-[0.58em]'
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
      <p className="text-sm font-medium tracking-wide uppercase text-muted-foreground mb-2 truncate">{label}</p>
      <p className={cn('text-3xl font-semibold tracking-tight tabular-nums leading-none',
                       warn && 'text-amber-600 dark:text-amber-400')}>
        {value}
        {usd !== undefined && <Usd value={usd} />}
      </p>
      {/* The definition lives ON the card (spec §2.5) — no hidden formulas. */}
      <p className="text-[13px] text-muted-foreground/70 leading-tight mt-1.5">{sub}</p>
    </Card>
  );
}

/** A headline card: the same shell as StatCard plus the period-comparison delta
 *  and an optional colour verdict on the value itself. */
function KpiCard({ label, value, usd, sub, accent, valueClass, delta, chip, tip }: {
  label: string; value: string; usd?: number | null; sub: ReactNode;
  accent?: string; valueClass?: string; delta?: ReactNode; chip?: ReactNode; tip?: ReactNode;
}) {
  return (
    <Card className="relative overflow-hidden p-4 border border-border/60">
      {accent && (
        <div className="absolute inset-x-0 top-0 h-[2px] opacity-70"
             style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
      )}
      <p className="text-sm font-medium tracking-wide uppercase text-muted-foreground mb-2 flex items-center gap-1.5">
        <span className="truncate">{label}</span>
        {tip && <InfoTip label={`What ${label} means`} content={tip} />}
      </p>
      <p className={cn('text-3xl font-semibold tracking-tight tabular-nums leading-none', valueClass)}>
        {value}
        {usd !== undefined && <Usd value={usd} />}
      </p>
      {delta}
      {chip && <div className="mt-2">{chip}</div>}
      <p className="text-[13px] text-muted-foreground/70 leading-tight mt-1.5">{sub}</p>
    </Card>
  );
}

function Chip({ tone, children, className }: {
  tone: 'green' | 'amber' | 'red'; children: ReactNode; className?: string;
}) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-tight',
      tone === 'green' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
      tone === 'amber' && 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
      tone === 'red' && 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
      className,
    )}>
      {children}
    </span>
  );
}

// ── Period comparison ────────────────────────────────────────────────────────
// The second call is the SAME RPC over the immediately preceding window of the
// same inclusive length, so every delta is blended.X against blended.X. Never
// compare a filtered subset (days with complete spend, a channel, a clean
// window) against a full window — that is what made the ChatGPT draft's "+X%"
// meaningless (plan 07 §defecto 3).

const deltaPct = (current: number | null | undefined, previous: number | null | undefined) =>
  current === null || current === undefined || previous === null || previous === undefined || previous === 0
    ? null
    : ((current - previous) / Math.abs(previous)) * 100;

/** `better` says which direction is good. 'lower' inverts the colour (CAC).
 *  'neutral' never colours — a spend increase is not inherently bad. */
function Delta({ current, previous, better }: {
  current: number | null | undefined;
  previous: number | null | undefined;
  better: 'higher' | 'lower' | 'neutral';
}) {
  const d = deltaPct(current, previous);
  if (d === null) return null;
  const good = better === 'neutral' ? null : better === 'higher' ? d > 0 : d < 0;
  return (
    <p className="mt-1.5 text-[13px] tabular-nums">
      <span className={cn(
        'font-medium',
        good === null && 'text-muted-foreground',
        good === true && 'text-emerald-600 dark:text-emerald-400',
        good === false && 'text-red-600 dark:text-red-400',
      )}>
        {d > 0 ? '+' : ''}{d.toFixed(1)}%
      </span>
      <span className="ml-1 text-muted-foreground/70">vs previous period</span>
    </p>
  );
}

/** A legend is not decoration here: without it the two bars are unlabelled
 *  colour. Rendered as real text above the chart so it reads at any width. */
function ChartLegend({ targetMer, oneDay }: { targetMer: number | null; oneDay: boolean }) {
  const Swatch = ({ color, shape, children }: { color: string; shape: 'bar' | 'line'; children: ReactNode }) => (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <span
        className={shape === 'bar' ? 'inline-block h-3 w-3 rounded-[3px]' : 'inline-block h-[3px] w-4 rounded-full'}
        style={{ background: color }}
      />
      {children}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
      <Swatch color="#3b82f6" shape="bar">Net sales (left axis)</Swatch>
      <Swatch color="#94a3b8" shape="bar">Ad spend (left axis)</Swatch>
      <Swatch color="#f59e0b" shape="line">MER (right axis)</Swatch>
      {targetMer !== null && <Swatch color="#10b981" shape="line">Target {targetMer.toFixed(2)}×</Swatch>}
      {oneDay && (
        <span className="text-[13px] text-amber-700 dark:text-amber-400">
          One day selected — pick a longer range to see the trend.
        </span>
      )}
    </div>
  );
}

function MerChart({ series, targetMer }: { series: MerPoint[]; targetMer: number | null }) {
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
          <XAxis dataKey="d" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 12 }}
                 axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis yAxisId="money" tick={{ fontSize: 12 }} axisLine={false} tickLine={false}
                 width={56} tickFormatter={(v: number) => fmtAud(v)} />
          <YAxis yAxisId="mer" orientation="right" tick={{ fontSize: 12 }} axisLine={false}
                 tickLine={false} width={40} tickFormatter={(v: number) => `${v}×`} />
          {/* The target sits on the MER axis, dashed, so the line is read against
              the number Juan's workbook asks for and not against itself. */}
          {targetMer !== null && (
            <ReferenceLine yAxisId="mer" y={targetMer} stroke="#10b981" strokeDasharray="4 3"
                           ifOverflow="extendDomain"
                           label={{ value: `target ${targetMer.toFixed(2)}×`, position: 'insideTopRight', fontSize: 12, fill: '#10b981' }} />
          )}
          <RTooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as MerPoint;
              return (
                <div className="rounded-lg border bg-popover px-2.5 py-2 text-[13px] shadow-md space-y-0.5">
                  <div className="font-medium">{String(label)}</div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Revenue</span><span className="tabular-nums">{fmtAud(p.revenueAud)}<Usd value={p.revenueUsd} size="table" /></span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Spend</span><span className="tabular-nums">{p.spendAud === null ? 'incomplete' : <>{fmtAud(p.spendAud)}<Usd value={p.spendUsd} size="table" /></>}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">MER</span><span className="tabular-nums font-medium" style={{ color: '#f59e0b' }}>{p.mer === null ? '— (spend not loaded)' : fmtX(p.mer)}</span></div>
                  {p.spendComplete === false && p.mer !== null && (
                    <div className="text-[13px] text-amber-700 dark:text-amber-400">Meta spend only — Google wasn't spending yet</div>
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
// through unchanged rather than crashing (spec Change 3). EVERY surface that
// prints a bucket goes through channelMixLabel — the mix table, live orders and
// (fixed in plan 07) the Google-by-bucket table, which used to print the raw key.
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
// Compact variant for tight rows (Live orders): same map, parenthetical dropped.
const shortBucketLabel = (bucket: string) => channelMixLabel(bucket).replace(/\s*\(.*$/, '');

// ── A2: per-bucket definitions for "Where the sales came from" ───────────────
// What the bucket is, where the datum comes from (referrer / UTM / feed tag),
// and the caveat that applies. Content validated with Mario on 11-Aug.
const BUCKET_TOOLTIPS: Record<string, ReactNode> = {
  direct: (
    <>
      <p><b>Not organic — it's the absence of a trail.</b> Mixes typed URLs and bookmarks
      with apps that strip the origin: WhatsApp, Instagram's in-app browser, email clients.
      Part of what Meta claims and the store doesn't recognise lands here.</p>
      <p className="mt-1.5">Measured 6–9 Aug: of 84 first-click direct orders, 56 had no referrer,
      27 carried our own site as referrer (recoverable by looking further back in the journey),
      1 was shopify.com noise.</p>
    </>
  ),
  'google-mixto-pre': (
    <p>Before 6 Aug 2026 Google clicks carried no UTMs, so <b>paid and organic can't be told
    apart</b>. That history lives here — it is never counted as organic.</p>
  ),
  'google-shopping-proxy': (
    <p>Recognised by the product-feed tag, a <b>proxy that also catches Google's free
    listings</b>. It inflates this bucket until the clean tagging lands.</p>
  ),
  'sin-journey': (
    <p>Shopify takes 2–3 days to assemble an order's journey. Recent orders wait here until
    it arrives — <b>processing lag, not a channel</b>.</p>
  ),
  'meta-paid': (
    <p>Last non-direct click was a Meta ad, read from its UTM. <b>Under-counts the
    channel</b>: view-through and cross-device journeys are invisible to the store.</p>
  ),
  'google-brand': (
    <p>Last non-direct click was a paid Google brand-search ad (UTM, clean since 6 Aug).
    <b> Under-counts</b>: view-through and cross-device journeys are invisible to the store.</p>
  ),
  'google-nonbrand': (
    <p>Last non-direct click was a paid Google non-brand search ad (UTM, clean since 6 Aug).
    <b> Under-counts</b>: view-through and cross-device journeys are invisible to the store.</p>
  ),
  'google-paid-other': (
    <p>A paid Google click (UTM) that matches neither brand, non-brand nor shopping.
    <b> Under-counts</b> like every paid bucket.</p>
  ),
  'google-organic': (
    <p>Google referrer with no paid tag — SEO. Read from the order's referrer.</p>
  ),
  email: <p>The referrer or UTM identifies an email client or campaign.</p>,
  'social-organic': <p>Referrer from a social network with no paid tag.</p>,
  'search-other': <p>Referrer from a search engine other than Google (Bing, DuckDuckGo…).</p>,
  'referral-other': <p>Referrer from another site linking to the store.</p>,
  'other-tagged': (
    <p>Carries a UTM that matches no known channel. <b>If this bucket grows, someone changed
    campaign URLs</b> — UTM drift.</p>
  ),
};

/** House info-icon tooltip (same Radix pattern as WebUpgradeTab's data-defs). */
function InfoTip({ content, label }: { content: ReactNode; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${label}?`}
          className="inline-flex align-middle ml-1.5 text-muted-foreground/50 hover:text-foreground focus:outline-none focus-visible:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[360px] text-[13px] leading-relaxed">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/** The reconciliation: paid channels are a SLICE of total net sales, not a rival
 *  figure. sum(rows.revenueAud) === blended.revenueAud (±rounding) by contract. */
function ChannelMix({ rows, totalAud }: { rows: ChannelMixRow[]; totalAud: number }) {
  const paidRows = rows.filter((r) => r.isPaid);
  const paidAud = paidRows.reduce((s, r) => s + r.revenueAud, 0);
  const paidUsd = paidRows.reduce((s, r) => s + r.revenueUsd, 0);
  const paidPct = totalAud > 0 ? (paidAud / totalAud) * 100 : 0;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Where the sales came from
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[15px]">
          <thead>
            <tr className="text-[13px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Channel</th>
              <th className="text-right font-medium pb-1.5">Orders</th>
              <th className="text-right font-medium pb-1.5">Net AUD</th>
              <th className="text-right font-medium pb-1.5">% of total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = totalAud > 0 ? (r.revenueAud / totalAud) * 100 : 0;
              const tip = BUCKET_TOOLTIPS[r.bucket];
              return (
                <tr key={r.bucket} className="border-t border-border/40">
                  <td className="py-1.5">
                    {channelMixLabel(r.bucket)}
                    {r.isPaid && (
                      <span className="ml-1.5 inline-block rounded-full bg-emerald-100 dark:bg-emerald-950/40 px-1.5 py-0 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 align-middle">
                        paid
                      </span>
                    )}
                    {tip && <InfoTip content={tip} label={channelMixLabel(r.bucket)} />}
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
      </div>
      <p className="text-[13px] text-muted-foreground/70 mt-2">
        Paid channels: {fmtAud(paidAud)}<Usd value={paidUsd} size="table" /> ({paidPct.toFixed(1)}% of net sales)
      </p>
    </Card>
  );
}

// ── B2: verdict chart — floor/ceiling per paid campaign ──────────────────────
// Pure HTML/CSS bars (the approved mockup), not recharts. Floor = store ROAS
// (last non-direct click), ceiling = panel ROAS (platform claims). The truth
// sits between; the two dashed lines say whether "between" is good enough.

// Wide enough for a real Meta campaign name on two lines ("HD Shower Screen —
// Campaign NEW Videos"). Names wrap; they are never cut.
const VERDICT_LABEL_W = 'w-[300px]';
const VERDICT_NUMS_W = 'w-[130px]';
const VERDICT_CHIP_W = 'w-[180px]';

function VerdictRowShell({ label, bar, nums, chip }: {
  label: ReactNode; bar: ReactNode; nums: ReactNode; chip: ReactNode;
}) {
  // One shared row shell so bars, header labels and the axis all use the exact
  // same column offsets — the dashed line segments align across rows for free.
  return (
    <div className="flex items-center gap-3 min-h-[36px]">
      <div className={cn(VERDICT_LABEL_W, 'shrink-0 min-w-0')}>{label}</div>
      <div className="relative h-7 flex-1">{bar}</div>
      <div className={cn(VERDICT_NUMS_W, 'shrink-0 text-right tabular-nums text-[13px]')}>{nums}</div>
      <div className={cn(VERDICT_CHIP_W, 'shrink-0')}>{chip}</div>
    </div>
  );
}

function VerdictChart({ channels, ue }: { channels: ChannelView[]; ue: UnitEconomics | null }) {
  const meta = channels.find((c) => c.key === 'meta');
  const google = channels.find((c) => c.key === 'google');
  const rows = [
    // Meta: real campaigns only — the '(otras N campañas)' aggregate is not a
    // campaign and would dominate the chart with an average of leftovers.
    ...(meta?.campaigns ?? [])
      .filter((c) => c.spendAud > 0 && !c.campaign.startsWith('(otras'))
      .map((c) => ({ ch: 'Meta' as const, c })),
    ...(google?.campaigns ?? [])
      .filter((c) => c.spendAud > 0)
      .map((c) => ({ ch: 'Google' as const, c })),
  ]
    .map(({ ch, c }) => ({
      ch,
      campaign: c.campaign,
      note: c.note,
      spendAud: c.spendAud,
      floor: c.storeLastClickAud / c.spendAud,
      ceiling: c.claimedValueAud / c.spendAud,
    }))
    .sort((a, b) => b.spendAud - a.spendAud);

  const breakeven = ue?.breakevenMer ?? null;
  const target = ue?.targetMer ?? null;
  const scaleMax = Math.max(4, target !== null ? Math.ceil(target) + 1 : 4);
  const pos = (v: number) => (Math.min(v, scaleMax) / scaleMax) * 100;

  const verdict = (floor: number, ceiling: number): ReactNode => {
    if (!ue) return <span className="text-[13px] text-muted-foreground">—</span>;
    if (target !== null && floor > target)
      return <Chip tone="green">works even undercounted</Chip>;
    if (breakeven !== null && ceiling < breakeven)
      return <Chip tone="red">loses even at panel numbers</Chip>;
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <Chip tone="amber">keep collecting</Chip>
        <span className="text-xs text-muted-foreground leading-tight">
          {breakeven !== null && floor < breakeven ? 'floor below breakeven' : 'above breakeven, below target'}
        </span>
      </span>
    );
  };

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Paid campaigns — what they really return
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-3">
        Floor = what the store recognises by last click. Ceiling = what the platform claims.
        The truth sits between.
      </p>

      {!ue && (
        <p className="text-[13px] text-amber-700 dark:text-amber-400 mb-3">
          No unit-economics row covers this window — the breakeven and target lines are hidden.
        </p>
      )}
      {ue && target === null && (
        <p className="text-[13px] text-amber-700 dark:text-amber-400 mb-3">
          Target not reachable at current economics — only the breakeven line is drawn.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">No paid campaign with spend in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[780px] space-y-2">
            {/* header: line labels + column captions */}
            <VerdictRowShell
              label={
                <span className="text-[13px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
                  Campaign
                  <InfoTip
                    label="Where the two dashed lines come from"
                    content={
                      <>
                        {ue ? (
                          <>
                            <p><b>Red line, breakeven {fmtX(breakeven)}</b> — below it a campaign loses
                            money. It is 1 ÷ your contribution margin
                            ({Math.round(ue.cm1Pct * 1000) / 10}%): what is left of each $1 of sales after
                            product cost, shipping, packaging and payment fees, before any advertising.</p>
                            <p className="mt-1.5"><b>Green line, target {target === null ? '—' : fmtX(target)}</b>
                            {' '}— what a campaign has to return for the business to make its
                            {' '}{Math.round(ue.targetMarginPct * 100)}% operating profit, once the
                            US${fmtNum(ue.fixedCostsUsd)}/month of fixed costs are paid too.</p>
                            <p className="mt-1.5 text-muted-foreground">Source: Juan's unit-economics
                            workbook, month {ue.month}. Change the workbook and both lines move.</p>
                          </>
                        ) : (
                          <p>No unit-economics row covers this window, so the reference lines are hidden.</p>
                        )}
                      </>
                    }
                  />
                </span>
              }
              bar={
                <>
                  {breakeven !== null && (
                    <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 whitespace-nowrap text-xs font-medium text-red-600 dark:text-red-400"
                          style={{ left: `${pos(breakeven)}%` }}>
                      breakeven {fmtX(breakeven)}
                    </span>
                  )}
                  {target !== null && ue && (
                    <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 whitespace-nowrap text-xs font-medium text-emerald-600 dark:text-emerald-400"
                          style={{ left: `${pos(target)}%` }}>
                      target {(ue.targetMarginPct * 100).toFixed(0)}% margin {fmtX(target)}
                    </span>
                  )}
                </>
              }
              nums={<span className="text-[13px] uppercase tracking-wider text-muted-foreground">floor → ceiling</span>}
              chip={<span className="text-[13px] uppercase tracking-wider text-muted-foreground">Verdict</span>}
            />

            {rows.map((r) => {
              const floorPos = pos(r.floor);
              const ceilPos = pos(r.ceiling);
              const offScale = r.ceiling > scaleMax;
              const color = r.ch === 'Meta' ? '#3b82f6' : '#10b981';
              return (
                <VerdictRowShell
                  key={`${r.ch}-${r.campaign}`}
                  label={
                    <div className="min-w-0">
                      {/* Campaign names WRAP, never truncate: a cut name is
                          unusable — you cannot tell two "HD Shower Screen …"
                          campaigns apart from their first 20 characters. */}
                      <div className="flex items-start gap-1.5 min-w-0">
                        <span className="inline-block h-2 w-2 rounded-full shrink-0 mt-[6px]" style={{ background: color }} />
                        <span className="text-[15px] leading-snug break-words">{r.campaign}</span>
                      </div>
                      {r.note && <p className="text-xs text-amber-700 dark:text-amber-400 leading-tight mt-0.5">{r.note}</p>}
                    </div>
                  }
                  bar={
                    <>
                      <div className="absolute inset-0 rounded bg-muted/50" />
                      {breakeven !== null && (
                        <div className="absolute inset-y-0 border-l border-dashed border-red-500/60"
                             style={{ left: `${pos(breakeven)}%` }} />
                      )}
                      {target !== null && (
                        <div className="absolute inset-y-0 border-l border-dashed border-emerald-500/70"
                             style={{ left: `${pos(target)}%` }} />
                      )}
                      <div
                        className="absolute inset-y-1 rounded-sm"
                        style={{
                          left: `${Math.min(floorPos, 99)}%`,
                          width: `${Math.max(ceilPos - floorPos, 1)}%`,
                          background: `linear-gradient(90deg, ${color}cc, ${color}55)`,
                        }}
                      />
                      {offScale && (
                        <span className="absolute right-0.5 top-1/2 -translate-y-1/2 text-sm font-bold"
                              style={{ color }} title="ceiling beyond the scale — true numbers on the right">
                          »
                        </span>
                      )}
                    </>
                  }
                  nums={
                    <span className={cn(offScale && 'font-medium')}>
                      {fmtX(r.floor)} → {fmtX(r.ceiling)}
                      {offScale && <span className="block text-xs text-muted-foreground">off scale</span>}
                    </span>
                  }
                  chip={verdict(r.floor, r.ceiling)}
                />
              );
            })}

            {/* axis */}
            <VerdictRowShell
              label={null}
              bar={
                <>
                  {Array.from({ length: scaleMax + 1 }, (_, i) => (
                    <span key={i}
                          className="absolute top-0 -translate-x-1/2 text-xs tabular-nums text-muted-foreground/70"
                          style={{ left: `${(i / scaleMax) * 100}%` }}>
                      {i}×
                    </span>
                  ))}
                </>
              }
              nums={null}
              chip={null}
            />
          </div>
        </div>
      )}

      <div className="mt-3 space-y-1">
        <p className="text-[13px] text-muted-foreground/70">
          The ads only started carrying tags we can trace on 6 Aug 2026. Pick a range that reaches
          further back and the left end of every bar reads lower than it really was.
        </p>
        <p className="text-[13px] text-muted-foreground/70">
          Google Shopping's left end reads high: we detect it from the product-feed tag, which also
          catches Google's free listings. It gets exact once the campaign is tagged properly.
        </p>
        <p className="text-[13px] text-muted-foreground/70">
          Platform claims for the most recent days are still maturing (Meta re-reads ~30 days).
        </p>
      </div>
    </Card>
  );
}

// ── Campaigns: per-channel efficiency + one unified table ────────────────────

/** The five ratios that decide budget, for one channel. All null-guarded: a
 *  channel with no spend or no new-customer orders renders '—', never Infinity. */
function ChannelEfficiency({ ch }: { ch: ChannelView }) {
  const items: { label: string; value: string }[] = [
    { label: 'Store ROAS', value: fmtX(ratio(ch.storeLastAud, ch.spendAud)) },
    { label: 'Panel ROAS', value: fmtX(ratio(ch.claimedAud, ch.spendAud)) },
    { label: 'CPA', value: fmtAud(ratio(ch.spendAud, ch.orders)) },
    { label: 'NC-CPA', value: fmtAud(ratio(ch.spendAud, ch.newCustomerOrders)) },
    { label: 'NC-ROAS', value: fmtX(ratio(ch.newCustomerRevenueAud, ch.spendAud)) },
  ];
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {ch.label}
        </h3>
        <p className="text-[15px] tabular-nums">
          <span className="text-[13px] text-muted-foreground mr-1.5">spend</span>
          <span className="font-medium">{fmtAud(ch.spendAud)}</span>
          <Usd value={ch.spendUsd} size="table" />
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {items.map((i) => (
          <div key={i.label}>
            <p className="text-[13px] uppercase tracking-wider text-muted-foreground truncate">{i.label}</p>
            <p className="text-xl font-semibold tabular-nums leading-tight mt-0.5">{i.value}</p>
          </div>
        ))}
      </div>
      {/* The channel-level caveat from the RPC (e.g. the pre-6-Aug Google
          under-count) — never dropped, it changes how the row is read. */}
      {ch.note && (
        <p className="text-[13px] text-amber-700 dark:text-amber-400 mt-3">{ch.note}</p>
      )}
    </Card>
  );
}

/** A right-aligned numeric column header that carries its own explanation.
 *  Every metric column in the tab has one — a column nobody can define is a
 *  column nobody can act on. */
function ColHead({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <th className="text-right font-medium pb-1.5">
      <span className="inline-flex items-center gap-1">
        {children}
        <InfoTip label={typeof children === 'string' ? children : 'Definition'} content={<p>{tip}</p>} />
      </span>
    </th>
  );
}

type ChannelFilter = 'all' | 'meta' | 'google';

/** The residual aggregate the RPC appends so the rendered rows still sum to the
 *  channel totals. It is DATA, not a campaign — never translated, never charted. */
const isResidual = (campaign: string) => campaign.startsWith('(otras');

function CampaignTable({ channels }: { channels: ChannelView[] }) {
  const [filter, setFilter] = useState<ChannelFilter>('all');

  const rows = channels
    .filter((ch) => filter === 'all' || ch.key === filter)
    .flatMap((ch) => ch.campaigns.map((c) => ({ ch, c })))
    // Residual rows last: they are leftovers, not the campaigns being judged.
    .sort((a, b) =>
      (isResidual(a.c.campaign) ? 1 : 0) - (isResidual(b.c.campaign) ? 1 : 0) ||
      b.c.spendAud - a.c.spendAud);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Every campaign, both channels
        </h3>
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          {([['all', 'All'], ['meta', 'Meta'], ['google', 'Google']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setFilter(k)}
              className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors',
                filter === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-[15px]">
          <thead>
            <tr className="text-[13px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Campaign</th>
              <th className="text-left font-medium pb-1.5">Channel</th>
              <ColHead tip="What the platform charged you for this campaign in the selected days.">Spend</ColHead>
              <ColHead tip={<>What the platform's own panel says this campaign sold. It counts people who
                only <b>saw</b> the ad, and it keeps rewriting the last few days upward, so treat fresh days
                as provisional.</>}>Claims</ColHead>
              <ColHead tip={<>What the store can actually trace to this campaign: the order's last click
                before buying was this ad. Ignores anyone who saw the ad and never clicked, or who clicked
                on the phone and bought on the laptop — so it is a <b>floor</b>.</>}>Store (closed)</ColHead>
              <ColHead tip="Store (closed) ÷ Spend. The pessimistic return: what you can prove.">Store ROAS</ColHead>
              <ColHead tip="Claims ÷ Spend. The optimistic return: what the platform says. The truth is between this and Store ROAS.">Panel ROAS</ColHead>
              <ColHead tip="Orders whose last click was this campaign.">Orders</ColHead>
              <ColHead tip="Of those orders, how many came from someone buying for the first time.">NC orders</ColHead>
              <ColHead tip={<>Spend ÷ new customers: what this campaign paid to win one first-time buyer.
                Compare it against the workbook lines on the New-customer CAC card.</>}>NC-CPA</ColHead>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ ch, c }) => (
              <tr key={`${ch.key}-${c.campaign}`} className="border-t border-border/40">
                <td className="py-1.5">
                  <span className={cn('font-medium', isResidual(c.campaign) && 'text-muted-foreground italic')}>
                    {c.campaign}
                  </span>
                  {c.note && <span className="block text-xs text-amber-700 dark:text-amber-400">{c.note}</span>}
                </td>
                <td className="py-1.5">
                  <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <span className="inline-block h-2 w-2 rounded-full"
                          style={{ background: ch.key === 'meta' ? '#3b82f6' : '#10b981' }} />
                    {ch.label}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.spendAud)}<Usd value={c.spendUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtAud(c.claimedValueAud)}<Usd value={c.claimedValueUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(c.storeLastClickAud)}<Usd value={c.storeLastClickUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtX(ratio(c.storeLastClickAud, c.spendAud))}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtX(ratio(c.claimedValueAud, c.spendAud))}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtNum(c.orders)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtNum(c.newCustomerOrders)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(ratio(c.spendAud, c.newCustomerOrders))}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="py-3 text-[15px] text-muted-foreground">No campaign in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[13px] text-muted-foreground/70 mt-2">
        The rows add up to each channel's totals above — the '(otras N campañas)' row carries
        the residual so nothing is lost.
      </p>
    </Card>
  );
}

/** Google split by bucket — only meaningful from 6-Aug-2026 (spec date-gate).
 *  Labels go through the shared map: the raw key ('google-mixto-pre') never
 *  reaches the screen (plan 07, fix 6). */
function GoogleBuckets({ rows }: { rows: GoogleBucketRow[] }) {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        Google by bucket · since 6-Aug
        <InfoTip
          label="Why Google is split this way"
          content={
            <>
              <p>Google sends traffic four different ways and they are worth very different things:
              people searching your <b>brand name</b> (they already knew you), people searching a
              <b> category</b>, <b>Shopping</b> listings, and <b>free</b> search results you pay nothing for.</p>
              <p className="mt-1.5">Only from <b>6 Aug 2026</b> do the ads carry tags that let us tell paid
              from free. Anything before that date sits in one mixed bucket and is never presented as
              organic — it would flatter the free side and hide what the ads did.</p>
            </>
          }
        />
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-3">
        Before 6-Aug Google paid and organic were a single bucket (no UTMs): that history is shown
        separately as "Google mixed", never as organic.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-[15px]">
          <thead>
            <tr className="text-[13px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Bucket</th>
              <th className="text-right font-medium pb-1.5">Orders</th>
              <th className="text-right font-medium pb-1.5">Net AUD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket} className="border-t border-border/40">
                <td className="py-1.5">
                  {channelMixLabel(r.bucket)}
                  {r.note && <span className="block text-xs text-muted-foreground/70">{r.note}</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtNum(r.orders)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(r.revenueAud)}<Usd value={r.revenueUsd} size="table" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── C1: channel overlap ──────────────────────────────────────────────────────

function OverlapCard({ o }: { o: OverlapSplit }) {
  const segs = [
    { label: 'Only Meta', orders: o.onlyMetaOrders, aud: o.onlyMetaRevenueAud, usd: o.onlyMetaRevenueUsd, color: '#3b82f6' },
    { label: 'Both', orders: o.bothOrders, aud: o.bothRevenueAud, usd: o.bothRevenueUsd, color: '#8b5cf6' },
    { label: 'Only Google', orders: o.onlyGoogleOrders, aud: o.onlyGoogleRevenueAud, usd: o.onlyGoogleRevenueUsd, color: '#10b981' },
  ];
  const total = segs.reduce((s, x) => s + x.orders, 0);

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        Channel overlap
        <InfoTip
          label="What overlap means"
          content={
            <>
              <p>Of the orders where somebody clicked a <b>paid</b> ad on the way to buying: how many
              touched only Meta, how many only Google, and how many touched both.</p>
              <p className="mt-1.5"><b>The "both" group is the heart of the argument with the agencies.</b>
              {' '}Meta counts those orders as its own, and Google counts the same orders as its own. Neither
              is lying; they simply both saw the customer.</p>
              <p className="mt-1.5">This counts touches on the journey, not credit. It does not say which
              side caused the sale.</p>
            </>
          }
        />
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-3">
        Paid click of each side anywhere in the journey — the 'both' segment is what both
        platforms claim entirely.
      </p>
      {total === 0 ? (
        <p className="text-[15px] text-muted-foreground">No paid-touched orders in this window.</p>
      ) : (
        <>
          <div className="flex h-6 w-full overflow-hidden rounded-md">
            {segs.map((s) => (
              <div key={s.label}
                   title={`${s.label}: ${fmtNum(s.orders)} orders`}
                   style={{ width: `${Math.max((s.orders / total) * 100, 2)}%`, background: s.color }} />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {segs.map((s) => (
              <div key={s.label}>
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  {s.label}
                </p>
                <p className="text-xl font-semibold tabular-nums mt-0.5">{fmtNum(s.orders)}</p>
                <p className="text-[13px] text-muted-foreground tabular-nums">
                  {fmtAud(s.aud)}<Usd value={s.usd} size="table" />
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── C2: live orders ──────────────────────────────────────────────────────────

function LiveOrdersCard({ orders }: { orders: LiveOrder[] }) {
  const today = storeToday();
  const yest = shiftDays(-1);
  const dayLabel = (createdAt: string) => {
    const d = createdAt.slice(0, 10);
    if (d === today) return 'today';
    if (d === yest) return 'yesterday';
    return fmtDay(d);
  };

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        Live orders
        <InfoTip
          label="What this list shows"
          content={
            <>
              <p>The last 12 orders the store took, with the channel that closed each one. It ignores
              the date range on purpose — it is a pulse, not a report.</p>
              <p className="mt-1.5">The small <b>M</b> and <b>G</b> marks mean a paid Meta or Google click
              appeared somewhere in that customer's journey.</p>
              <p className="mt-1.5">An amount showing "syncing" is an order that arrived seconds ago and
              whose lines have not loaded yet — not a zero-value order.</p>
            </>
          }
        />
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-2">
        The latest 12 orders, whatever range is selected above. Times are Brisbane.
      </p>
      <div>
        {orders.map((o) => (
          <div key={o.name} className="flex items-center gap-2 border-t border-border/40 py-1.5 text-[15px]">
            <span className="font-medium whitespace-nowrap">{o.name}</span>
            <span className="flex items-center gap-1 shrink-0">
              {o.touchesMeta && (
                <span title="Meta paid click in the journey"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400 text-[10px] font-bold">
                  M
                </span>
              )}
              {o.touchesGoogle && (
                <span title="Google paid click in the journey"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400 text-[10px] font-bold">
                  G
                </span>
              )}
            </span>
            <span className="flex-1 truncate text-[13px] text-muted-foreground" title={channelMixLabel(o.lastBucket)}>
              {shortBucketLabel(o.lastBucket)}
            </span>
            <span className="text-[13px] text-muted-foreground whitespace-nowrap tabular-nums">
              {o.createdAt.slice(11, 16)} · {dayLabel(o.createdAt)}
            </span>
            <span className="w-[110px] text-right tabular-nums">
              {o.netAud === null
                ? <span className="italic text-muted-foreground">syncing…</span>
                : <>{fmtAud(o.netAud)}<Usd value={o.netUsd} size="table" /></>}
            </span>
          </div>
        ))}
        {orders.length === 0 && (
          <p className="text-[15px] text-muted-foreground">No orders captured yet.</p>
        )}
      </div>
    </Card>
  );
}

// ── B3: incrementality — "Is Google adding sales?" ───────────────────────────

function bandPosition(r: number, band: AdvertisingIncrementality['band']): string {
  if (r > band.maxPct)
    return `above the zero-spend maximum (${band.maxPct}%) — outside everything the no-spend period ever produced`;
  if (r > band.p75Pct)
    return `above p75 (${band.p75Pct}%) but below the zero-spend maximum (${band.maxPct}%) — historical windows reached this with zero spend`;
  if (r >= band.p25Pct)
    return `inside the zero-spend band (p25 ${band.p25Pct}% – p75 ${band.p75Pct}%) — indistinguishable from no ads`;
  return `below the zero-spend p25 (${band.p25Pct}%)`;
}

function IncrementalityBlock({ inc, loading, error }: {
  inc: AdvertisingIncrementality | null; loading: boolean; error: string | null;
}) {
  if (loading || (!inc && !error)) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Is Google adding sales?
        </h3>
        <div className="h-[200px] flex items-center justify-center rounded-md bg-muted/30">
          <p className="text-[15px] text-muted-foreground animate-pulse">
            Computing 14 months of attribution… this takes ~15 seconds, it runs once.
          </p>
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Is Google adding sales?
        </h3>
        <p className="text-[15px] text-red-700 dark:text-red-400">{error}</p>
      </Card>
    );
  }
  const data = inc!;
  const { band, brandCut, last10Days } = data;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
        Is Google adding sales?
        <InfoTip
          label="How to read this"
          content={
            <>
              <p><b>Everything Google brings</b> — paid clicks plus free search results — <b>divided by
              everything the rest of the store brings.</b> One number per month.</p>
              <p className="mt-1.5">Why divided instead of the plain amount: the store grows and shrinks
              on its own, so the plain amount would move even if Google did nothing.</p>
              <p className="mt-1.5"><b>The grey band</b> is what that ratio did over {band.windows} different
              stretches of {band.windowDays} days back when <b>you spent nothing on Google</b>. If today's
              months sit inside that band, paid Google is not adding anything you weren't already getting.
              Above it, and sustained, it is.</p>
              <p className="mt-1.5">Careful: those stretches ranged from {band.minPct}% to {band.maxPct}%
              with zero spend. One month above the band proves nothing.</p>
            </>
          }
        />
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-3">
        Everything Google brings (paid clicks + free search results, counted together because
        before 6 Aug 2026 they could not be told apart) ÷ everything the rest of the store brings,
        month by month — against what that ratio did over {band.windows} stretches of {band.windowDays} days
        back when Google spend was zero.
      </p>

      <div className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data.monthly} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
            <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fontSize: 12 }}
                   axisLine={false} tickLine={false} minTickGap={12} />
            <YAxis tick={{ fontSize: 12 }} axisLine={false} tickLine={false} width={44}
                   tickFormatter={(v: number) => `${v}%`} domain={[0, 'auto']} />
            {/* Counterfactual band: p25–p75 of the zero-spend 10-day windows. */}
            <ReferenceArea y1={band.p25Pct} y2={band.p75Pct} fill="#94a3b8" fillOpacity={0.18}
                           ifOverflow="extendDomain" />
            <ReferenceLine y={band.medianPct} stroke="#64748b" strokeDasharray="4 3"
                           label={{ value: `zero-spend median ${band.medianPct}%`, position: 'insideTopRight', fontSize: 12, fill: '#64748b' }} />
            <RTooltip
              cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as AdvertisingIncrementality['monthly'][number];
                return (
                  <div className="rounded-lg border bg-popover px-2.5 py-2 text-[13px] shadow-md space-y-0.5">
                    <div className="font-medium">{fmtMonth(p.month)}</div>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">Bag ÷ rest</span><span className="tabular-nums font-medium">{p.ratioPct.toFixed(1)}%</span></div>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">Google bag</span><span className="tabular-nums">{fmtAud(p.bagAud)}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">Rest of store</span><span className="tabular-nums">{fmtAud(p.restAud)}</span></div>
                    <div className="flex justify-between gap-4"><span className="text-muted-foreground">Google spend</span><span className="tabular-nums">{fmtAud(p.googleSpendAud)}</span></div>
                  </div>
                );
              }}
            />
            <Bar dataKey="ratioPct" fill="#3b82f6" radius={[4, 4, 0, 0]} name="bag ÷ rest" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[13px] text-muted-foreground/70 mt-1 mb-3">
        Shaded band: p25–p75 of the zero-spend windows ({band.period}).
      </p>

      <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
        <StatCard label="Last 10 days" value={`${last10Days.ratioPct.toFixed(1)}%`} accent="#3b82f6"
          sub={`To ${fmtDay(last10Days.to)} — ${bandPosition(last10Days.ratioPct, band)}.`} />
        <StatCard label={`Brand cut (${fmtDay(brandCut.cutDate)})`}
          value={`${brandCut.pre.ratioPct.toFixed(1)}% → ${brandCut.post.ratioPct.toFixed(1)}%`} accent="#8b5cf6"
          sub={`Brand spend ${fmtAud(brandCut.pre.brandSpendPerDayAud)}/day → ${fmtAud(brandCut.post.brandSpendPerDayAud)}/day. If the bag holds while brand spend stays cut, brand was harvesting demand it didn't create.`} />
        <StatCard label="Verdict due" value={fmtDay(brandCut.verdictDate)} accent="#f59e0b"
          sub="After a full month at the reduced brand spend. Until then every reading is preliminary." />
      </div>

      <p className="text-[13px] text-muted-foreground/70 mt-3">
        Reading rule: the yardstick is the whole Google bag ÷ the rest of the store.
        Historical {band.windowDays}-day windows reached {band.maxPct}% with zero spend — only a
        sustained departure from the band means anything.
      </p>
    </Card>
  );
}

// ── B4: scale plan simulator (Juan's formulas, verbatim) ─────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function SimStat({ label, value, approx, sub }: {
  label: string; value: string; approx?: string; sub: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <p className="text-sm font-medium tracking-wide uppercase text-muted-foreground mb-1 truncate">{label}</p>
      <p className="text-2xl font-semibold tabular-nums leading-none">
        {value}
        {approx && <span className="ml-1 text-[0.6em] font-normal text-muted-foreground align-baseline">{approx}</span>}
      </p>
      <p className="text-[13px] text-muted-foreground/70 leading-tight mt-1.5">{sub}</p>
    </div>
  );
}

export type PlanDraft = { profit: number; spend: number };

/** Commits the month's plan for everyone. The write goes through the definer
 *  RPC advertising_plan_save, which stamps the actor from the session's JWT —
 *  the client cannot claim to be someone else. Saving a month that already has
 *  a plan overwrites it, so the button says so. */
function SavePlan({ month, spend, profit, plan, dirty, onSaved }: {
  month: string; spend: number; profit: number;
  plan: MonthlyPlan | null; dirty: boolean; onSaved: () => void;
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setState('saving');
    setMessage(null);
    const { error } = await supabase.rpc('advertising_plan_save', {
      p_month: `${month}-01`,
      p_spend_usd: spend,
      p_profit_usd: profit,
    });
    if (error) {
      setState('error');
      setMessage(error.message.includes('AUTH_REQUIRED')
        ? 'Your session expired — sign in again to save.'
        : error.message);
      return;
    }
    setState('idle');
    setMessage(null);
    onSaved();
  };

  return (
    <div className="text-right">
      <Button size="sm" onClick={save} disabled={state === 'saving' || !dirty}>
        {state === 'saving'
          ? 'Saving…'
          : !dirty
            ? `Plan saved for ${fmtMonth(month)}`
            : plan
              ? `Update the ${fmtMonth(month)} plan`
              : `Save as the ${fmtMonth(month)} plan`}
      </Button>
      <p className="text-[13px] text-muted-foreground/70 mt-1.5 max-w-[280px]">
        {plan
          ? <>Committed plan: {fmtUsd0(plan.plannedSpendUsd)} spend for {fmtUsd0(plan.targetProfitUsd)} profit.{' '}
              {dirty ? 'Saving replaces it for everyone.' : 'The tracking below measures the month against it.'}</>
          : <>No plan committed for {fmtMonth(month)} yet. Saving one turns on the daily tracking below and
              is visible to everyone who opens the tab.</>}
      </p>
      {state === 'error' && message && (
        <p className="text-[13px] text-red-600 dark:text-red-400 mt-1 max-w-[280px]">{message}</p>
      )}
    </div>
  );
}

function ScalePlan({ ue, plan, blended, from, to, totalOrders, draft, onDraft, onSaved }: {
  ue: UnitEconomics | null;
  plan: MonthlyPlan | null;
  blended: AdvertisingDashboard['blended'];
  from: string;
  to: string;
  totalOrders: number;
  draft: PlanDraft | null;
  onDraft: (d: PlanDraft) => void;
  onSaved: () => void;
}) {
  // The draft lives in the PARENT (see AdvertisingTab): this component unmounts
  // every time you switch workspace, and local state died with it — you moved a
  // slider, went to Overview, came back and it had snapped to the default.
  const defaultSpend = clamp(Math.round(plan?.plannedSpendUsd ?? DEFAULT_PLANNED_SPEND_USD), 0, 300_000);
  const defaultProfit = clamp(
    ue
      ? Math.round(plan?.targetProfitUsd
          ?? (ue.cm1Pct * ue.baselineRevenueUsd - ue.fixedCostsUsd - defaultSpend))
      : 58_000,
    0, 150_000,
  );
  const profit = draft?.profit ?? defaultProfit;
  const spend = draft?.spend ?? defaultSpend;
  const setProfit = (v: number) => onDraft({ profit: v, spend });
  const setSpend = (v: number) => onDraft({ profit, spend: v });

  // What the month's committed plan says, versus what is on screen right now.
  const planMonth = to.slice(0, 7);
  const savedForThisMonth = plan !== null && plan.month === planMonth;
  const dirty = !savedForThisMonth
    || Math.round(plan.plannedSpendUsd) !== spend
    || Math.round(plan.targetProfitUsd) !== profit;

  if (!ue) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          Scale plan
        </h3>
        <p className="text-[15px] text-muted-foreground">
          No unit-economics row covers this window — load Juan's monthly workbook row to
          simulate.
        </p>
      </Card>
    );
  }

  // USD is primary HERE ONLY: these are Juan's workbook formulas in the
  // workbook's currency. The AUD companion is approximate, via the window's
  // implied blended rate.
  const impliedRate = blended.revenueUsd > 0 ? blended.revenueAud / blended.revenueUsd : null;
  const fmtU = (v: number | null) => (v === null ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`);
  const approxA = (v: number | null) =>
    v === null || impliedRate === null ? undefined : `≈ A$${Math.round(v * impliedRate).toLocaleString('en-AU')}`;

  // Juan's formulas, verbatim (plan 06 §B4 — verified against the 1.38× row):
  const revenueNeeded = (profit + ue.fixedCostsUsd + spend) / ue.cm1Pct;
  const ordersNeeded = revenueNeeded / ue.revenuePerOrderUsd;
  const newCustomers = ordersNeeded * ue.pctNewCustomers;
  const targetCac = ratio(spend, newCustomers);
  const requiredMer = ratio(revenueNeeded, spend);
  const capCac = ue.cm1Pct * ue.revenuePerOrderUsd; // ≈ $55.07 with July numbers

  const cacChip = targetCac === null ? null
    : targetCac <= HEALTHY_CAC_USD
      ? <Chip tone="green">CAC healthy — under the ${HEALTHY_CAC_USD} line (3× LTV:CAC)</Chip>
      : targetCac <= capCac
        ? <Chip tone="amber">CAC above the healthy ${HEALTHY_CAC_USD}, under the ${capCac.toFixed(2)} CM1-per-order cap</Chip>
        : <Chip tone="red">CAC above the ${capCac.toFixed(2)} cap — each new customer costs more than it contributes</Chip>;

  const merChip = requiredMer === null ? null
    : requiredMer >= ue.breakevenMer
      ? <Chip tone="green">needs {fmtX(requiredMer)} — above the {ue.breakevenMer}× breakeven floor</Chip>
      : <Chip tone="red">below the {ue.breakevenMer}× breakeven — the row is fiction</Chip>;

  // MTD tracking (only when a plan is committed for the month of `to`).
  const showTracking = plan !== null && plan.month === to.slice(0, 7);
  let tracking: { label: string; required: number; actual: number; money: boolean }[] = [];
  if (showTracking && plan) {
    const [py, pm] = plan.month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const windowDays = inclusiveDays(from, to);
    const planRevenueUsd = (plan.targetProfitUsd + ue.fixedCostsUsd + plan.plannedSpendUsd) / ue.cm1Pct;
    const planOrders = planRevenueUsd / ue.revenuePerOrderUsd;
    tracking = [
      { label: 'Revenue (USD)', required: planRevenueUsd / daysInMonth, actual: blended.revenueUsd / windowDays, money: true },
      { label: 'Orders', required: planOrders / daysInMonth, actual: totalOrders / windowDays, money: false },
      { label: 'Spend (USD)', required: plan.plannedSpendUsd / daysInMonth, actual: blended.spendUsd / windowDays, money: true },
    ];
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Scale plan — Juan's formulas
          </h3>
          <p className="text-[13px] text-muted-foreground/70">
            USD — the workbook's currency. AUD companions are approximate, via the window's
            implied rate.
          </p>
        </div>
        <SavePlan
          month={planMonth}
          spend={spend}
          profit={profit}
          plan={savedForThisMonth ? plan : null}
          dirty={dirty}
          onSaved={onSaved}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-5">
          <div>
            <label className="text-[15px] font-medium">Monthly operating profit you accept</label>
            <div className="flex items-center gap-3 mt-2">
              <Slider value={[profit]} min={0} max={150_000} step={1_000}
                      onValueChange={([v]) => setProfit(v)} className="flex-1" />
              <input type="number" min={0} max={150_000} step={1_000} value={profit}
                     onChange={(e) => setProfit(clamp(Number(e.target.value) || 0, 0, 150_000))}
                     className="h-8 w-28 rounded-md border bg-background px-2 text-sm tabular-nums" />
            </div>
            <p className="text-[13px] text-muted-foreground/70 mt-1">USD / month</p>
          </div>
          <div>
            <label className="text-[15px] font-medium">Monthly ad spend</label>
            <div className="flex items-center gap-3 mt-2">
              <Slider value={[spend]} min={0} max={300_000} step={1_000}
                      onValueChange={([v]) => setSpend(v)} className="flex-1" />
              <input type="number" min={0} max={300_000} step={1_000} value={spend}
                     onChange={(e) => setSpend(clamp(Number(e.target.value) || 0, 0, 300_000))}
                     className="h-8 w-28 rounded-md border bg-background px-2 text-sm tabular-nums" />
            </div>
            <p className="text-[13px] text-muted-foreground/70 mt-1">USD / month, Meta + Google</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
            <SimStat label="Revenue needed" value={fmtU(revenueNeeded)} approx={approxA(revenueNeeded)}
              sub={<>= (profit + fixed {fmtU(ue.fixedCostsUsd)} + spend) ÷ CM1 {(ue.cm1Pct * 100).toFixed(1)}%</>} />
            <SimStat label="Orders" value={fmtNum(ordersNeeded)}
              sub={<>= revenue ÷ ${ue.revenuePerOrderUsd}/order</>} />
            <SimStat label="New customers" value={fmtNum(newCustomers)}
              sub={<>= orders × {(ue.pctNewCustomers * 100).toFixed(1)}% first purchases</>} />
            <SimStat label="Target CAC" value={fmtU(targetCac)}
              sub="= spend ÷ new customers" />
            <SimStat label="Target MER" value={fmtX(requiredMer)}
              sub="= revenue ÷ spend — what the store must return blended" />
          </div>
          <div className="flex flex-wrap gap-2">
            {cacChip}
            {merChip}
          </div>
        </div>
      </div>

      {showTracking && plan && (
        <div className="mt-5">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Plan tracking — {fmtMonth(plan.month)}
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full max-w-2xl min-w-[480px] text-[15px]">
              <thead>
                <tr className="text-[13px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium pb-1.5">Per day</th>
                  <th className="text-right font-medium pb-1.5">Plan requires</th>
                  <th className="text-right font-medium pb-1.5">Actual (window)</th>
                  <th className="text-right font-medium pb-1.5">Pace</th>
                </tr>
              </thead>
              <tbody>
                {tracking.map((t) => {
                  const pace = ratio(t.actual, t.required);
                  const tone = pace === null ? 'amber'
                    : t.label.startsWith('Spend')
                      ? (pace >= 0.8 && pace <= 1.2 ? 'green' : 'amber')
                      : pace >= 1 ? 'green' : pace >= 0.9 ? 'amber' : 'red';
                  return (
                    <tr key={t.label} className="border-t border-border/40">
                      <td className="py-1.5">{t.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{t.money ? fmtU(t.required) : fmtNum(t.required)}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{t.money ? fmtU(t.actual) : fmtNum(t.actual)}</td>
                      <td className="py-1.5 text-right">
                        <Chip tone={tone}>{pace === null ? '—' : `${Math.round(pace * 100)}%`}</Chip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[13px] text-muted-foreground/70 mt-2">
            Actual = the window selected above ({from} → {to}). Select the current month to read
            it as month-to-date.
          </p>
        </div>
      )}

      <p className="text-[13px] text-muted-foreground/70 mt-4">
        Constants from Juan's July workbook (CM1 {(ue.cm1Pct * 100).toFixed(1)}%, fixed {fmtU(ue.fixedCostsUsd)},
        ${ue.revenuePerOrderUsd}/order, {(ue.pctNewCustomers * 100).toFixed(1)}% new) — refreshed monthly.
      </p>
    </Card>
  );
}

// ── D1: Help — SOPs on a separate surface (no inline toggles) ────────────────
// This is where the methodology prose lives. Anything stripped from a main
// screen lands in the relevant section below rather than being deleted.

const HELP_SECTIONS: { title: string; body: ReactNode }[] = [
  {
    title: 'Reading the floor/ceiling chart',
    body: (
      <>
        <p><b>The left end of the bar (floor)</b> is what the store can prove: the order's last
        click before buying was that ad. It counts less than reality — it cannot see someone who
        watched the ad without clicking, or who clicked on the phone and bought on the laptop.</p>
        <p><b>The right end (ceiling)</b> is what the platform's own panel claims. It counts more
        than reality — Meta and Google both take credit for the same order when both were involved.</p>
        <p><b>The truth is somewhere inside the bar.</b> That is why it is drawn as a range and not
        as one number.</p>
        <p>Three verdicts: the <b>whole bar to the right of the green line</b> — it works even by the
        strict measure, put more money in. The <b>whole bar to the left of the red line</b> — it loses
        money even by the platform's own flattering numbers, cut it. The <b>lines crossing the bar</b>
        {' '}— not enough evidence yet, leave the budget alone and collect more weeks.</p>
        <p>Never decide from one end of the bar alone. Reading only the platform's end is what the
        agencies do; reading only ours would be equally wrong in the other direction.</p>
      </>
    ),
  },
  {
    title: 'Reading the period comparison',
    body: (
      <>
        <p>Every headline card carries a % against the immediately preceding window of the same
        length: pick 30 days and it compares against the 30 days before those.</p>
        <p>Both sides come from the same query over the whole window — never from a filtered
        subset of days, which would compare different things and call it growth.</p>
        <p>Green means better, red means worse: for CAC that is inverted, because a cheaper new
        customer is a better one. Ad spend is never coloured — spending more is a decision, not
        a result.</p>
        <p>Ranges longer than 92 days skip the comparison: the query is slow and a year-on-year
        read is not what this tab answers.</p>
      </>
    ),
  },
  {
    title: 'Comparing against Meta Ads Manager',
    body: (
      <>
        <p>Open one ad account at a time — US and AU are separate accounts in different
        currencies.</p>
        <p>Keep Ads Manager in the account's native currency; this tab converts everything to
        AUD, so match the currency before comparing totals.</p>
        <p>Match the attribution setting (7-day click, 1-day view) and the exact date range.</p>
        <p>Expect the most recent days to differ: Meta rewrites the last ~30 days as
        conversions late-attribute.</p>
      </>
    ),
  },
  {
    title: 'Comparing against the Google Ads panel',
    body: (
      <>
        <p>Google reports conversions on the click date; this tab reports orders on the order
        date (Brisbane day).</p>
        <p>An order placed today from a click last Tuesday lands on different days in the two
        systems.</p>
        <p>Compare whole weeks or months, never single days.</p>
      </>
    ),
  },
  {
    title: 'Loading the monthly Google spend CSV',
    body: (
      <>
        <p>In Google Ads: Reports → Report editor → daily cost by campaign → download as CSV.</p>
        <p>Open <b>Data health</b> from the top bar of this tab and load the days with the manual
        spend form at the bottom of the drawer.</p>
        <p>Verify: the daily MER line has no gap over the loaded period, and the tab's Google
        spend total matches the panel's.</p>
      </>
    ),
  },
  {
    title: 'A gap in the MER line',
    body: (
      <>
        <p>A gap is a day whose spend is not fully loaded — usually a missing Google day. It is
        never a zero: the tab refuses to compute a fake MER.</p>
        <p>Fix it by loading the missing day; Meta spend arrives by API on its own.</p>
        <p>Days before 25 Jun 2026 carry Meta spend only — Google did not exist in the
        denominator yet, so that MER is not comparable with a both-platform MER.</p>
      </>
    ),
  },
  {
    title: "What 'double counting' means",
    body: (
      <>
        <p>When both platforms had a paid click in an order's journey, each claims the full
        order — their panels sum to more than the store sold.</p>
        <p>Nobody is lying: each panel answers "did I touch this order?", not "was I the only
        cause?".</p>
        <p>The overlap card in Attribution shows how many orders are claimed twice; the ratio
        itself lives in Data health.</p>
      </>
    ),
  },
  {
    title: 'When to distrust the tab',
    body: (
      <>
        <p>Orders from the last 2–3 days often arrive without a journey: Shopify takes that long
        to assemble it. That is processing lag, not a channel.</p>
        <p>The "no journey" counter grows past those recent days: Shopify's journey feed is
        lagging.</p>
        <p>The "other tagged" or unclassified buckets grow: someone changed campaign URLs —
        UTM drift.</p>
        <p>Any Google split before 6 Aug 2026: no UTMs existed then, paid and organic are
        merged in "Google mixed".</p>
      </>
    ),
  },
];

function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>How to use this tab</DialogTitle>
          <DialogDescription className="text-[13px]">
            Short procedures for reading and maintaining the advertising numbers.
          </DialogDescription>
        </DialogHeader>
        <div>
          {HELP_SECTIONS.map((s) => (
            <details key={s.title} className="group border-b border-border/60 py-1.5">
              <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                {s.title}
                <span className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
              </summary>
              <div className="space-y-1.5 pb-2 text-[13px] leading-relaxed text-muted-foreground">
                {s.body}
              </div>
            </details>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Data health — the measurement diagnostics, off the main screens ──────────
// Everything here answers "can I trust the numbers?", not "how is the business
// doing?". It used to be scattered across the headline row, the Leadership prose
// and the bottom of the Google view.

function HealthRow({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border/40 py-1.5">
      <div className="min-w-0">
        <p className="text-[15px]">{label}</p>
        {sub && <p className="text-[13px] text-muted-foreground/70 leading-tight">{sub}</p>}
      </div>
      <p className="text-[15px] font-medium tabular-nums whitespace-nowrap">{value}</p>
    </div>
  );
}

function DataHealthSheet({ open, onOpenChange, data, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: AdvertisingDashboard;
  onSaved: () => void;
}) {
  const days = data.merSeries;
  const missing = days.filter((p) => p.spendAud === null);
  const metaOnly = days.filter((p) => p.spendAud !== null && !p.spendComplete);
  const complete = days.filter((p) => p.spendComplete);
  const b = data.blended;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Data health</SheetTitle>
          <SheetDescription className="text-[13px]">
            Can the numbers be trusted for this window — and the only place to load Google spend.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-6">
          <section>
            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Spend coverage · {data.from} → {data.to}
            </h4>
            <HealthRow label="Days with both platforms loaded" value={`${complete.length} of ${days.length}`} />
            <HealthRow label="Days with Meta spend only"
              value={fmtNum(metaOnly.length)}
              sub="Google was not spending yet, or its row is missing — the MER of those days is not comparable." />
            <HealthRow label="Days with no spend loaded at all"
              value={fmtNum(missing.length)}
              sub="No MER is computed for these — the daily line shows a hole, never a zero." />
            <HealthRow label="Meta spend (API)" value={<>{fmtAud(data.channels.find((c) => c.key === 'meta')?.spendAud)}</>} />
            <HealthRow label="Google spend (loaded by hand)" value={<>{fmtAud(data.channels.find((c) => c.key === 'google')?.spendAud)}</>} />

            {days.some((p) => !p.spendComplete) && (
              <div className="mt-3">
                <p className="text-[13px] text-muted-foreground mb-1">Days without complete spend:</p>
                <p className="text-[13px] leading-relaxed">
                  {days.filter((p) => !p.spendComplete).map((p) => fmtDay(p.d)).join(' · ')}
                </p>
              </div>
            )}
          </section>

          <section>
            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Attribution diagnostics
            </h4>
            <HealthRow label="Orders with no journey captured" value={fmtNum(b.noJourneyOrders)}
              sub="Shopify takes 2–3 days to assemble a journey. More than the last few days here means the feed is lagging." />
            <HealthRow label="Unclassified orders" value={fmtNum(b.unclassifiedOrders)}
              sub="A UTM that matches no known channel — if it grows, someone changed campaign URLs." />
            <HealthRow label="Double counting" value={`${b.doubleCountRatio.toFixed(2)}×`}
              sub={<>The platforms claim {fmtAud(b.claimedTotalAud)}<Usd value={b.claimedTotalUsd} size="table" /> between them — claimed ÷ recognised.</>} />
            <HealthRow label="Orders claimed by both platforms" value={fmtNum(b.overlapOrders)}
              sub="A paid click of each side in the same journey." />
          </section>

          <section>
            <h4 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Manual spend entry · Google Ads
            </h4>
            {/* onSaved refetches the dashboard, so the coverage above and the
                daily line update without reloading the page. */}
            <GoogleSpendForm onSaved={onSaved} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Workspaces ───────────────────────────────────────────────────────────────

type Workspace = 'overview' | 'campaigns' | 'attribution' | 'incrementality' | 'planning';

const WORKSPACES: {
  key: Workspace; label: string; question: string; icon: typeof Gauge;
}[] = [
  { key: 'overview', label: 'Overview', question: 'What changed, and does it need action?', icon: Gauge },
  { key: 'campaigns', label: 'Campaigns', question: 'Which campaigns earn their money?', icon: BarChart3 },
  { key: 'attribution', label: 'Attribution', question: 'Where did the sales actually come from?', icon: Layers3 },
  { key: 'incrementality', label: 'Incrementality', question: 'Is Google adding sales?', icon: TrendingUp },
  { key: 'planning', label: 'Planning', question: 'What does the plan require?', icon: Target },
];

function WorkspaceRail({ value, onChange }: { value: Workspace; onChange: (w: Workspace) => void }) {
  return (
    <>
      {/* Narrow: one scrollable row of pills — the questions don't fit, the
          labels do, and the workspace names are short on purpose. */}
      <div className="lg:hidden -mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex w-max gap-1.5">
          {WORKSPACES.map((w) => (
            <button
              key={w.key}
              type="button"
              onClick={() => onChange(w.key)}
              aria-current={value === w.key ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors',
                value === w.key
                  ? 'border-transparent bg-foreground text-background'
                  : 'border-border/60 text-muted-foreground hover:text-foreground',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <Card className="hidden lg:block p-1.5 lg:sticky lg:top-4">
        <nav aria-label="Advertising workspaces" className="space-y-0.5">
          {WORKSPACES.map((w) => {
            const Icon = w.icon;
            const active = value === w.key;
            return (
              <button
                key={w.key}
                type="button"
                onClick={() => onChange(w.key)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                  active ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0',
                                    active ? 'text-foreground' : 'text-muted-foreground/70')} />
                <span className="min-w-0">
                  <span className={cn('block text-[15px] font-medium leading-tight',
                                      active ? 'text-foreground' : 'text-muted-foreground')}>
                    {w.label}
                  </span>
                  <span className="block text-[13px] leading-tight text-muted-foreground/70 mt-0.5">
                    {w.question}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
      </Card>
    </>
  );
}

// ── Overview blocks ──────────────────────────────────────────────────────────

/** One line of context under the headline cards: no cards, no accents — these
 *  are the numbers you read AFTER the four that matter. */
function SecondaryStrip({ b }: { b: AdvertisingDashboard['blended'] }) {
  const aov = ratio(b.revenueAud, b.orders);
  const ncShare = ratio(b.newCustomerOrders, b.orders);
  const ncRoas = ratio(b.newCustomerRevenueAud, b.spendAud);
  const items: { label: string; value: string; tip: ReactNode }[] = [
    {
      label: 'Orders', value: fmtNum(b.orders),
      tip: <p>Every order the store took in the selected days, from any source.</p>,
    },
    {
      label: 'AOV', value: fmtAud(aov),
      tip: <p>Average order value: net sales ÷ orders. GST included, shipping not — so it reads
        higher than the AOV in Triple Whale, which strips tax and adds shipping.</p>,
    },
    {
      label: 'New-customer share', value: ncShare === null ? '—' : fmtPct(ncShare * 100),
      tip: <p>How many of those orders came from someone buying for the first time. Falling share
        with flat spend means you are paying to sell to people you already had.</p>,
    },
    {
      label: 'NC-ROAS', value: fmtX(ncRoas),
      tip: <p>Sales to <b>first-time buyers</b> ÷ all ad spend. Stricter than MER: it ignores repeat
        customers, who would have come back anyway. This is the number that says whether advertising
        is growing the customer base or just serving it.</p>,
    },
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 px-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-baseline gap-1.5">
          <span className="text-[13px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
            {i.label}
            <InfoTip label={i.label} content={i.tip} />
          </span>
          <span className="text-[15px] font-medium tabular-nums">{i.value}</span>
        </span>
      ))}
    </div>
  );
}

type Attention = { text: string; go: Workspace | 'health' };

/** Max three, derived from real data only — never a fixed checklist. Ordered by
 *  how much money the item can cost if ignored. */
function needsAttention(d: AdvertisingDashboard): Attention[] {
  const items: Attention[] = [];
  const b = d.blended;
  const ue = d.unitEconomics;
  const incompleteDays = d.merSeries.filter((p) => !p.spendComplete).length;
  const noJourneyShare = ratio(b.noJourneyOrders, b.orders);

  if (ue && b.mer < ue.breakevenMer) {
    items.push({
      text: `MER is ${fmtX(b.mer)}, below the ${fmtX(ue.breakevenMer)} breakeven — the window loses money.`,
      go: 'campaigns',
    });
  }
  if (incompleteDays > 0) {
    items.push({
      text: `${incompleteDays} ${incompleteDays === 1 ? 'day' : 'days'} in this window don't have complete ad spend.`,
      go: 'health',
    });
  }
  if (b.unclassifiedOrders > 0) {
    items.push({
      text: `${fmtNum(b.unclassifiedOrders)} orders carry a UTM that matches no channel — possible UTM drift.`,
      go: 'attribution',
    });
  }
  if (noJourneyShare !== null && noJourneyShare > NO_JOURNEY_ALERT_SHARE) {
    items.push({
      text: `${fmtNum(b.noJourneyOrders)} orders have no journey (${fmtPct(noJourneyShare * 100)} of the window) — more than the usual 2–3 day lag.`,
      go: 'health',
    });
  }
  if (ue && ue.targetMer !== null && b.mer >= ue.breakevenMer && b.mer < ue.targetMer) {
    items.push({
      text: `MER is ${fmtX(b.mer)} — above breakeven, below the ${fmtX(ue.targetMer)} target margin.`,
      go: 'campaigns',
    });
  }
  return items.slice(0, 3);
}

const PRESETS = STORE_DATE_PRESETS;                    // from '@/lib/storeDate'
const DEFAULT = PRESETS.find((p) => p.label === '30 days')!.range();

type WindowResult = { data: AdvertisingDashboard | null; error: string | null };

export default function AdvertisingTab() {
  const [workspace, setWorkspace] = useState<Workspace>('overview');
  const [range, setRange] = useState<{ from: string; to: string }>(DEFAULT);
  const [data, setData] = useState<AdvertisingDashboard | null>(null);
  const [prev, setPrev] = useState<AdvertisingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);

  // > 92 days: the 90-day preset stays quiet, 12 months (and anything past it)
  // warns — that range measured ~15s — and the comparison call is skipped.
  const rangeDays = inclusiveDays(range.from, range.to);
  const longRange = rangeDays > COMPARISON_MAX_DAYS;

  // A sequence number rather than a boolean closure, so `load` can be called
  // both by the range-change effect AND on demand (GoogleSpendForm's
  // onSaved) without the two races stepping on each other — only the result
  // of the most recent call is ever applied.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true); setError(null);

    const days = inclusiveDays(range.from, range.to);
    const compare = days <= COMPARISON_MAX_DAYS;
    // The preceding window of EQUAL length: prevTo = from − 1 day,
    // prevFrom = prevTo − (days − 1). Same RPC, same shape, same metric.
    const prevTo = addDays(range.from, -1);
    const prevFrom = addDays(prevTo, -(days - 1));

    // Promise.resolve() because the postgrest builder is only a PromiseLike.
    const fetchWindow = (from: string, to: string): Promise<WindowResult> =>
      Promise.resolve(supabase.rpc('advertising_dashboard', { p_from: from, p_to: to }))
        .then(({ data: res, error: err }) => ({
          data: err ? null : (res as AdvertisingDashboard),
          error: err ? err.message : null,
        }));

    const current = fetchWindow(range.from, range.to);
    // Fired in parallel: the comparison never delays the page, and if it fails
    // the current numbers still render — just without deltas.
    const previous: Promise<WindowResult> = compare
      ? fetchWindow(prevFrom, prevTo)
      : Promise.resolve({ data: null, error: null });

    void Promise.all([current, previous]).then(([cur, prv]) => {
      if (loadSeq.current !== seq) return;
      if (cur.error) { setError(cur.error); setData(null); }
      else setData(cur.data);
      setPrev(prv.data);
      setLoading(false);
    });
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  // The Planning sliders live HERE, not inside ScalePlan: that component
  // unmounts on every workspace switch, so local state was silently thrown away
  // between visits. null = "untouched", so the sliders show the committed plan
  // (or the defaults) until the user actually moves something; a save clears it
  // back to null so the freshly-saved figures take over.
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);

  // B3 incrementality: fetched the first time the Incrementality workspace is
  // opened, ONCE per tab lifetime — the RPC takes ~15s and its window is fixed
  // (14 months), no range dependency. It no longer runs on tab open.
  const [inc, setInc] = useState<AdvertisingIncrementality | null>(null);
  const [incLoading, setIncLoading] = useState(false);
  const [incError, setIncError] = useState<string | null>(null);
  const incFired = useRef(false);
  useEffect(() => {
    if (workspace !== 'incrementality' || incFired.current) return;
    incFired.current = true;
    setIncLoading(true);
    supabase.rpc('advertising_incrementality').then(({ data: res, error: err }) => {
      if (err) setIncError(err.message);
      else setInc(res as AdvertisingIncrementality);
      setIncLoading(false);
    });
  }, [workspace]);

  const totalOrders = data ? data.channelMix.reduce((s, r) => s + r.orders, 0) : 0;
  const attention = useMemo(() => (data ? needsAttention(data) : []), [data]);
  const hasSpendGap = data ? data.merSeries.some((p) => !p.spendComplete) : false;

  const ue = data?.unitEconomics ?? null;
  const b = data?.blended ?? null;
  const pb = prev?.blended ?? null;

  // MER verdict colour: red below breakeven, amber between, green at/above target.
  const merClass = !b || !ue ? undefined
    : b.mer < ue.breakevenMer ? 'text-red-600 dark:text-red-400'
      : ue.targetMer !== null && b.mer >= ue.targetMer ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-amber-600 dark:text-amber-400';

  const cacCeilingUsd = ue ? ue.cm1Pct * ue.revenuePerOrderUsd : CAC_CEILING_FALLBACK_USD;
  const cacTone = !b ? 'amber'
    : b.cacBlendedUsd <= HEALTHY_CAC_USD ? 'green'
      : b.cacBlendedUsd <= cacCeilingUsd ? 'amber' : 'red';

  return (
    <TooltipProvider delayDuration={120}>
      <div className="space-y-4">
        {/* ── Top bar: date controls + the two separate surfaces ── */}
        <div className="flex items-center justify-end gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                onClick={() => setRange(p.range())}
                className={cn(
                  'h-8 rounded-lg px-2.5 text-sm',
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
              className="h-8 rounded-md border bg-background px-2 text-sm ml-1"
            />
            <span className="text-sm text-muted-foreground">→</span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              max={storeToday()}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            />
          </div>
          <span className="text-[13px] text-muted-foreground/70 whitespace-nowrap">
            {data ? `${data.from} → ${data.to}` : ''}
          </span>
          <Button variant="outline" size="sm" className="relative h-8 gap-1.5 text-sm"
                  disabled={!data} onClick={() => setHealthOpen(true)}>
            <Activity className="h-4 w-4" />
            Data health
            {hasSpendGap && (
              <span aria-hidden className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-background" />
            )}
          </Button>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm"
                  onClick={() => setHelpOpen(true)}>
            <HelpCircle className="h-4 w-4" />
            Help
          </Button>
        </div>

        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
        {data && (
          <DataHealthSheet open={healthOpen} onOpenChange={setHealthOpen} data={data} onSaved={load} />
        )}

        {longRange && (
          <p className="text-[13px] text-amber-700 dark:text-amber-400">
            Long ranges are slow (12 months ≈ 15s).
          </p>
        )}

        {error && (
          <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/30">
            <p className="text-[15px] text-red-700 dark:text-red-400">{error}</p>
          </Card>
        )}

        {loading && !data && <p className="text-[15px] text-muted-foreground animate-pulse">Loading…</p>}

        {data && b && (
          <div className={cn('grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)] items-start', loading && 'opacity-60')}>
            <WorkspaceRail value={workspace} onChange={setWorkspace} />

            <div className="min-w-0 space-y-4">
              {workspace === 'overview' && (
                <>
                  {/* EXACTLY four headline cards, every one read straight off
                      blended.* — no day filtering, no subset (plan 07 §defecto 1). */}
                  <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
                    <KpiCard
                      label="MER"
                      value={fmtX(b.mer)}
                      accent="#f59e0b"
                      valueClass={merClass}
                      delta={<Delta current={b.mer} previous={pb?.mer} better="higher" />}
                      tip={
                        <>
                          <p><b>Every dollar of sales the store made, divided by every dollar you spent
                          on ads.</b> Nobody's attribution touches it — that's why it's the arbiter.</p>
                          {ue && (
                            <>
                              <p className="mt-1.5"><b>Breakeven {fmtX(ue.breakevenMer)}</b>: below this,
                              ads lose money. It is 1 ÷ your contribution margin
                              ({Math.round(ue.cm1Pct * 1000) / 10}%): of every $1 that comes in, that much
                              is left before paying for ads.</p>
                              <p className="mt-1.5"><b>Target {ue.targetMer === null ? '—' : fmtX(ue.targetMer)}</b>:
                              what you need for a {Math.round(ue.targetMarginPct * 100)}% operating profit,
                              once fixed costs (US${fmtNum(ue.fixedCostsUsd)}/month) are covered too.</p>
                              <p className="mt-1.5 text-muted-foreground">Both come from Juan's unit-economics
                              workbook, month {ue.month}. They refresh when the workbook does.</p>
                            </>
                          )}
                        </>
                      }
                      sub={ue
                        ? <>Net sales ÷ ad spend. Breakeven {fmtX(ue.breakevenMer)} · target {ue.targetMer === null ? 'unreachable at current economics' : fmtX(ue.targetMer)} <span className="text-muted-foreground/60">(Juan's workbook, {ue.month})</span></>
                        : 'Net sales ÷ ad spend. No unit-economics row for this window.'}
                    />
                    <KpiCard
                      label="Net sales"
                      value={fmtAud(b.revenueAud)}
                      usd={b.revenueUsd}
                      accent="#3b82f6"
                      delta={<Delta current={b.revenueAud} previous={pb?.revenueAud} better="higher" />}
                      tip={
                        <>
                          <p><b>Everything the store sold in the selected days</b>, whatever brought the
                          customer in — ads, search, email or nothing at all.</p>
                          <p className="mt-1.5">Australian orders carry GST inside the price, and it is left
                          in on purpose so these figures line up with Triple Whale. The B2C Sales Explorer
                          strips it, which is why that tab shows less.</p>
                          <p className="mt-1.5">Shipping charged to the customer is <b>not</b> included here.
                          Triple Whale does include it — that is the whole difference between its sales
                          number and ours.</p>
                        </>
                      }
                      sub="Same figure as the E-commerce tab: AUD, Brisbane day, GST included on AU orders."
                    />
                    <KpiCard
                      label="Ad spend"
                      value={fmtAud(b.spendAud)}
                      usd={b.spendUsd}
                      accent="#94a3b8"
                      delta={<Delta current={b.spendAud} previous={pb?.spendAud} better="neutral" />}
                      tip={
                        <>
                          <p><b>What the two platforms charged you</b>, added together and converted to
                          Australian dollars at the rate of the month each charge happened.</p>
                          <p className="mt-1.5">Meta arrives on its own three times a day. Google is loaded
                          by hand from the account's export, so the freshest days can be missing until
                          someone loads them — the Data health drawer tells you which.</p>
                          <p className="mt-1.5 text-muted-foreground">Spending more is not automatically bad,
                          so this number is never coloured green or red.</p>
                        </>
                      }
                      sub="Meta (API) + Google (loaded by hand). AUD."
                    />
                    <KpiCard
                      label="New-customer CAC"
                      value={fmtAud(b.cacBlended)}
                      usd={b.cacBlendedUsd}
                      accent="#10b981"
                      delta={<Delta current={b.cacBlended} previous={pb?.cacBlended} better="lower" />}
                      chip={
                        <Chip tone={cacTone}>
                          {cacTone === 'green'
                            ? `under the US$${HEALTHY_CAC_USD} healthy line`
                            : cacTone === 'amber'
                              ? `above US$${HEALTHY_CAC_USD}, under the US$${cacCeilingUsd.toFixed(2)} ceiling`
                              : `above the US$${cacCeilingUsd.toFixed(2)} ceiling`}
                        </Chip>
                      }
                      tip={
                        <>
                          <p><b>What it cost you to win one new customer</b>: all the ad spend divided by
                          the orders from people buying for the first time ({fmtNum(b.newCustomerOrders)} of
                          {' '}{fmtNum(b.orders)} orders in this window).</p>
                          <p className="mt-1.5">Two lines to judge it against, both from Juan's workbook:
                          {' '}<b>US${HEALTHY_CAC_USD}</b> is the healthy line — pay less than that and a
                          customer returns three times what they cost over a year.
                          {' '}<b>US${cacCeilingUsd.toFixed(2)}</b> is the hard ceiling: it is what one order
                          leaves after product, shipping and fees, so above it the first sale loses money
                          outright.</p>
                          <p className="mt-1.5 text-muted-foreground">Compared in US dollars because the
                          workbook is in US dollars.</p>
                        </>
                      }
                      sub={<>Spend ÷ {fmtNum(b.newCustomerOrders)} first purchases. Guardrails: healthy US${HEALTHY_CAC_USD} · ceiling US${cacCeilingUsd.toFixed(2)} (Juan's workbook, USD).</>}
                    />
                  </div>

                  <p className="text-[13px] text-muted-foreground/70 px-1">
                    {longRange
                      ? `Period comparison is off above ${COMPARISON_MAX_DAYS} days.`
                      : prev
                        ? `Compared with the ${rangeDays} days before this window (${prev.from} → ${prev.to}).`
                        : 'The previous period could not be loaded — the current numbers stand on their own.'}
                  </p>

                  <SecondaryStrip b={b} />

                  {attention.length > 0 && (
                    <Card className="p-4">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Needs attention
                      </h3>
                      <ul className="space-y-1">
                        {attention.map((a) => (
                          <li key={a.text}>
                            <button
                              type="button"
                              onClick={() => (a.go === 'health' ? setHealthOpen(true) : setWorkspace(a.go))}
                              className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[15px] hover:bg-muted/50"
                            >
                              <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                              <span className="min-w-0">{a.text}</span>
                              <span className="ml-auto shrink-0 text-[13px] text-muted-foreground">
                                {a.go === 'health' ? 'Data health ›' : `${WORKSPACES.find((w) => w.key === a.go)!.label} ›`}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}

                  <Card className="p-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                      Daily MER · revenue vs spend
                      <InfoTip
                        label="What this chart shows"
                        content={
                          <>
                            <p><b>Blue bars</b> are the sales the store made that day. <b>Grey bars</b> are
                            what you spent on ads that day. Both read against the money scale on the left.</p>
                            <p className="mt-1.5"><b>The orange line</b> is the MER: sales divided by spend.
                            It reads against the × scale on the right. The <b>green dashed line</b> is the
                            target you need to hit your 20% margin.</p>
                            <p className="mt-1.5">When a day has no Google spend loaded yet, the orange line
                            breaks instead of dropping to zero — a hole means "not known", never "it was zero".</p>
                          </>
                        }
                      />
                    </h3>
                    <ChartLegend targetMer={ue?.targetMer ?? null} oneDay={data.merSeries.length <= 1} />
                    <MerChart series={data.merSeries} targetMer={ue?.targetMer ?? null} />
                    <p className="text-[13px] text-muted-foreground/70 mt-2">
                      Days without loaded Google spend don't compute a MER (gap in the line) — never a false zero.
                    </p>
                    {data.merSeries.some((p) => p.spendComplete === false && p.mer !== null) && (
                      <p className="text-[13px] text-muted-foreground/70 mt-1">
                        The days flagged in the tooltip are Meta-only MER: Google started spending on
                        25-Jun-2026, before that there was nothing to add.
                      </p>
                    )}
                  </Card>
                </>
              )}

              {workspace === 'campaigns' && (
                <>
                  <VerdictChart channels={data.channels} ue={ue} />
                  <div className="grid gap-4 xl:grid-cols-2 items-start">
                    {data.channels.map((ch) => <ChannelEfficiency key={ch.key} ch={ch} />)}
                  </div>
                  <CampaignTable channels={data.channels} />
                </>
              )}

              {workspace === 'attribution' && (
                <>
                  <ChannelMix rows={data.channelMix} totalAud={b.revenueAud} />
                  <div className="grid gap-4 xl:grid-cols-2 items-start">
                    <OverlapCard o={data.overlap} />
                    <LiveOrdersCard orders={data.liveOrders} />
                  </div>
                  <GoogleBuckets rows={data.googleBuckets} />
                  {range.from < '2026-06-25' && (
                    <p className="text-[13px] text-muted-foreground/70">
                      Google spent nothing before 25-Jun-2026.
                    </p>
                  )}
                </>
              )}

              {workspace === 'incrementality' && (
                <IncrementalityBlock inc={inc} loading={incLoading} error={incError} />
              )}

              {workspace === 'planning' && (
                <ScalePlan
                  ue={ue}
                  plan={data.plan}
                  blended={b}
                  from={data.from}
                  to={data.to}
                  totalOrders={totalOrders}
                  draft={planDraft}
                  onDraft={setPlanDraft}
                  onSaved={() => { setPlanDraft(null); load(); }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
