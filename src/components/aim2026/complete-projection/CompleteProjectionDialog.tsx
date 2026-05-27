// =============================================================================
// AIM 2026 — Complete Projection: container modal
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';
import { HelpCircle, Sparkles, X, Container as ContainerIcon, Factory } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SKURow, POBuilderItem, POType } from '@/lib/aim2026/types';
import {
  buildProjectionRows, buildChartSeries, daysBetween, addDays, SCENARIO_LABEL,
  buildPipelineEvents,
  type Scenario, type ProjectionRow, type PipelineEvent,
} from './projection';
import { fetchRecentOrders, fetchDemandWarehouseSplit } from '@/lib/aim2026/api';
import { ProjectionTable, type SortCol, type SortState } from './ProjectionTable';
import { SkuProjectionPanel } from './SkuProjectionPanel';
import { CompleteProjectionHelpPopup } from './HelpPopup';
import { POBuilderPanel } from '../POBuilderPanel';

interface DateRange { from?: Date; to?: Date; }

interface CompleteProjectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filteredData: SKURow[];
  dateRange?: DateRange;
  setDateRange?: (range: DateRange) => void;
  demandIsDaily: boolean;
  onAddProjectionItem?: (sku: string, qty: number, poType: 'Container' | 'Production', projectionDate?: string) => void;
  /** True when the dashboard's PO Builder mode is active. Auto-exits our
   *  internal poMode on true→false transition (e.g. user cleared cart). */
  poBuilderMode?: boolean;
  /** Cart actual del dashboard. Fuente de verdad única para la columna
   *  Container Load — cambios externos (remove/edit qty desde POBuilderPanel)
   *  se reflejan instantáneamente porque derivamos addedSkus de acá. */
  poItems?: POBuilderItem[];
  /** Handlers del cart — el modal renderiza el POBuilderPanel adentro cuando
   *  está abierto (docked o flotante). El Dashboard lo oculta mientras tanto. */
  onPORemove?: (sku: string, poType: POType) => void;
  onPOUpdateQty?: (sku: string, poType: POType, qty: number) => void;
  onPOClear?: () => void;
  onCreatePO?: () => Promise<void>;
  poCreating?: boolean;
}

export type DemandUnit = 'daily' | 'monthly';
export type PoMode = 'container' | 'production' | null;

const COVERAGE_PRESETS = [60, 90, 120];
const STATUS_RANK: Record<ProjectionRow['status'], number> = { stockout: 0, atrisk: 1, healthy: 2, surplus: 3 };
const PRESETS = [30, 60, 90, 120];
const SCENARIOS: Scenario[] = ['optimistic', 'expected', 'pessimistic'];
const CART_DOCKED_KEY = 'aim2026-po-cart-docked';

function startOfToday(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

export function CompleteProjectionDialog({
  open, onOpenChange, filteredData, dateRange, setDateRange, demandIsDaily,
  onAddProjectionItem, poBuilderMode = false, poItems,
  onPORemove, onPOUpdateQty, onPOClear, onCreatePO, poCreating = false,
}: CompleteProjectionDialogProps) {
  const today = useMemo(() => startOfToday(), []);
  const [projectionDate, setProjectionDate] = useState<Date>(() => addDays(startOfToday(), 60));
  const [scenario, setScenario] = useState<Scenario>('expected');
  const [search, setSearch] = useState('');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [expandedSoh, setExpandedSoh] = useState(false);
  const [expandedConsumed, setExpandedConsumed] = useState(false);
  const [demandUnit, setDemandUnit] = useState<DemandUnit>('monthly');
  const [coverageDays, setCoverageDays] = useState(90);
  const [poMode, setPoMode] = useState<PoMode>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showAllSkus, setShowAllSkus] = useState(false);
  // Cart docked vs flotante. Default = docked (anclado a la derecha del modal).
  // Persiste en localStorage para respetar la elección del user entre sesiones.
  const [cartDocked, setCartDocked] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(CART_DOCKED_KEY);
      return saved === null ? true : saved === 'true';
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(CART_DOCKED_KEY, String(cartDocked)); } catch { /* */ }
  }, [cartDocked]);

  const [sort, setSort] = useState<SortState>({ col: 'effDailyDemand', dir: 'desc' });
  const [eventsBySku, setEventsBySku] = useState<Map<string, PipelineEvent[]>>(new Map());
  const [eventsLoading, setEventsLoading] = useState(false);
  const [chinaDailyBySku, setChinaDailyBySku] = useState<Map<string, number>>(new Map());
  const [chinaDemandLoading, setChinaDemandLoading] = useState(false);
  const [applyChinaCommitments, setApplyChinaCommitments] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProjectionDate(addDays(startOfToday(), 60));
    setCoverageDays(90);
    setScenario('expected');
    setSearch('');
    setSelectedGroups(new Set());
    setSelectedSku(null);
    setExpandedSoh(false);
    setExpandedConsumed(false);
    setDemandUnit('monthly');
    setPoMode(null);
    setShowAllSkus(false);
    setSort({ col: 'effDailyDemand', dir: 'desc' });
    setEventsBySku(new Map());
    setChinaDailyBySku(new Map());
    setApplyChinaCommitments(false);
    if (setDateRange) setDateRange({ from: new Date(2026, 0, 1), to: startOfToday() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-exit internal poMode when parent dashboard exits PO Builder mode
  // (user clicked trash on POBuilderPanel). Watches for true→false transition.
  const prevPoBuilderMode = useRef(poBuilderMode);
  useEffect(() => {
    if (prevPoBuilderMode.current && !poBuilderMode && poMode) {
      setPoMode(null);
      // addedSkus se deriva de poItems — el clear del cart externo ya lo vacía.
    }
    prevPoBuilderMode.current = poBuilderMode;
  }, [poBuilderMode, poMode]);

  // Fetch real PO ETAs for SKUs with any inbound stock — production OR
  // container OR DHL. Production POs land in China (counted in pipelineReceived).
  // Container/DHL POs land in Main (counted in mainAtArrival). Both feed the
  // projection. One HTTP call per SKU (Promise.all).
  useEffect(() => {
    if (!open) return;
    const skus = filteredData
      .filter((r) => r.onProduction > 0 || r.container > 0 || r.dhl > 0)
      .map((r) => r.sku);
    if (skus.length === 0) { setEventsBySku(new Map()); return; }
    let cancelled = false;
    setEventsLoading(true);
    Promise.all(
      skus.map((sku) =>
        fetchRecentOrders(sku).then((orders) => {
          const row = filteredData.find((r) => r.sku === sku)!;
          return [sku, buildPipelineEvents(orders, row, today)] as const;
        }).catch(() => [sku, [] as PipelineEvent[]] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      setEventsBySku(new Map(pairs));
      setEventsLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filteredData]);

  useEffect(() => {
    if (!open || !applyChinaCommitments) return;
    if (chinaDailyBySku.size > 0) return;
    const from = dateRange?.from;
    const to = dateRange?.to;
    if (!from || !to) return;
    const fromStr = format(from, 'yyyy-MM-dd');
    const toStr = format(to, 'yyyy-MM-dd');
    const days = Math.max(daysBetween(from, to), 1);
    let cancelled = false;
    setChinaDemandLoading(true);
    fetchDemandWarehouseSplit(fromStr, toStr).then((res) => {
      if (cancelled) return;
      const map = new Map<string, number>();
      for (const item of res.data) {
        if (item.warehouse !== 'China-W') continue;
        const daily = item.qty / days;
        if (daily > 0) map.set(item.sku, daily);
      }
      setChinaDailyBySku(map);
      setChinaDemandLoading(false);
    }).catch(() => { if (!cancelled) setChinaDemandLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, applyChinaCommitments, dateRange?.from, dateRange?.to]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    document.body.style.pointerEvents = 'auto';
    return () => { document.body.style.pointerEvents = ''; };
  }, [open]);

  const groups = useMemo(
    () => [...new Set(filteredData.map((r) => r.productGroup))].filter(Boolean).sort(),
    [filteredData],
  );

  const skuMap = useMemo(() => {
    const m = new Map<string, SKURow>();
    for (const r of filteredData) m.set(r.sku, r);
    return m;
  }, [filteredData]);

  const allRows = useMemo(
    () => buildProjectionRows(
      filteredData, projectionDate, today, scenario, demandIsDaily, coverageDays,
      eventsBySku, applyChinaCommitments, chinaDailyBySku,
    ),
    [filteredData, projectionDate, today, scenario, demandIsDaily, coverageDays, eventsBySku, applyChinaCommitments, chinaDailyBySku],
  );

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = allRows;
    if (q) rows = rows.filter((r) => r.sku.toLowerCase().includes(q));
    if (selectedGroups.size > 0) rows = rows.filter((r) => selectedGroups.has(r.group));
    if (!showAllSkus) {
      if (poMode === 'container') rows = rows.filter((r) => r.containerLoadQty > 0);
      else if (poMode === 'production') rows = rows.filter((r) => r.productionQty > 0);
    }

    const dir = sort.dir === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      let cmp: number;
      if (sort.col === 'sku') cmp = a.sku.localeCompare(b.sku);
      else if (sort.col === 'status') cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      else {
        const av = a[sort.col] as number;
        const bv = b[sort.col] as number;
        cmp = (isFinite(av) ? av : Number.MAX_SAFE_INTEGER) - (isFinite(bv) ? bv : Number.MAX_SAFE_INTEGER);
      }
      return cmp * dir;
    });
    return sorted;
  }, [allRows, search, selectedGroups, sort, poMode, showAllSkus]);

  const selectedRow = useMemo(
    () => (selectedSku ? allRows.find((r) => r.sku === selectedSku) ?? null : null),
    [allRows, selectedSku],
  );

  const series = useMemo(() => {
    if (!selectedSku) return null;
    const raw = skuMap.get(selectedSku);
    if (!raw) return null;
    return buildChartSeries(raw, today, scenario, demandIsDaily, 180, eventsBySku.get(selectedSku));
  }, [selectedSku, skuMap, today, scenario, demandIsDaily, eventsBySku]);

  const onSort = (col: SortCol) =>
    setSort((p) => (p.col === col ? { col, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));

  const onRowClick = (sku: string) => setSelectedSku((p) => (p === sku ? null : sku));

  /** addedSkus derivado del cart externo. */
  const addedSkus = useMemo(() => {
    const m = new Map<string, { container: number; production: number }>();
    for (const it of poItems ?? []) {
      const cur = m.get(it.sku) ?? { container: 0, production: 0 };
      if (it.poType === 'Container') cur.container += it.quantity;
      else cur.production += it.quantity;
      m.set(it.sku, cur);
    }
    return m;
  }, [poItems]);

  const onAddToCart = (sku: string, customQty?: number, forceType?: 'Container' | 'Production') => {
    if (!poMode || !onAddProjectionItem) return;
    const row = allRows.find((r) => r.sku === sku);
    if (!row) return;
    const skuRow = skuMap.get(sku);
    const packSize = Math.max(1, skuRow?.packSize ?? 1);
    const type: 'Container' | 'Production' = forceType ?? (poMode === 'container' ? 'Container' : 'Production');
    const suggested = type === 'Container' ? row.containerLoadQty : row.productionQty;
    const rawQty = customQty != null && customQty > 0 ? Math.round(customQty) : suggested;
    if (rawQty <= 0) return;
    const qty = packSize > 1
      ? Math.max(packSize, Math.round(rawQty / packSize) * packSize)
      : rawQty;
    const isoProjection = type === 'Container' ? format(projectionDate, 'yyyy-MM-dd') : undefined;
    onAddProjectionItem(sku, qty, type, isoProjection);
  };

  const enterPoMode = useCallback((mode: Exclude<PoMode, null>) => {
    setPoMode(mode);
    setSelectedSku(null);
  }, []);

  const tDays = daysBetween(today, projectionDate);
  const windowLabel = dateRange?.from && dateRange?.to
    ? `${format(dateRange.from, 'd MMM yyyy')} → ${format(dateRange.to, 'd MMM yyyy')} · ${daysBetween(dateRange.from, dateRange.to)}d`
    : 'Default demand window';
  const maxDate = addDays(today, 365);

  const showCart = !!(onAddProjectionItem && poItems && poItems.length > 0 && onPORemove && onPOUpdateQty && onPOClear && onCreatePO);
  const cartCollapsed = showCart && cartDocked && !!selectedRow;

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Complete Projection"
      className="pointer-events-auto fixed inset-0 z-[55] flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f5]"
    >
      {/* ─── Header (compact) ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-2.5">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#ede9fe]"><Sparkles size={18} className="text-[#7c3aed]" /></span>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-[#0f1115]">Complete Projection</h2>
            <span className="inline-flex items-center rounded-full bg-[#ede9fe] px-2 py-0.5 text-[10px] font-bold leading-none text-[#4c1d95]">NEW</span>
            {eventsLoading && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-[#ede9fe] px-2 py-0.5 text-[10px] font-semibold text-[#4c1d95]">loading real ETAs…</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            title="How this works: formulas, modes and column meanings"
            className="inline-flex items-center gap-1 rounded-md border border-[#e8e8e3] bg-white px-2 py-1.5 text-xs font-medium text-[#5b6270] hover:bg-[#faf9f7] hover:text-[#2a2f38]"
          >
            <HelpCircle size={14} /> Help
          </button>
          <button type="button" className="rounded-md bg-[#0f1115] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#2a2f38]">Export projection</button>
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-md p-1.5 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]" aria-label="Close"><X size={20} /></button>
        </div>
      </div>

      <CompleteProjectionHelpPopup open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* ─── Body: sidebar | main | cart ─────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar izquierdo */}
        <aside className="flex w-[240px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-[#e8e8e3] bg-[#fbfbf9] px-3 py-3 text-sm">
          <SidebarSection title={poMode === 'container' ? 'Container loading date' : poMode === 'production' ? 'Production target date' : 'Projection date'}>
            <div className="flex items-center gap-2">
              <input type="date" value={format(projectionDate, 'yyyy-MM-dd')} min={format(today, 'yyyy-MM-dd')} max={format(maxDate, 'yyyy-MM-dd')}
                onChange={(e) => { if (e.target.value) setProjectionDate(new Date(e.target.value + 'T00:00:00')); }}
                className="h-8 flex-1 rounded-md border border-[#e8e8e3] bg-white px-2 text-xs text-[#2a2f38] focus:outline-none" />
              <span className="rounded-full bg-[#f0f0ec] px-2 py-0.5 text-[11px] font-medium text-[#5b6270]">+{tDays}d</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {PRESETS.map((p) => {
                const active = tDays === p;
                return (
                  <button key={p} type="button" onClick={() => setProjectionDate(addDays(today, p))}
                    className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors',
                      active ? 'bg-[#0f1115] text-white' : 'bg-white text-[#5b6270] border border-[#e8e8e3] hover:bg-[#f0f0ec]')}>{p}d</button>
                );
              })}
            </div>
          </SidebarSection>

          <SidebarSection title="Stock coverage target">
            <div className="inline-flex overflow-hidden rounded-md border border-[#e8e8e3]">
              {COVERAGE_PRESETS.map((d) => {
                const active = coverageDays === d;
                return (
                  <button key={d} type="button" onClick={() => setCoverageDays(d)}
                    className={cn('px-2.5 py-1.5 text-xs font-medium transition-colors',
                      active ? 'bg-[#7c3aed] text-white' : 'bg-white text-[#5b6270] hover:bg-[#faf9f7]')}>{d}d</button>
                );
              })}
            </div>
          </SidebarSection>

          <SidebarSection title="Demand window">
            {setDateRange ? (
              <div className="flex flex-col gap-1">
                <input type="date" value={dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : ''}
                  onChange={(e) => setDateRange({ from: e.target.value ? new Date(e.target.value + 'T00:00:00') : undefined, to: dateRange?.to })}
                  className="h-7 rounded-md border border-[#e8e8e3] bg-white px-2 text-xs text-[#2a2f38] focus:outline-none" />
                <input type="date" value={dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : ''}
                  onChange={(e) => setDateRange({ from: dateRange?.from, to: e.target.value ? new Date(e.target.value + 'T00:00:00') : undefined })}
                  className="h-7 rounded-md border border-[#e8e8e3] bg-white px-2 text-xs text-[#2a2f38] focus:outline-none" />
                {dateRange?.from && dateRange?.to && (
                  <span className="self-end rounded-full bg-[#f0f0ec] px-2 py-0.5 text-[11px] font-medium text-[#5b6270]">{daysBetween(dateRange.from, dateRange.to)}d</span>
                )}
              </div>
            ) : (
              <span className="inline-flex h-7 items-center rounded-md border border-[#e8e8e3] bg-white px-2 text-xs text-[#5b6270]">{windowLabel}</span>
            )}
          </SidebarSection>

          <SidebarSection title="Demand scenario">
            <div className="flex flex-col overflow-hidden rounded-md border border-[#e8e8e3]">
              {SCENARIOS.map((s) => {
                const active = scenario === s;
                return (
                  <button key={s} type="button" onClick={() => setScenario(s)}
                    className={cn('px-2.5 py-1.5 text-left text-xs font-medium transition-colors',
                      active ? 'bg-[#0f1115] text-white' : 'bg-white text-[#5b6270] hover:bg-[#faf9f7]')}>{SCENARIO_LABEL[s]}</button>
                );
              })}
            </div>
          </SidebarSection>

          <SidebarSection title="Options">
            <label
              title="When on, subtracts Allocated China and projected China-W outbound demand from both On hand on date (global) and Available China on date. Off (default) = ignore commitments."
              className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                applyChinaCommitments ? 'border-[#7c3aed] bg-[#ede9fe] text-[#4c1d95]' : 'border-[#e8e8e3] bg-white text-[#5b6270] hover:bg-[#faf9f7]')}
            >
              <input
                type="checkbox"
                checked={applyChinaCommitments}
                onChange={(e) => setApplyChinaCommitments(e.target.checked)}
                className="h-3 w-3 accent-[#7c3aed]"
              />
              Apply China commitments{chinaDemandLoading && ' …'}
            </label>
            {poMode && (
              <label
                title={poMode === 'container'
                  ? 'Off: only SKUs that need Container Load. On: all SKUs — useful to manually add one the formula did not flag.'
                  : 'Off: only SKUs that need Production. On: all SKUs.'}
                className={cn('mt-1 flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                  showAllSkus ? 'border-[#7c3aed] bg-[#ede9fe] text-[#4c1d95]' : 'border-[#e8e8e3] bg-white text-[#5b6270] hover:bg-[#faf9f7]')}
              >
                <input
                  type="checkbox"
                  checked={showAllSkus}
                  onChange={() => setShowAllSkus((v) => !v)}
                  className="h-3 w-3 accent-[#7c3aed]"
                />
                Show all SKUs
              </label>
            )}
          </SidebarSection>

          {/* Shortcuts: solo Container mode tiene Ctrl+click = Production. */}
          <SidebarSection title="Shortcuts">
            <div className="space-y-1 text-[11px] text-[#5b6270]">
              <div className="flex items-center justify-between gap-2">
                <kbd className="rounded border border-[#e8e8e3] bg-white px-1.5 py-0.5 font-mono text-[10px]">Click</kbd>
                <span className="text-[#828a98]">→ Container</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <kbd className="rounded border border-[#e8e8e3] bg-white px-1.5 py-0.5 font-mono text-[10px]">Ctrl/Cmd+Click</kbd>
                <span className="text-[#828a98]">→ Production</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <kbd className="rounded border border-[#e8e8e3] bg-white px-1.5 py-0.5 font-mono text-[10px]">Alt+Click</kbd>
                <span className="text-[#828a98]">→ custom qty</span>
              </div>
              <p className="pt-1 text-[10px] italic text-[#a3a8b1]">*Container mode only</p>
            </div>
          </SidebarSection>

          {/* CTAs principales: dos botones apilados con jerarquía visual. */}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <CTAButton
              active={poMode === 'container'}
              primary
              icon={<ContainerIcon size={14} />}
              title="Load container"
              subtitle={`SKUs covered for ${coverageDays}d (Container)`}
              onClick={() => poMode === 'container' ? setPoMode(null) : enterPoMode('container')}
              disabled={!onAddProjectionItem}
            />
            <CTAButton
              active={poMode === 'production'}
              icon={<Factory size={14} />}
              title="Create Purchase Order"
              subtitle={`SKUs short of ${coverageDays}d coverage (Production)`}
              onClick={() => poMode === 'production' ? setPoMode(null) : enterPoMode('production')}
              disabled={!onAddProjectionItem}
            />
          </div>

          <div className="pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[#828a98]">Formula</p>
            <code className="mt-1 block font-mono text-[10px] leading-snug text-[#5b6270]">
              On hand = SOH_global<br />+ Pipeline·min(t/LT,1)<br />− DailyDemand·t
            </code>
          </div>
        </aside>

        {/* Main: tabla + (chart si hay SKU seleccionado) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
          <ProjectionTable
            rows={visibleRows} totalCount={allRows.length} projectionDate={projectionDate}
            search={search} onSearch={setSearch} groups={groups} selectedGroups={selectedGroups}
            onGroupsChange={setSelectedGroups} selectedSku={selectedSku} onRowClick={onRowClick}
            expandedSoh={expandedSoh} setExpandedSoh={setExpandedSoh}
            expandedConsumed={expandedConsumed} setExpandedConsumed={setExpandedConsumed}
            demandUnit={demandUnit} onToggleDemandUnit={() => setDemandUnit((u) => (u === 'daily' ? 'monthly' : 'daily'))}
            poMode={poMode} coverageDays={coverageDays} addedSkus={addedSkus} onAddToCart={onAddToCart} sort={sort} onSort={onSort}
            showAllSkus={showAllSkus} onToggleShowAllSkus={() => setShowAllSkus((v) => !v)}
          />
        </div>

        {/* Chart panel cuando hay SKU seleccionado */}
        {selectedRow && series && (
          <div className="w-[40%] min-w-[460px] shrink-0 border-l border-[#e8e8e3]">
            <SkuProjectionPanel row={selectedRow} series={series} today={today} projectionDate={projectionDate}
              onSetProjectionDate={setProjectionDate} onClose={() => setSelectedSku(null)}
              events={eventsBySku.get(selectedRow.sku)} poMode={poMode} />
          </div>
        )}

        {/* Cart docked (anclado o rail). Si !cartDocked se renderiza abajo como flotante. */}
        {showCart && cartDocked && (
          <POBuilderPanel
            items={poItems!}
            onRemove={onPORemove!}
            onUpdateQty={onPOUpdateQty!}
            onClear={onPOClear!}
            onCreatePO={onCreatePO!}
            creating={poCreating}
            docked
            collapsed={cartCollapsed}
            onToggleDocked={() => setCartDocked(false)}
            onExpandFromRail={() => setSelectedSku(null)}
          />
        )}
      </div>

      {/* Cart flotante (si !cartDocked). Se renderiza vía portal así que no afecta el layout. */}
      {showCart && !cartDocked && (
        <POBuilderPanel
          items={poItems!}
          onRemove={onPORemove!}
          onUpdateQty={onPOUpdateQty!}
          onClear={onPOClear!}
          onCreatePO={onCreatePO!}
          creating={poCreating}
          onToggleDocked={() => setCartDocked(true)}
        />
      )}
    </div>,
    document.body,
  );
}

// ─── Sidebar section helper ─────────────────────────────────────────────────

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#5b6270]">{title}</p>
      {children}
    </div>
  );
}

// ─── CTA button (Load container / Create PO) ───────────────────────────────-

function CTAButton({
  active, primary = false, icon, title, subtitle, onClick, disabled,
}: {
  active: boolean;
  primary?: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-[#7c3aed] bg-[#ede9fe] text-[#4c1d95]'
          : primary
            ? 'border-amber-300 text-[#3b1f00] hover:brightness-95'
            : 'border-[#e8e8e3] bg-white text-[#5b6270] hover:bg-[#faf9f7]',
      )}
      style={primary && !active ? { background: 'linear-gradient(180deg,#fbbf24,#f59e0b)' } : undefined}
    >
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        <span>{active ? `${title} · active` : title}</span>
      </div>
      <p className={cn('mt-0.5 text-[10px] leading-tight', active ? 'text-[#6d4ec9]' : primary ? 'text-[#7c4a16]' : 'text-[#828a98]')}>
        {subtitle}
      </p>
    </button>
  );
}
