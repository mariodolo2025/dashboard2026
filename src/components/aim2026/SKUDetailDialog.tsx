import { useState, useEffect } from 'react';
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
  Legend,
} from 'recharts';
import {
  Package,
  DollarSign,
  TrendingUp,
  TrendingDown,
  BarChart3,
  ShieldAlert,
  Clock,
  Timer,
  Truck,
  ArrowRight,
  Info,
  Loader2,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';
import { ABCBadge } from './ABCBadge';
import type { SKURow } from '@/lib/aim2026/types';
import { fetchRecentOrders, type RecentOrder } from '@/lib/aim2026/api';
import type { BOMComponent } from '@/lib/aim2026/api';

// ─── Types ─────────────────────────────────────────────────────────────────

interface SKUDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sku: SKURow | null;
  bomComponents?: BOMComponent[];
  assembledProductSKUs?: Set<string>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmt(v: number, decimals = 0): string {
  return v.toLocaleString('en-AU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtCurrency(v: number): string {
  return `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── SOH History fetcher ────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

interface SOHHistoryPoint {
  month: string;
  mainWH: number;
  china: number;
}

async function fetchSOHHistory(sku: string): Promise<SOHHistoryPoint[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/aim2026-get-dashboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON}`,
        apikey: SUPABASE_ANON,
      },
      body: JSON.stringify({ action: 'soh_history', sku }),
    });
    const json = await res.json();
    if (!json.success || !json.data) return [];

    // Group by month: aggregate warehouse data
    const monthMap = new Map<string, { mainWH: number; china: number }>();
    for (const row of json.data) {
      const d = new Date(row.snapshot_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const wh = String(row.warehouse || '').toLowerCase();
      const qty = Number(row.quantity ?? 0);

      const existing = monthMap.get(key) ?? { mainWH: 0, china: 0 };
      if (wh.includes('main')) {
        existing.mainWH = Math.max(existing.mainWH, qty); // Use max within month (latest snapshot)
      } else if (wh.includes('china')) {
        existing.china = Math.max(existing.china, qty);
      }
      monthMap.set(key, existing);
    }

    // Sort and take last 12 months
    const entries = [...monthMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12);

    return entries.map(([key, val]) => {
      const [y, m] = key.split('-').map(Number);
      const d = new Date(y, m - 1, 1);
      return {
        month: d.toLocaleString('en', { month: 'short', year: '2-digit' }),
        mainWH: val.mainWH,
        china: val.china,
      };
    });
  } catch (e) {
    console.error('Failed to fetch SOH history:', e);
    return [];
  }
}

function formatOrderDate(dateStr: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

// ─── Stat Card ─────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  color = 'text-foreground',
  sub,
}: {
  label: string;
  value: string;
  icon: any;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="bg-muted/40 rounded-lg px-3 py-2.5 border border-border/30">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1">
        <Icon size={12} />
        {label}
      </div>
      <div className={cn('text-lg font-bold tabular-nums', color)}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Order Status Badge ─────────────────────────────────────────────────────

function OrderStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  let colorClass = 'text-muted-foreground';
  if (s.includes('complet') || s.includes('received')) colorClass = 'text-emerald-600';
  else if (s.includes('ship') || s.includes('transit')) colorClass = 'text-blue-600';
  else if (s.includes('container')) colorClass = 'text-cyan-600';
  else if (s.includes('placed') || s.includes('backorder')) colorClass = 'text-amber-600';
  else if (s.includes('dhl')) colorClass = 'text-orange-600';
  else if (s.includes('production')) colorClass = 'text-purple-600';
  else if (s.includes('parked')) colorClass = 'text-slate-400';

  return (
    <span className={cn('text-[10px] font-medium whitespace-nowrap', colorClass)}>
      {status}
    </span>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

export function SKUDetailDialog({
  open,
  onOpenChange,
  sku,
  bomComponents = [],
  assembledProductSKUs = new Set(),
}: SKUDetailDialogProps) {
  // Fetch real SOH history
  const [sohHistory, setSohHistory] = useState<SOHHistoryPoint[]>([]);
  const [sohLoading, setSohLoading] = useState(false);

  useEffect(() => {
    if (!open || !sku?.sku) {
      setSohHistory([]);
      return;
    }
    let cancelled = false;
    setSohLoading(true);
    fetchSOHHistory(sku.sku)
      .then((data) => {
        if (!cancelled) setSohHistory(data);
      })
      .finally(() => {
        if (!cancelled) setSohLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, sku?.sku]);

  // Fetch real recent orders from CSV data
  const [orders, setOrders] = useState<RecentOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  useEffect(() => {
    if (!open || !sku?.sku) {
      setOrders([]);
      return;
    }
    let cancelled = false;
    setOrdersLoading(true);
    fetchRecentOrders(sku.sku)
      .then((data) => {
        if (!cancelled) setOrders(data);
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, sku?.sku]);

  if (!sku) return null;

  const profitPerUnit = sku.avgSellingPrice - sku.landedCostAUD;
  const profitPercent = sku.avgSellingPrice > 0 ? (profitPerUnit / sku.avgSellingPrice) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="px-6 pt-6 pb-4 border-b bg-muted/20">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4 pr-8">
              <div>
                <DialogTitle className="flex items-center gap-2 text-xl">
                  <Package size={20} className="text-blue-500" />
                  {sku.sku}
                </DialogTitle>
                <DialogDescription className="text-sm mt-1">
                  {sku.product}
                </DialogDescription>
                <div className="flex items-center gap-2 mt-2">
                  <ABCBadge abcClass={sku.abcClass} />
                  <StatusBadge status={sku.status} />
                  <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-md">
                    {sku.productGroup}
                  </span>
                  <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-md">
                    {sku.supplier}
                  </span>
                </div>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* ── BOM Components (assembled products only) ───────────────── */}
          {assembledProductSKUs.has(sku.sku) && bomComponents.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                <Layers size={13} />
                BOM Components
              </h3>
              <div className="rounded-lg border bg-muted/20 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b">
                      <th className="text-left px-3 py-2 font-medium">Component SKU</th>
                      <th className="text-right px-3 py-2 font-medium">Qty per assembly</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bomComponents
                      .filter((c) => c.assembly_sku === sku.sku)
                      .map((c) => (
                        <tr key={c.component_sku} className="border-b last:border-0">
                          <td className="px-3 py-2 font-mono">{c.component_sku}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {c.quantity_per_assembly}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Help Banner ──────────────────────────────────────────── */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg px-4 py-2.5 border border-blue-200/40 dark:border-blue-800/40 flex items-start gap-2">
            <Info size={13} className="text-blue-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-blue-700 dark:text-blue-300 leading-relaxed">
              <strong>Cost China</strong> = FOB factory price (AUD). 
              <strong>Landed AUD</strong> = Cost China × (1 + freight + duty + insurance).
              <strong>GMROI</strong> (Gross Margin Return on Investment) measures profit per dollar invested — target &gt; 3.0.
              <strong>ROP</strong> (Reorder Point) = trigger level to place an order. <strong>Sug. Qty</strong> = order up to Target Stock Level minus pipeline.
            </p>
          </div>

          {/* ── Cost & Profit ────────────────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <DollarSign size={13} />
              Cost & Profit
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                label="Cost China"
                value={fmtCurrency(sku.productCostChina)}
                icon={Package}
                sub="FOB Factory"
              />
              <StatCard
                label="Landed AUD"
                value={fmtCurrency(sku.landedCostAUD)}
                icon={Truck}
                sub="Incl. freight, duty, ins."
              />
              <StatCard
                label="Avg Sell Price"
                value={fmtCurrency(sku.avgSellingPrice)}
                icon={DollarSign}
                sub="Last 90 days avg"
              />
              <StatCard
                label="Profit / Unit"
                value={fmtCurrency(profitPerUnit)}
                icon={profitPercent >= 30 ? TrendingUp : TrendingDown}
                color={profitPercent >= 30 ? 'text-emerald-600' : profitPercent >= 15 ? 'text-amber-600' : 'text-red-500'}
                sub={`${profitPercent.toFixed(1)}% margin`}
              />
            </div>
          </div>

          {/* ── Key Metrics ──────────────────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <BarChart3 size={13} />
              Key Metrics
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <StatCard
                label="Lead Time"
                value={`${sku.leadTimeDays}d`}
                icon={Timer}
                color={
                  sku.leadTimeDays > 60
                    ? 'text-red-500'
                    : sku.leadTimeDays > 30
                    ? 'text-amber-600'
                    : 'text-emerald-600'
                }
                sub="Supplier lead time"
              />
              <StatCard
                label="Reorder Point"
                value={fmt(sku.reorderPoint)}
                icon={ShieldAlert}
                sub={`Safety Stock: ${fmt(sku.safetyStock)}`}
              />
              {/* A metric that could not be measured shows "—" and says why.
                  It must never be painted red with a verdict like "Below target",
                  which is what a missing landed cost used to produce. */}
              <StatCard
                label="Days of Cover"
                value={sku.daysOfCover === null ? '—' : `${Math.round(sku.daysOfCover)}d`}
                icon={Clock}
                color={
                  sku.daysOfCover === null
                    ? 'text-muted-foreground'
                    : sku.daysOfCover < 30
                    ? 'text-red-500'
                    : sku.daysOfCover < 60
                    ? 'text-amber-600'
                    : 'text-emerald-600'
                }
                sub={
                  sku.daysOfCover === null
                    ? 'No demand in range'
                    : sku.daysOfCover < sku.leadTimeDays
                    ? 'Below lead time!'
                    : 'Above lead time'
                }
              />
              <StatCard
                label="Turnover"
                value={sku.turnover === null ? '—' : sku.turnover.toFixed(1)}
                icon={TrendingUp}
                color={sku.turnover === null ? 'text-muted-foreground' : undefined}
                sub={sku.turnover === null ? 'No landed cost' : 'Times/year (annualised)'}
              />
              <StatCard
                label="GMROI"
                value={sku.gmroi === null ? '—' : sku.gmroi > 100 ? '>100' : sku.gmroi.toFixed(1)}
                icon={DollarSign}
                color={
                  sku.gmroi === null
                    ? 'text-muted-foreground'
                    : sku.gmroi >= 3
                    ? 'text-emerald-600'
                    : sku.gmroi >= 1
                    ? 'text-foreground'
                    : 'text-red-500'
                }
                sub={
                  sku.gmroi === null
                    ? 'No landed cost or price'
                    : sku.gmroi > 100
                    ? 'Very low stock vs demand'
                    : sku.gmroi >= 3
                    ? 'Healthy'
                    : sku.gmroi >= 1
                    ? 'Acceptable'
                    : 'Below target'
                }
              />
            </div>
          </div>

          {/* ── Stock Overview ────────────────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Package size={13} />
              Stock Positions
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              {[
                { label: 'Main WH', value: sku.sohMainWH, color: 'bg-blue-500' },
                { label: 'China', value: sku.sohChina, color: 'bg-violet-500' },
                { label: 'Container', value: sku.container, color: 'bg-cyan-500' },
                { label: 'DHL', value: sku.dhl, color: 'bg-orange-500' },
                { label: 'On Prod.', value: sku.onProduction, color: 'bg-purple-500' },
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                  {i > 0 && <ArrowRight size={12} className="text-muted-foreground/30" />}
                  <div className="flex items-center gap-1.5 bg-muted/40 rounded-md px-2.5 py-1.5 border border-border/30">
                    <div className={cn('w-2 h-2 rounded-full', item.color)} />
                    <span className="text-[10px] text-muted-foreground">{item.label}</span>
                    <span className="text-sm font-semibold tabular-nums">{fmt(item.value)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── SOH History Chart ─────────────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              SOH History
              {sohHistory.length > 0 && <span className="text-[10px] font-normal ml-1">({sohHistory.length} months)</span>}
            </h3>
            {sohLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                Loading SOH history...
              </div>
            ) : sohHistory.length === 0 ? (
              <div className="text-xs text-muted-foreground py-8 text-center border rounded-lg bg-muted/20">
                No SOH history available for this SKU.
              </div>
            ) : (
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sohHistory} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradMainWH" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradChina" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
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
                    width={40}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                    labelStyle={{ fontWeight: 600 }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: '11px' }}
                    iconType="circle"
                    iconSize={8}
                  />
                  <Area
                    type="monotone"
                    dataKey="mainWH"
                    name="Main WH"
                    stroke="#3b82f6"
                    fill="url(#gradMainWH)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="china"
                    name="China"
                    stroke="#8b5cf6"
                    fill="url(#gradChina)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            )}
          </div>

          {/* ── Recent Orders ─────────────────────────────────────────── */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Recent Activity
            </h3>
            {ordersLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
                <Loader2 size={14} className="animate-spin" />
                Loading orders...
              </div>
            ) : orders.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4 text-center border rounded-lg bg-muted/20">
                No recent orders found for this SKU.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Sales Orders */}
                {orders.filter((o) => o.orderType === 'sales').length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
                      <TrendingUp size={10} />
                      Sales Orders ({orders.filter((o) => o.orderType === 'sales').length})
                    </div>
                    <div className="border rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Date</th>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Customer</th>
                            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Qty</th>
                            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Amount</th>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orders
                            .filter((o) => o.orderType === 'sales')
                            .map((o, i) => (
                              <tr key={i} className="border-t border-border/40 hover:bg-muted/20 transition-colors">
                                <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{formatOrderDate(o.date)}</td>
                                <td className="px-3 py-1.5 truncate max-w-[160px]" title={o.customer}>{o.customer || '—'}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fmt(o.quantity)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{o.amount > 0 ? fmtCurrency(o.amount) : '—'}</td>
                                <td className="px-3 py-1.5">
                                  <OrderStatusBadge status={o.status} />
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Purchase Orders */}
                {orders.filter((o) => o.orderType === 'purchase').length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400 mb-1.5 flex items-center gap-1">
                      <Truck size={10} />
                      Purchase Orders ({orders.filter((o) => o.orderType === 'purchase').length})
                    </div>
                    <div className="border rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">PO #</th>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Supplier</th>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Ordered</th>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">ETA</th>
                            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Qty</th>
                            <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {orders
                            .filter((o) => o.orderType === 'purchase')
                            .map((o, i) => (
                              <tr key={i} className="border-t border-border/40 hover:bg-muted/20 transition-colors">
                                <td className="px-3 py-1.5 font-mono text-blue-600 dark:text-blue-400">{o.orderNumber || '—'}</td>
                                <td className="px-3 py-1.5 truncate max-w-[140px]" title={o.supplier}>{o.supplier || '—'}</td>
                                <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{formatOrderDate(o.date)}</td>
                                <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{o.deliveryDate ? formatOrderDate(o.deliveryDate) : '—'}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fmt(o.quantity)}</td>
                                <td className="px-3 py-1.5">
                                  <OrderStatusBadge status={o.status} />
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
