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
} from '@/lib/aim2026/api';

// ─── Formatting ─────────────────────────────────────────────────────────────

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtAud2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;
const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');

const iso = (d: Date) => d.toISOString().slice(0, 10);

function shiftDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
}

/** Monday-to-Sunday of the week before the current one. */
function lastWeek(): { from: string; to: string } {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0 = Monday
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - dow);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  return { from: iso(lastMonday), to: iso(lastSunday) };
}

export const DATE_PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: 'Yesterday', range: () => ({ from: shiftDays(-1), to: shiftDays(-1) }) },
  { label: 'Last week', range: lastWeek },
  { label: '30 days', range: () => ({ from: shiftDays(-29), to: iso(new Date()) }) },
  { label: '90 days', range: () => ({ from: shiftDays(-89), to: iso(new Date()) }) },
  { label: '12 months', range: () => ({ from: shiftDays(-364), to: iso(new Date()) }) },
];

const GRANULARITIES: { key: SalesGranularity; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
];

/** Change vs the equivalent previous window. null when there is no previous
 * figure — a first-ever period is not "+100%". */
function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/** Centred 3-point moving average, so the curve shows direction rather than
 * repeating the bars. */
function withTrend(series: { bucket: string; units: number; net_aud: number }[]) {
  return series.map((p, i) => {
    const window = series.slice(Math.max(0, i - 1), Math.min(series.length, i + 2));
    const trend = window.reduce((s, w) => s + w.units, 0) / window.length;
    return { ...p, netAud: p.net_aud, trend: Math.round(trend * 10) / 10 };
  });
}

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
  if (value === null) return <span className="text-[11px] text-muted-foreground">sin base previa</span>;
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
  icon, label, value, sub, delta: d, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
      <div className="flex items-end gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums leading-none">{value}</span>
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
          placeholder={selected.length ? 'Agregar otro SKU…' : 'Buscar SKU o producto…'}
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
                Ningún SKU de Shopify coincide con “{query}”.
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
                aria-label={`Quitar ${s}`}
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
              limpiar
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
  showTrend: boolean;
  onShowTrendChange: (v: boolean) => void;
  /** Hides the search when the caller has already fixed the SKU. */
  showSearch?: boolean;
  compact?: boolean;
}

export function B2CSalesPanel({
  skus, onSkusChange, from, to, onRangeChange,
  granularity, onGranularityChange, showTrend, onShowTrendChange,
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
    if (skus.length === 0) { setStats(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchShopifySkuStats(skus, from, to, granularity)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skus.join('|'), from, to, granularity]);

  const activePreset = useMemo(
    () => DATE_PRESETS.find((p) => { const r = p.range(); return r.from === from && r.to === to; })?.label ?? null,
    [from, to]
  );

  const chartData = useMemo(() => withTrend(stats?.series ?? []), [stats]);

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
            max={iso(new Date())}
            onChange={(e) => onRangeChange(from, e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          />
        </div>
      </div>

      {skus.length === 0 && (
        <p className="text-sm text-muted-foreground py-6">
          Elegí uno o más SKUs para ver sus ventas de Shopify.
        </p>
      )}

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {loading && !stats && <p className="text-sm text-muted-foreground animate-pulse">Cargando…</p>}

      {stats && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          <p className="text-[11px] text-muted-foreground/70">
            {skus.length === 1 ? stats.perSku[0]?.product_title ?? '' : `${skus.length} SKUs`}
            {' · vs '}{stats.previousFrom} → {stats.previousTo}
          </p>

          {/* ── Stat cards ──────────────────────────────────────── */}
          <div className={cn('grid gap-3', compact ? 'grid-cols-2 lg:grid-cols-3' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6')}>
            <StatCard
              icon={<Package size={15} />} label="Units" accent="#3b82f6"
              value={fmtNum(stats.summary.units)}
              sub={`${fmtNum(stats.previous.units)} en el período anterior`}
              delta={unitsDelta}
            />
            <StatCard
              icon={<DollarSign size={15} />} label="Net sales" accent="#10b981"
              value={fmtAud(stats.summary.netAud)}
              sub={`${fmtAud(stats.previous.netAud)} antes · AUD`}
              delta={netDelta}
            />
            <StatCard
              icon={<ShoppingCart size={15} />} label="Orders" accent="#8b5cf6"
              value={fmtNum(stats.summary.orders)}
              sub={`${fmtNum(stats.previous.orders)} antes`}
              delta={ordersDelta}
            />
            <StatCard
              icon={<Tag size={15} />} label="Precio real" accent="#f59e0b"
              value={fmtAud2(stats.summary.avgNetPriceAud)}
              sub="neto por unidad, después de descuentos"
            />
            <StatCard
              icon={<Tag size={15} />} label="Descuentos" accent="#ef4444"
              value={fmtAud(stats.summary.discountsAud)}
              sub={stats.summary.grossAud > 0
                ? `${((stats.summary.discountsAud / stats.summary.grossAud) * 100).toFixed(1)}% del bruto`
                : undefined}
            />
            <StatCard
              icon={<RotateCcw size={15} />} label="Devoluciones" accent="#f97316"
              value={fmtAud(stats.summary.returnsAud)}
              sub={stats.summary.grossAud > 0
                ? `${((stats.summary.returnsAud / stats.summary.grossAud) * 100).toFixed(1)}% del bruto`
                : undefined}
            />
          </div>

          {/* ── Series ──────────────────────────────────────────── */}
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Unidades por {granularity === 'day' ? 'día' : granularity === 'week' ? 'semana' : 'mes'}
              </h3>
              <div className="flex items-center gap-2">
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
                Sin ventas de Shopify en este rango.
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
                    <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <RTooltip
                      labelFormatter={(b: string) => bucketLabel(b, granularity)}
                      formatter={(v: number, name: string) => {
                        if (name === 'trend') return [fmtNum(v), 'Tendencia'];
                        if (name === 'netAud') return [fmtAud(v), 'Net AUD'];
                        return [fmtNum(v), 'Unidades'];
                      }}
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Bar dataKey="units" fill="#3b82f6" radius={[4, 4, 0, 0]} name="units" />
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
                Por SKU
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium pb-1.5">SKU</th>
                    <th className="text-right font-medium pb-1.5">Unidades</th>
                    <th className="text-right font-medium pb-1.5">Órdenes</th>
                    <th className="text-right font-medium pb-1.5">Neto AUD</th>
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
                      <td className="py-1.5 text-right tabular-nums">{fmtNum(p.units)}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtNum(p.orders)}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtAud(p.net_aud)}</td>
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
                <Globe size={12} /> Países
              </h3>
              {stats.countries.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">Sin datos.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left font-medium pb-1.5">País</th>
                      <th className="text-right font-medium pb-1.5">Unidades</th>
                      <th className="text-right font-medium pb-1.5">Neto AUD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.countries.map((c) => (
                      <tr key={c.country} className="border-t border-border/40">
                        <td className="py-1.5">{c.country}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtNum(c.units)}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtAud(c.net_aud)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Últimas ventas
              </h3>
              {stats.recentOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">Sin datos.</p>
              ) : (
                <div className="max-h-[280px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="text-left font-medium pb-1.5">Fecha</th>
                        {skus.length > 1 && <th className="text-left font-medium pb-1.5">SKU</th>}
                        <th className="text-left font-medium pb-1.5">País</th>
                        <th className="text-right font-medium pb-1.5">Cant.</th>
                        <th className="text-right font-medium pb-1.5">Neto AUD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentOrders.map((o, i) => (
                        <tr key={`${o.order_date}-${o.sku}-${i}`} className="border-t border-border/40">
                          <td className="py-1.5 tabular-nums">{o.order_date}</td>
                          {skus.length > 1 && <td className="py-1.5 text-[11px]">{o.sku}</td>}
                          <td className="py-1.5">{o.country}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtNum(o.quantity)}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtAud2(o.net_aud)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <p className="text-[11px] text-muted-foreground/70">
            Solo ventas de Shopify. Importes en AUD, convertidos desde USD a la tasa del mes de cada
            orden — la misma que usa el resto del dashboard.
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
  showTrend: boolean;
}

function defaultState(): B2CExplorerState {
  const r = DATE_PRESETS.find((p) => p.label === '90 days')!.range();
  return { skus: [], from: r.from, to: r.to, granularity: 'month', showTrend: true };
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
