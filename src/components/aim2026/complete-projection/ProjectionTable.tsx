// =============================================================================
// AIM 2026 — Complete Projection: SKU-level projection table
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronUp, Search, ExternalLink, ListFilter, Download, ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectionRow, ProjectionStatus } from './projection';
import type { DemandUnit } from './CompleteProjectionDialog';
import { GroupsFilter } from './GroupsFilter';

const STATUS_STYLE: Record<ProjectionStatus, { label: string; cls: string }> = {
  stockout: { label: 'Stockout', cls: 'bg-red-50 text-[#dc2626] border-red-200' },
  atrisk: { label: 'At risk', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  surplus: { label: 'Surplus', cls: 'bg-blue-50 text-[#2563eb] border-blue-200' },
  healthy: { label: 'Healthy', cls: 'bg-emerald-50 text-[#059669] border-emerald-200' },
};

export function StatusPill({ status, className }: { status: ProjectionStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold leading-tight whitespace-nowrap', s.cls, className)}>
      {s.label}
    </span>
  );
}

export type SortCol = 'sku' | 'effDailyDemand' | 'sohGlobal' | 'pipeline' | 'demandConsumed' | 'projectedOnHand' | 'availableChinaOnDate' | 'daysOfCover' | 'status';
export interface SortState { col: SortCol; dir: 'asc' | 'desc'; }

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const dec = (n: number) => n.toFixed(2);
const mono = 'font-mono tabular-nums';

interface ProjectionTableProps {
  rows: ProjectionRow[];
  totalCount: number;
  projectionDate: Date;
  search: string;
  onSearch: (v: string) => void;
  groups: string[];
  selectedGroups: Set<string>;
  onGroupsChange: (next: Set<string>) => void;
  selectedSku: string | null;
  onRowClick: (sku: string) => void;
  expandedSoh: boolean;
  setExpandedSoh: (v: boolean) => void;
  expandedConsumed: boolean;
  setExpandedConsumed: (v: boolean) => void;
  demandUnit: DemandUnit;
  onToggleDemandUnit: () => void;
  poMode: 'container' | 'production' | null;
  coverageDays: number;
  addedSkus: Map<string, number>;
  onAddToCart: (sku: string, customQty?: number) => void;
  sort: SortState;
  onSort: (col: SortCol) => void;
}

export function ProjectionTable({
  rows, totalCount, projectionDate, search, onSearch, groups, selectedGroups, onGroupsChange,
  selectedSku, onRowClick, expandedSoh, setExpandedSoh,
  expandedConsumed, setExpandedConsumed, demandUnit, onToggleDemandUnit, poMode, coverageDays, addedSkus,
  onAddToCart, sort, onSort,
}: ProjectionTableProps) {
  const colCount = 8 + (expandedSoh ? 3 : 0) + (poMode ? 1 : 0);
  // Inline custom-qty editor: when the user clicks "+ add" on a SKU with no
  // suggested qty, the cell turns into a numeric input focused immediately.
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const editingInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editingSku && editingInputRef.current) {
      editingInputRef.current.focus();
      editingInputRef.current.select();
    }
  }, [editingSku]);
  const commitCustomQty = (sku: string) => {
    const qty = parseInt(editingValue.replace(/[^0-9]/g, ''), 10);
    setEditingSku(null);
    setEditingValue('');
    if (isFinite(qty) && qty > 0) onAddToCart(sku, qty);
  };
  const cancelCustomQty = () => { setEditingSku(null); setEditingValue(''); };

  const Th = ({ col, children, align = 'right' }: { col: SortCol; children: React.ReactNode; align?: 'left' | 'right' }) => {
    const activeSort = sort.col === col;
    return (
      <th
        onClick={() => onSort(col)}
        className={cn(
          'cursor-pointer select-none px-2.5 py-2 text-sm font-semibold uppercase tracking-wide text-[#5b6270] hover:text-[#2a2f38]',
          align === 'right' ? 'text-right' : 'text-left',
        )}
      >
        <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
          {children}
          {activeSort && (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
        </span>
      </th>
    );
  };

  const violetCell = 'bg-[#ede9fe]/50';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#e8e8e3] bg-white">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[#e8e8e3] px-3.5 py-2.5">
        <div>
          <div className="text-sm font-bold uppercase tracking-wide text-[#0f1115]">SKU-level projection</div>
          <div className="mt-0.5 text-sm text-[#828a98]">
            {format(projectionDate, 'd MMM yyyy')} · {rows.length} of {totalCount} SKUs ·{' '}
            {poMode ? 'click a row for the curve · click the violet cell to add to the PO' : 'click a row for the curve'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-[#e8e8e3] px-2 py-1 text-xs font-medium text-[#5b6270]"><ListFilter size={12} /> Status</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#e8e8e3] px-2 py-1 text-xs font-medium text-[#5b6270]"><Download size={12} /> Export</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] px-3.5 py-2">
        <div className="relative w-64 max-w-[60%]">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#b6bcc7]" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search SKU…"
            className="h-9 w-full rounded-md border border-[#e8e8e3] bg-white pl-8 pr-2 text-sm text-[#2a2f38] placeholder:text-[#b6bcc7] focus:border-[#d8d8d2] focus:outline-none"
          />
        </div>
        <GroupsFilter groups={groups} selected={selectedGroups} onChange={onGroupsChange} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            {expandedSoh && (
              <tr className="border-b border-[#f0f0ec]">
                <th colSpan={2} />
                <th colSpan={4} onClick={() => setExpandedSoh(false)} className={cn('cursor-pointer px-2.5 py-1 text-center text-xs font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>
                  <span className="inline-flex items-center gap-1">SOH global breakdown · Main + China + DHL + Container <ChevronUp size={12} /></span>
                </th>
                <th colSpan={poMode ? 6 : 5} />
              </tr>
            )}
            <tr className="border-b border-[#e8e8e3]">
              <th onClick={() => onSort('sku')} style={{ width: '1px' }} className="cursor-pointer select-none whitespace-nowrap px-2.5 py-2.5 text-left text-sm font-semibold uppercase tracking-wide text-[#5b6270] hover:text-[#2a2f38]">
                <span className="inline-flex items-center gap-1">
                  SKU{sort.col === 'sku' && (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                </span>
              </th>
              <th onClick={onToggleDemandUnit} title="Toggle daily / monthly" className="cursor-pointer select-none whitespace-nowrap px-2.5 py-2.5 text-right text-sm font-semibold uppercase tracking-wide text-[#5b6270] hover:text-[#2a2f38]">
                <span className="inline-flex flex-row-reverse items-center gap-1">
                  {demandUnit === 'daily' ? 'Daily demand' : 'Monthly demand'}
                  <ArrowLeftRight size={12} className="text-[#7c3aed]" />
                </span>
              </th>

              {expandedSoh ? (
                <>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>Main</th>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>China</th>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>DHL</th>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>Container</th>
                </>
              ) : (
                <th onClick={() => setExpandedSoh(true)} className="cursor-pointer select-none px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#5b6270] hover:text-[#2a2f38]">
                  <span className="inline-flex flex-row-reverse items-center gap-1">SOH global <ChevronDown size={12} /></span>
                </th>
              )}

              <th title="Units on production in China — arriving via lead time. DHL and Container are already counted inside SOH global (available today)." className="px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#5b6270]">
                On Prod.
              </th>

              <th
                onClick={() => setExpandedConsumed(!expandedConsumed)}
                title={expandedConsumed ? 'Click to hide Allocated' : 'Click to fold Allocated into the consumed total'}
                className={cn('cursor-pointer select-none px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide hover:text-[#2a2f38]', expandedConsumed ? 'bg-[#ede9fe]/40 text-[#4c1d95]' : 'text-[#5b6270]')}
              >
                <span className="inline-flex flex-row-reverse items-center gap-1">
                  <span>{expandedConsumed ? 'Cons. + Alloc' : 'Consumed'}</span>
                  {expandedConsumed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </span>
              </th>
              {poMode === 'container' ? (
                <th
                  onClick={() => onSort('availableChinaOnDate')}
                  title="Units physically available in China on the projection date — what you can actually load into a container that day. Formula: (SOH China − Allocated China) + production POs arriving in China by that date. Does NOT subtract China outbound demand yet."
                  className={cn('cursor-pointer select-none px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide hover:text-[#2a2f38]', violetCell, 'text-[#4c1d95]')}
                >
                  <span className="inline-flex flex-col items-end leading-tight">
                    <span className="inline-flex flex-row-reverse items-center gap-1">
                      Available China on date
                      {sort.col === 'availableChinaOnDate' && (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </span>
                    <span className="text-[10px] font-medium normal-case tracking-normal text-[#7c3aed]">loadable units</span>
                  </span>
                </th>
              ) : (
                <Th col="projectedOnHand">On hand on date</Th>
              )}
              {poMode && (
                <th
                  title={
                    poMode === 'container'
                      ? `Container Load — units to load to guarantee the selected ${coverageDays}d stock coverage target after the container arrives. Computed as full demand over the coverage window (effective daily demand × ${coverageDays}d). Click any row's cell to add it to the PO draft.`
                      : `To Produce — units to manufacture to reach the selected ${coverageDays}d stock coverage target. Computed as the shortfall against (effective daily demand × ${coverageDays}d) minus projected on hand. Click any row's cell to add it to the PO draft.`
                  }
                  className={cn('px-2.5 py-2.5 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}
                >
                  <span className="inline-flex flex-col items-end leading-tight">
                    <span>{poMode === 'container' ? 'Container Load' : 'To Produce'}</span>
                    <span className="text-[10px] font-medium normal-case tracking-normal text-[#7c3aed]">click to add</span>
                  </span>
                </th>
              )}
              <Th col="daysOfCover">Cover</Th>
              <Th col="status" align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-3 py-16 text-center text-base text-[#828a98]">No SKUs match the current filters</td>
              </tr>
            ) : (
              rows.map((r) => {
                const selected = r.sku === selectedSku;
                const risky = r.status === 'atrisk' || r.status === 'stockout';
                return (
                  <tr
                    key={r.sku}
                    onClick={() => onRowClick(r.sku)}
                    className={cn('cursor-pointer border-b border-[#f3f3ef]', selected ? 'border-l-2 border-l-[#7c3aed] bg-[#ede9fe]/40' : risky ? 'bg-amber-50/60 hover:bg-amber-50' : 'hover:bg-[#faf9f7]')}
                  >
                    <td className={cn('whitespace-nowrap px-2.5 py-2 text-left text-sm font-medium', mono, 'text-[#2563eb]')}>
                      <span className="inline-flex items-center gap-1">{r.sku}{selected && <ExternalLink size={12} />}</span>
                    </td>
                    <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono)}>
                      {demandUnit === 'daily' ? dec(r.effDailyDemand) : num(r.effDailyDemand * 30)}
                    </td>

                    {expandedSoh ? (
                      <>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.sohMain)}</td>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.sohChina)}</td>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.dhl)}</td>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.container)}</td>
                      </>
                    ) : (
                      <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono)}>{num(r.sohGlobal)}</td>
                    )}

                    <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono)}>{num(r.onProd)}</td>

                    <td className={cn('px-2.5 py-2 text-right text-sm text-[#dc2626]', mono, expandedConsumed && 'bg-[#ede9fe]/30')}>
                      {expandedConsumed ? (
                        <span className="inline-flex flex-col items-end leading-tight">
                          <span>−{num(r.demandConsumed + r.allocated)}</span>
                          <span className="text-[10px] font-medium normal-case text-[#7c3aed]">allocated: {num(r.allocated)}</span>
                        </span>
                      ) : (<>−{num(r.demandConsumed)}</>)}
                    </td>
                    {poMode === 'container' ? (
                      <td
                        title={`Global on hand on date: ${num(r.projectedOnHand)}. Available China today: ${num(r.availableChinaToday)} + production arriving by date: ${num(r.pipelineReceived)} = ${num(r.availableChinaOnDate)}.`}
                        className={cn('px-2.5 py-2 text-right text-base font-bold', mono, violetCell, r.availableChinaOnDate <= 0 ? 'text-[#dc2626]' : 'text-[#0f1115]')}
                      >
                        <span className="inline-flex flex-col items-end leading-tight">
                          <span>{num(r.availableChinaOnDate)}</span>
                          <span className="text-[10px] font-medium normal-case text-[#7c3aed]">global: {num(r.projectedOnHand)}</span>
                        </span>
                      </td>
                    ) : (
                      <td className={cn('px-2.5 py-2 text-right text-base font-bold', mono, r.projectedOnHand <= 0 ? 'text-[#dc2626]' : 'text-[#0f1115]')}>
                        {num(r.projectedOnHand)}
                      </td>
                    )}
                    {poMode && (() => {
                      const added = addedSkus.get(r.sku);
                      const toCommit = poMode === 'container' ? Math.round(r.coverageDemand) : Math.round(r.neededQty);
                      const postSurplus = poMode === 'container' ? Math.round(Math.abs(r.neededQty)) : 0;
                      const hasSuggestion = toCommit > 0;
                      const isEditing = editingSku === r.sku;
                      // Coverage state — only meaningful for container mode with a suggestion.
                      // Violet = China cubre el load; amber = gap < 30% del load; red = gap ≥ 30%.
                      const chinaCover = Math.max(0, Math.round(r.availableChinaOnDate));
                      const gap = poMode === 'container' && hasSuggestion ? Math.max(0, toCommit - chinaCover) : 0;
                      const gapRatio = toCommit > 0 ? gap / toCommit : 0;
                      const coverState: 'covered' | 'partial' | 'short' =
                        poMode === 'container' && hasSuggestion
                          ? (gap <= 0 ? 'covered' : gapRatio < 0.3 ? 'partial' : 'short')
                          : 'covered';
                      const stateBg = coverState === 'covered' ? violetCell : coverState === 'partial' ? 'bg-amber-50' : 'bg-red-50';
                      const stateHover = coverState === 'covered' ? 'hover:bg-[#ddd6fe]' : coverState === 'partial' ? 'hover:bg-amber-100' : 'hover:bg-red-100';
                      const stateText = coverState === 'covered' ? 'text-[#7c3aed]' : coverState === 'partial' ? 'text-amber-700' : 'text-red-700';
                      const gapLabel = coverState !== 'covered' ? `cover ${num(chinaCover)} · short ${num(gap)}` : null;
                      const tip = added != null
                        ? `Added ${num(added)} to the PO. ${poMode === 'container' ? `Remaining China stock after load: ${num(postSurplus)} u.` : 'Shortfall covered.'}`
                        : hasSuggestion
                          ? (poMode === 'container'
                              ? (coverState === 'covered'
                                  ? `Click to load ${num(toCommit)} u. China can cover it. Hold Alt/Option to enter a custom qty.`
                                  : `Click to load ${num(toCommit)} u. China only covers ${num(chinaCover)} u (gap ${num(gap)}). Click adds the full qty — resolve the shortfall separately. Hold Alt/Option to enter a custom qty.`)
                              : `Click to produce ${num(toCommit)} u. Hold Alt/Option to enter a custom qty.`)
                          : (poMode === 'container'
                              ? 'No suggested qty — click to enter a custom load qty.'
                              : 'No suggested qty — click to enter a custom production qty.');
                      const startEditing = (defaultQty: number) => {
                        setEditingSku(r.sku);
                        setEditingValue(defaultQty > 0 ? String(defaultQty) : '');
                      };
                      return (
                        <td
                          title={isEditing ? '' : tip}
                          onClick={(e) => {
                            if (isEditing) { e.stopPropagation(); return; }
                            e.stopPropagation();
                            if (added != null) return;
                            if (!hasSuggestion) { startEditing(0); return; }
                            if (e.altKey) { startEditing(toCommit); return; }
                            onAddToCart(r.sku);
                          }}
                          className={cn('px-2.5 py-2 text-right text-base font-bold', mono, stateBg, added == null && !isEditing && cn('cursor-pointer', stateHover))}
                        >
                          {added != null ? (
                            <span className="inline-flex flex-col items-end gap-0.5 leading-tight">
                              <span className={cn('text-[#059669]', mono)}>{poMode === 'container' ? `+${num(postSurplus)}` : '✓'}</span>
                              <span className="text-[10px] font-medium normal-case text-[#7c3aed]">{poMode === 'container' ? `loaded: ${num(added)}` : `ordered: ${num(added)}`}</span>
                            </span>
                          ) : isEditing ? (
                            <span className="inline-flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              <input
                                ref={editingInputRef}
                                type="text"
                                inputMode="numeric"
                                value={editingValue}
                                onChange={(e) => setEditingValue(e.target.value.replace(/[^0-9]/g, ''))}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.preventDefault(); commitCustomQty(r.sku); }
                                  else if (e.key === 'Escape') { e.preventDefault(); cancelCustomQty(); }
                                }}
                                onBlur={() => commitCustomQty(r.sku)}
                                placeholder="qty"
                                className="w-20 rounded border border-[#c4b5fd] bg-white px-1.5 py-0.5 text-right text-sm font-bold text-[#4c1d95] focus:border-[#7c3aed] focus:outline-none"
                              />
                            </span>
                          ) : hasSuggestion ? (
                            gapLabel ? (
                              <span className="inline-flex flex-col items-end leading-tight">
                                <span className={cn('inline-flex items-center gap-1', stateText)}>
                                  {coverState === 'short' ? '⚠ ' : ''}+{num(toCommit)}
                                </span>
                                <span className={cn('text-[10px] font-medium normal-case', coverState === 'partial' ? 'text-amber-700' : 'text-red-700')}>{gapLabel}</span>
                              </span>
                            ) : (
                              <span className={stateText}>+{num(toCommit)}</span>
                            )
                          ) : (
                            <span className="inline-flex flex-col items-end leading-tight">
                              <span className="text-[#7c3aed]">+ add</span>
                              <span className="text-[10px] font-medium normal-case text-[#828a98]">custom qty</span>
                            </span>
                          )}
                        </td>
                      );
                    })()}
                    <td className={cn('px-2.5 py-2 text-right text-sm text-[#5b6270]', mono)}>{isFinite(r.daysOfCover) ? `${num(r.daysOfCover)}d` : '∞'}</td>
                    <td className="px-2.5 py-2 text-right"><StatusPill status={r.status} /></td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
