import { useState, useMemo, useCallback, useEffect } from 'react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { RefreshCw, Settings, Clock, Zap, AlertTriangle, Database, ShoppingCart, X, Warehouse, Calendar as CalendarIcon, Download, BarChart2, ChevronDown, Truck, Container } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { KPISummaryCards } from './aim2026/KPISummaryCards';
import { FilterBar } from './aim2026/FilterBar';
import { InventoryTable } from './aim2026/InventoryTable';
import { SKUDetailDialog } from './aim2026/SKUDetailDialog';
import { DemandHistoryDialog } from './aim2026/DemandHistoryDialog';
import { StockValuationDialog } from './aim2026/StockValuationDialog';
import { SettingsPanel } from './aim2026/SettingsPanel';
import { POBuilderPanel } from './aim2026/POBuilderPanel';
import { QtyConfirmDialog } from './aim2026/QtyConfirmDialog';
import { AIInsightsDialog } from './aim2026/AIInsightsDialog';
import { AIM2026ExportCSVDialog } from './aim2026/AIM2026ExportCSVDialog';
import { FutureProjectedDemandDialog } from './aim2026/FutureProjectedDemandDialog';
import { RealInboundStockDialog } from './aim2026/RealInboundStockDialog';
import { ContainerFeasibility } from './aim2026/ContainerFeasibility';
import { CompleteProjectionDialog } from './aim2026/complete-projection/CompleteProjectionDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AIM2026Filters, SKURow, KPISummary, SyncStatus, StockValuationTotals, StockValuationHistoryRecord, AIM2026Config, POBuilderItem } from '@/lib/aim2026/types';
import { matchesSkuProductSearch } from '@/lib/aim2026/searchFilter';
import type { BOMComponent } from '@/lib/aim2026/api';
import { DEFAULT_FILTERS, DEFAULT_CONFIG } from '@/lib/aim2026/types';
import {
  fetchDashboardData,
  createPurchaseOrder,
  recalcKPIsForDateRange,
  recalcKPIsForDemandMode,
  fetchDemandWarehouseSplit,
  fetchWhDemandDetail,
  downloadAsCSV,
} from '@/lib/aim2026/api';
import type { DemandWarehouseSplitItem } from '@/lib/aim2026/api';
import { runFullCSVSync, type CSVSyncProgress } from '@/lib/aim2026/csvSync';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DateRange {
  from?: Date;
  to?: Date;
}

const AIM2026_FILTERS_STORAGE_KEY = 'aim2026_filters';

interface AIM2026DashboardProps {
  dateRange?: DateRange;
  setDateRange?: (range: DateRange) => void;
}

/** Deduplicate rows by SKU (keeps first occurrence) to prevent duplicate lines */
function dedupeRowsBySKU(rows: SKURow[]): SKURow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.sku)) return false;
    seen.add(r.sku);
    return true;
  });
}

// ─── Dashboard Component ─────────────────────────────────────────────────────

function loadFiltersFromStorage(): AIM2026Filters {
  try {
    const raw = localStorage.getItem(AIM2026_FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw) as Partial<AIM2026Filters>;
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export default function AIM2026Dashboard({ dateRange, setDateRange }: AIM2026DashboardProps) {
  // ─── State ─────────────────────────────────────────────────────────────────

  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [filters, setFilters] = useState<AIM2026Filters>(loadFiltersFromStorage);
  const [skuData, setSKUData] = useState<SKURow[]>([]);
  const [kpiSummary, setKPISummary] = useState<KPISummary | null>(null);
  const [valuation, setValuation] = useState<StockValuationTotals | null>(null);
  const [valuationHistory, setValuationHistory] = useState<StockValuationHistoryRecord[]>([]);
  const [config, setConfig] = useState<AIM2026Config>(DEFAULT_CONFIG);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportCSVOpen, setExportCSVOpen] = useState(false);
  const [exportSelectedSKUs, setExportSelectedSKUs] = useState<Set<string>>(new Set());

  // Popup state
  const [skuDetailOpen, setSKUDetailOpen] = useState(false);
  const [selectedSKU, setSelectedSKU] = useState<SKURow | null>(null);
  const [demandOpen, setDemandOpen] = useState(false);
  const [demandSKU, setDemandSKU] = useState<SKURow | null>(null);
  const [valuationOpen, setValuationOpen] = useState(false);
  const [aiInsightsOpen, setAIInsightsOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [realInboundOpen, setRealInboundOpen] = useState(false);
  const [containerFeasibilityOpen, setContainerFeasibilityOpen] = useState(false);
  const [completeProjectionOpen, setCompleteProjectionOpen] = useState(false);

  // PO Builder state — cart persists in localStorage across panel toggles
  const [poBuilderMode, setPOBuilderMode] = useState(false);
  const [poItems, setPOItems] = useState<POBuilderItem[]>(() => {
    try {
      const saved = localStorage.getItem('aim2026-po-draft');
      return saved ? (JSON.parse(saved) as POBuilderItem[]) : [];
    } catch {
      return [];
    }
  });
  const [poCreating, setPOCreating] = useState(false);
  const [qtyDialogOpen, setQtyDialogOpen] = useState(false);
  const [qtyDialogRow, setQtyDialogRow] = useState<SKURow | null>(null);
  /** When set, Qty dialog uses this as suggested qty (China WH planned inbound qty from Real Inbound). */
  const [qtyDialogInboundQty, setQtyDialogInboundQty] = useState<number | null>(null);
  /** After confirm, open PO draft panel (Real Inbound → add to PO flow). */
  const [qtyDialogOpenPOBuilder, setQtyDialogOpenPOBuilder] = useState(false);
  const [poNotification, setPONotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [tableMaximized, setTableMaximized] = useState(false);
  const [assembledProductSKUs, setAssembledProductSKUs] = useState<Set<string>>(new Set());
  const [bomComponents, setBomComponents] = useState<BOMComponent[]>([]);
  const [showAssembledProducts, setShowAssembledProducts] = useState(false);
  const [insightFilterSKUs, setInsightFilterSKUs] = useState<string[] | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // B2B / B2C demand channel split (pure display toggle — data is in SKURow already)
  const [splitDemand, setSplitDemand] = useState(false);

  // Warehouse demand split (fetched on demand)
  const [warehouseDemandFilter, setWarehouseDemandFilter] = useState<string | null>(null);
  const [warehouseDemandData, setWarehouseDemandData] = useState<DemandWarehouseSplitItem[]>([]);
  const [warehouseList, setWarehouseList] = useState<string[]>([]);
  const [warehouseDemandLoading, setWarehouseDemandLoading] = useState(false);

  // ─── Load real data from Supabase ──────────────────────────────────────────

  const [syncError, setSyncError] = useState<string | null>(null);
  const [needsFirstSync, setNeedsFirstSync] = useState(false);
  const [syncStep, setSyncStep] = useState<string>('');
  const [syncProgress, setSyncProgress] = useState<number>(0);

  // Persist filters to localStorage when they change
  useEffect(() => {
    try {
      localStorage.setItem(AIM2026_FILTERS_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // ignore storage errors
    }
  }, [filters]);

  // When date range is set, the date range effect handles loading — avoid race with cache
  useEffect(() => {
    if (dateRange?.from && dateRange?.to) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    async function loadData() {
      try {
        const data = await fetchDashboardData();
        if (!cancelled) {
          if (data.rows.length === 0) {
            setNeedsFirstSync(true);
          } else {
            setSKUData(dedupeRowsBySKU(data.rows));
            setKPISummary(data.kpiSummary);
            setValuation(data.valuation);
            setValuationHistory(data.valuationHistory);
            setAssembledProductSKUs(new Set(data.assembledProductSKUs ?? []));
            setBomComponents(data.bomComponents ?? []);
            setNeedsFirstSync(false);
          }
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to load dashboard data:', err);
        if (!cancelled) {
          setNeedsFirstSync(true);
          setLoading(false);
        }
      }
    }

    loadData();
    return () => { cancelled = true; };
  }, [filters.demandMode, dateRange?.from?.getTime(), dateRange?.to?.getTime()]);

  // ─── Date Range recalculation ───────────────────────────────────────────────

  const [dateRangeLoading, setDateRangeLoading] = useState(false);
  const [dateRangeLabel, setDateRangeLabel] = useState<string | null>(null);
  const [demandIsDaily, setDemandIsDaily] = useState(false);

  useEffect(() => {
    if (!dateRange?.from || !dateRange?.to || loading || needsFirstSync) return;

    const from = dateRange.from;
    const to = dateRange.to;
    const rangeFrom = format(from, 'yyyy-MM-dd');
    const rangeTo = format(to, 'yyyy-MM-dd');
    const startDate = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-01`;
    const toMonthLast = new Date(to.getFullYear(), to.getMonth() + 1, 0);
    const endDate = `${toMonthLast.getFullYear()}-${String(toMonthLast.getMonth() + 1).padStart(2, '0')}-${String(toMonthLast.getDate()).padStart(2, '0')}`;

    // Check if the range covers roughly "all data" (> 11 months) — if so, use full cache
    const monthsDiff = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (monthsDiff >= 11) {
      setDateRangeLabel(null);
      setDemandIsDaily(false);
      fetchDashboardData().then((data) => {
        if (data.rows.length > 0) {
          setSKUData(dedupeRowsBySKU(data.rows));
          setKPISummary(data.kpiSummary);
          setAssembledProductSKUs(new Set(data.assembledProductSKUs ?? []));
          setBomComponents(data.bomComponents ?? []);
        }
      }).catch(console.error);
      return;
    }

    const fromLabel = from.toLocaleDateString('en', { month: 'short', year: 'numeric' });
    const toLabel = to.toLocaleDateString('en', { month: 'short', year: 'numeric' });
    const label = fromLabel === toLabel ? fromLabel : `${fromLabel} – ${toLabel}`;

    let cancelled = false;
    setDateRangeLoading(true);

    // Fetch valuation in parallel; use recalc for skuData (correct demand for date range)
    Promise.all([
      fetchDashboardData(),
      recalcKPIsForDateRange(startDate, endDate, rangeFrom, rangeTo, filters.demandMode),
    ])
      .then(([data, result]) => {
        if (!cancelled && result.rows.length > 0) {
          setSKUData(dedupeRowsBySKU(result.rows));
          setValuation(data.valuation);
          setValuationHistory(data.valuationHistory);
          setAssembledProductSKUs(new Set(data.assembledProductSKUs ?? []));
          setBomComponents(data.bomComponents ?? []);
          setDemandIsDaily(result.demandIsDaily ?? false);
          // Preserve fixed inventory value — always use total from valuation history, not date-range recalc
          setKPISummary((prev) => {
            const inventorySource = prev ?? data.kpiSummary;
            return {
              ...result.kpiSummary,
              totalInventoryValueAUD: inventorySource.totalInventoryValueAUD,
              totalInventoryValueUSD: inventorySource.totalInventoryValueUSD,
              inventoryValueHistory: inventorySource.inventoryValueHistory,
            };
          });
          setDateRangeLabel(label);
        }
      })
      .catch((err) => {
        console.error('Date range recalculation failed:', err);
      })
      .finally(() => {
        if (!cancelled) setDateRangeLoading(false);
      });

    return () => { cancelled = true; };
  }, [dateRange?.from?.getTime(), dateRange?.to?.getTime(), filters.demandMode, loading, needsFirstSync]);

  // ─── Demand Mode recalculation (no date range) ───────────────────────────
  useEffect(() => {
    if (loading || needsFirstSync) return;
    if (dateRange?.from && dateRange?.to) return; // handled by date range effect
    let cancelled = false;
    if (filters.demandMode === 'realDemand') {
      // Cached KPIs are already realDemand; avoid recalc to prevent duplication
      fetchDashboardData()
        .then((data) => {
          if (!cancelled && data.rows.length > 0) {
            setSKUData(dedupeRowsBySKU(data.rows));
            setKPISummary(data.kpiSummary);
            setAssembledProductSKUs(new Set(data.assembledProductSKUs ?? []));
            setBomComponents(data.bomComponents ?? []);
          }
        })
        .catch((err) => console.error('Dashboard fetch failed:', err));
    } else {
      recalcKPIsForDemandMode(filters.demandMode)
        .then((result) => {
          if (!cancelled && result.rows.length > 0) {
            setSKUData(dedupeRowsBySKU(result.rows));
            setKPISummary((prev) => {
              if (!prev) return result.kpiSummary;
              return {
                ...result.kpiSummary,
                totalInventoryValueAUD: prev.totalInventoryValueAUD,
                totalInventoryValueUSD: prev.totalInventoryValueUSD,
                inventoryValueHistory: prev.inventoryValueHistory,
              };
            });
          }
        })
        .catch((err) => console.error('Demand mode recalculation failed:', err));
    }
    return () => { cancelled = true; };
  }, [filters.demandMode, loading, needsFirstSync, dateRange?.from?.getTime(), dateRange?.to?.getTime()]);

  // ─── Derived data ──────────────────────────────────────────────────────────

  const productGroups = useMemo(
    () => [...new Set(skuData.map((r) => r.productGroup))].filter(Boolean).sort(),
    [skuData]
  );

  const suppliers = useMemo(
    () => [...new Set(skuData.map((r) => r.supplier))].filter(Boolean).sort(),
    [skuData]
  );

  const filteredData = useMemo(() => {
    let result = skuData;
    if (!showAssembledProducts && assembledProductSKUs.size > 0) {
      result = result.filter((r) => !assembledProductSKUs.has(r.sku));
    }
    if (insightFilterSKUs && insightFilterSKUs.length > 0) {
      const set = new Set(insightFilterSKUs);
      result = result.filter((r) => set.has(r.sku));
    }
    if (filters.search.trim()) {
      result = result.filter((r) =>
        matchesSkuProductSearch(r.sku, r.product, filters.search)
      );
    }
    if (filters.abcClass !== 'all') result = result.filter((r) => r.abcClass === filters.abcClass);
    if (filters.status !== 'all') result = result.filter((r) => r.status === filters.status);
    if (filters.productGroup !== 'all') result = result.filter((r) => r.productGroup === filters.productGroup);
    if (filters.supplier !== 'all') result = result.filter((r) => r.supplier === filters.supplier);
    return result;
  }, [
    skuData,
    filters.search,
    filters.abcClass,
    filters.status,
    filters.productGroup,
    filters.supplier,
    showAssembledProducts,
    assembledProductSKUs,
    insightFilterSKUs,
  ]);

  /** Same row set as passed to RealInboundStockDialog (export selection overlay). */
  const realInboundFilteredData = useMemo(
    () =>
      exportSelectedSKUs.size > 0
        ? filteredData.filter((r) => exportSelectedSKUs.has(r.sku))
        : filteredData,
    [exportSelectedSKUs, filteredData]
  );

  const filteredCount = filteredData.length;

  // Keep row selection in sync with the current filtered view.
  // If filters/search change, the set of visible rows changes too.
  useEffect(() => {
    setExportSelectedSKUs(new Set());
  }, [filteredData]);

  const filteredValuation = useMemo(() => {
    let mainWH = 0, china = 0, container = 0, dhl = 0, onProduction = 0;
    for (const r of filteredData) {
      mainWH += r.sohMainWH * (r.landedCostAUD || 0);
      china += r.sohChina * (r.productCostChina || 0);
      container += r.container * (r.landedCostAUD || 0);
      dhl += r.dhl * (r.landedCostAUD || 0);
      onProduction += r.onProduction * (r.productCostChina || 0);
    }
    const total = mainWH + china + container + dhl + onProduction;
    return { mainWH, china, container, dhl, onProduction, total };
  }, [filteredData]);

  // KPIs computed from filtered selection when filters are active
  const filteredKPIOverrides = useMemo(() => {
    if (filteredData.length === 0 || filteredData.length === skuData.length) return null;
    const n = filteredData.length;
    const itemsAtRisk = filteredData.filter(
      (r) => r.status === 'CRITICAL' || r.status === 'LOW STOCK'
    ).length;
    const withSellingPrice = filteredData.filter((r) => (r.avgSellingPrice ?? 0) > 0);
    const avgMarginPercent = withSellingPrice.length > 0
      ? withSellingPrice.reduce((s, r) => s + r.marginPercent, 0) / withSellingPrice.length
      : 0;
    return {
      avgMarginPercent,
      avgTurnover: filteredData.reduce((s, r) => s + r.turnover, 0) / n,
      avgGMROI: filteredData.reduce((s, r) => s + r.gmroi, 0) / n,
      avgDaysOfCover: filteredData.reduce((s, r) => s + r.daysOfCover, 0) / n,
      itemsAtRisk,
      totalProducts: n,
    };
  }, [filteredData, skuData.length]);

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleSync = useCallback(async (forceDownload = false) => {
    setSyncStatus('syncing');
    setSyncError(null);
    setSyncStep('Starting...');
    setSyncProgress(0);

    try {
      const result = await runFullCSVSync((p: CSVSyncProgress) => {
        setSyncStep(p.step);
        setSyncProgress(p.progress);
      });

      if (!result.success) {
        throw new Error(result.errors.join('; ') || 'Sync failed');
      }

      // Auto-download: only when explicitly requested (no automatic CSV downloads after sync)
      if (forceDownload && result.deltaFiles.length > 0) {
        for (const { name, blob } of result.deltaFiles) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          a.click();
          URL.revokeObjectURL(url);
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // Reload dashboard data
      setSyncStep('Reloading dashboard...');
      setSyncProgress(97);
      const data = await fetchDashboardData();
      setSKUData(dedupeRowsBySKU(data.rows));
      setKPISummary(data.kpiSummary);
      setValuation(data.valuation);
      setValuationHistory(data.valuationHistory);
      setAssembledProductSKUs(new Set(data.assembledProductSKUs ?? []));
      setBomComponents(data.bomComponents ?? []);
      setNeedsFirstSync(false);

      if (filters.demandMode !== 'realDemand') {
        const demandModeResult = await recalcKPIsForDemandMode(filters.demandMode);
        if (demandModeResult.rows.length > 0) {
          setSKUData(dedupeRowsBySKU(demandModeResult.rows));
          setKPISummary((prev) => {
            if (!prev) return demandModeResult.kpiSummary;
            return {
              ...demandModeResult.kpiSummary,
              totalInventoryValueAUD: prev.totalInventoryValueAUD,
              totalInventoryValueUSD: prev.totalInventoryValueUSD,
              inventoryValueHistory: prev.inventoryValueHistory,
            };
          });
        }
      }

      setSyncStep('');
      setSyncProgress(0);
      setSyncStatus('success');
      setTimeout(() => setSyncStatus('idle'), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Sync failed:', msg);
      setSyncError(msg);
      setSyncStep('');
      setSyncProgress(0);
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 8000);
    }
  }, []);

  /* ── OLD Sync (Unleashed API direct) — kept for reference ──────────────────
  const handleSync_OLD = useCallback(async () => {
    setSyncStatus('syncing');
    setSyncError(null);
    try {
      const { syncUnleashed as apiSync } = await import('@/lib/aim2026/api');
      const result = await apiSync();
      if (!result.success) throw new Error(result.message || 'Sync failed');
      const data = await fetchDashboardData();
      setSKUData(data.rows);
      setKPISummary(data.kpiSummary);
      setValuation(data.valuation);
      setValuationHistory(data.valuationHistory);
      setNeedsFirstSync(false);
      setSyncStatus('success');
      setTimeout(() => setSyncStatus('idle'), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setSyncError(msg);
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 8000);
    }
  }, []);
  ── END OLD Sync ─────────────────────────────────────────────────────────── */

  const handleSKUClick = useCallback(
    (sku: string) => {
      const row = skuData.find((r) => r.sku === sku);
      if (row) {
        setSelectedSKU(row);
        setSKUDetailOpen(true);
      }
    },
    [skuData]
  );

  const handleDemandClick = useCallback(
    (sku: string) => {
      const row = skuData.find((r) => r.sku === sku);
      if (row) {
        setDemandSKU(row);
        setDemandOpen(true);
      }
    },
    [skuData]
  );

  // ─── B2B/B2C Split Handler (pure display toggle) ─────────────────────────

  const handleToggleSplit = useCallback(() => {
    setSplitDemand((v) => !v);
  }, []);

  // ─── Warehouse Demand Handler ──────────────────────────────────────────

  // Derive month-boundary date strings for warehouse demand queries
  const whDemandFrom = useMemo(() => {
    if (!dateRange?.from) return undefined;
    const f = dateRange.from;
    return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-01`;
  }, [dateRange?.from?.getTime()]);

  const whDemandTo = useMemo(() => {
    if (!dateRange?.to) return undefined;
    const t = dateRange.to;
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
  }, [dateRange?.to?.getTime()]);

  const hasPartialWhDemandRange = useMemo(
    () => Boolean(dateRange?.from) !== Boolean(dateRange?.to),
    [dateRange?.from?.getTime(), dateRange?.to?.getTime()]
  );

  // Lazily load warehouse names when the user first opens the "More" section
  const loadWarehouseListIfNeeded = useCallback(() => {
    if (warehouseList.length > 0 || warehouseDemandLoading || hasPartialWhDemandRange) return;
    setWarehouseDemandLoading(true);
    fetchDemandWarehouseSplit(whDemandFrom, whDemandTo)
      .then((r) => {
        setWarehouseList(r.warehouses);
        if (r.data.length > 0) setWarehouseDemandData(r.data);
      })
      .catch(() => {})
      .finally(() => setWarehouseDemandLoading(false));
  }, [warehouseList.length, warehouseDemandLoading, hasPartialWhDemandRange, whDemandFrom, whDemandTo]);

  const handleWarehouseDemandChange = useCallback(async (warehouse: string | null) => {
    setWarehouseDemandFilter(warehouse);
    if (!warehouse) {
      return;
    }
    if (hasPartialWhDemandRange) {
      setWarehouseDemandData([]);
      return;
    }
    // If data hasn't been fetched yet, fetch now
    if (warehouseDemandData.length === 0) {
      setWarehouseDemandLoading(true);
      try {
        const result = await fetchDemandWarehouseSplit(whDemandFrom, whDemandTo);
        setWarehouseDemandData(result.data);
        setWarehouseList(result.warehouses);
      } catch {
        setWarehouseDemandData([]);
      } finally {
        setWarehouseDemandLoading(false);
      }
    }
  }, [warehouseDemandData.length, hasPartialWhDemandRange, whDemandFrom, whDemandTo]);

  // Re-fetch warehouse demand data when date range changes and a filter is active
  useEffect(() => {
    if (!warehouseDemandFilter) return;
    if (hasPartialWhDemandRange) {
      setWarehouseDemandData([]);
      return;
    }
    setWarehouseDemandLoading(true);
    fetchDemandWarehouseSplit(whDemandFrom, whDemandTo)
      .then((r) => {
        setWarehouseDemandData(r.data);
        setWarehouseList(r.warehouses);
      })
      .catch(() => {})
      .finally(() => setWarehouseDemandLoading(false));
  }, [whDemandFrom, whDemandTo, warehouseDemandFilter, hasPartialWhDemandRange]);

  // Pre-compute per-SKU demand for the selected warehouse
  const warehouseDemandMap = useMemo(() => {
    if (!warehouseDemandFilter || warehouseDemandData.length === 0) return null;
    const map = new Map<string, number>();
    for (const item of warehouseDemandData) {
      if (item.warehouse === warehouseDemandFilter) {
        map.set(item.sku, (map.get(item.sku) ?? 0) + item.qty);
      }
    }
    return map;
  }, [warehouseDemandFilter, warehouseDemandData]);

  // ─── WH Demand CSV Download ─────────────────────────────────────────────

  const handleWhDemandClick = useCallback(async (sku: string) => {
    const rows = await fetchWhDemandDetail(sku, whDemandFrom, whDemandTo);
    if (rows.length === 0) return;
    const csvRows = rows.map((r) => ({
      SKU: String(r.sku ?? ''),
      Warehouse: String(r.warehouse ?? ''),
      Period: String(r.period_date ?? ''),
      Quantity_Sold: Number(r.quantity_sold ?? 0),
      Component_Usage: Number(r.component_usage ?? 0),
      Total: Number(r.quantity_sold ?? 0) + Number(r.component_usage ?? 0),
      Revenue: Math.round(Number(r.revenue ?? 0) * 100) / 100,
    }));
    downloadAsCSV(csvRows, `wh_demand_${sku}_${warehouseDemandFilter ?? 'all'}.csv`);
  }, [whDemandFrom, whDemandTo, warehouseDemandFilter]);

  // ─── PO Builder Handlers ──────────────────────────────────────────────────

  const poSelectedSKUs = useMemo(
    () => new Set(poItems.map((i) => i.sku)),
    [poItems]
  );

  const handleSugQtyClick = useCallback((row: SKURow) => {
    setQtyDialogRow(row);
    setQtyDialogInboundQty(null);
    setQtyDialogOpenPOBuilder(false);
    setQtyDialogOpen(true);
  }, []);

  /** Real Inbound: China WH (planned) row → same PO flow with planned ship qty as suggested. */
  const handleChinaPlannedAddToPO = useCallback(
    (sku: string, plannedQty: number) => {
      const row =
        realInboundFilteredData.find((r) => r.sku === sku) ??
        skuData.find((r) => r.sku === sku);
      if (!row) return;
      setQtyDialogRow(row);
      setQtyDialogInboundQty(plannedQty);
      setQtyDialogOpenPOBuilder(true);
      setQtyDialogOpen(true);
    },
    [realInboundFilteredData, skuData]
  );

  const handleQtyDialogOpenChange = useCallback((open: boolean) => {
    setQtyDialogOpen(open);
    if (!open) {
      setQtyDialogInboundQty(null);
      setQtyDialogOpenPOBuilder(false);
    }
  }, []);

  const handleQtyConfirm = useCallback(
    (qty: number) => {
      if (!qtyDialogRow) return;
      const suggestedFromRow = qtyDialogRow.suggestedQty || qtyDialogRow.softSuggestedQty;
      setPOItems((prev) => {
        const existing = prev.find((i) => i.sku === qtyDialogRow.sku);
        if (existing) {
          return prev.map((i) => (i.sku === qtyDialogRow.sku ? { ...i, quantity: qty } : i));
        }
        return [
          ...prev,
          {
            sku: qtyDialogRow.sku,
            product: qtyDialogRow.product,
            quantity: qty,
            suggestedQty: suggestedFromRow,
            unitPrice: qtyDialogRow.productCostChina ?? 0,
          },
        ];
      });
      if (qtyDialogOpenPOBuilder) {
        setPOBuilderMode(true);
        setQtyDialogOpenPOBuilder(false);
      }
    },
    [qtyDialogRow, qtyDialogOpenPOBuilder]
  );

  const handlePORemoveItem = useCallback((sku: string) => {
    setPOItems((prev) => prev.filter((i) => i.sku !== sku));
  }, []);

  const handlePOUpdateQty = useCallback((sku: string, qty: number) => {
    setPOItems((prev) => prev.map((i) => (i.sku === sku ? { ...i, quantity: qty } : i)));
  }, []);

  const handleAddProjectionItem = useCallback(
    (sku: string, qty: number, _poType: 'Container' | 'Production') => {
      const row = skuData.find((r) => r.sku === sku);
      if (!row || qty <= 0) return;
      setPOItems((prev) => {
        const existing = prev.find((i) => i.sku === sku);
        if (existing) return prev.map((i) => (i.sku === sku ? { ...i, quantity: qty } : i));
        return [...prev, {
          sku: row.sku,
          product: row.product,
          quantity: qty,
          suggestedQty: row.suggestedQty || row.softSuggestedQty,
          unitPrice: row.productCostChina ?? 0,
        }];
      });
      setPOBuilderMode(true);
    },
    [skuData]
  );

  const handlePOClear = useCallback(() => {
    // Trash icon on POBuilderPanel = cancel the whole PO. Drop items AND exit
    // PO Builder mode so the user doesn't have to click Exit PO mode in each
    // sub-modal (Complete Projection picks up the transition via prop).
    setPOItems([]);
    setPOBuilderMode(false);
  }, []);

  // Persist draft cart to localStorage whenever it changes
  useEffect(() => {
    try {
      if (poItems.length > 0) {
        localStorage.setItem('aim2026-po-draft', JSON.stringify(poItems));
      } else {
        localStorage.removeItem('aim2026-po-draft');
      }
    } catch { /* storage unavailable */ }
  }, [poItems]);

  // Close maximized table on Escape
  useEffect(() => {
    if (!tableMaximized) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTableMaximized(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tableMaximized]);

  const handleCreatePO = useCallback(async (customOrderStatus: string) => {
    if (poItems.length === 0) return;
    setPOCreating(true);
    try {
      // DHL Inbounds y Container → Main Warehouse (producto en tránsito hacia Australia)
      // Production → China-W (producto en fábrica)
      const warehouseCode = (customOrderStatus === 'DHL-Inbounds' || customOrderStatus === 'Container') ? 'MAIN' : 'China';

      const result = await createPurchaseOrder({
        items: poItems.map((i) => ({
          productCode: i.sku,
          orderQuantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
        supplierCode: 'Winkin',
        warehouseCode,
        customOrderStatus,
      });

      if (result.success) {
        setPONotification({ type: 'success', message: result.message });
        setPOItems([]);
        setPOBuilderMode(false);
        setTimeout(() => setPONotification(null), 6000);
      } else {
        setPONotification({ type: 'error', message: result.message });
        setTimeout(() => setPONotification(null), 8000);
      }
    } catch (err) {
      setPONotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to create PO',
      });
      setTimeout(() => setPONotification(null), 8000);
    } finally {
      setPOCreating(false);
    }
  }, [poItems]);

  // Toggle the PO panel — items are NEVER discarded on close; they persist in
  // localStorage until the user explicitly clears them or sends the PO.
  const handleTogglePOMode = useCallback(() => {
    setPOBuilderMode((prev) => !prev);
  }, []);

  // ─── Format last sync time ────────────────────────────────────────────────

  const lastSyncLabel = useMemo(() => {
    if (!kpiSummary?.lastSyncAt) return 'Never synced';
    const diff = Date.now() - new Date(kpiSummary.lastSyncAt).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }, [kpiSummary?.lastSyncAt]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* ─── Header Bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              <Zap size={18} className="text-primary" />
              AIM 2026
              {!tableMaximized && setDateRange && dateRange ? (
                <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen} modal>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className={cn(
                        "h-7 gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border",
                        "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
                      )}
                    >
                      <CalendarIcon className="h-3 w-3" />
                      {dateRangeLabel || 'Date range'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start" side="bottom">
                    <Calendar
                      initialFocus
                      mode="range"
                      defaultMonth={dateRange?.from}
                      selected={dateRange as never}
                      onSelect={(range) => setDateRange(range || {})}
                      numberOfMonths={2}
                      weekStartsOn={1}
                    />
                    <div className="p-2 border-t flex justify-end">
                      <Button size="sm" onClick={() => setDatePickerOpen(false)}>
                        Apply
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              ) : !tableMaximized && dateRangeLabel ? (
                <span className="text-[10px] font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-full border border-primary/20">
                  {dateRangeLabel}
                </span>
              ) : null}
              {dateRangeLoading && (
                <RefreshCw size={13} className="animate-spin text-primary/60" />
              )}
            </h2>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <Clock size={11} />
              {lastSyncLabel}
              {kpiSummary && (
                <span className="text-muted-foreground/50">
                  &middot; {kpiSummary.totalProducts} products
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={handleTogglePOMode}
            size="sm"
            variant={poBuilderMode ? 'default' : 'outline'}
            className={`h-8 gap-1.5 text-xs font-medium ${
              poBuilderMode
                ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                : poItems.length > 0
                ? 'border-blue-400 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30'
                : ''
            }`}
          >
            <ShoppingCart size={14} />
            {poBuilderMode
              ? 'Hide PO Draft'
              : poItems.length > 0
              ? 'PO Draft'
              : 'Create Purchase Order'}
            {poItems.length > 0 && (
              <span className="inline-flex items-center justify-center bg-blue-600 text-white text-[9px] font-bold rounded-full min-w-[16px] h-[16px] px-1 leading-none">
                {poItems.length}
              </span>
            )}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs font-medium"
                disabled={loading || filteredCount === 0}
              >
                <BarChart2 size={14} />
                Reports
                <ChevronDown size={12} className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setReportsOpen(true)}>
                <BarChart2 size={13} className="mr-2 text-muted-foreground" />
                Future Projected Demand
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRealInboundOpen(true)}>
                <Truck size={13} className="mr-2 text-muted-foreground" />
                Real Inbound Stock Curve
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setContainerFeasibilityOpen(true)}>
                <Container size={13} className="mr-2 text-muted-foreground" />
                Container Feasibility
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setCompleteProjectionOpen(true)}>
                <Zap size={13} className="mr-2 text-[#7c3aed]" />
                Complete Projection
                <span className="ml-2 inline-flex items-center rounded-full bg-[#ede9fe] px-1.5 py-0.5 text-[9px] font-bold leading-none text-[#4c1d95]">NEW</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            onClick={() => setExportCSVOpen(true)}
            disabled={loading || filteredCount === 0}
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs font-medium min-w-[160px]"
          >
            <Download size={14} />
            Export CSV
          </Button>

          <Button
            onClick={() => handleSync()}
            disabled={syncStatus === 'syncing' || poBuilderMode}
            size="sm"
            className="h-8 gap-1.5 text-xs font-medium relative overflow-hidden min-w-[160px]"
          >
            <RefreshCw
              size={14}
              className={syncStatus === 'syncing' ? 'animate-spin' : ''}
            />
            {syncStatus === 'syncing'
              ? (syncStep || 'Syncing...')
              : syncStatus === 'success'
              ? 'Synced!'
              : syncStatus === 'error'
              ? 'Sync Failed'
              : 'Sync with Unleashed'}

            {/* Progress fill */}
            {syncStatus === 'syncing' && syncProgress > 0 && (
              <span
                className="absolute bottom-0 left-0 h-0.5 bg-white/40 transition-all duration-300"
                style={{ width: `${syncProgress}%` }}
              />
            )}

            {/* Success flash */}
            {syncStatus === 'success' && (
              <motion.div
                initial={{ opacity: 0.5 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 1.5 }}
                className="absolute inset-0 bg-emerald-400/20"
              />
            )}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={15} className="text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* ─── Sync Progress Bar ──────────────────────────────────────────────── */}
      {syncStatus === 'syncing' && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-1"
        >
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-500 rounded-full"
              style={{ width: `${syncProgress}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground tabular-nums flex items-center gap-1.5">
            <RefreshCw size={9} className="animate-spin flex-shrink-0" />
            {syncStep || 'Syncing…'}
            {syncProgress > 0 && (
              <span className="text-muted-foreground/50 ml-auto">{syncProgress}%</span>
            )}
          </p>
        </motion.div>
      )}

      {/* ─── Sync Error Banner ───────────────────────────────────────────── */}
      {syncError && syncStatus === 'error' && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-lg px-4 py-3 flex items-start gap-3"
        >
          <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">Sync Failed</p>
            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{syncError}</p>
            <p className="text-[10px] text-red-500/70 mt-1">
              Make sure Unleashed credentials are saved in Settings and the API is accessible.
            </p>
          </div>
        </motion.div>
      )}

      {/* ─── PO Notification Banner ──────────────────────────────────────── */}
      <AnimatePresence>
        {poNotification && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`rounded-lg px-4 py-3 flex items-start gap-3 border ${
              poNotification.type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/50'
                : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/50'
            }`}
          >
            {poNotification.type === 'success' ? (
              <ShoppingCart size={16} className="text-emerald-500 mt-0.5 flex-shrink-0" />
            ) : (
              <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${
                poNotification.type === 'success'
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-red-700 dark:text-red-300'
              }`}>
                {poNotification.type === 'success' ? 'Purchase Order Created' : 'PO Creation Failed'}
              </p>
              <p className={`text-xs mt-0.5 ${
                poNotification.type === 'success'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              }`}>{poNotification.message}</p>
            </div>
            <button onClick={() => setPONotification(null)} className="text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Empty State (needs first sync) ──────────────────────────────── */}
      {needsFirstSync && !loading && skuData.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-20 gap-4"
        >
          <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center">
            <Database size={28} className="text-muted-foreground/50" />
          </div>
          <div className="text-center space-y-1.5">
            <h3 className="text-sm font-semibold">No Data Yet</h3>
            <p className="text-xs text-muted-foreground max-w-sm">
              Click <strong>Sync with Unleashed</strong> to pull your real inventory data from Unleashed Software. 
              Make sure your API credentials are configured.
            </p>
          </div>
          <Button
            onClick={() => handleSync()}
            disabled={syncStatus === 'syncing'}
            size="sm"
            className="gap-1.5"
          >
            <RefreshCw size={14} className={syncStatus === 'syncing' ? 'animate-spin' : ''} />
            {syncStatus === 'syncing' ? 'Syncing...' : 'Sync Now'}
          </Button>
        </motion.div>
      ) : (
        <>
          {/* ─── KPI Summary Cards ──────────────────────────────────────────── */}
          <KPISummaryCards
            data={kpiSummary}
            filteredOverrides={filteredKPIOverrides}
            loading={loading}
            onValuationClick={() => setValuationOpen(true)}
            onAIInsightsClick={() => setAIInsightsOpen(true)}
          />

          {/* ─── Filter Bar ───────────────────────────────────────────────── */}
          <div className="bg-muted/20 rounded-lg border border-border/40 px-4 py-3">
            <FilterBar
              filters={filters}
              onFiltersChange={setFilters}
              productGroups={productGroups}
              suppliers={suppliers}
              totalCount={skuData.length}
              filteredCount={filteredCount}
              showAssembledProducts={showAssembledProducts}
              onShowAssembledProductsChange={setShowAssembledProducts}
              assembledCount={assembledProductSKUs.size}
              onMaximizeClick={() => setTableMaximized(true)}
              splitDemand={splitDemand}
              onToggleSplit={handleToggleSplit}
              warehouseList={warehouseList}
              warehouseDemandFilter={warehouseDemandFilter}
              onWarehouseDemandChange={handleWarehouseDemandChange}
              warehouseDemandLoading={warehouseDemandLoading}
              onLoadWarehouseList={loadWarehouseListIfNeeded}
            />
          </div>

          {/* ─── AI Insight Filter Banner ───────────────────────────────────── */}
          <AnimatePresence>
            {insightFilterSKUs && insightFilterSKUs.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-purple-50 dark:bg-purple-950/30 border border-purple-200/60 dark:border-purple-800/40 rounded-lg px-4 py-2.5 flex items-center gap-3"
              >
                <Zap size={14} className="text-purple-500 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-xs font-medium text-purple-700 dark:text-purple-300">
                    Viewing {insightFilterSKUs.length} products from AI Insight
                  </p>
                  <p className="text-[10px] text-purple-600/70 dark:text-purple-400/70">
                    Filter applied from Intelligent Growth Insights. Clear to see all products.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-purple-600 dark:text-purple-400 hover:bg-purple-200/50 dark:hover:bg-purple-800/30"
                  onClick={() => setInsightFilterSKUs(null)}
                >
                  <X size={12} className="mr-1" />
                  Clear filter
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ─── Filtered Stock Valuation Strip ─────────────────────────────── */}
          {filteredData.length > 0 && filteredData.length <= skuData.length && (
            <div className="bg-muted/20 rounded-lg border border-border/40 px-4 py-2.5">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 text-muted-foreground mr-1">
                  <Warehouse size={13} className="opacity-60" />
                  <span className="text-[11px] font-medium uppercase tracking-wide">
                    Stock Valuation
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">
                    ({filteredCount} {filteredCount === 1 ? 'product' : 'products'})
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-wrap flex-1">
                  {[
                    { label: 'Main WH', value: filteredValuation.mainWH, color: 'text-blue-600 dark:text-blue-400' },
                    { label: 'China', value: filteredValuation.china, color: 'text-purple-600 dark:text-purple-400' },
                    { label: 'Container', value: filteredValuation.container, color: 'text-cyan-600 dark:text-cyan-400' },
                    { label: 'DHL', value: filteredValuation.dhl, color: 'text-orange-600 dark:text-orange-400' },
                    { label: 'Production', value: filteredValuation.onProduction, color: 'text-violet-600 dark:text-violet-400' },
                  ].map((loc) => (
                    <div key={loc.label} className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground/70">{loc.label}</span>
                      <span className={`text-xs font-semibold tabular-nums ${loc.color}`}>
                        ${loc.value >= 1000 ? `${(loc.value / 1000).toFixed(1)}K` : loc.value.toFixed(0)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center gap-1 ml-auto pl-3 border-l border-border/40">
                    <span className="text-[10px] text-muted-foreground/70">Total</span>
                    <span className="text-xs font-bold tabular-nums text-foreground">
                      ${filteredValuation.total >= 1_000_000
                        ? `${(filteredValuation.total / 1_000_000).toFixed(2)}M`
                        : filteredValuation.total >= 1000
                        ? `${(filteredValuation.total / 1000).toFixed(1)}K`
                        : filteredValuation.total.toFixed(0)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ─── PO Builder Mode Banner ────────────────────────────────────── */}
          <AnimatePresence>
            {poBuilderMode && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40 rounded-lg px-4 py-2.5 flex items-center gap-3"
              >
                <ShoppingCart size={14} className="text-blue-500 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
                    PO Builder Mode Active
                  </p>
                  <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70">
                    Click any <strong>Sug. Qty</strong> cell to add that SKU to your draft Purchase Order (even if suggested qty is 0)
                  </p>
                </div>
                {poItems.length > 0 && (
                  <span className="bg-blue-600 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full">
                    {poItems.length} items
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* ─── Main Inventory Table ─────────────────────────────────────── */}
          <InventoryTable
            data={filteredData}
            filters={filters}
            loading={loading}
            onSKUClick={handleSKUClick}
            onDemandClick={handleDemandClick}
            onWhDemandClick={handleWhDemandClick}
            poBuilderMode={poBuilderMode}
            poSelectedSKUs={poSelectedSKUs}
            onSugQtyClick={handleSugQtyClick}
            exportSelectedSKUs={exportSelectedSKUs}
            onExportSelectedSKUsChange={setExportSelectedSKUs}
            dataIsFullyFiltered
            splitDemand={splitDemand}
            warehouseDemandFilter={warehouseDemandFilter}
            warehouseDemandMap={warehouseDemandMap}
            demandIsDaily={demandIsDaily}
          />
        </>
      )}

      {/* ─── Maximized table overlay (FilterBar + valuation + table) ────────── */}
      <AnimatePresence>
        {tableMaximized && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-background flex flex-col"
          >
            <div className="flex items-center justify-between gap-4 px-4 py-2 border-b bg-muted/30 shrink-0">
              <span className="text-sm font-medium">AIM 2026 — Main table</span>

              <div className="flex items-center gap-3">
                {setDateRange && dateRange ? (
                  <div className="flex items-center gap-3">
                    <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen} modal>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn(
                            'h-7 gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border',
                            'bg-primary/10 text-primary border-primary/20 hover:bg-primary/20'
                          )}
                        >
                          <CalendarIcon className="h-3 w-3" />
                          {dateRangeLabel || 'Date range'}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-auto p-0 z-[70]"
                        align="start"
                        side="bottom"
                      >
                        <Calendar
                          initialFocus
                          mode="range"
                          defaultMonth={dateRange?.from}
                          selected={dateRange as never}
                          onSelect={(range) => setDateRange(range || {})}
                          numberOfMonths={2}
                          weekStartsOn={1}
                        />
                        <div className="p-2 border-t flex justify-end">
                          <Button size="sm" onClick={() => setDatePickerOpen(false)}>
                            Apply
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>

                    {dateRangeLoading && (
                      <RefreshCw size={13} className="animate-spin text-primary/60" />
                    )}
                  </div>
                ) : dateRangeLabel ? (
                  <span className="text-[10px] font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-full border border-primary/20">
                    {dateRangeLabel}
                  </span>
                ) : null}

                <Button
                  onClick={() => setExportCSVOpen(true)}
                  disabled={loading || filteredCount === 0}
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs font-medium min-w-[160px]"
                >
                  <Download size={14} />
                  Export CSV
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 p-4 flex flex-col gap-3 overflow-auto">
              <div className="bg-muted/20 rounded-lg border border-border/40 px-4 py-3 shrink-0">
                <FilterBar
                  filters={filters}
                  onFiltersChange={setFilters}
                  productGroups={productGroups}
                  suppliers={suppliers}
                  totalCount={skuData.length}
                  filteredCount={filteredCount}
                  showAssembledProducts={showAssembledProducts}
                  onShowAssembledProductsChange={setShowAssembledProducts}
                  assembledCount={assembledProductSKUs.size}
                  onRestoreClick={() => setTableMaximized(false)}
                  isMaximized
                  splitDemand={splitDemand}
                  onToggleSplit={handleToggleSplit}
                  warehouseList={warehouseList}
                  warehouseDemandFilter={warehouseDemandFilter}
                  onWarehouseDemandChange={handleWarehouseDemandChange}
                  warehouseDemandLoading={warehouseDemandLoading}
                  onLoadWarehouseList={loadWarehouseListIfNeeded}
                />
              </div>
              {filteredData.length > 0 && (
                <div className="bg-muted/20 rounded-lg border border-border/40 px-4 py-2.5 shrink-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5 text-muted-foreground mr-1">
                      <Warehouse size={13} className="opacity-60" />
                      <span className="text-[11px] font-medium uppercase tracking-wide">Stock Valuation</span>
                      <span className="text-[10px] text-muted-foreground/60">
                        ({filteredCount} {filteredCount === 1 ? 'product' : 'products'})
                      </span>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap flex-1">
                      {[
                        { label: 'Main WH', value: filteredValuation.mainWH, color: 'text-blue-600 dark:text-blue-400' },
                        { label: 'China', value: filteredValuation.china, color: 'text-purple-600 dark:text-purple-400' },
                        { label: 'Container', value: filteredValuation.container, color: 'text-cyan-600 dark:text-cyan-400' },
                        { label: 'DHL', value: filteredValuation.dhl, color: 'text-orange-600 dark:text-orange-400' },
                        { label: 'Production', value: filteredValuation.onProduction, color: 'text-violet-600 dark:text-violet-400' },
                      ].map((loc) => (
                        <div key={loc.label} className="flex items-center gap-1">
                          <span className="text-[10px] text-muted-foreground/70">{loc.label}</span>
                          <span className={`text-xs font-semibold tabular-nums ${loc.color}`}>
                            ${loc.value >= 1000 ? `${(loc.value / 1000).toFixed(1)}K` : loc.value.toFixed(0)}
                          </span>
                        </div>
                      ))}
                      <div className="flex items-center gap-1 ml-auto pl-3 border-l border-border/40">
                        <span className="text-[10px] text-muted-foreground/70">Total</span>
                        <span className="text-xs font-bold tabular-nums text-foreground">
                          ${filteredValuation.total >= 1_000_000
                            ? `${(filteredValuation.total / 1_000_000).toFixed(2)}M`
                            : filteredValuation.total >= 1000
                            ? `${(filteredValuation.total / 1000).toFixed(1)}K`
                            : filteredValuation.total.toFixed(0)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 flex flex-col">
                <InventoryTable
                  data={filteredData}
                  filters={filters}
                  loading={loading}
                  onSKUClick={handleSKUClick}
                  onDemandClick={handleDemandClick}
                  onWhDemandClick={handleWhDemandClick}
                  poBuilderMode={poBuilderMode}
                  poSelectedSKUs={poSelectedSKUs}
                  onSugQtyClick={handleSugQtyClick}
                  exportSelectedSKUs={exportSelectedSKUs}
                  onExportSelectedSKUsChange={setExportSelectedSKUs}
                  fullHeight
                  dataIsFullyFiltered
                  splitDemand={splitDemand}
                  warehouseDemandFilter={warehouseDemandFilter}
                  warehouseDemandMap={warehouseDemandMap}
                  demandIsDaily={demandIsDaily}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Footer Status ──────────────────────────────────────────────────── */}
      {skuData.length > 0 && (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground/50 px-1">
          <span>
            AIM 2026 &middot; Data from Unleashed Software
          </span>
          <span className="tabular-nums">
            {filteredCount} of {skuData.length} products &middot; Last sync: {lastSyncLabel}
          </span>
        </div>
      )}

      {/* ─── Interactive Popups ─────────────────────────────────────────────── */}
      <SKUDetailDialog
        open={skuDetailOpen}
        onOpenChange={setSKUDetailOpen}
        sku={selectedSKU}
        bomComponents={bomComponents}
        assembledProductSKUs={assembledProductSKUs}
      />
      <DemandHistoryDialog
        open={demandOpen}
        onOpenChange={setDemandOpen}
        sku={demandSKU}
      />
      <StockValuationDialog
        open={valuationOpen}
        onOpenChange={setValuationOpen}
        valuation={valuation}
        history={valuationHistory}
      />
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        config={config}
        onSave={setConfig}
        onSyncAndDownload={() => handleSync(true)}
      />
      <AIInsightsDialog
        open={aiInsightsOpen}
        onOpenChange={setAIInsightsOpen}
        skuData={skuData}
        kpiSummary={kpiSummary}
        assembledProductSKUs={assembledProductSKUs}
        config={config}
        onApplyFilter={(skus) => {
          setInsightFilterSKUs(skus);
          setAIInsightsOpen(false);
        }}
      />

      <AIM2026ExportCSVDialog
        open={exportCSVOpen}
        onOpenChange={setExportCSVOpen}
        filters={filters}
        filteredRows={filteredData}
        selectedRowSKUs={exportSelectedSKUs}
        dateRange={dateRange}
        setDateRange={setDateRange}
        splitDemand={splitDemand}
        warehouseDemandFilter={warehouseDemandFilter}
        warehouseDemandMap={warehouseDemandMap}
      />

      <FutureProjectedDemandDialog
        open={reportsOpen}
        onOpenChange={setReportsOpen}
        filteredData={exportSelectedSKUs.size > 0 ? filteredData.filter((r) => exportSelectedSKUs.has(r.sku)) : filteredData}
        dateRange={dateRange}
      />

      <RealInboundStockDialog
        open={realInboundOpen}
        onOpenChange={setRealInboundOpen}
        filteredData={realInboundFilteredData}
        warehouseDemandMap={warehouseDemandMap}
        onAddChinaPlannedToPO={handleChinaPlannedAddToPO}
      />

      <ContainerFeasibility
        open={containerFeasibilityOpen}
        onOpenChange={setContainerFeasibilityOpen}
      />

      <CompleteProjectionDialog
        open={completeProjectionOpen}
        onOpenChange={setCompleteProjectionOpen}
        filteredData={exportSelectedSKUs.size > 0 ? filteredData.filter((r) => exportSelectedSKUs.has(r.sku)) : filteredData}
        dateRange={dateRange}
        setDateRange={setDateRange}
        demandIsDaily={(() => {
          const f = dateRange?.from, t = dateRange?.to;
          if (!f || !t) return false;
          return ((t.getTime() - f.getTime()) / 86400000) < 30;
        })()}
        onAddProjectionItem={handleAddProjectionItem}
        poBuilderMode={poBuilderMode}
      />

      {/* ─── PO Builder Components ─────────────────────────────────────────── */}
      <QtyConfirmDialog
        open={qtyDialogOpen}
        onOpenChange={handleQtyDialogOpenChange}
        sku={qtyDialogRow?.sku ?? ''}
        product={qtyDialogRow?.product ?? ''}
        suggestedQty={
          qtyDialogInboundQty != null
            ? qtyDialogInboundQty
            : (qtyDialogRow?.suggestedQty || qtyDialogRow?.softSuggestedQty) ?? 0
        }
        onConfirm={handleQtyConfirm}
      />

      {poBuilderMode && (
        <POBuilderPanel
          items={poItems}
          onRemove={handlePORemoveItem}
          onUpdateQty={handlePOUpdateQty}
          onClear={handlePOClear}
          onCreatePO={handleCreatePO}
          creating={poCreating}
        />
      )}
    </div>
  );
}
