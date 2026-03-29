import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, parse, isValid, differenceInDays, addDays, startOfDay } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
  ComposedChart,
  Line,
} from 'recharts';
import {
  Calendar as CalendarIcon,
  Maximize2,
  Minimize2,
  Search,
  X,
  Loader2,
  Package,
  BarChart2,
  Container,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SKURow } from '@/lib/aim2026/types';
import {
  fetchConsolidationData,
  fetchPOByNumber,
  type ConsolidationLine,
  type FetchedPO,
} from '@/lib/aim2026/api';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHART_COLORS = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#10b981',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1',
  '#14b8a6', '#a855f7', '#e11d48', '#0ea5e9', '#eab308',
  '#22c55e',
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConsolidationReportProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filteredData: SKURow[];
}

interface PivotRow {
  productCode: string;
  productDescription: string;
  dates: Record<string, number>;
  total: number;
}

type ViewMode = 'table' | 'stacked-bar' | 'cumulative' | 'timeline';

interface PlannerRow {
  productCode: string;
  productDescription: string;
  required: number;
  sohNow: number;
  arrivingBefore: number;
  demand: number;
  available: number;
  status: 'green' | 'yellow' | 'red';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseDateStr(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isValid(d) ? d : null;
}

function fmtDate(s: string): string {
  const d = parseDateStr(s);
  if (!d) return s || '—';
  return format(d, 'dd/MM/yyyy');
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-AU');
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ConsolidationReport({
  open,
  onOpenChange,
  filteredData,
}: ConsolidationReportProps) {
  const [maximized, setMaximized] = useState(true);
  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<ConsolidationLine[]>([]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<string>('productCode');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [showDemand, setShowDemand] = useState(false);

  // Container Loading Planner
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [plannerDate, setPlannerDate] = useState<Date>(addDays(startOfDay(new Date()), 30));
  const [plannerDatePickerOpen, setPlannerDatePickerOpen] = useState(false);
  const [plannerPOInput, setPlannerPOInput] = useState('');
  const [plannerFetching, setPlannerFetching] = useState(false);
  const [plannerPO, setPlannerPO] = useState<FetchedPO | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [plannerDemandOn, setPlannerDemandOn] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // ── Fetch data ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchConsolidationData()
      .then((data) => {
        if (!cancelled) setLines(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open]);

  // ── Demand map from filteredData ───────────────────────────────────────────

  const demandMap = useMemo(() => {
    const m = new Map<string, { allocated: number; sohChina: number }>();
    for (const r of filteredData) {
      m.set(r.sku, {
        allocated: r.allocatedTotal,
        sohChina: r.sohChina,
      });
    }
    return m;
  }, [filteredData]);

  // ── Pivot data ─────────────────────────────────────────────────────────────

  const { pivotRows, allDates, grandTotals } = useMemo(() => {
    const dateSet = new Set<string>();
    const skuMap = new Map<string, PivotRow>();

    for (const l of lines) {
      const dateKey = l.lineDeliveryDate || 'No Date';
      dateSet.add(dateKey);
      let row = skuMap.get(l.productCode);
      if (!row) {
        row = {
          productCode: l.productCode,
          productDescription: l.productDescription,
          dates: {},
          total: 0,
        };
        skuMap.set(l.productCode, row);
      }
      row.dates[dateKey] = (row.dates[dateKey] || 0) + l.orderQuantity;
      row.total += l.orderQuantity;
    }

    const allDates = [...dateSet].sort((a, b) => {
      const da = parseDateStr(a);
      const db = parseDateStr(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.getTime() - db.getTime();
    });

    const grandTotals: Record<string, number> = {};
    for (const d of allDates) {
      grandTotals[d] = 0;
    }
    let grandTotal = 0;
    for (const row of skuMap.values()) {
      for (const d of allDates) {
        grandTotals[d] += row.dates[d] || 0;
      }
      grandTotal += row.total;
    }
    grandTotals['_total'] = grandTotal;

    let rows = [...skuMap.values()];
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.productCode.toLowerCase().includes(q) ||
          r.productDescription.toLowerCase().includes(q)
      );
    }

    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'productCode') cmp = a.productCode.localeCompare(b.productCode);
      else if (sortKey === 'total') cmp = a.total - b.total;
      else cmp = (a.dates[sortKey] || 0) - (b.dates[sortKey] || 0);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return { pivotRows: rows, allDates, grandTotals };
  }, [lines, search, sortKey, sortDir]);

  // ── Chart data ─────────────────────────────────────────────────────────────

  const { stackedData, topSKUs } = useMemo(() => {
    const skuTotals = new Map<string, number>();
    for (const row of pivotRows) {
      skuTotals.set(row.productCode, row.total);
    }
    const sorted = [...skuTotals.entries()].sort((a, b) => b[1] - a[1]);
    const topSKUs = sorted.slice(0, 16).map(([sku]) => sku);
    const topSet = new Set(topSKUs);

    const stackedData = allDates.map((d) => {
      const point: Record<string, any> = { date: fmtDate(d) };
      let otherTotal = 0;
      for (const row of pivotRows) {
        const qty = row.dates[d] || 0;
        if (topSet.has(row.productCode)) {
          point[row.productCode] = qty;
        } else {
          otherTotal += qty;
        }
      }
      if (otherTotal > 0) point['Other'] = otherTotal;
      return point;
    });

    return { stackedData, topSKUs };
  }, [pivotRows, allDates]);

  const cumulativeData = useMemo(() => {
    let cumulative = 0;
    return allDates.map((d) => {
      const total = grandTotals[d] || 0;
      cumulative += total;
      return { date: fmtDate(d), total, cumulative };
    });
  }, [allDates, grandTotals]);

  const timelineData = useMemo(() => {
    return pivotRows.slice(0, 30).map((row) => {
      const entry: Record<string, any> = { sku: row.productCode };
      for (const d of allDates) {
        entry[fmtDate(d)] = row.dates[d] || 0;
      }
      return entry;
    });
  }, [pivotRows, allDates]);

  // ── Sort handler ───────────────────────────────────────────────────────────

  const handleSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('asc');
      return key;
    });
  }, []);

  // ── Container Loading Planner logic ────────────────────────────────────────

  const handleFetchPO = useCallback(async () => {
    if (!plannerPOInput.trim()) return;
    setPlannerFetching(true);
    setPlannerError(null);
    setPlannerPO(null);
    try {
      const result = await fetchPOByNumber(plannerPOInput.trim());
      setPlannerPO(result);
    } catch (e) {
      setPlannerError(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setPlannerFetching(false);
    }
  }, [plannerPOInput]);

  const plannerRows: PlannerRow[] = useMemo(() => {
    if (!plannerPO) return [];
    const plannerDateMs = plannerDate.getTime();

    return plannerPO.lines.map((poLine) => {
      const required = poLine.orderQuantity;
      const skuData = demandMap.get(poLine.productCode);
      const sohNow = skuData?.sohChina ?? 0;

      let arrivingBefore = 0;
      for (const l of lines) {
        if (l.productCode !== poLine.productCode) continue;
        const ld = parseDateStr(l.lineDeliveryDate);
        if (ld && ld.getTime() <= plannerDateMs) {
          arrivingBefore += l.orderQuantity;
        }
      }

      const demand = plannerDemandOn ? (skuData?.allocated ?? 0) : 0;
      const available = sohNow + arrivingBefore - demand;

      let status: PlannerRow['status'] = 'green';
      if (available <= 0) status = 'red';
      else if (available < required) status = 'yellow';

      return {
        productCode: poLine.productCode,
        productDescription: poLine.productDescription,
        required,
        sohNow,
        arrivingBefore,
        demand,
        available,
        status,
      };
    });
  }, [plannerPO, plannerDate, plannerDemandOn, demandMap, lines]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'overflow-y-auto',
          maximized
            ? 'max-w-[100vw] w-[100vw] max-h-[100vh] h-[100vh] rounded-none'
            : 'max-w-[95vw] max-h-[90vh]'
        )}
      >
        <DialogHeader className="flex-row items-center justify-between gap-4 pr-12">
          <div>
            <DialogTitle className="text-base flex items-center gap-2">
              <Package size={16} className="text-primary" />
              Consolidation Report — Production POs
            </DialogTitle>
            <DialogDescription className="text-xs mt-0.5">
              Pivot of active Production orders (China warehouse) by SKU and line ETA.
              {lines.length > 0 && (
                <span className="ml-2 font-medium text-foreground">
                  {pivotRows.length} SKUs &middot; {allDates.length} dates &middot; {fmtNum(grandTotals['_total'] || 0)} total units
                </span>
              )}
            </DialogDescription>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={() => setMaximized((m) => !m)}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20 gap-2 text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
            Loading Production POs from Unleashed…
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            {/* ── Toolbar ──────────────────────────────────────────────── */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search SKU or description…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full h-8 pl-8 pr-8 text-xs rounded-md border border-border bg-transparent focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                {search && (
                  <button
                    onClick={() => { setSearch(''); searchRef.current?.focus(); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <Checkbox
                  id="demand-toggle"
                  checked={showDemand}
                  onCheckedChange={(v) => setShowDemand(!!v)}
                />
                <Label htmlFor="demand-toggle" className="text-xs cursor-pointer">
                  Show Demand
                </Label>
              </div>

              <div className="flex items-center gap-1 ml-auto">
                {(['table', 'stacked-bar', 'cumulative', 'timeline'] as ViewMode[]).map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={viewMode === v ? 'default' : 'outline'}
                    className="h-7 text-[10px] px-2"
                    onClick={() => setViewMode(v)}
                  >
                    {v === 'table' ? 'Table' : v === 'stacked-bar' ? 'Stacked Bar' : v === 'cumulative' ? 'Cumulative' : 'Timeline'}
                  </Button>
                ))}
              </div>
            </div>

            {/* ── Main content ─────────────────────────────────────────── */}
            {viewMode === 'table' && (
              <div className="overflow-auto rounded-lg border max-h-[calc(100vh-280px)]">
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-muted/60 sticky top-0 z-10">
                    <tr>
                      <th
                        className="sticky left-0 z-20 bg-muted/90 text-left px-3 py-2 font-medium text-muted-foreground cursor-pointer hover:text-foreground min-w-[120px]"
                        onClick={() => handleSort('productCode')}
                      >
                        SKU {sortKey === 'productCode' && (sortDir === 'asc' ? '↑' : '↓')}
                      </th>
                      <th
                        className="sticky left-[120px] z-20 bg-muted/90 text-left px-3 py-2 font-medium text-muted-foreground min-w-[180px]"
                      >
                        Description
                      </th>
                      {showDemand && (
                        <th className="text-right px-3 py-2 font-medium text-amber-600 min-w-[70px]">
                          Demand
                        </th>
                      )}
                      {allDates.map((d) => (
                        <th
                          key={d}
                          className="text-right px-3 py-2 font-medium text-muted-foreground cursor-pointer hover:text-foreground whitespace-nowrap min-w-[80px]"
                          onClick={() => handleSort(d)}
                        >
                          {fmtDate(d)}
                          {sortKey === d && (sortDir === 'asc' ? ' ↑' : ' ↓')}
                        </th>
                      ))}
                      <th
                        className="text-right px-3 py-2 font-semibold text-foreground cursor-pointer hover:text-primary min-w-[80px]"
                        onClick={() => handleSort('total')}
                      >
                        Total {sortKey === 'total' && (sortDir === 'asc' ? '↑' : '↓')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pivotRows.map((row) => (
                      <tr
                        key={row.productCode}
                        className="border-t border-border/30 hover:bg-muted/20 transition-colors"
                      >
                        <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-mono font-semibold text-primary whitespace-nowrap">
                          {row.productCode}
                        </td>
                        <td className="sticky left-[120px] z-10 bg-card px-3 py-1.5 truncate max-w-[200px] text-muted-foreground" title={row.productDescription}>
                          {row.productDescription}
                        </td>
                        {showDemand && (
                          <td className="text-right px-3 py-1.5 tabular-nums text-amber-600 font-medium">
                            {fmtNum(demandMap.get(row.productCode)?.allocated ?? 0)}
                          </td>
                        )}
                        {allDates.map((d) => {
                          const val = row.dates[d] || 0;
                          return (
                            <td
                              key={d}
                              className={cn(
                                'text-right px-3 py-1.5 tabular-nums',
                                val > 0 ? 'font-semibold text-foreground' : 'text-muted-foreground/40'
                              )}
                            >
                              {val > 0 ? fmtNum(val) : ''}
                            </td>
                          );
                        })}
                        <td className="text-right px-3 py-1.5 tabular-nums font-bold">
                          {fmtNum(row.total)}
                        </td>
                      </tr>
                    ))}
                    {/* Totals row */}
                    <tr className="border-t-2 border-border bg-muted/40 font-semibold sticky bottom-0">
                      <td className="sticky left-0 z-10 bg-muted/80 px-3 py-2">Total</td>
                      <td className="sticky left-[120px] z-10 bg-muted/80 px-3 py-2" />
                      {showDemand && <td className="text-right px-3 py-2 tabular-nums text-amber-600">{fmtNum([...demandMap.values()].reduce((s, v) => s + v.allocated, 0))}</td>}
                      {allDates.map((d) => (
                        <td key={d} className="text-right px-3 py-2 tabular-nums">
                          {fmtNum(grandTotals[d] || 0)}
                        </td>
                      ))}
                      <td className="text-right px-3 py-2 tabular-nums font-bold text-primary">
                        {fmtNum(grandTotals['_total'] || 0)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {viewMode === 'stacked-bar' && (
              <div className="h-[500px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stackedData} margin={{ top: 10, right: 20, left: 10, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={70} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                    <RechartsTooltip
                      contentStyle={{ fontSize: 11 }}
                      formatter={(value: number, name: string) => [fmtNum(value), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {[...topSKUs, ...(pivotRows.length > topSKUs.length ? ['Other'] : [])].map((sku, i) => (
                      <Bar
                        key={sku}
                        dataKey={sku}
                        stackId="a"
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {viewMode === 'cumulative' && (
              <div className="h-[500px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={cumulativeData} margin={{ top: 10, right: 20, left: 10, bottom: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-45} textAnchor="end" height={70} />
                    <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                    <RechartsTooltip
                      contentStyle={{ fontSize: 11 }}
                      formatter={(value: number, name: string) => [fmtNum(value), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar yAxisId="left" dataKey="total" fill="#3b82f6" name="Units per date" />
                    <Line yAxisId="right" type="monotone" dataKey="cumulative" stroke="#ef4444" strokeWidth={2} dot={false} name="Cumulative" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {viewMode === 'timeline' && (
              <div className="h-[600px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={timelineData}
                    layout="vertical"
                    margin={{ top: 10, right: 20, left: 100, bottom: 10 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                    <YAxis dataKey="sku" type="category" tick={{ fontSize: 9 }} width={95} />
                    <RechartsTooltip
                      contentStyle={{ fontSize: 11 }}
                      formatter={(value: number, name: string) => [fmtNum(value), name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {allDates.map((d, i) => (
                      <Bar
                        key={d}
                        dataKey={fmtDate(d)}
                        stackId="a"
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* ── Container Loading Planner ────────────────────────────── */}
            <div className="rounded-lg border bg-card">
              <button
                onClick={() => setPlannerOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm font-semibold hover:bg-muted/30 transition-colors"
              >
                <Container size={15} className="text-cyan-600" />
                Container Loading Planner
                {plannerOpen ? <ChevronUp size={14} className="ml-auto text-muted-foreground" /> : <ChevronDown size={14} className="ml-auto text-muted-foreground" />}
              </button>

              {plannerOpen && (
                <div className="px-4 pb-4 space-y-4 border-t">
                  <div className="flex items-end gap-4 flex-wrap pt-3">
                    {/* Date picker */}
                    <div className="space-y-1">
                      <Label className="text-xs">Container Load Date</Label>
                      <Popover open={plannerDatePickerOpen} onOpenChange={setPlannerDatePickerOpen}>
                        <PopoverTrigger asChild>
                          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs min-w-[140px]">
                            <CalendarIcon size={13} />
                            {format(plannerDate, 'dd/MM/yyyy')}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={plannerDate}
                            onSelect={(d) => { if (d) { setPlannerDate(d); setPlannerDatePickerOpen(false); } }}
                            weekStartsOn={1}
                          />
                        </PopoverContent>
                      </Popover>
                    </div>

                    {/* PO number input */}
                    <div className="space-y-1 flex-1 min-w-[200px] max-w-sm">
                      <Label className="text-xs">Reference PO (Parked)</Label>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          placeholder="e.g. PO-00001350"
                          value={plannerPOInput}
                          onChange={(e) => setPlannerPOInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleFetchPO(); }}
                          className="flex-1 h-8 text-xs rounded-md border border-border bg-transparent px-2.5 focus:outline-none focus:ring-1 focus:ring-primary/40"
                        />
                        <Button
                          size="sm"
                          className="h-8 text-xs gap-1"
                          onClick={handleFetchPO}
                          disabled={plannerFetching || !plannerPOInput.trim()}
                        >
                          {plannerFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          Fetch
                        </Button>
                      </div>
                    </div>

                    {/* Demand toggle */}
                    <div className="flex items-center gap-1.5 pb-1">
                      <Checkbox
                        id="planner-demand"
                        checked={plannerDemandOn}
                        onCheckedChange={(v) => setPlannerDemandOn(!!v)}
                      />
                      <Label htmlFor="planner-demand" className="text-xs cursor-pointer">
                        Subtract Demand
                      </Label>
                    </div>
                  </div>

                  {plannerError && (
                    <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 rounded px-3 py-2">
                      {plannerError}
                    </div>
                  )}

                  {plannerPO && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>PO: <strong className="text-foreground">{plannerPO.orderNumber}</strong></span>
                        <span>Status: <strong className="text-foreground">{plannerPO.orderStatus}</strong></span>
                        <span>Warehouse: <strong className="text-foreground">{plannerPO.warehouse}</strong></span>
                        <span>{plannerPO.lines.length} line{plannerPO.lines.length !== 1 ? 's' : ''}</span>
                      </div>

                      <div className="overflow-auto rounded-lg border max-h-[300px]">
                        <table className="w-full text-xs">
                          <thead className="bg-muted/50 sticky top-0">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium text-muted-foreground">SKU</th>
                              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Description</th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Required</th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">SOH Now</th>
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Arriving Before</th>
                              {plannerDemandOn && (
                                <th className="text-right px-3 py-2 font-medium text-amber-600">Demand</th>
                              )}
                              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Available</th>
                              <th className="text-center px-3 py-2 font-medium text-muted-foreground">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {plannerRows.map((r) => (
                              <tr key={r.productCode} className="border-t border-border/30">
                                <td className="px-3 py-1.5 font-mono font-semibold text-primary">{r.productCode}</td>
                                <td className="px-3 py-1.5 truncate max-w-[180px] text-muted-foreground" title={r.productDescription}>{r.productDescription}</td>
                                <td className="text-right px-3 py-1.5 tabular-nums font-semibold">{fmtNum(r.required)}</td>
                                <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(r.sohNow)}</td>
                                <td className="text-right px-3 py-1.5 tabular-nums">{fmtNum(r.arrivingBefore)}</td>
                                {plannerDemandOn && (
                                  <td className="text-right px-3 py-1.5 tabular-nums text-amber-600">{fmtNum(r.demand)}</td>
                                )}
                                <td className={cn(
                                  'text-right px-3 py-1.5 tabular-nums font-semibold',
                                  r.status === 'green' ? 'text-emerald-600' :
                                  r.status === 'yellow' ? 'text-amber-600' :
                                  'text-red-600'
                                )}>
                                  {fmtNum(r.available)}
                                </td>
                                <td className="text-center px-3 py-1.5">
                                  <span className={cn(
                                    'inline-block w-3 h-3 rounded-full',
                                    r.status === 'green' ? 'bg-emerald-500' :
                                    r.status === 'yellow' ? 'bg-amber-500' :
                                    'bg-red-500'
                                  )} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1">
                        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> Available ≥ Required</span>
                        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-500" /> Partial (0 &lt; Available &lt; Required)</span>
                        <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" /> Unavailable (Available ≤ 0)</span>
                      </div>
                    </div>
                  )}

                  {!plannerPO && !plannerError && !plannerFetching && (
                    <p className="text-xs text-muted-foreground py-2">
                      Enter a Parked PO number and click Fetch to load the container requirements.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
