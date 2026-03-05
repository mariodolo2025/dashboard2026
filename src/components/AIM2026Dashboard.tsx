import { useState, useMemo, useCallback, useEffect } from 'react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw, Settings, Clock, Zap, AlertTriangle, Database, ShoppingCart, X, Warehouse } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import type { AIM2026Filters, SKURow, KPISummary, SyncStatus, StockValuationTotals, StockValuationHistoryRecord, AIM2026Config, POBuilderItem } from '@/lib/aim2026/types';
import { DEFAULT_FILTERS, DEFAULT_CONFIG } from '@/lib/aim2026/types';
import {
  fetchDashboardData,
  createPurchaseOrder,
  recalcKPIsForDateRange,
  recalcKPIsForDemandMode,
} from '@/lib/aim2026/api';
import { runFullCSVSync, type CSVSyncProgress } from '@/lib/aim2026/csvSync';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DateRange {
  from?: Date;
  to?: Date;
}

interface AIM2026DashboardProps {
  dateRange?: DateRange;
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

export default function AIM2026Dashboard({ dateRange }: AIM2026DashboardProps) {
  // ─── State ─────────────────────────────────────────────────────────────────

  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [filters, setFilters] = useState<AIM2026Filters>(DEFAULT_FILTERS);
  const [skuData, setSKUData] = useState<SKURow[]>([]);
  const [kpiSummary, setKPISummary] = useState<KPISummary | null>(null);
  const [valuation, setValuation] = useState<StockValuationTotals | null>(null);
  const [valuationHistory, setValuationHistory] = useState<StockValuationHistoryRecord[]>([]);
  const [config, setConfig] = useState<AIM2026Config>(DEFAULT_CONFIG);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Popup state
  const [skuDetailOpen, setSKUDetailOpen] = useState(false);
  const [selectedSKU, setSelectedSKU] = useState<SKURow | null>(null);
  const [demandOpen, setDemandOpen] = useState(false);
  const [demandSKU, setDemandSKU] = useState<SKURow | null>(null);
  const [valuationOpen, setValuationOpen] = useState(false);
  const [aiInsightsOpen, setAIInsightsOpen] = useState(false);

  // PO Builder state
  const [poBuilderMode, setPOBuilderMode] = useState(false);
  const [poItems, setPOItems] = useState<POBuilderItem[]>([]);
  const [poCreating, setPOCreating] = useState(false);
  const [qtyDialogOpen, setQtyDialogOpen] = useState(false);
  const [qtyDialogRow, setQtyDialogRow] = useState<SKURow | null>(null);
  const [poNotification, setPONotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // ─── Load real data from Supabase ──────────────────────────────────────────

  const [syncError, setSyncError] = useState<string | null>(null);
  const [needsFirstSync, setNeedsFirstSync] = useState(false);
  const [syncStep, setSyncStep] = useState<string>('');
  const [syncProgress, setSyncProgress] = useState<number>(0);

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
      fetchDashboardData().then((data) => {
        if (data.rows.length > 0) {
          setSKUData(dedupeRowsBySKU(data.rows));
          setKPISummary(data.kpiSummary);
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
          // Preserve fixed inventory value — only update demand-dependent KPIs
          setKPISummary((prev) => {
            if (!prev) return result.kpiSummary;
            return {
              ...result.kpiSummary,
              totalInventoryValueAUD: prev.totalInventoryValueAUD,
              totalInventoryValueUSD: prev.totalInventoryValueUSD,
              inventoryValueHistory: prev.inventoryValueHistory,
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
    if (filters.search) {
      const term = filters.search.toLowerCase();
      result = result.filter(
        (r) => r.sku.toLowerCase().includes(term) || r.product.toLowerCase().includes(term)
      );
    }
    if (filters.abcClass !== 'all') result = result.filter((r) => r.abcClass === filters.abcClass);
    if (filters.status !== 'all') result = result.filter((r) => r.status === filters.status);
    if (filters.productGroup !== 'all') result = result.filter((r) => r.productGroup === filters.productGroup);
    if (filters.supplier !== 'all') result = result.filter((r) => r.supplier === filters.supplier);
    return result;
  }, [skuData, filters]);

  const filteredCount = filteredData.length;

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

  // ─── PO Builder Handlers ──────────────────────────────────────────────────

  const poSelectedSKUs = useMemo(
    () => new Set(poItems.map((i) => i.sku)),
    [poItems]
  );

  const handleSugQtyClick = useCallback((row: SKURow) => {
    setQtyDialogRow(row);
    setQtyDialogOpen(true);
  }, []);

  const handleQtyConfirm = useCallback(
    (qty: number) => {
      if (!qtyDialogRow) return;
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
            suggestedQty: qtyDialogRow.suggestedQty || qtyDialogRow.softSuggestedQty,
            unitPrice: qtyDialogRow.productCostChina ?? 0,
          },
        ];
      });
    },
    [qtyDialogRow]
  );

  const handlePORemoveItem = useCallback((sku: string) => {
    setPOItems((prev) => prev.filter((i) => i.sku !== sku));
  }, []);

  const handlePOUpdateQty = useCallback((sku: string, qty: number) => {
    setPOItems((prev) => prev.map((i) => (i.sku === sku ? { ...i, quantity: qty } : i)));
  }, []);

  const handlePOClear = useCallback(() => {
    setPOItems([]);
  }, []);

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

  const handleTogglePOMode = useCallback(() => {
    setPOBuilderMode((prev) => {
      if (prev) {
        // Exiting PO mode — if items exist, ask to confirm
        if (poItems.length > 0) {
          const discard = confirm('Discard PO draft with ' + poItems.length + ' items?');
          if (!discard) return true; // keep mode
          setPOItems([]);
        }
      }
      return !prev;
    });
  }, [poItems.length]);

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
              <Zap size={18} className="text-blue-500" />
              AIM 2026
              {dateRangeLabel && (
                <span className="text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/20">
                  {dateRangeLabel}
                </span>
              )}
              {dateRangeLoading && (
                <RefreshCw size={13} className="animate-spin text-blue-500/60" />
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
                ? 'bg-blue-600 hover:bg-blue-700 text-white'
                : ''
            }`}
          >
            {poBuilderMode ? (
              <>
                <X size={14} />
                Exit PO Mode
              </>
            ) : (
              <>
                <ShoppingCart size={14} />
                Create Purchase Order
              </>
            )}
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
            />
          </div>

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
            data={skuData}
            filters={filters}
            loading={loading}
            onSKUClick={handleSKUClick}
            onDemandClick={handleDemandClick}
            poBuilderMode={poBuilderMode}
            poSelectedSKUs={poSelectedSKUs}
            onSugQtyClick={handleSugQtyClick}
          />
        </>
      )}

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
      />

      {/* ─── PO Builder Components ─────────────────────────────────────────── */}
      <QtyConfirmDialog
        open={qtyDialogOpen}
        onOpenChange={setQtyDialogOpen}
        sku={qtyDialogRow?.sku ?? ''}
        product={qtyDialogRow?.product ?? ''}
        suggestedQty={(qtyDialogRow?.suggestedQty || qtyDialogRow?.softSuggestedQty) ?? 0}
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
