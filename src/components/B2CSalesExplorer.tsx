// =============================================================================
// B2C Sales Explorer — type a SKU, see what it did on Shopify
// =============================================================================
// The question this answers used to require reasoning about which table held
// what: AIM 2026 mixes wholesale and component usage, the E-commerce tab is
// store-wide. Here the unit of analysis is one SKU on one channel (Shopify),
// over a window you choose.
//
// Money is AUD. shopify_sales_lines stores 43 currencies natively, so summing
// net_native would be meaningless; the RPC converts net_usd at the same
// per-month rate the rest of the dashboard uses.

import { useState, useEffect, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Search, X, ShoppingCart, DollarSign, Tag, RotateCcw, Globe, Package, TrendingUp, TrendingDown, Minus,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, CartesianGrid,
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
} from '@/lib/aim2026/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined
    ? '—'
    : `$${Math.round(v).toLocaleString('en-AU')}`;

const fmtAud2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${v.toFixed(2)}`;

const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');

const iso = (d: Date) => d.toISOString().slice(0, 10);

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return iso(d);
}

const PRESETS: { label: string; from: () => string; to: () => string }[] = [
  { label: '30 days', from: () => daysAgo(30), to: () => iso(new Date()) },
  { label: '90 days', from: () => daysAgo(90), to: () => iso(new Date()) },
  { label: '12 months', from: () => daysAgo(365), to: () => iso(new Date()) },
];

/** Change vs the equivalent previous window. Returns null when there is no
 * previous figure to compare against — a first-ever month is not "+100%". */
function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function DeltaPill({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-[11px] text-muted-foreground">sin base previa</span>;
  }
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

// ─── SKU search ─────────────────────────────────────────────────────────────

function SkuSearch({
  skus, value, onChange,
}: {
  skus: ShopifySkuListItem[];
  value: string | null;
  onChange: (sku: string) => void;
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
    if (!q) return skus.slice(0, 30);
    return skus
      .filter(
        (s) =>
          s.sku.toLowerCase().includes(q) ||
          (s.product_title ?? '').toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [skus, query]);

  return (
    <div className="relative flex-1 min-w-[260px] max-w-lg" ref={boxRef}>
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
      <Input
        placeholder="Buscar SKU o producto…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        className="pl-9 pr-8 h-10 text-sm"
      />
      {query && (
        <button
          onClick={() => { setQuery(''); setOpen(true); }}
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
          {matches.map((s) => (
            <button
              key={s.sku}
              onClick={() => { onChange(s.sku); setQuery(''); setOpen(false); }}
              className={cn(
                'w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors',
                value === s.sku && 'bg-muted/40'
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium truncate">{s.sku}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums flex-shrink-0">
                  {fmtNum(s.units)} u
                </span>
              </div>
              {s.product_title && (
                <p className="text-[10px] text-muted-foreground/70 truncate">{s.product_title}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Explorer ───────────────────────────────────────────────────────────────

export function B2CSalesExplorer() {
  const [skus, setSkus] = useState<ShopifySkuListItem[]>([]);
  const [sku, setSku] = useState<string | null>(null);
  const [from, setFrom] = useState(() => daysAgo(90));
  const [to, setTo] = useState(() => iso(new Date()));
  const [stats, setStats] = useState<ShopifySkuStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchShopifySkuList().then((list) => {
      setSkus(list);
      // Land on the best seller so the screen is never empty on open.
      if (list.length > 0) setSku((cur) => cur ?? list[0].sku);
    });
  }, []);

  useEffect(() => {
    if (!sku) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchShopifySkuStats(sku, from, to)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sku, from, to]);

  const activePreset = PRESETS.find((p) => p.from() === from && p.to() === to)?.label ?? null;

  const chartData = useMemo(
    () => (stats?.monthly ?? []).map((m) => ({ ...m, netAud: m.net_aud })),
    [stats]
  );

  const unitsDelta = stats ? delta(stats.summary.units, stats.previous.units) : null;
  const netDelta = stats ? delta(stats.summary.netAud, stats.previous.netAud) : null;
  const ordersDelta = stats ? delta(stats.summary.orders, stats.previous.orders) : null;

  return (
    <div className="space-y-4">
      {/* ── Controls ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <SkuSearch skus={skus} value={sku} onChange={setSku} />

        <div className="flex items-center gap-1">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="sm"
              onClick={() => { setFrom(p.from()); setTo(p.to()); }}
              className={cn(
                'h-8 rounded-lg px-3 text-xs',
                activePreset === p.label && 'bg-muted text-foreground font-medium'
              )}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          />
          <span>→</span>
          <input
            type="date"
            value={to}
            min={from}
            max={iso(new Date())}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          />
        </div>
      </div>

      {/* ── Header ─────────────────────────────────────────────────── */}
      {stats && (
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-lg font-semibold tracking-tight">{stats.sku}</h2>
          {stats.productTitle && (
            <span className="text-sm text-muted-foreground">{stats.productTitle}</span>
          )}
          <span className="text-[11px] text-muted-foreground/70">
            vs {stats.previousFrom} → {stats.previousTo}
          </span>
        </div>
      )}

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {loading && !stats && (
        <p className="text-sm text-muted-foreground animate-pulse">Cargando…</p>
      )}

      {stats && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className={cn('space-y-4', loading && 'opacity-60')}
        >
          {/* ── Stat cards ──────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              icon={<Package size={15} />}
              label="Units"
              value={fmtNum(stats.summary.units)}
              sub={`${fmtNum(stats.previous.units)} en el período anterior`}
              delta={unitsDelta}
              accent="#3b82f6"
            />
            <StatCard
              icon={<DollarSign size={15} />}
              label="Net sales"
              value={fmtAud(stats.summary.netAud)}
              sub={`${fmtAud(stats.previous.netAud)} antes · AUD`}
              delta={netDelta}
              accent="#10b981"
            />
            <StatCard
              icon={<ShoppingCart size={15} />}
              label="Orders"
              value={fmtNum(stats.summary.orders)}
              sub={`${fmtNum(stats.previous.orders)} antes`}
              delta={ordersDelta}
              accent="#8b5cf6"
            />
            <StatCard
              icon={<Tag size={15} />}
              label="Precio real"
              value={fmtAud2(stats.summary.avgNetPriceAud)}
              sub="neto por unidad, después de descuentos"
              accent="#f59e0b"
            />
            <StatCard
              icon={<Tag size={15} />}
              label="Descuentos"
              value={fmtAud(stats.summary.discountsAud)}
              sub={
                stats.summary.grossAud > 0
                  ? `${((stats.summary.discountsAud / stats.summary.grossAud) * 100).toFixed(1)}% del bruto`
                  : undefined
              }
              accent="#ef4444"
            />
            <StatCard
              icon={<RotateCcw size={15} />}
              label="Devoluciones"
              value={fmtAud(stats.summary.returnsAud)}
              sub={
                stats.summary.grossAud > 0
                  ? `${((stats.summary.returnsAud / stats.summary.grossAud) * 100).toFixed(1)}% del bruto`
                  : undefined
              }
              accent="#f97316"
            />
          </div>

          {/* ── Monthly ─────────────────────────────────────────── */}
          <Card className="p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Por mes
            </h3>
            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Sin ventas de Shopify en este rango.
              </p>
            ) : (
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                    <RTooltip
                      formatter={(v: number, name: string) =>
                        name === 'netAud' ? [fmtAud(v), 'Net AUD'] : [fmtNum(v), 'Units']
                      }
                      contentStyle={{ fontSize: 12, borderRadius: 8 }}
                    />
                    <Bar dataKey="units" fill="#3b82f6" radius={[4, 4, 0, 0]} name="units" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* ── Countries + recent orders ───────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
                        <th className="text-left font-medium pb-1.5">País</th>
                        <th className="text-right font-medium pb-1.5">Cant.</th>
                        <th className="text-right font-medium pb-1.5">Neto AUD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recentOrders.map((o, i) => (
                        <tr key={`${o.order_date}-${i}`} className="border-t border-border/40">
                          <td className="py-1.5 tabular-nums">{o.order_date}</td>
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
        </motion.div>
      )}
    </div>
  );
}

export default B2CSalesExplorer;
