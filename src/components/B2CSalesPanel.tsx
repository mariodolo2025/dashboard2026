// =============================================================================
// B2C Sales Panel — Shopify sales for one or more SKUs
// =============================================================================
// The body of the B2C Sales Explorer, extracted so the Web Upgrade tab can open
// the same thing as a dialog for whichever SKU was clicked. Both surfaces share
// the date presets, the day/week/month granularity and the trend curve.
//
// Money is AUD. shopify_sales_lines stores 43 currencies natively, so summing
// net_native would be meaningless; the RPC converts net_usd at the same
// per-month rate the rest of the dashboard uses.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search, X, ShoppingCart, DollarSign, Tag, RotateCcw, Globe, Package,
  TrendingUp, TrendingDown, Minus,
} from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip as RTooltip, CartesianGrid,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  fetchShopifySkuList,
  fetchShopifySkuStats,
  type ShopifySkuListItem,
  type ShopifySkuStats,
  type SalesGranularity,
  type SalesMetric,
} from '@/lib/aim2026/api';
import { STORE_DATE_PRESETS, storeToday } from '@/lib/storeDate';

// ─── Formatting ─────────────────────────────────────────────────────────────

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtAud2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
const fmtUsd = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : `(US$${Math.round(v).toLocaleString('en-AU')})`;

// Shopify stores the shipping country as an ISO 3166-1 alpha-2 code. Intl
// resolves it to the English name without shipping a 250-row lookup table that
// would then need maintaining. Anything it does not recognise — 'Unknown', or a
// code Intl has no name for — falls through unchanged rather than being hidden.
const regionNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;
const countryName = (code: string) => {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return code;
  try { return regionNames?.of(code.toUpperCase()) ?? code; } catch { return code; }
};
const fmtUsd2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '' : `(US$${v.toFixed(2)})`;

/** The USD companion of an AUD figure: same number, source currency, set smaller
 * so it never competes with the amount it annotates.
 *
 * Size is fixed rather than relative. At 0.58em it rendered around 8px inside a
 * table cell — legible next to a 24px stat card, unreadable in a row. */
function Usd({
  value, decimals = false, size = 'card',
}: {
  value: number | null | undefined;
  decimals?: boolean;
  size?: 'card' | 'table';
}) {
  const text = decimals ? fmtUsd2(value) : fmtUsd(value);
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

const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');

export const DATE_PRESETS = STORE_DATE_PRESETS;

const GRANULARITIES: { key: SalesGranularity; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

const METRICS: { key: SalesMetric; label: string }[] = [
  { key: 'units', label: 'Units' },
  { key: 'revenue', label: 'Revenue' },
];

/** Change vs the equivalent previous window. null when there is no previous
 * figure — a first-ever period is not "+100%". */
function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/** Centred moving average, so the curve shows direction rather than repeating
 * the bars. Daily data gets a 7-point window — a 3-point one on days is as
 * twitchy as the bars themselves — while weeks and months keep 3.
 *
 * This only reads as a trend because the series is gap-filled server-side: a day
 * with no sales is a zero bucket, not a missing one. Averaging over points that
 * are not adjacent in time produced a flat line that meant nothing. */
function withTrend(
  series: { bucket: string; units: number; net_aud: number; net_usd: number; orders: number }[],
  granularity: SalesGranularity,
  metric: SalesMetric
) {
  const half = granularity === 'day' ? 3 : 1;
  // The curve has to average the same thing the bars draw, or it reads as a
  // trend for a quantity nobody is looking at.
  const rev = metric === 'revenue';
  const valueOf = (p: { units: number; net_aud: number }) => (rev ? p.net_aud : p.units);
  return series.map((p, i) => {
    const window = series.slice(Math.max(0, i - half), Math.min(series.length, i + half + 1));
    const avg = (f: (w: typeof p) => number) =>
      Math.round((window.reduce((s, w) => s + f(w), 0) / window.length) * 100) / 100;
    return {
      ...p,
      netAud: p.net_aud,
      value: valueOf(p),
      // Money carries its USD companion everywhere it is shown. Units do not:
      // a count has no second currency.
      valueUsd: rev ? p.net_usd : null,
      trend: avg(valueOf),
      trendUsd: rev ? avg((w) => w.net_usd) : null,
    };
  });
}

type ChartPoint = ReturnType<typeof withTrend>[number];

/** Bucket label: a day and a week start show the date, a month shows the month. */
function bucketLabel(bucket: string, granularity: SalesGranularity): string {
  const d = new Date(`${bucket}T00:00:00Z`);
  if (granularity === 'month') {
    return d.toLocaleDateString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  return d.toLocaleDateString('en', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

function DeltaPill({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[11px] text-muted-foreground">no prior baseline</span>;
  const up = value > 0;
  const flat = Math.abs(value) < 0.5;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-medium',
        flat ? 'text-muted-foreground' : up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
      )}
    >
      <Icon size={11} />
      {value > 0 ? '+' : ''}{value.toFixed(1)}%
    </span>
  );
}

function StatCard({
  icon, label, value, usd, usdDecimals, sub, delta: d, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** Same amount in USD, rendered small in parentheses beside the AUD figure. */
  usd?: number | null;
  usdDecimals?: boolean;
  sub?: string;
  delta?: number | null;
  accent?: string;
}) {
  return (
    <Card className="relative overflow-hidden p-4 border border-border/60">
      {accent && (
        <div
          className="absolute inset-x-0 top-0 h-[2px] opacity-70"
          style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }}
        />
      )}
      <div className="flex items-center gap-1.5 text-muted-foreground mb-2">
        <span className="opacity-60">{icon}</span>
        <span className="text-xs font-medium tracking-wide uppercase truncate">{label}</span>
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <span className="text-2xl font-semibold tracking-tight tabular-nums leading-none">
          {value}
          {usd !== undefined && <Usd value={usd} decimals={usdDecimals} />}
        </span>
        {d !== undefined && <DeltaPill value={d} />}
      </div>
      {sub && <p className="text-[11px] text-muted-foreground/70 leading-tight mt-1.5">{sub}</p>}
    </Card>
  );
}

/** Multi-select SKU search: picked SKUs stay as chips, the dropdown adds more. */
function SkuMultiSearch({
  skus, selected, onChange,
}: {
  skus: ShopifySkuListItem[];
  selected: string[];
  onChange: (skus: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? skus.filter(
          (s) => s.sku.toLowerCase().includes(q) || (s.product_title ?? '').toLowerCase().includes(q)
        )
      : skus;
    return pool.slice(0, 40);
  }, [skus, query]);

  const toggle = (sku: string) => {
    onChange(selected.includes(sku) ? selected.filter((s) => s !== sku) : [...selected, sku]);
  };

  return (
    <div className="flex-1 min-w-[280px]" ref={boxRef}>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
        <Input
          placeholder={selected.length ? 'Add another SKU…' : 'Search SKU or product…'}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          className="pl-9 pr-8 h-10 text-sm"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
          >
            <X size={14} />
          </button>
        )}

        {open && (
          <div className="absolute top-full mt-1 left-0 right-0 z-50 bg-popover border rounded-lg shadow-lg py-1 max-h-[320px] overflow-y-auto">
            {matches.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                No Shopify SKU matches “{query}”.
              </p>
            )}
            {matches.map((s) => {
              const on = selected.includes(s.sku);
              return (
                <button
                  key={s.sku}
                  onClick={() => toggle(s.sku)}
                  className={cn(
                    'w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors flex items-start gap-2',
                    on && 'bg-muted/40'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[9px] leading-none',
                      on ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                    )}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium truncate">{s.sku}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                        {fmtNum(s.units)} u
                      </span>
                    </span>
                    {s.product_title && (
                      <span className="block text-[10px] text-muted-foreground/70 truncate">
                        {s.product_title}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {selected.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium"
            >
              {s}
              <button
                onClick={() => toggle(s)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${s}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {selected.length > 1 && (
            <button
              onClick={() => onChange([])}
              className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export interface B2CSalesPanelProps {
  /** SKUs to report on. When onSkusChange is omitted the selection is fixed
   *  (the dialog opened from a product row). */
  skus: string[];
  onSkusChange?: (skus: string[]) => void;
  from: string;
  to: string;
  onRangeChange: (from: string, to: string) => void;
  granularity: SalesGranularity;
  onGranularityChange: (g: SalesGranularity) => void;
  metric: SalesMetric;
  onMetricChange: (m: SalesMetric) => void;
  showTrend: boolean;
  onShowTrendChange: (v: boolean) => void;
  /** Hides the search when the caller has already fixed the SKU. */
  showSearch?: boolean;
  compact?: boolean;
}

export function B2CSalesPanel({
  skus, onSkusChange, from, to, onRangeChange,
  granularity, onGranularityChange, metric, onMetricChange,
  showTrend, onShowTrendChange,
  showSearch = true, compact = false,
}: B2CSalesPanelProps) {
  const [skuList, setSkuList] = useState<ShopifySkuListItem[]>([]);
  const [stats, setStats] = useState<ShopifySkuStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!showSearch) return;
    fetchShopifySkuList().then(setSkuList);
  }, [showSearch]);

  useEffect(() => {
    // An empty selection is not an empty state: it means the whole store.
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchShopifySkuStats(skus, from, to, granularity, metric)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skus.join('|'), from, to, granularity, metric]);

  const activePreset = useMemo(
    () => DATE_PRESETS.find((p) => { const r = p.range(); return r.from === from && r.to === to; })?.label ?? null,
    [from, to]
  );

  const chartData = useMemo(
    () => withTrend(stats?.series ?? [], stats?.granularity ?? granularity, metric),
    [stats, granularity, metric]
  );

  const unitsDelta = stats ? delta(stats.summary.units, stats.previous.units) : null;
  const netDelta = stats ? delta(stats.summary.netAud, stats.previous.netAud) : null;
  const ordersDelta = stats ? delta(stats.summary.orders, stats.previous.orders) : null;

  return (
    <div className="space-y-4">
      {/* ── Controls ───────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 flex-wrap">
        {showSearch && onSkusChange && (
          <SkuMultiSearch skus={skuList} selected={skus} onChange={onSkusChange} />
        )}

        <div className="flex items-center gap-1 flex-wrap">
          {DATE_PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="sm"
              onClick={() => { const r = p.range(); onRangeChange(r.from, r.to); }}
              className={cn(
                'h-8 rounded-lg px-2.5 text-xs',
                activePreset === p.label && 'bg-muted text-foreground font-medium'
              )}
            >
              {p.label}
            </Button>
          ))}
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => onRangeChange(e.target.value, to)}
            className="h-8 rounded-md border bg-background px-2 text-xs ml-1"
          />
          <span className="text-xs text-muted-foreground">→</span>
          <input
            type="date"
            value={to}
            min={from}
            max={storeToday()}
            onChange={(e) => onRangeChange(from, e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          />
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {loading && !stats && <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>}

      {stats && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <p className="text-[11px] text-muted-foreground/70">
            {stats.wholeStore
              ? `Whole store · ${fmtNum(stats.skuCount)} SKUs sold`
              : skus.length === 1
                ? stats.perSku[0]?.product_title ?? ''
                : `${skus.length} SKUs`}
            {' · vs '}{stats.previousFrom} → {stats.previousTo}
          </p>

          {/* ── Stat cards ──────────────────────────────────────── */}
          <div className={cn('grid gap-3', compact ? 'grid-cols-2 lg:grid-cols-3' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6')}>
            <StatCard
              icon={<Package size={15} />} label="Units" accent="#3b82f6"
              value={fmtNum(stats.summary.units)}
              sub={`${fmtNum(stats.previous.units)} in the previous period`}
              delta={unitsDelta}
            />
            <StatCard
              icon={<DollarSign size={15} />} label="Net sales · ex tax" accent="#10b981"
              value={fmtAud(stats.summary.netAud)}
              usd={stats.summary.netUsd}
              sub={`${fmtAud(stats.previous.netAud)} ${fmtUsd(stats.previous.netUsd)} before`}
              delta={netDelta}
            />
            <StatCard
              icon={<ShoppingCart size={15} />} label="Orders" accent="#8b5cf6"
              value={fmtNum(stats.summary.orders)}
              sub={`${fmtNum(stats.previous.orders)} before`}
              delta={ordersDelta}
            />
            <StatCard
              icon={<Tag size={15} />} label="Realised price" accent="#f59e0b"
              value={fmtAud2(stats.summary.avgNetPriceAud)}
              usd={stats.summary.avgNetPriceUsd}
              usdDecimals
              sub="net per unit, after discounts"
            />
            <StatCard
              icon={<Tag size={15} />} label="Discounts" accent="#ef4444"
              value={fmtAud(stats.summary.discountsAud)}
              usd={stats.summary.discountsUsd}
              sub={stats.summary.grossAud > 0
                ? `${((stats.summary.discountsAud / stats.summary.grossAud) * 100).toFixed(1)}% of gross`
                : undefined}
            />
            <StatCard
              icon={<RotateCcw size={15} />} label="Returns" accent="#f97316"
              value={fmtAud(stats.summary.returnsAud)}
              usd={stats.summary.returnsUsd}
              sub={stats.summary.grossAud > 0
                ? `${((stats.summary.returnsAud / stats.summary.grossAud) * 100).toFixed(1)}% of gross`
                : undefined}
            />
          </div>

          {/* ── Series ──────────────────────────────────────────── */}
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {metric === 'revenue' ? 'Net AUD' : 'Units'} per {granularity}
              </h3>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
                  {METRICS.map((m) => (
                    <button
                      key={m.key}
                      onClick={() => onMetricChange(m.key)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                        metric === m.key
                          ? 'bg-background shadow-sm text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
                  {GRANULARITIES.map((g) => (
                    <button
                      key={g.key}
                      onClick={() => onGranularityChange(g.key)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
                        granularity === g.key
                          ? 'bg-background shadow-sm text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => onShowTrendChange(!showTrend)}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    showTrend
                      ? 'border-amber-400 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  Trend {showTrend ? 'on' : 'off'}
                </button>
              </div>
            </div>

            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No Shopify sales in this range.
              </p>
            ) : (
              <div className={compact ? 'h-[180px]' : 'h-[240px]'}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                    <XAxis
                      dataKey="bucket"
                      tickFormatter={(b: string) => bucketLabel(b, granularity)}
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={16}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={metric === 'revenue' ? 60 : 44}
                      tickFormatter={(v: number) => (metric === 'revenue' ? fmtAud(v) : fmtNum(v))}
                    />
                    <RTooltip
                      cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as ChartPoint;
                        return (
                          <div className="rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md">
                            <div className="font-medium mb-1">{bucketLabel(String(label), granularity)}</div>
                            <div className="flex items-baseline justify-between gap-4">
                              <span className="text-muted-foreground">{metric === 'revenue' ? 'Net AUD' : 'Units'}</span>
                              <span className="font-medium tabular-nums" style={{ color: '#3b82f6' }}>
                                {metric === 'revenue'
                                  ? <>{fmtAud(p.value)}<Usd value={p.valueUsd} size="table" /></>
                                  : fmtNum(p.value)}
                              </span>
                            </div>
                            {/* Orders alongside the measure: 40 units over 8 orders and
                                over 40 orders are different days, and neither the bar
                                nor the trend line can tell them apart. */}
                            <div className="flex items-baseline justify-between gap-4">
                              <span className="text-muted-foreground">Orders</span>
                              <span className="font-medium tabular-nums">{fmtNum(p.orders)}</span>
                            </div>
                            {showTrend && (
                              <div className="flex items-baseline justify-between gap-4">
                                <span className="text-muted-foreground">Trend</span>
                                <span className="font-medium tabular-nums" style={{ color: '#f59e0b' }}>
                                  {metric === 'revenue'
                                    ? <>{fmtAud(p.trend)}<Usd value={p.trendUsd} size="table" /></>
                                    : fmtNum(p.trend)}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="value" fill="#3b82f6" radius={[4, 4, 0, 0]} name="value" />
                    {showTrend && (
                      <Line
                        type="monotone"
                        dataKey="trend"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        dot={false}
                        name="trend"
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* ── Per SKU, only when comparing several ────────────── */}
          {stats.perSku.length > 1 && (
            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                {stats.wholeStore ? 'Top products' : 'By SKU'}
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium pb-1.5">SKU</th>
                    <th className="text-right font-medium pb-1.5">Units</th>
                    <th className="text-right font-medium pb-1.5">Orders</th>
                    <th className="text-right font-medium pb-1.5">Net AUD</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.perSku.map((p) => (
                    <tr key={p.sku} className="border-t border-border/40">
                      <td className="py-1.5">
                        <span className="font-medium">{p.sku}</span>
                        {p.product_title && (
                          <span className="block text-[11px] text-muted-foreground/70 truncate max-w-[280px]">
                            {p.product_title}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{fmtNum(p.units)}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{fmtNum(p.orders)}</td>
                      <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(p.net_aud)}<Usd value={p.net_usd} size="table" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* ── Countries + recent orders ───────────────────────── */}
          <div className={cn('grid gap-4', compact ? 'grid-cols-1' : 'grid-cols-1 lg:grid-cols-2')}>
            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                <Globe size={12} /> Countries
              </h3>
              {stats.countries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No data.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left font-medium pb-1.5">Country</th>
                      <th className="text-right font-medium pb-1.5">Units</th>
                      <th className="text-right font-medium pb-1.5">Net AUD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.countries.map((c) => (
                      <tr key={c.country} className="border-t border-border/40">
                        <td className="py-1.5">{countryName(c.country)}</td>
                        <td className="py-1.5 text-right tabular-nums font-medium">{fmtNum(c.units)}</td>
                        <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(c.net_aud)}<Usd value={c.net_usd} size="table" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Recent sales
              </h3>
              {stats.recentOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No data.</p>
              ) : (
                <div className="max-h-[280px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="text-left font-medium pb-1.5">Date</th>
                        {skus.length !== 1 && <th className="text-left font-medium pb-1.5">SKU</th>}
                        <th className="text-left font-medium pb-1.5">Country</th>
                        <th className="text-right font-medium pb-1.5">Qty</th>
                        <th className="text-right font-medium pb-1.5">Net AUD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentOrders.map((o, i) => (
                        <tr key={`${o.order_date}-${o.sku}-${i}`} className="border-t border-border/40">
                          <td className="py-1.5 tabular-nums">{o.order_date}</td>
                          {skus.length !== 1 && <td className="py-1.5 text-[11px]">{o.sku}</td>}
                          <td className="py-1.5">{countryName(o.country)}</td>
                          <td className="py-1.5 text-right tabular-nums font-medium">{fmtNum(o.quantity)}</td>
                          <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud2(o.net_aud)}<Usd value={o.net_usd} decimals size="table" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <p className="text-[11px] text-muted-foreground/70">
            Shopify sales only. <b className="text-muted-foreground">Every amount here excludes sales tax</b>, so
            it matches Shopify’s Net sales: Australian prices carry the 10% GST inside the shelf
            price and other markets add tax at checkout, and that tax is not revenue.
            {' '}{fmtAud(stats.summary.taxExcludedAud)} <span className="whitespace-nowrap">{fmtUsd(stats.summary.taxExcludedUsd)}</span>{' '}
            of tax was taken out of this period. Amounts in AUD, converted from USD at each
            order’s month rate — the same rate the rest of the dashboard uses. Dates are the
            store’s calendar days in Brisbane time, the same days Shopify reports.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Shared state, persisted ────────────────────────────────────────────────
// The tab is a modal: closing it unmounts everything, and re-picking the range
// every time was the complaint. Persisted so the explorer reopens where it was.

const STORAGE_KEY = 'b2c-sales-explorer.v1';

export interface B2CExplorerState {
  skus: string[];
  from: string;
  to: string;
  granularity: SalesGranularity;
  metric: SalesMetric;
  showTrend: boolean;
}

function defaultState(): B2CExplorerState {
  const r = DATE_PRESETS.find((p) => p.label === '90 days')!.range();
  return { skus: [], from: r.from, to: r.to, granularity: 'day', metric: 'units', showTrend: true };
}

export function useB2CExplorerState() {
  const [state, setState] = useState<B2CExplorerState>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw) as Partial<B2CExplorerState>;
      const d = defaultState();
      return {
        skus: Array.isArray(parsed.skus) ? parsed.skus : d.skus,
        from: typeof parsed.from === 'string' ? parsed.from : d.from,
        to: typeof parsed.to === 'string' ? parsed.to : d.to,
        granularity: (['day', 'week', 'month'] as const).includes(parsed.granularity as SalesGranularity)
          ? (parsed.granularity as SalesGranularity)
          : d.granularity,
        metric: (['units', 'revenue'] as const).includes(parsed.metric as SalesMetric)
          ? (parsed.metric as SalesMetric)
          : d.metric,
        showTrend: typeof parsed.showTrend === 'boolean' ? parsed.showTrend : d.showTrend,
      };
    } catch {
      return defaultState();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // A full or blocked localStorage must not take the panel down.
    }
  }, [state]);

  const patch = useCallback((p: Partial<B2CExplorerState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  return { state, patch };
}

export default B2CSalesPanel;
