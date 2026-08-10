// =============================================================================
// Advertising tab — mini Triple Whale
// =============================================================================
// Spec: ADVERTISING/SPEC.md (v2.1) + ADVERTISING/plans/06-mejoras-post-revision.md.
// Reads public.advertising_dashboard (Plan 4) and, lazily,
// public.advertising_incrementality (Plan 6 B3). The data shapes are the RPC
// contracts — see advertising/types.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip as RTooltip, CartesianGrid, ReferenceArea, ReferenceLine,
} from 'recharts';
import { HelpCircle, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { STORE_DATE_PRESETS, storeToday, shiftDays } from '@/lib/storeDate';
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

/** Numerator ÷ denominator, null-guarded: a zero divisor renders as '—', never
 *  Infinity/NaN. Every client-side ratio in the tab goes through this. */
const ratio = (num: number | null | undefined, den: number | null | undefined) =>
  num === null || num === undefined || !den || den <= 0 ? null : num / den;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-08-31' → '31 Aug' */
const fmtDay = (iso: string) => `${+iso.slice(8, 10)} ${MONTHS_SHORT[+iso.slice(5, 7) - 1]}`;
/** '2026-08' → 'Aug 26' */
const fmtMonth = (ym: string) => `${MONTHS_SHORT[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;

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

function MerChart({ series }: { series: MerPoint[] }) {
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
      <table className="w-full text-[15px]">
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

const VERDICT_LABEL_W = 'w-[240px]';
const VERDICT_NUMS_W = 'w-[130px]';
const VERDICT_CHIP_W = 'w-[180px]';

function VerdictRowShell({ label, bar, nums, chip }: {
  label: ReactNode; bar: ReactNode; nums: ReactNode; chip: ReactNode;
}) {
  // One shared row shell so bars, header labels and the axis all use the exact
  // same column offsets — the dashed line segments align across rows for free.
  return (
    <div className="flex items-center gap-3">
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
              label={<span className="text-[13px] uppercase tracking-wider text-muted-foreground">Campaign</span>}
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
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                        <span className="truncate text-[15px]" title={r.campaign}>{r.campaign}</span>
                      </div>
                      {r.note && <p className="text-xs text-amber-700 dark:text-amber-400 leading-tight truncate" title={r.note}>{r.note}</p>}
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
          Clean UTM data starts 6 Aug 2026 — windows reaching earlier under-count the floor.
        </p>
        <p className="text-[13px] text-muted-foreground/70">
          Google Shopping's floor is inflated by the feed-tag proxy (free listings mixed in) until clean tagging lands.
        </p>
        <p className="text-[13px] text-muted-foreground/70">
          Platform claims for the most recent days are still maturing (Meta re-reads ~30 days).
        </p>
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
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Channel overlap
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
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Live orders
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
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Is Google adding sales?
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-3">
        The whole Google bag (paid + organic + pre-gate mixed) ÷ the rest of the store,
        monthly — against what that ratio did in {band.windows} rolling {band.windowDays}-day
        windows when Google spend was zero.
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
        <StatCard label="Verdict" value={`serious verdict ${fmtDay(brandCut.verdictDate)}`} accent="#f59e0b"
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

// Juan's healthy-CAC line (3× LTV:CAC) from the July workbook. LTV is not in
// the unit-economics contract, so this travels as a workbook constant and gets
// refreshed monthly with the rest.
const HEALTHY_CAC_USD = 20.93;
const DEFAULT_PLANNED_SPEND_USD = 129_939; // workbook Simulators §4 baseline

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

function ScalePlan({ ue, plan, blended, from, to, totalOrders }: {
  ue: UnitEconomics | null;
  plan: MonthlyPlan | null;
  blended: AdvertisingDashboard['blended'];
  from: string;
  to: string;
  totalOrders: number;
}) {
  const defaultSpend = clamp(Math.round(plan?.plannedSpendUsd ?? DEFAULT_PLANNED_SPEND_USD), 0, 300_000);
  const defaultProfit = clamp(
    ue
      ? Math.round(ue.cm1Pct * ue.baselineRevenueUsd - ue.fixedCostsUsd - defaultSpend)
      : 58_000,
    0, 150_000,
  );
  const [profit, setProfit] = useState(defaultProfit);
  const [spend, setSpend] = useState(defaultSpend);

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
    const windowDays = Math.round(
      (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000
    ) + 1;
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
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Scale plan — Juan's formulas
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-4">
        USD — the workbook's currency. AUD companions are approximate, via the window's
        implied rate{impliedRate !== null ? ` (${impliedRate.toFixed(4)})` : ''}.
      </p>

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
          <table className="w-full max-w-2xl text-[15px]">
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
          <p className="text-[13px] text-muted-foreground/70 mt-2">
            Actual = the window selected above ({from} → {to}). Select the current month to read
            it as month-to-date.
          </p>
        </div>
      )}

      <p className="text-[13px] text-muted-foreground/70 mt-4">
        Constants from Juan's July workbook (CM1 {(ue.cm1Pct * 100).toFixed(1)}%, fixed {fmtU(ue.fixedCostsUsd)},
        ${ue.revenuePerOrderUsd}/order, {(ue.pctNewCustomers * 100).toFixed(1)}% new) — refreshed monthly.
        Juan's note: each incremental $1 only needs {ue.breakevenMer}× incremental revenue to add profit dollars.
      </p>
    </Card>
  );
}

// ── D1: Help — SOPs on a separate surface (no inline toggles) ────────────────

const HELP_SECTIONS: { title: string; body: ReactNode }[] = [
  {
    title: 'Reading the floor/ceiling chart',
    body: (
      <>
        <p>Floor = what the store recognises by last non-direct click. It under-counts:
        view-through and cross-device journeys are invisible to it.</p>
        <p>Ceiling = what the platform's panel claims. It over-counts: the platforms overlap
        each other on the same orders.</p>
        <p>The truth sits between. Floor above the green target line: the campaign works even
        under-counted — scale it. Ceiling below the red breakeven: it loses money even at the
        platform's own numbers — cut it. Anything in between: keep collecting before moving
        budget.</p>
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
        <p>Open the Google view of this tab and load it with the manual spend form at the
        bottom.</p>
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
        <p>The overlap card shows exactly how many orders are claimed twice.</p>
      </>
    ),
  },
  {
    title: 'When to distrust the tab',
    body: (
      <>
        <p>The "no journey" counter grows past the normal 2–3 recent days: Shopify's journey
        feed is lagging.</p>
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

const PRESETS = STORE_DATE_PRESETS;                    // from '@/lib/storeDate'
const DEFAULT = PRESETS.find((p) => p.label === '30 days')!.range();

export default function AdvertisingTab() {
  const [view, setView] = useState<'leadership' | 'meta' | 'google'>('leadership');
  const [range, setRange] = useState<{ from: string; to: string }>(DEFAULT);
  const [data, setData] = useState<AdvertisingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

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

  // B3 incrementality: fetched lazily the first time Leadership renders (it is
  // the default view, so in practice on mount), ONCE per tab lifetime — the RPC
  // takes ~15s and its window is fixed (14 months), no range dependency.
  const [inc, setInc] = useState<AdvertisingIncrementality | null>(null);
  const [incLoading, setIncLoading] = useState(false);
  const [incError, setIncError] = useState<string | null>(null);
  const incFired = useRef(false);
  useEffect(() => {
    if (view !== 'leadership' || incFired.current) return;
    incFired.current = true;
    setIncLoading(true);
    supabase.rpc('advertising_incrementality').then(({ data: res, error: err }) => {
      if (err) setIncError(err.message);
      else setInc(res as AdvertisingIncrementality);
      setIncLoading(false);
    });
  }, [view]);

  // > 92 days: the 90-day preset stays quiet, 12 months (and anything past it)
  // warns — that range measured ~15s.
  const rangeDays = Math.round(
    (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000
  );
  const longRange = rangeDays > 92;

  const totalOrders = data ? data.channelMix.reduce((s, r) => s + r.orders, 0) : 0;

  return (
    <TooltipProvider delayDuration={120}>
      <div className="space-y-4">
        {/* ── View switch + date controls ── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {([['leadership', 'Leadership'], ['meta', 'Meta'], ['google', 'Google']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setView(k)}
                className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors',
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
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm"
                    onClick={() => setHelpOpen(true)}>
              <HelpCircle className="h-4 w-4" />
              Help
            </Button>
          </div>
        </div>

        <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />

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
                  <p className="text-[13px] text-amber-700 dark:text-amber-400">
                    Note: before 6-Aug the paid Google clicks were not distinguishable from organic, so
                    "double counting" and Google's ROAS for that period under-count the store.
                  </p>
                )}

                <Card className="p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Daily MER · revenue vs spend
                  </h3>
                  <MerChart series={data.merSeries} />
                  <p className="text-[13px] text-muted-foreground/70 mt-2">
                    Days without loaded Google spend don't compute a MER (gap in the line) — never a false zero.
                  </p>
                  <p className="text-[13px] text-muted-foreground/70 mt-1">
                    Orders from the last 2-3 days may show up without a journey: Shopify takes time to
                    process it. The "no journey" counter reflects this.
                  </p>
                  {data.merSeries.some((p) => p.spendComplete === false && p.mer !== null) && (
                    <p className="text-[13px] text-muted-foreground/70 mt-1">
                      The days flagged in the tooltip are Meta-only MER: Google started spending on
                      25-Jun-2026, before that there was nothing to add.
                    </p>
                  )}
                </Card>

                <VerdictChart channels={data.channels} ue={data.unitEconomics} />

                <ChannelMix rows={data.channelMix} totalAud={data.blended.revenueAud} />

                <p className="text-[13px] text-muted-foreground/70">
                  Reading rule: our measurement <b>under-counts</b> (it doesn't see view-through or
                  cross-device), the platforms <b>over-count</b> (they overlap each other). The truth
                  sits bounded between the two.
                  {' '}Unclassified: {fmtNum(data.blended.unclassifiedOrders)} orders (UTM drift) ·
                  no journey: {fmtNum(data.blended.noJourneyOrders)}.
                </p>

                <div className="grid gap-4 lg:grid-cols-2 items-start">
                  <OverlapCard o={data.overlap} />
                  <LiveOrdersCard orders={data.liveOrders} />
                </div>

                <IncrementalityBlock inc={inc} loading={incLoading} error={incError} />

                <ScalePlan
                  ue={data.unitEconomics}
                  plan={data.plan}
                  blended={data.blended}
                  from={data.from}
                  to={data.to}
                  totalOrders={totalOrders}
                />
              </div>
            )}

            {view === 'meta' && <ChannelPanel ch={data.channels[0]} />}
            {view === 'google' && (
              <div className="space-y-4">
                <ChannelPanel ch={data.channels[1]} />
                {range.from < '2026-08-06' && (
                  <p className="text-[13px] text-muted-foreground/70">
                    Before 6-Aug Google paid and organic were indistinguishable (no UTMs): that period
                    shows as "Google mixed", not organic.
                  </p>
                )}
                {range.from < '2026-06-25' && (
                  <p className="text-[13px] text-muted-foreground/70">
                    Google spent nothing before 25-Jun-2026.
                  </p>
                )}
                <GoogleBuckets rows={data.googleBuckets} />

                <Card className="p-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Manual spend entry · Google Ads
                  </h3>
                  <GoogleSpendForm onSaved={load} />
                </Card>
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
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

      {/* B1: the double-yardstick ratios. All client-side divisions, null-guarded. */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatCard label="Store ROAS" value={fmtX(ratio(ch.storeLastAud, ch.spendAud))} accent="#3b82f6"
          sub="Store-recognised last click ÷ spend — the conservative yardstick." />
        <StatCard label="Panel ROAS" value={fmtX(ratio(ch.claimedAud, ch.spendAud))} accent="#ef4444"
          sub="The platform's claimed value ÷ spend — its own scoreboard." />
        <StatCard label="CPA" value={fmtAud(ratio(ch.spendAud, ch.orders))} accent="#94a3b8"
          sub={`Spend ÷ ${fmtNum(ch.orders)} last-click orders.`} />
        <StatCard label="NC-CPA" value={fmtAud(ratio(ch.spendAud, ch.newCustomerOrders))} accent="#10b981"
          sub={`Spend ÷ ${fmtNum(ch.newCustomerOrders)} new-customer orders (first purchase).`} />
      </div>

      {ch.note && (
        <p className="text-[13px] text-amber-700 dark:text-amber-400">{ch.note}</p>
      )}

      <Card className="p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          By campaign · two yardsticks side by side
        </h3>
        <table className="w-full text-[15px]">
          <thead>
            <tr className="text-[13px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Campaign</th>
              <th className="text-right font-medium pb-1.5">Spend</th>
              <th className="text-right font-medium pb-1.5">Claims</th>
              <th className="text-right font-medium pb-1.5">Platform ROAS</th>
              <th className="text-right font-medium pb-1.5">Store (closed)</th>
              <th className="text-right font-medium pb-1.5">Store ROAS</th>
              <th className="text-right font-medium pb-1.5">Orders</th>
              <th className="text-right font-medium pb-1.5">Initiated</th>
            </tr>
          </thead>
          <tbody>
            {ch.campaigns.map((c) => (
              <tr key={c.campaign} className="border-t border-border/40">
                <td className="py-1.5">
                  <span className="font-medium">{c.campaign}</span>
                  {c.note && <span className="block text-xs text-amber-700 dark:text-amber-400">{c.note}</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.spendAud)}<Usd value={c.spendUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtAud(c.claimedValueAud)}<Usd value={c.claimedValueUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtX(ratio(c.claimedValueAud, c.spendAud))}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(c.storeLastClickAud)}<Usd value={c.storeLastClickUsd} size="table" /></td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtX(ratio(c.storeLastClickAud, c.spendAud))}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtNum(c.orders)}</td>
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
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Google by bucket · since 6-Aug
      </h3>
      <p className="text-[13px] text-muted-foreground/70 mb-3">
        Before 6-Aug Google paid and organic were a single bucket (no UTMs): that history is shown
        separately as "Google mixed", never as organic.
      </p>
      <table className="w-full text-[15px]">
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
                {r.bucket}
                {r.note && <span className="block text-xs text-muted-foreground/70">{r.note}</span>}
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
