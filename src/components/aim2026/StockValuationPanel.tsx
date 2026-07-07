import { useMemo, useState } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { Warehouse, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import type { StockValuationTotals, StockValuationHistoryRecord } from '@/lib/aim2026/types';

// ─── Types ─────────────────────────────────────────────────────────────────

interface StockValuationPanelProps {
  valuation: StockValuationTotals | null;
  history: StockValuationHistoryRecord[];
  loading: boolean;
}

// ─── Colors ────────────────────────────────────────────────────────────────

const LOCATION_COLORS: Record<string, string> = {
  mainWarehouse: '#3b82f6',
  china: '#8b5cf6',
  container: '#06b6d4',
  dhl: '#f97316',
  onProduction: '#a855f7',
  pesadoKorea: '#ec4899',
};

const LOCATION_LABELS: Record<string, string> = {
  mainWarehouse: 'Main Warehouse',
  china: 'China WH (net)',
  container: 'Container (Sea)',
  dhl: 'DHL (Express)',
  onProduction: 'On Production',
  pesadoKorea: 'Pesado Korea',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtCurrency(v: number): string {
  if (v >= 1000) {
    return `$${(v / 1000).toFixed(1)}k`;
  }
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtCurrencyFull(v: number): string {
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ─── Pie Custom Label ──────────────────────────────────────────────────────

function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }: any) {
  if (percent < 0.05) return null; // Skip tiny slices
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

// ─── Custom Pie Tooltip ────────────────────────────────────────────────────

function PieTooltipContent({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const { name, value } = payload[0];
  return (
    <div className="bg-popover border rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold">{name}</p>
      <p className="text-muted-foreground mt-0.5">{fmtCurrencyFull(value)} AUD</p>
    </div>
  );
}

// ─── Skeleton ──────────────────────────────────────────────────────────────

function SkeletonPanel() {
  return (
    <div className="border rounded-lg p-4 bg-card space-y-3 animate-pulse">
      <div className="h-4 w-40 bg-muted rounded" />
      <div className="h-32 bg-muted/50 rounded-lg" />
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 bg-muted/50 rounded" />
        ))}
      </div>
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export function StockValuationPanel({ valuation, history, loading }: StockValuationPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // Prepare pie data
  const pieData = useMemo(() => {
    if (!valuation) return [];
    return Object.entries(LOCATION_LABELS)
      .map(([key, name]) => ({
        name,
        value: valuation[key as keyof StockValuationTotals] as number,
        color: LOCATION_COLORS[key],
      }))
      .filter((d) => d.value > 0);
  }, [valuation]);

  // History trend
  const trend = useMemo(() => {
    if (history.length < 2) return { direction: 'stable' as const, percent: 0 };
    const latest = history[0]?.totalInventory ?? 0;
    const previous = history[1]?.totalInventory ?? 0;
    const diff = previous > 0 ? ((latest - previous) / previous) * 100 : 0;
    return {
      direction: diff > 1 ? ('up' as const) : diff < -1 ? ('down' as const) : ('stable' as const),
      percent: Math.abs(diff),
    };
  }, [history]);

  if (loading) return <SkeletonPanel />;
  if (!valuation) return null;

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Warehouse size={16} className="text-blue-500" />
          <span className="text-sm font-semibold">Stock Valuation</span>
          <span className="text-xs font-bold text-foreground tabular-nums ml-1">
            {fmtCurrencyFull(valuation.totalInventory)} AUD
          </span>
          {trend.direction === 'up' && (
            <span className="flex items-center gap-0.5 text-[10px] text-emerald-600 font-medium">
              <TrendingUp size={11} /> +{trend.percent.toFixed(1)}%
            </span>
          )}
          {trend.direction === 'down' && (
            <span className="flex items-center gap-0.5 text-[10px] text-red-500 font-medium">
              <TrendingDown size={11} /> -{trend.percent.toFixed(1)}%
            </span>
          )}
          {trend.direction === 'stable' && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <Minus size={11} /> stable
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp size={16} className="text-muted-foreground" />
        ) : (
          <ChevronDown size={16} className="text-muted-foreground" />
        )}
      </button>

      {/* ── Expandable Content ───────────────────────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4 border-t">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                {/* ── Pie Chart ──────────────────────────────────────── */}
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Distribution by Location
                  </h4>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={80}
                          paddingAngle={2}
                          dataKey="value"
                          labelLine={false}
                          label={renderCustomLabel}
                        >
                          {pieData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} stroke="none" />
                          ))}
                        </Pie>
                        <RechartsTooltip content={<PieTooltipContent />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Legend */}
                  <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center mt-1">
                    {pieData.map((d, i) => (
                      <div key={i} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                        {d.name}
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Location Breakdown ─────────────────────────────── */}
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Breakdown
                  </h4>
                  <div className="space-y-2">
                    {pieData.map((d, i) => {
                      const pct = valuation.totalInventory > 0 ? (d.value / valuation.totalInventory) * 100 : 0;
                      return (
                        <div key={i}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: d.color }} />
                              <span className="font-medium">{d.name}</span>
                            </div>
                            <span className="tabular-nums font-semibold">{fmtCurrencyFull(d.value)}</span>
                          </div>
                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${pct}%` }}
                              transition={{ duration: 0.6, delay: i * 0.08 }}
                              className="h-full rounded-full"
                              style={{ backgroundColor: d.color }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {/* Total */}
                    <div className="flex items-center justify-between text-xs pt-2 border-t mt-2">
                      <span className="font-semibold">Total Inventory</span>
                      <span className="font-bold tabular-nums text-sm">{fmtCurrencyFull(valuation.totalInventory)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── History Chart ────────────────────────────────────── */}
              {history.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Valuation Trend (Weekly)
                  </h4>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={[...history].reverse()}
                        margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                      >
                        <defs>
                          <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                        <XAxis
                          dataKey="snapshotDate"
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(v: string) => {
                            const d = new Date(v);
                            return d.toLocaleDateString('en', { day: '2-digit', month: 'short' });
                          }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          width={55}
                          tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                        />
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: 'hsl(var(--popover))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px',
                            fontSize: '12px',
                          }}
                          formatter={(value: number) => [`$${value.toLocaleString()}`, 'Total']}
                          labelFormatter={(label: string) => {
                            const d = new Date(label);
                            return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' });
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="totalInventory"
                          stroke="#3b82f6"
                          fill="url(#gradTotal)"
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
