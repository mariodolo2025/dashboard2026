import { useMemo, useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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
import { Warehouse, TrendingUp, TrendingDown, Minus, Info, Download, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import type { StockValuationTotals, StockValuationHistoryRecord } from '@/lib/aim2026/types';
import { fetchWarehouseDetail, downloadAsCSV } from '@/lib/aim2026/api';

// ─── Types ─────────────────────────────────────────────────────────────────

interface StockValuationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  valuation: StockValuationTotals | null;
  history: StockValuationHistoryRecord[];
}

// ─── Colors & Labels ───────────────────────────────────────────────────────

const LOCATIONS = [
  { key: 'mainWarehouse', label: 'Main Warehouse', color: '#3b82f6', desc: 'Physical stock in the main warehouse in Australia, valued at landed cost (AUD).' },
  { key: 'china', label: 'China WH', color: '#8b5cf6', desc: 'Stock held in the China warehouse, valued at FOB cost × exchange rate.' },
  { key: 'container', label: 'Container (Sea)', color: '#06b6d4', desc: 'Stock currently in sea freight containers en route to Australia.' },
  { key: 'dhl', label: 'DHL (Express)', color: '#f97316', desc: 'Stock being shipped via DHL express courier (5-7 business days).' },
  { key: 'onProduction', label: 'On Production', color: '#a855f7', desc: 'Stock currently being manufactured in China, not yet shipped.' },
  { key: 'pesadoKorea', label: 'Pesado Korea', color: '#ec4899', desc: 'Stock held at the Pesado Korea warehouse/partner.' },
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtCurrencyFull(v: number): string {
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ─── Pie Label ─────────────────────────────────────────────────────────────

function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) {
  if (percent < 0.05) return null;
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

function PieTooltipContent({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold">{payload[0].name}</p>
      <p className="text-muted-foreground mt-0.5">{fmtCurrencyFull(payload[0].value)} AUD</p>
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export function StockValuationDialog({ open, onOpenChange, valuation, history }: StockValuationDialogProps) {
  const [downloadingWH, setDownloadingWH] = useState<string | null>(null);

  const handleWarehouseDownload = useCallback(async (warehouseKey: string, label: string) => {
    setDownloadingWH(warehouseKey);
    try {
      const result = await fetchWarehouseDetail(warehouseKey);
      if (result.success && result.data.length > 0) {
        const csvRows = result.data.map((r) => ({
          SKU: r.sku,
          Product: r.product,
          'Product Group': r.productGroup,
          Warehouse: r.warehouse,
          Quantity: r.quantity,
          Allocated: r.allocated,
          Available: r.available,
          'Cost China (USD)': r.unitCostChina,
          'Landed Cost (AUD)': r.landedCostAUD,
          'Unit Cost Used': r.unitCostUsed,
          'Total Value (AUD)': r.totalValue,
          'Valuation Method': r.valuationMethod,
        }));
        const date = result.snapshotDate ?? new Date().toISOString().slice(0, 10);
        downloadAsCSV(csvRows, `Valuation_${label.replace(/\s+/g, '_')}_${date}.csv`);
      } else {
        console.warn('No valuation detail data for', warehouseKey);
      }
    } catch (e) {
      console.error('Failed to download warehouse detail:', e);
    } finally {
      setDownloadingWH(null);
    }
  }, []);

  const pieData = useMemo(() => {
    if (!valuation) return [];
    return LOCATIONS
      .map((loc) => ({
        name: loc.label,
        key: loc.key,
        value: valuation[loc.key as keyof StockValuationTotals] as number,
        color: loc.color,
        desc: loc.desc,
      }))
      .filter((d) => d.value > 0);
  }, [valuation]);

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

  if (!valuation) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="px-6 pt-6 pb-4 border-b bg-muted/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Warehouse size={18} className="text-blue-500" />
              Stock Valuation Breakdown
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 mt-1">
              Total inventory value across all locations:{' '}
              <span className="font-bold text-foreground tabular-nums">
                {fmtCurrencyFull(valuation.totalInventory)} AUD
              </span>
              {trend.direction === 'up' && (
                <span className="flex items-center gap-0.5 text-[11px] text-emerald-600 font-medium">
                  <TrendingUp size={12} /> +{trend.percent.toFixed(1)}%
                </span>
              )}
              {trend.direction === 'down' && (
                <span className="flex items-center gap-0.5 text-[11px] text-red-500 font-medium">
                  <TrendingDown size={12} /> -{trend.percent.toFixed(1)}%
                </span>
              )}
              {trend.direction === 'stable' && (
                <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                  <Minus size={12} /> stable
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ── Help Banner ───────────────────────────────────────────── */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg px-4 py-3 border border-blue-200/40 dark:border-blue-800/40 flex items-start gap-2">
            <Info size={14} className="text-blue-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
              <strong>What is this?</strong> Stock Valuation shows the total monetary value of your inventory 
              across all physical locations. Main WH is valued at landed cost (AUD), while China/Production 
              locations are valued at FOB cost × exchange rate. Hover over each location for details.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* ── Pie Chart ──────────────────────────────────────── */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Distribution by Location
              </h4>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={90}
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
              <div className="flex flex-wrap gap-x-3 gap-y-1 justify-center mt-1">
                {pieData.map((d, i) => (
                  <div key={i} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                    {d.name}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Breakdown Bars ──────────────────────────────────── */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Breakdown
              </h4>
              <div className="space-y-3">
                {pieData.map((d, i) => {
                  const pct = valuation.totalInventory > 0 ? (d.value / valuation.totalInventory) * 100 : 0;
                  const isDownloading = downloadingWH === d.key;
                  return (
                    <div key={i} className="group">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <button
                          onClick={() => handleWarehouseDownload(d.key, d.name)}
                          disabled={isDownloading}
                          className="flex items-center gap-1.5 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                          title={`Download CSV with SKU-level detail for ${d.name}`}
                        >
                          <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: d.color }} />
                          <span className="font-medium">{d.name}</span>
                          {isDownloading ? (
                            <Loader2 size={10} className="animate-spin text-muted-foreground" />
                          ) : (
                            <Download size={10} className="opacity-0 group-hover:opacity-60 transition-opacity" />
                          )}
                        </button>
                        <span className="tabular-nums font-semibold">{fmtCurrencyFull(d.value)}</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.6, delay: i * 0.08 }}
                          className="h-full rounded-full"
                          style={{ backgroundColor: d.color }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {d.desc} <span className="text-blue-500/60">Click name to download CSV.</span>
                      </p>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between text-xs pt-3 border-t mt-3">
                  <span className="font-semibold">Total Inventory</span>
                  <span className="font-bold tabular-nums text-base">{fmtCurrencyFull(valuation.totalInventory)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── History Chart ────────────────────────────────────────── */}
          {history.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Valuation Trend (Weekly Snapshots)
              </h4>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={[...history].reverse()}
                    margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="gradTotalVal" x1="0" y1="0" x2="0" y2="1">
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
                      fill="url(#gradTotalVal)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
