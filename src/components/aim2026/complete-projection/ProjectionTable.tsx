// =============================================================================
// AIM 2026 — Complete Projection: SKU-level projection table
// =============================================================================

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

export type SortCol = 'sku' | 'effDailyDemand' | 'sohGlobal' | 'pipeline' | 'demandConsumed' | 'projectedOnHand' | 'daysOfCover' | 'status';
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
  expandedPipeline: boolean;
  setExpandedPipeline: (v: boolean) => void;
  expandedConsumed: boolean;
  setExpandedConsumed: (v: boolean) => void;
  demandUnit: DemandUnit;
  onToggleDemandUnit: () => void;
  poMode: 'container' | 'production' | null;
  addedSkus: Map<string, number>;
  onAddToCart: (sku: string) => void;
  sort: SortState;
  onSort: (col: SortCol) => void;
}

export function ProjectionTable({
  rows, totalCount, projectionDate, search, onSearch, groups, selectedGroups, onGroupsChange,
  selectedSku, onRowClick, expandedSoh, setExpandedSoh, expandedPipeline, setExpandedPipeline,
  expandedConsumed, setExpandedConsumed, demandUnit, onToggleDemandUnit, poMode, addedSkus,
  onAddToCart, sort, onSort,
}: ProjectionTableProps) {
  const colCount = 8 + (expandedSoh ? 1 : 0) + (expandedPipeline ? 2 : 0) + (poMode ? 1 : 0);

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
            {(expandedSoh || expandedPipeline) && (
              <tr className="border-b border-[#f0f0ec]">
                <th colSpan={2} />
                {expandedSoh ? (
                  <th colSpan={2} onClick={() => setExpandedSoh(false)} className={cn('cursor-pointer px-2.5 py-1 text-center text-xs font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>
                    <span className="inline-flex items-center gap-1">SOH global breakdown <ChevronUp size={12} /></span>
                  </th>
                ) : (<th />)}
                {expandedPipeline ? (
                  <th colSpan={3} onClick={() => setExpandedPipeline(false)} className={cn('cursor-pointer px-2.5 py-1 text-center text-xs font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>
                    <span className="inline-flex items-center gap-1">Pipeline breakdown <ChevronUp size={12} /></span>
                  </th>
                ) : (<th />)}
                <th colSpan={poMode ? 5 : 4} />
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
                </>
              ) : (
                <th onClick={() => setExpandedSoh(true)} className="cursor-pointer select-none px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#5b6270] hover:text-[#2a2f38]">
                  <span className="inline-flex flex-row-reverse items-center gap-1">SOH global <ChevronDown size={12} /></span>
                </th>
              )}

              {expandedPipeline ? (
                <>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>DHL</th>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>Container</th>
                  <th className={cn('px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>On Prod.</th>
                </>
              ) : (
                <th onClick={() => setExpandedPipeline(true)} className="cursor-pointer select-none px-2.5 py-2 text-right text-sm font-semibold uppercase tracking-wide text-[#5b6270] hover:text-[#2a2f38]">
                  <span className="inline-flex flex-row-reverse items-center gap-1">Pipeline <ChevronDown size={12} /></span>
                </th>
              )}

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
              <Th col="projectedOnHand">On hand on date</Th>
              {poMode && (
                <th title={poMode === 'container' ? 'Click the cell to load this SKU into the container.' : 'Click the cell to order this SKU for production.'} className={cn('px-2.5 py-2.5 text-right text-sm font-semibold uppercase tracking-wide text-[#4c1d95]', violetCell)}>
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
                      </>
                    ) : (
                      <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono)}>{num(r.sohGlobal)}</td>
                    )}

                    {expandedPipeline ? (
                      <>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.dhl)}</td>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.container)}</td>
                        <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono, violetCell)}>{num(r.onProd)}</td>
                      </>
                    ) : (
                      <td className={cn('px-2.5 py-2 text-right text-sm text-[#2a2f38]', mono)}>{num(r.pipeline)}</td>
                    )}

                    <td className={cn('px-2.5 py-2 text-right text-sm text-[#dc2626]', mono, expandedConsumed && 'bg-[#ede9fe]/30')}>
                      {expandedConsumed ? (
                        <span className="inline-flex flex-col items-end leading-tight">
                          <span>−{num(r.demandConsumed + r.allocated)}</span>
                          <span className="text-[10px] font-medium normal-case text-[#7c3aed]">allocated: {num(r.allocated)}</span>
                        </span>
                      ) : (<>−{num(r.demandConsumed)}</>)}
                    </td>
                    <td className={cn('px-2.5 py-2 text-right text-base font-bold', mono, r.projectedOnHand <= 0 ? 'text-[#dc2626]' : 'text-[#0f1115]')}>
                      {num(r.projectedOnHand)}
                    </td>
                    {poMode && (() => {
                      const added = addedSkus.get(r.sku);
                      const toCommit = poMode === 'container' ? Math.round(r.coverageDemand) : Math.round(r.neededQty);
                      const postSurplus = poMode === 'container' ? Math.round(Math.abs(r.neededQty)) : 0;
                      const tip = added != null
                        ? `Added ${num(added)} to the PO. ${poMode === 'container' ? `Remaining China stock after load: ${num(postSurplus)} u.` : 'Shortfall covered.'}`
                        : poMode === 'container'
                          ? `Click to load ${num(toCommit)} u into the container.`
                          : `Click to produce ${num(toCommit)} u to reach coverage.`;
                      return (
                        <td
                          title={tip}
                          onClick={(e) => { e.stopPropagation(); if (added != null) return; if (toCommit <= 0) return; onAddToCart(r.sku); }}
                          className={cn('px-2.5 py-2 text-right text-base font-bold', mono, violetCell, added == null && toCommit > 0 && 'cursor-pointer hover:bg-[#ddd6fe]')}
                        >
                          {added != null ? (
                            <span className="inline-flex flex-col items-end gap-0.5 leading-tight">
                              <span className={cn('text-[#059669]', mono)}>{poMode === 'container' ? `+${num(postSurplus)}` : '✓'}</span>
                              <span className="text-[10px] font-medium normal-case text-[#7c3aed]">{poMode === 'container' ? `loaded: ${num(added)}` : `ordered: ${num(added)}`}</span>
                            </span>
                          ) : (
                            <span className={toCommit > 0 ? 'text-[#7c3aed]' : 'text-[#828a98]'}>{toCommit > 0 ? `+${num(toCommit)}` : '—'}</span>
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
