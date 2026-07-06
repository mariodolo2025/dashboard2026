// =============================================================================
// AIM 2026 — Action List (Replenishment Worklist) overlay.
//
// Decision-first daily view: which SKUs need a replenishment decision now, and
// whether it's Container (cheap sea freight), DHL (urgent air), or a Production
// order first. Body-portaled full-screen overlay (same pattern as Complete
// Projection) to avoid Radix focus-trap conflicts with the floating PO cart.
//
// Reuses the Complete Projection engine via worklist.ts, and the dashboard's
// existing PO builder via onAddProjectionItem — Container/Produce rows drop
// straight into the PO Draft. DHL is an urgent stock transfer, not a PO, so it
// is surfaced as a recommendation with the bridge quantity (no PO button).
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';
import { X, Plane, Ship, Factory, Check, Search, ShoppingCart, Download } from 'lucide-react';
import { cn, downloadCSV } from '@/lib/utils';
import type { SKURow } from '@/lib/aim2026/types';
import {
  buildWorklist,
  containerArrivalDays,
  DEFAULT_WORKLIST_CONFIG,
  type WorklistAction,
  type WorklistConfig,
  type WorklistRow,
} from './worklist';
import type { Scenario } from '../complete-projection/projection';

interface ActionListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filteredData: SKURow[];
  /** Same handler Complete Projection uses; drops a row into the PO Draft. */
  onAddProjectionItem?: (sku: string, qty: number, poType: 'Container' | 'Production', projectionDate?: string) => void;
  /** SKUs already in the cart (sku + poType), to show an "added" state. */
  addedKeys?: Set<string>;
}

const COVERAGE_PRESETS = [60, 90, 120];
const SCENARIOS: Scenario[] = ['optimistic', 'expected', 'pessimistic'];
const SCENARIO_SHORT: Record<Scenario, string> = {
  optimistic: 'Low −15%',
  expected: 'Expected',
  pessimistic: 'High +20%',
};

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const ACTION_META: Record<WorklistAction, { label: string; icon: any; cls: string; dot: string }> = {
  DHL: { label: 'Send DHL', icon: Plane, cls: 'bg-red-50 text-red-700 border-red-200', dot: 'bg-red-500' },
  Produce: { label: 'Produce', icon: Factory, cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  Container: { label: 'Load container', icon: Ship, cls: 'bg-blue-50 text-blue-700 border-blue-200', dot: 'bg-blue-500' },
  OK: { label: 'OK', icon: Check, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
};

const fmtInt = (v: number) => (isFinite(v) ? Math.round(v).toLocaleString('en-AU') : '∞');
const fmtDays = (v: number) => (isFinite(v) ? `${Math.round(v)}d` : '∞');

export function ActionListDialog({
  open,
  onOpenChange,
  filteredData,
  onAddProjectionItem,
  addedKeys,
}: ActionListDialogProps) {
  const today = useMemo(() => startOfToday(), []);
  const [config, setConfig] = useState<WorklistConfig>(DEFAULT_WORKLIST_CONFIG);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<WorklistAction | 'all'>('all');

  useEffect(() => {
    if (!open) return;
    setConfig(DEFAULT_WORKLIST_CONFIG);
    setSearch('');
    setActionFilter('all');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const allRows = useMemo(
    () => (open ? buildWorklist(filteredData, today, config) : []),
    [open, filteredData, today, config],
  );

  const counts = useMemo(() => {
    const c: Record<WorklistAction, number> = { DHL: 0, Produce: 0, Container: 0, OK: 0 };
    for (const r of allRows) c[r.action]++;
    return c;
  }, [allRows]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (actionFilter !== 'all' && r.action !== actionFilter) return false;
      if (q && !(`${r.sku} ${r.product}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [allRows, search, actionFilter]);

  const arrivalDays = containerArrivalDays(config);

  if (!open) return null;

  const addToCart = (r: WorklistRow) => {
    if (!onAddProjectionItem) return;
    if (r.action === 'Container') {
      onAddProjectionItem(r.sku, r.actionQty, 'Container', format(today, 'yyyy-MM-dd'));
    } else if (r.action === 'Produce') {
      onAddProjectionItem(r.sku, r.actionQty, 'Production');
    }
  };

  const exportCsv = () => {
    downloadCSV(
      rows,
      `aim2026-action-list-${format(today, 'yyyy-MM-dd')}.csv`,
      [
        { header: 'SKU', key: 'sku' },
        { header: 'Product', key: 'product' },
        { header: 'Action', key: 'action' },
        { header: 'Action Qty', key: 'actionQty', formatter: (v) => String(Math.round(v)) },
        { header: 'Demand/day', key: 'effDailyDemand', formatter: (v) => v.toFixed(2) },
        { header: 'SOH Main', key: 'sohMain', formatter: (v) => String(Math.round(v)) },
        { header: 'Days cover Main', key: 'daysOfCoverMain', formatter: (v) => (isFinite(v) ? String(Math.round(v)) : '') },
        { header: 'China avail', key: 'availableChinaOnDate', formatter: (v) => String(Math.round(v)) },
        { header: 'In transit DHL', key: 'dhl', formatter: (v) => String(Math.round(v)) },
        { header: 'In transit Container', key: 'container', formatter: (v) => String(Math.round(v)) },
        { header: 'On production', key: 'onProd', formatter: (v) => String(Math.round(v)) },
        { header: 'Lead time (d)', key: 'leadTime', formatter: (v) => String(Math.round(v)) },
        { header: 'China shortfall', key: 'chinaShortfall', formatter: (v) => String(Math.round(v)) },
      ],
    );
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Action List"
      className="pointer-events-auto fixed inset-0 z-[50] flex h-screen w-screen flex-col overflow-hidden bg-[#f7f7f5]"
    >
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-[#e8e8e3] bg-white px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-[#0f1115]">Action List</h2>
            <span className="text-xs text-muted-foreground">Replenishment worklist · ranked by urgency</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e2e2dd] px-2.5 text-xs text-muted-foreground hover:bg-[#faf9f7]"
            >
              <Download size={13} /> CSV
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md p-1.5 text-[#828a98] hover:bg-[#faf9f7] hover:text-[#2a2f38]"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Config strip */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Next container loads in</span>
            <input
              type="number"
              min={0}
              value={config.containerLoadInDays}
              onChange={(e) => setConfig((c) => ({ ...c, containerLoadInDays: Math.max(0, Number(e.target.value) || 0) }))}
              className="h-7 w-16 rounded-md border border-[#e2e2dd] px-2 tabular-nums"
            />
            <span className="text-muted-foreground">days → arrives Main in <b>{arrivalDays}d</b></span>
          </label>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Coverage target</span>
            <div className="flex items-center rounded-lg bg-[#f1f1ee] p-0.5">
              {COVERAGE_PRESETS.map((d) => (
                <button
                  key={d}
                  onClick={() => setConfig((c) => ({ ...c, coverageDays: d }))}
                  className={cn(
                    'rounded-md px-2 py-0.5 font-medium',
                    config.coverageDays === d ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Demand</span>
            <div className="flex items-center rounded-lg bg-[#f1f1ee] p-0.5">
              {SCENARIOS.map((s) => (
                <button
                  key={s}
                  onClick={() => setConfig((c) => ({ ...c, scenario: s }))}
                  className={cn(
                    'rounded-md px-2 py-0.5 font-medium',
                    config.scenario === s ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {SCENARIO_SHORT[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="relative ml-auto">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SKU / product"
              className="h-7 w-56 rounded-md border border-[#e2e2dd] pl-7 pr-2"
            />
          </div>
        </div>

        {/* Summary chips (also act as filters) */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActionFilter('all')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
              actionFilter === 'all' ? 'border-[#0f1115] bg-[#0f1115] text-white' : 'border-[#e2e2dd] text-muted-foreground',
            )}
          >
            All <b>{allRows.length}</b>
          </button>
          {(['DHL', 'Produce', 'Container', 'OK'] as WorklistAction[]).map((a) => {
            const meta = ACTION_META[a];
            return (
              <button
                key={a}
                onClick={() => setActionFilter((f) => (f === a ? 'all' : a))}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                  actionFilter === a ? meta.cls : 'border-[#e2e2dd] text-muted-foreground',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
                {meta.label} <b>{counts[a]}</b>
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-[#f7f7f5]">
            <tr className="border-b border-[#e2e2dd] text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-right font-medium">Demand/d</th>
              <th className="px-3 py-2 text-right font-medium">SOH Main</th>
              <th className="px-3 py-2 text-right font-medium">Cover Main</th>
              <th className="px-3 py-2 text-right font-medium">China avail</th>
              <th className="px-3 py-2 text-right font-medium">DHL</th>
              <th className="px-3 py-2 text-right font-medium">Cont.</th>
              <th className="px-3 py-2 text-right font-medium">On prod</th>
              <th className="px-3 py-2 text-right font-medium">Lead</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const meta = ACTION_META[r.action];
              const Icon = meta.icon;
              const canAdd = r.action === 'Container' || r.action === 'Produce';
              const cartKey = `${r.sku}::${r.action === 'Container' ? 'Container' : 'Production'}`;
              const added = addedKeys?.has(cartKey);
              return (
                <tr key={r.sku} className="border-b border-[#eeeee9] hover:bg-white">
                  <td className="px-3 py-1.5">
                    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', meta.cls)}>
                      <Icon size={12} />
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="font-mono text-xs font-medium">{r.sku}</div>
                    <div className="max-w-[280px] truncate text-[11px] text-muted-foreground">{r.product}</div>
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                    {r.action === 'OK' ? '—' : fmtInt(r.actionQty)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.effDailyDemand.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtInt(r.sohMain)}</td>
                  <td className={cn(
                    'px-3 py-1.5 text-right tabular-nums font-medium',
                    r.daysOfCoverMain < arrivalDays ? 'text-red-600' : 'text-foreground',
                  )}>
                    {fmtDays(r.daysOfCoverMain)}
                  </td>
                  <td className={cn(
                    'px-3 py-1.5 text-right tabular-nums',
                    r.chinaShortfall > 0 ? 'text-amber-600 font-medium' : '',
                  )}>
                    {fmtInt(r.availableChinaOnDate)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.dhl ? fmtInt(r.dhl) : '·'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.container ? fmtInt(r.container) : '·'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.onProd ? fmtInt(r.onProd) : '·'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.leadTime ? `${Math.round(r.leadTime)}d` : '·'}</td>
                  <td className="px-3 py-1.5 text-right">
                    {canAdd && onAddProjectionItem ? (
                      added ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                          <Check size={12} /> In draft
                        </span>
                      ) : (
                        <button
                          onClick={() => addToCart(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-[#e2e2dd] px-2 py-1 text-xs hover:bg-[#faf9f7]"
                        >
                          <ShoppingCart size={12} />
                          Add
                        </button>
                      )
                    ) : r.action === 'DHL' ? (
                      <span className="text-[11px] text-red-600">urgent transfer</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-16 text-center text-sm text-muted-foreground">
                  No SKUs match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer legend */}
      <div className="shrink-0 border-t border-[#e8e8e3] bg-white px-5 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium">Container vs DHL:</span> a container loaded now reaches Main in {arrivalDays}d.
        If Main breaks before that (red cover), the gap must fly <b className="text-red-600">DHL</b> (bridge qty).
        Otherwise sea freight <b className="text-blue-600">Container</b> is enough. If China can't cover the shipment, a
        <b className="text-amber-600"> Production</b> order comes first.
      </div>
    </div>,
    document.body,
  );
}
