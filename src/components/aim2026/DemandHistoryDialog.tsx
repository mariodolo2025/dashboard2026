import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
  ComposedChart,
  Bar,
  Line,
  Legend,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  Calendar,
  Activity,
  Download,
  Loader2,
  Warehouse,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SKURow, TrendDirection } from '@/lib/aim2026/types';
import { fetchDemandTransactions, downloadAsCSV } from '@/lib/aim2026/api';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DemandHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sku: SKURow | null;
}

interface DemandMonth {
  month: string;       // "Mar"
  fullMonth: string;   // "March 2025"
  yearMonth: string;   // "2025-03" (for CSV query)
  quantity: number;    // Sales (Completed)
  quantityPlaced: number;
  quantityParked: number;
  quantityBackordered: number;
  componentUsage: number;
  totalDemand: number; // Sales + Comp Usage + Placed + Backordered (+ Parked if enabled)
  revenue: number;
  movingAvg: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

async function fetchDemandHistory(sku: string, warehouse = 'all'): Promise<DemandMonth[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/aim2026-get-dashboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON}`,
        apikey: SUPABASE_ANON,
      },
      body: JSON.stringify({ action: 'demand_history', sku, warehouse }),
    });
    const json = await res.json();
    if (!json.success || !json.data) return [];

    // Group by month (use quantity_completed, quantity_placed, quantity_parked when available)
    const monthMap = new Map<string, { sold: number; placed: number; parked: number; backordered: number; revenue: number; compUsage: number }>();
    for (const row of json.data) {
      const d = new Date(row.period_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const existing = monthMap.get(key) ?? { sold: 0, placed: 0, parked: 0, backordered: 0, revenue: 0, compUsage: 0 };
      existing.sold += Number(row.quantity_completed ?? row.quantity_sold ?? 0);
      existing.placed += Number(row.quantity_placed ?? 0);
      existing.parked += Number(row.quantity_parked ?? 0);
      existing.backordered += Number(row.quantity_backordered ?? 0);
      existing.revenue += Number(row.revenue ?? 0);
      existing.compUsage += Number(row.component_usage ?? 0);
      monthMap.set(key, existing);
    }

    const entries = [...monthMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12);

    const data: DemandMonth[] = entries.map(([key, val]) => {
      const [y, m] = key.split('-').map(Number);
      const d = new Date(y, m - 1, 1);
      const totalDemand = val.sold + val.compUsage + val.placed + val.backordered + val.parked;
      return {
        month: d.toLocaleString('en', { month: 'short' }),
        fullMonth: d.toLocaleString('en', { month: 'long', year: 'numeric' }),
        yearMonth: key,
        quantity: Math.round(val.sold),
        quantityPlaced: Math.round(val.placed),
        quantityParked: Math.round(val.parked),
        quantityBackordered: Math.round(val.backordered),
        componentUsage: Math.round(val.compUsage),
        totalDemand: Math.round(totalDemand),
        revenue: Math.round(val.revenue),
        movingAvg: 0,
      };
    });

    // Calculate 3-month moving average
    for (let i = 0; i < data.length; i++) {
      if (i < 2) {
        data[i].movingAvg = data[i].totalDemand;
      } else {
        data[i].movingAvg = Math.round(
          (data[i].totalDemand + data[i - 1].totalDemand + data[i - 2].totalDemand) / 3
        );
      }
    }

    return data;
  } catch (e) {
    console.error('Failed to fetch demand history:', e);
    return [];
  }
}

function computeStats(data: DemandMonth[]) {
  if (data.length === 0) return { avg: 0, stdDev: 0, cv: 0, max: 0, min: 0, total: 0, trendPercent: 0 };

  const quantities = data.map((d) => d.totalDemand);
  const total = quantities.reduce((a, b) => a + b, 0);
  const avg = total / quantities.length;
  const variance = quantities.reduce((sum, q) => sum + (q - avg) ** 2, 0) / quantities.length;
  const stdDev = Math.sqrt(variance);
  const cv = avg > 0 ? (stdDev / avg) * 100 : 0;
  const max = Math.max(...quantities);
  const min = Math.min(...quantities);

  const n = quantities.length;
  const sumX = (n * (n - 1)) / 2;
  const sumXX = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumXY = quantities.reduce((sum, y, x) => sum + x * y, 0);
  const sumY = total;
  const slope = (n * sumXX - sumX * sumX) !== 0
    ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
    : 0;
  const trendPercent = avg > 0 ? (slope / avg) * 100 : 0;

  return { avg, stdDev, cv, max, min, total, trendPercent };
}

// ─── Trend Icon ────────────────────────────────────────────────────────────

function TrendIcon({ direction, className }: { direction: TrendDirection; className?: string }) {
  if (direction === 'up') return <TrendingUp size={16} className={cn('text-emerald-500', className)} />;
  if (direction === 'down') return <TrendingDown size={16} className={cn('text-red-500', className)} />;
  return <Minus size={16} className={cn('text-muted-foreground', className)} />;
}

// ─── Stat Pill ─────────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col items-center bg-muted/40 rounded-lg px-3 py-2 border border-border/30 min-w-[80px]">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
      <span className={cn('text-base font-bold tabular-nums mt-0.5', color)}>{value}</span>
    </div>
  );
}

// ─── Custom Tooltip ────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold mb-1">{payload[0]?.payload?.fullMonth ?? label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium tabular-nums">
            {p.name === 'Revenue' ? `$${p.value.toLocaleString()}` : p.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

const WAREHOUSE_OPTIONS = [
  { value: 'all', label: 'All Warehouses' },
  { value: 'Main Warehouse', label: 'Main Warehouse' },
  { value: 'China', label: 'China-W' },
  { value: 'Container', label: 'Container' },
  { value: 'DHL', label: 'DHL' },
  { value: 'Korea', label: 'Pesado Korea' },
];

export function DemandHistoryDialog({ open, onOpenChange, sku }: DemandHistoryDialogProps) {
  const [demandData, setDemandData] = useState<DemandMonth[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingMonth, setDownloadingMonth] = useState<string | null>(null);
  const [selectedWarehouse, setSelectedWarehouse] = useState('all');

  // Fetch demand data when dialog opens or warehouse changes
  useEffect(() => {
    if (!open || !sku?.sku) {
      setDemandData([]);
      setSelectedWarehouse('all');
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchDemandHistory(sku.sku, selectedWarehouse)
      .then((data) => {
        if (!cancelled) setDemandData(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, sku?.sku, selectedWarehouse]);

  const stats = useMemo(() => computeStats(demandData), [demandData]);

  // Download CSV for a specific month
  const handleMonthDownload = useCallback(async (yearMonth: string, fullMonth: string) => {
    if (!sku?.sku) return;
    setDownloadingMonth(yearMonth);
    try {
      const result = await fetchDemandTransactions(sku.sku, yearMonth);
      if (result.success && result.data.length > 0) {
        const csvRows = result.data.map((t: any) => ({
          Type: t.type,
          Date: t.date,
          'Order Number': t.orderNumber ?? '',
          Customer: t.customer,
          Quantity: t.quantity,
          'Amount (AUD)': t.amount,
          Status: t.status,
          Warehouse: t.warehouse,
          'Product Group': t.productGroup,
          'Customer Type': t.customerType,
        }));
        downloadAsCSV(csvRows, `Demand_${sku.sku}_${yearMonth}.csv`);
      } else {
        console.warn('No transactions found for', sku.sku, yearMonth);
      }
    } catch (e) {
      console.error('Failed to download demand transactions:', e);
    } finally {
      setDownloadingMonth(null);
    }
  }, [sku?.sku]);

  if (!sku) return null;

  const trendLabel = sku.demandTrend === 'up' ? 'Upward' : sku.demandTrend === 'down' ? 'Downward' : 'Stable';
  const trendColor = sku.demandTrend === 'up' ? 'text-emerald-600' : sku.demandTrend === 'down' ? 'text-red-500' : 'text-muted-foreground';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="px-6 pt-6 pb-4 border-b bg-muted/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <Activity size={18} className="text-blue-500" />
              Demand History
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 mt-1">
              <span className="font-mono text-foreground font-medium">{sku.sku}</span>
              <span className="text-muted-foreground">—</span>
              <span>{sku.product}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3 flex items-center gap-2">
            <Warehouse size={14} className="text-muted-foreground" />
            <select
              value={selectedWarehouse}
              onChange={(e) => setSelectedWarehouse(e.target.value)}
              className="text-xs bg-background border border-border rounded-md px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
            >
              {WAREHOUSE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* ── Help Banner ───────────────────────────────────────────── */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg px-4 py-2.5 border border-blue-200/40 dark:border-blue-800/40 flex items-start gap-2">
            <Activity size={13} className="text-blue-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-300 leading-relaxed">
              <strong>Total Demand</strong> = Sales (Completed) + Comp Usage + Placed + Backordered (+ Parked when enabled).
              Sales = completed orders; Placed/Backordered/Parked = units in open orders. Use the Demand mode selector in the main table to include Parked in KPI calculations.
              Click on a demand value to <strong>download the transactions CSV</strong>.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              Loading demand history...
            </div>
          ) : demandData.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No demand history found for this SKU.
            </div>
          ) : (
            <>
              {/* ── Stats Strip ───────────────────────────────────────────── */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <StatPill label="Monthly Avg" value={Math.round(stats.avg).toLocaleString()} />
                <StatPill label="12M Total" value={stats.total.toLocaleString()} />
                <StatPill label="Std Dev" value={Math.round(stats.stdDev).toLocaleString()} />
                <StatPill
                  label="CV %"
                  value={`${stats.cv.toFixed(1)}%`}
                  color={stats.cv > 30 ? 'text-amber-600' : 'text-foreground'}
                />
                <StatPill label="Peak" value={stats.max.toLocaleString()} />
                <StatPill label="Low" value={stats.min.toLocaleString()} />
                <div className="flex flex-col items-center bg-muted/40 rounded-lg px-3 py-2 border border-border/30 min-w-[80px]">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Trend</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <TrendIcon direction={sku.demandTrend} />
                    <span className={cn('text-sm font-bold', trendColor)}>{trendLabel}</span>
                  </div>
                </div>
              </div>

              {/* ── Main Chart ────────────────────────────────────────────── */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                  <BarChart3 size={13} />
                  Demand Volume & Trend
                </h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={demandData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gradDemand" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.6} />
                          <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.1} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                      <XAxis
                        dataKey="month"
                        tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={false}
                        tickLine={false}
                        width={45}
                      />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <ReferenceLine
                        y={stats.avg}
                        stroke="#f59e0b"
                        strokeDasharray="5 3"
                        strokeWidth={1.5}
                        label={{
                          value: `Avg: ${Math.round(stats.avg)}`,
                          position: 'right',
                          fill: '#f59e0b',
                          fontSize: 10,
                        }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                        iconSize={12}
                        payload={[
                          { value: 'Total Demand', type: 'square' as const, color: '#3b82f6' },
                          { value: '3M Moving Avg', type: 'line' as const, color: '#ef4444' },
                          { value: `Monthly Avg (${Math.round(stats.avg)})`, type: 'line' as const, color: '#f59e0b' },
                        ]}
                      />
                      <Bar
                        dataKey="totalDemand"
                        name="Total Demand"
                        fill="url(#gradDemand)"
                        radius={[4, 4, 0, 0]}
                        barSize={28}
                      />
                      <Line
                        type="monotone"
                        dataKey="movingAvg"
                        name="3M Moving Avg"
                        stroke="#ef4444"
                        strokeWidth={2}
                        dot={false}
                        strokeDasharray="4 2"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* ── Revenue Chart ─────────────────────────────────────────── */}
              {demandData.some((d) => d.revenue > 0) && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                    <Calendar size={13} />
                    Revenue Generated
                  </h3>
                  <div className="h-40 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={demandData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                            <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                        <XAxis
                          dataKey="month"
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                          axisLine={false}
                          tickLine={false}
                          width={50}
                          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Area
                          type="monotone"
                          dataKey="revenue"
                          name="Revenue"
                          stroke="#10b981"
                          fill="url(#gradRevenue)"
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* ── Monthly Breakdown Table ────────────────────────────────── */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Monthly Breakdown
                  <span className="text-[9px] ml-2 font-normal normal-case text-blue-500/70">
                    Click demand value to download CSV
                  </span>
                </h3>
                <div className="border rounded-lg overflow-hidden">
                  <div className="grid grid-cols-7 text-[10px] uppercase tracking-wider font-medium text-muted-foreground bg-muted/50 px-3 py-2">
                    <span>Month</span>
                    <span className="text-right">Sales</span>
                    <span className="text-right">Placed</span>
                    <span className="text-right">Parked</span>
                    <span className="text-right">Comp. Usage</span>
                    <span className="text-right">Revenue</span>
                    <span className="text-right">vs Avg</span>
                  </div>
                  {demandData.map((d, i) => {
                    const vsAvg = stats.avg > 0 ? ((d.totalDemand - stats.avg) / stats.avg) * 100 : 0;
                    const isDownloading = downloadingMonth === d.yearMonth;
                    return (
                      <div
                        key={i}
                        className="grid grid-cols-7 text-xs px-3 py-1.5 border-t border-border/30 hover:bg-muted/20 transition-colors"
                      >
                        <span className="text-muted-foreground">{d.fullMonth}</span>
                        <button
                          onClick={() => handleMonthDownload(d.yearMonth, d.fullMonth)}
                          disabled={isDownloading}
                          className="text-right tabular-nums font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline cursor-pointer transition-colors flex items-center justify-end gap-1 disabled:opacity-50 disabled:cursor-wait"
                          title={`Download transactions for ${d.fullMonth}`}
                        >
                          {isDownloading ? (
                            <Loader2 size={10} className="animate-spin" />
                          ) : (
                            <Download size={9} className="opacity-40" />
                          )}
                          {d.quantity.toLocaleString()}
                        </button>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {d.quantityPlaced > 0 ? d.quantityPlaced.toLocaleString() : '—'}
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {d.quantityParked > 0 ? d.quantityParked.toLocaleString() : '—'}
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {d.componentUsage > 0 ? d.componentUsage.toLocaleString() : '—'}
                        </span>
                        <span className="text-right tabular-nums text-muted-foreground">
                          {d.revenue > 0 ? `$${d.revenue.toLocaleString()}` : '—'}
                        </span>
                        <span
                          className={cn(
                            'text-right tabular-nums font-medium',
                            vsAvg > 0 ? 'text-emerald-600' : vsAvg < -10 ? 'text-red-500' : 'text-muted-foreground'
                          )}
                        >
                          {vsAvg > 0 ? '+' : ''}
                          {vsAvg.toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
