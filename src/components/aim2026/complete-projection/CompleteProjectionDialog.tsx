// =============================================================================
// AIM 2026 — Complete Projection: container modal
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';
import { HelpCircle, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SKURow, POBuilderItem } from '@/lib/aim2026/types';
import {
  buildProjectionRows, buildChartSeries, daysBetween, addDays, SCENARIO_LABEL,
  buildPipelineEvents,
  type Scenario, type ProjectionRow, type PipelineEvent,
} from './projection';
import { fetchRecentOrders, fetchDemandWarehouseSplit } from '@/lib/aim2026/api';
import { ProjectionTable, type SortCol, type SortState } from './ProjectionTable';
import { SkuProjectionPanel } from './SkuProjectionPanel';
import { CompleteProjectionHelpPopup } from './HelpPopup';

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
}

export type DemandUnit = 'daily' | 'monthly';
export type PoMode = 'container' | 'production' | null;

const COVERAGE_PRESETS = [60, 90, 120];
const STATUS_RANK: Record<ProjectionRow['status'], number> = { stockout: 0, atrisk: 1, healthy: 2, surplus: 3 };
const PRESETS = [30, 60, 90, 120];
const SCENARIOS: Scenario[] = ['optimistic', 'expected', 'pessimistic'];

function startOfToday(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

export function CompleteProjectionDialog({
  open, onOpenChange, filteredData, dateRange, setDateRange, demandIsDaily,
  onAddProjectionItem, poBuilderMode = false, poItems,
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
  const [poMenuOpen, setPoMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ col: 'effDailyDemand', dir: 'desc' });
  // Real PO ETAs per SKU. When loaded, projection uses them instead of the
  // linear-by-leadTime approximation. Fetched once on open for SKUs that have
  // onProduction > 0 (only those need real ETA tracking — DHL/Container are
  // already counted in sohGlobal).
  const [eventsBySku, setEventsBySku] = useState<Map<string, PipelineEvent[]>>(new Map());
  const [eventsLoading, setEventsLoading] = useState(false);
  // China-W outbound demand per SKU (daily units). When "Apply China commitments"
  // toggle is on, we subtract both allocatedChina and this projected demand from
  // availableChinaOnDate. Default off — Dolo prioritises B2C and allocations
  // aren't firm commitments.
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
    setPoMenuOpen(false);
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

  // Fetch real PO ETAs for SKUs with onProduction > 0. One HTTP call per SKU
  // (Promise.all). For ~50–100 production SKUs this completes in a few seconds;
  // the projection falls back to the linear approximation while loading.
  useEffect(() => {
    if (!open) return;
    const skus = filteredData.filter((r) => r.onProduction > 0).map((r) => r.sku);
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

  // China-W outbound demand per SKU, for the same date range used as the demand
  // window. We only need this when the user enables the toggle; we fetch it
  // lazily on first toggle-on so the open flow stays fast.
  useEffect(() => {
    if (!open || !applyChinaCommitments) return;
    if (chinaDailyBySku.size > 0) return; // already loaded
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

  // Force-clear body pointer-events. Never restore captured value: Radix may
  // have set 'none' just before mount (Reports dropdown closing into our open)
  // and that captured state is stale by unmount → would leave page unclickable.
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
    // Container mode: SKUs where Main alone would cover the gap (containerLoadQty
    // is the deficit at arrival). Production mode: SKUs that need production.
    if (poMode === 'container') rows = rows.filter((r) => r.containerLoadQty > 0);
    else if (poMode === 'production') rows = rows.filter((r) => r.productionQty > 0);

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
  }, [allRows, search, selectedGroups, sort, poMode]);

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

  /** addedSkus derivado del cart externo. Map<sku, {container, production}>.
   *  Si removés/editás desde POBuilderPanel, la columna refleja el cambio
   *  inmediatamente porque poItems es la fuente de verdad. */
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

  /** Add a SKU to the container or production cart. `forceType` lets us route
   *  the split prompt to production while staying in container poMode. */
  const onAddToCart = (sku: string, customQty?: number, forceType?: 'Container' | 'Production') => {
    if (!poMode || !onAddProjectionItem) return;
    const row = allRows.find((r) => r.sku === sku);
    if (!row) return;
    const type: 'Container' | 'Production' = forceType ?? (poMode === 'container' ? 'Container' : 'Production');
    const suggested = type === 'Container' ? row.containerLoadQty : row.productionQty;
    const qty = customQty != null && customQty > 0 ? Math.round(customQty) : suggested;
    if (qty <= 0) return;
    // El dashboard hace no-op si ya existe (sku, type) — coherente con la decisión
    // de "modificar manualmente desde el panel". projectionDate solo aplica a
    // Container — el handler la usa para calcular DeliveryDate = projectionDate + 30d.
    const isoProjection = type === 'Container' ? format(projectionDate, 'yyyy-MM-dd') : undefined;
    onAddProjectionItem(sku, qty, type, isoProjection);
  };

  const enterPoMode = (mode: Exclude<PoMode, null>) => {
    setPoMode(mode);
    setPoMenuOpen(false);
    setSelectedSku(null);
  };

  const tDays = daysBetween(today, projectionDate);
  const windowLabel = dateRange?.from && dateRange?.to
    ? `${format(dateRange.from, 'd MMM yyyy')} → ${format(dateRange.to, 'd MMM yyyy')} · ${daysBetween(dateRange.from, dateRange.to)}d`
    : 'Default demand window';
  const maxDate = addDays(today, 365);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Complete Projection"
      className="pointer-events-auto fixed inset-0 z-[55] flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f5]"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#ede9fe]"><Sparkles size={18} className="text-[#7c3aed]" /></span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-[#0f1115]">Complete Projection</h2>
              <span className="inline-flex items-center rounded-full bg-[#ede9fe] px-2 py-0.5 text-[10px] font-bold leading-none text-[#4c1d95]">NEW</span>
            </div>
            <p className="text-sm text-[#828a98]">On-hand forecast per SKU · demand · global SOH · pipeline arrivals{eventsLoading && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[#ede9fe] px-2 py-0.5 text-[10px] font-semibold text-[#4c1d95]">loading real ETAs…</span>
            )}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            title="How this works: formulas, modes and column meanings"
            className="inline-flex items-center gap-1 rounded-md border border-[#e8e8e3] bg-white px-2 py-1.5 text-xs font-medium text-[#5b6270] hover:bg-[#faf9f7] hover:text-[#2a2f38]"
            aria-label="Help"
          >
            <HelpCircle size={14} /> Help
          </button>
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-md p-1.5 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]" aria-label="Close"><X size={20} /></button>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-end gap-6 border-b border-[#e8e8e3] bg-[#fbfbf9] px-5 py-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5b6270]">
            {poMode === 'container' ? 'Container loading date' : poMode === 'production' ? 'Production target date' : 'Projection date'}
          </label>
          <div className="flex items-center gap-2">
            <input type="date" value={format(projectionDate, 'yyyy-MM-dd')} min={format(today, 'yyyy-MM-dd')} max={format(maxDate, 'yyyy-MM-dd')}
              onChange={(e) => { if (e.target.value) setProjectionDate(new Date(e.target.value + 'T00:00:00')); }}
              className="h-9 rounded-md border border-[#e8e8e3] bg-white px-2.5 text-sm text-[#2a2f38] focus:outline-none" />
            <span className="rounded-full bg-[#f0f0ec] px-2.5 py-1 text-sm font-medium text-[#5b6270]">+{tDays}d</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {PRESETS.map((p) => {
              const active = tDays === p;
              return (
                <button key={p} type="button" onClick={() => setProjectionDate(addDays(today, p))}
                  className={cn('rounded-full px-2.5 py-1 text-sm font-medium transition-colors', active ? 'bg-[#0f1115] text-white' : 'bg-white text-[#5b6270] border border-[#e8e8e3] hover:bg-[#f0f0ec]')}>{p}d</button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5b6270]">Stock coverage target</label>
          <div className="inline-flex overflow-hidden rounded-md border border-[#e8e8e3]">
            {COVERAGE_PRESETS.map((d) => {
              const active = coverageDays === d;
              return (
                <button key={d} type="button" onClick={() => setCoverageDays(d)}
                  className={cn('px-3 py-2 text-sm font-medium transition-colors', active ? 'bg-[#7c3aed] text-white' : 'bg-white text-[#5b6270] hover:bg-[#faf9f7]')}>{d}d</button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5b6270]">Demand window</label>
          {setDateRange ? (
            <div className="flex items-center gap-1.5">
              <input type="date" value={dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : ''}
                onChange={(e) => setDateRange({ from: e.target.value ? new Date(e.target.value + 'T00:00:00') : undefined, to: dateRange?.to })}
                className="h-9 rounded-md border border-[#e8e8e3] bg-white px-2.5 text-sm text-[#2a2f38] focus:outline-none" />
              <span className="text-sm text-[#828a98]">→</span>
              <input type="date" value={dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : ''}
                onChange={(e) => setDateRange({ from: dateRange?.from, to: e.target.value ? new Date(e.target.value + 'T00:00:00') : undefined })}
                className="h-9 rounded-md border border-[#e8e8e3] bg-white px-2.5 text-sm text-[#2a2f38] focus:outline-none" />
              {dateRange?.from && dateRange?.to && (
                <span className="rounded-full bg-[#f0f0ec] px-2.5 py-1 text-sm font-medium text-[#5b6270]">{daysBetween(dateRange.from, dateRange.to)}d</span>
              )}
            </div>
          ) : (
            <span className="inline-flex h-9 items-center rounded-md border border-[#e8e8e3] bg-white px-2.5 text-sm text-[#5b6270]">{windowLabel}</span>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5b6270]">Demand scenario</label>
          <div className="inline-flex overflow-hidden rounded-md border border-[#e8e8e3]">
            {SCENARIOS.map((s) => {
              const active = scenario === s;
              return (
                <button key={s} type="button" onClick={() => setScenario(s)}
                  className={cn('px-3 py-2 text-sm font-medium transition-colors', active ? 'bg-[#0f1115] text-white' : 'bg-white text-[#5b6270] hover:bg-[#faf9f7]')}>{SCENARIO_LABEL[s]}</button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#5b6270]">China commitments</label>
          <label
            title="When on, subtracts Allocated China (units reserved against pending sales orders) and projected China-W outbound demand from both On hand on date (global) and Available China on date. Off (default) = ignore commitments — Dolo prioritises B2C and most allocations aren't firm."
            className={cn('inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium cursor-pointer transition-colors',
              applyChinaCommitments ? 'border-[#7c3aed] bg-[#ede9fe] text-[#4c1d95]' : 'border-[#e8e8e3] bg-white text-[#5b6270] hover:bg-[#faf9f7]')}
          >
            <input
              type="checkbox"
              checked={applyChinaCommitments}
              onChange={(e) => setApplyChinaCommitments(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#7c3aed]"
            />
            Apply China commitments{chinaDemandLoading && ' (loading…)'}
          </label>
        </div>
      </div>

      {poMode && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#ddd6fe] bg-[#ede9fe] px-5 py-2">
          <div className="text-sm text-[#4c1d95]">
            <span className="font-semibold">{poMode === 'container' ? 'Load container' : 'Create Purchase Order'}</span>
            {' '}· showing SKUs {poMode === 'container' ? 'covered for' : 'short of'} {coverageDays}d coverage · click the violet cell on each row to add
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPoMode(null)} className="rounded-md border border-[#c4b5fd] bg-white px-2.5 py-1 text-xs font-medium text-[#4c1d95] hover:bg-[#f5f3ff]">Exit PO mode</button>
          </div>
        </div>
      )}

      <CompleteProjectionHelpPopup open={helpOpen} onClose={() => setHelpOpen(false)} />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
          <ProjectionTable
            rows={visibleRows} totalCount={allRows.length} projectionDate={projectionDate}
            search={search} onSearch={setSearch} groups={groups} selectedGroups={selectedGroups}
            onGroupsChange={setSelectedGroups} selectedSku={selectedSku} onRowClick={onRowClick}
            expandedSoh={expandedSoh} setExpandedSoh={setExpandedSoh}
            expandedConsumed={expandedConsumed} setExpandedConsumed={setExpandedConsumed}
            demandUnit={demandUnit} onToggleDemandUnit={() => setDemandUnit((u) => (u === 'daily' ? 'monthly' : 'daily'))}
            poMode={poMode} coverageDays={coverageDays} addedSkus={addedSkus} onAddToCart={onAddToCart} sort={sort} onSort={onSort}
          />
        </div>
        {selectedRow && series && (
          <div className="w-[40%] min-w-[460px] shrink-0 border-l border-[#e8e8e3]">
            <SkuProjectionPanel row={selectedRow} series={series} today={today} projectionDate={projectionDate}
              onSetProjectionDate={setProjectionDate} onClose={() => setSelectedSku(null)}
              events={eventsBySku.get(selectedRow.sku)} poMode={poMode} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-[#e8e8e3] bg-white px-5 py-2.5">
        <code className="font-mono text-xs text-[#828a98]">On hand = SOH_global + Pipeline·min(t/LT,1) − DailyDemand·t</code>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-md border border-[#e8e8e3] bg-white px-3 py-1.5 text-sm font-medium text-[#5b6270] hover:bg-[#faf9f7]">Close</button>
          <button type="button" className="rounded-md bg-[#0f1115] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#2a2f38]">Export projection</button>
          <div className="relative">
            <button type="button" disabled={!onAddProjectionItem} onClick={() => setPoMenuOpen((o) => !o)}
              className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#3b1f00] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: 'linear-gradient(180deg,#fbbf24,#f59e0b)' }}>Create PO ▾</button>
            {poMenuOpen && onAddProjectionItem && (
              <div className="absolute bottom-full right-0 z-50 mb-1 w-56 overflow-hidden rounded-md border border-[#e8e8e3] bg-white shadow-lg">
                <button type="button" onClick={() => enterPoMode('container')} className="block w-full px-3 py-2 text-left text-sm text-[#2a2f38] hover:bg-[#faf9f7]">
                  <span className="font-semibold">Load container</span>
                  <span className="block text-xs text-[#828a98]">SKUs already covered for {coverageDays}d (Container)</span>
                </button>
                <button type="button" onClick={() => enterPoMode('production')} className="block w-full border-t border-[#f0f0ec] px-3 py-2 text-left text-sm text-[#2a2f38] hover:bg-[#faf9f7]">
                  <span className="font-semibold">Create Purchase Order</span>
                  <span className="block text-xs text-[#828a98]">SKUs short of {coverageDays}d coverage (Production)</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

