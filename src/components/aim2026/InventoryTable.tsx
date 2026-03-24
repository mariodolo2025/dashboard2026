import { useMemo, useRef } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusBadge } from './StatusBadge';
import { ABCBadge } from './ABCBadge';
import { TrendIndicator } from './TrendIndicator';
import { ColumnTooltip } from './ColumnTooltip';
import type { SKURow, AIM2026Filters, StockStatus } from '@/lib/aim2026/types';
import { useState } from 'react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNum(v: number, decimals = 0): string {
  if (v === 0) return '—';
  return v.toLocaleString('en-AU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function getDaysOfCoverColor(days: number): string {
  if (days <= 0) return 'text-red-600 dark:text-red-400 font-semibold';
  if (days < 30) return 'text-red-500 dark:text-red-400';
  if (days < 60) return 'text-amber-600 dark:text-amber-400';
  if (days > 180) return 'text-violet-600 dark:text-violet-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function getMarginColor(margin: number): string {
  if (margin >= 50) return 'text-emerald-600 dark:text-emerald-400';
  if (margin >= 30) return 'text-foreground';
  if (margin >= 15) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-500 dark:text-red-400';
}

function getGMROIColor(gmroi: number): string {
  if (gmroi >= 3) return 'text-emerald-600 dark:text-emerald-400';
  if (gmroi >= 1) return 'text-foreground';
  return 'text-red-500 dark:text-red-400';
}

// ─── Sort Header ─────────────────────────────────────────────────────────────

function SortHeader({
  column,
  children,
  kpiKey,
  className,
}: {
  column: any;
  children: React.ReactNode;
  kpiKey?: string;
  className?: string;
}) {
  const sorted = column.getIsSorted();
  const content = kpiKey ? <ColumnTooltip kpiKey={kpiKey}>{children}</ColumnTooltip> : children;

  return (
    <button
      onClick={column.getToggleSortingHandler()}
      className={cn(
        'flex items-center text-xs font-medium text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap group w-full relative',
        className
      )}
    >
      {content}
      <span className={cn(
        'ml-1 transition-opacity flex-shrink-0',
        sorted ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
      )}>
        {sorted === 'asc' ? (
          <ArrowUp size={12} className="text-foreground" />
        ) : sorted === 'desc' ? (
          <ArrowDown size={12} className="text-foreground" />
        ) : (
          <ArrowUpDown size={12} />
        )}
      </span>
    </button>
  );
}

// ─── Skeleton Rows ───────────────────────────────────────────────────────────

function SkeletonTable() {
  return (
    <div className="space-y-0 border border-border/60 rounded-2xl overflow-hidden shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
      {/* Header */}
      <div className="h-10 bg-muted/50 border-b animate-pulse" />
      {/* Rows */}
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 h-10 border-b last:border-0">
          <div className="h-3 w-20 rounded bg-muted animate-pulse" />
          <div className="h-3 w-40 rounded bg-muted animate-pulse" />
          <div className="h-3 w-8 rounded bg-muted animate-pulse" />
          <div className="h-3 w-12 rounded bg-muted animate-pulse" />
          <div className="h-3 w-12 rounded bg-muted animate-pulse" />
          <div className="h-3 w-16 rounded bg-muted animate-pulse" />
          <div className="h-3 w-12 rounded bg-muted animate-pulse" />
          <div className="h-3 w-14 rounded bg-muted animate-pulse" />
          <div className="h-3 w-14 rounded bg-muted animate-pulse" />
          <div className="h-3 w-16 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Main Table Component ────────────────────────────────────────────────────

interface InventoryTableProps {
  data: SKURow[];
  filters: AIM2026Filters;
  loading: boolean;
  onSKUClick: (sku: string) => void;
  onDemandClick: (sku: string) => void;
  poBuilderMode?: boolean;
  poSelectedSKUs?: Set<string>;
  onSugQtyClick?: (row: SKURow) => void;
  exportSelectedSKUs?: Set<string>;
  onExportSelectedSKUsChange?: (next: Set<string>) => void;
  /** When true, table scroll container fills parent height (for maximized overlay) */
  fullHeight?: boolean;
  /** When true, data is already fully filtered (e.g. includes assembled filter); do not apply filters again */
  dataIsFullyFiltered?: boolean;
  /** When true, replaces the Demand column with separate B2B and B2C columns */
  splitDemand?: boolean;
}

export function InventoryTable({
  data,
  filters,
  loading,
  onSKUClick,
  onDemandClick,
  poBuilderMode = false,
  poSelectedSKUs,
  onSugQtyClick,
  exportSelectedSKUs,
  onExportSelectedSKUsChange,
  fullHeight = false,
  dataIsFullyFiltered = false,
  splitDemand = false,
}: InventoryTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'projectedDemand', desc: true },
  ]);

  const parentRef = useRef<HTMLDivElement>(null);

  // ─── Filter data ─────────────────────────────────────────────────────────

  const filteredData = useMemo(() => {
    if (dataIsFullyFiltered) return data;

    let result = data;

    if (filters.search) {
      const term = filters.search.toLowerCase();
      result = result.filter(
        (r) =>
          r.sku.toLowerCase().includes(term) || r.product.toLowerCase().includes(term)
      );
    }

    if (filters.abcClass !== 'all') {
      result = result.filter((r) => r.abcClass === filters.abcClass);
    }

    if (filters.status !== 'all') {
      result = result.filter((r) => r.status === filters.status);
    }

    if (filters.productGroup !== 'all') {
      result = result.filter((r) => r.productGroup === filters.productGroup);
    }

    if (filters.supplier !== 'all') {
      result = result.filter((r) => r.supplier === filters.supplier);
    }

    return result;
  }, [data, filters, dataIsFullyFiltered]);

  const allRowSKUs = useMemo(() => filteredData.map((r) => r.sku), [filteredData]);
  const allRowsSelected =
    allRowSKUs.length > 0 && !!exportSelectedSKUs && allRowSKUs.every((sku) => exportSelectedSKUs.has(sku));
  const someRowsSelected = allRowSKUs.some((sku) => exportSelectedSKUs?.has(sku));

  // ─── Column definitions ──────────────────────────────────────────────────

  const columns = useMemo<ColumnDef<SKURow>[]>(() => {
    const cols: ColumnDef<SKURow>[] = [
      // ── Selection checkbox column ───────────────────────────────────────
      {
        id: 'select',
        header: () => (
          <div className="flex justify-center">
            <Checkbox
              checked={
                allRowsSelected ? true : someRowsSelected ? ('indeterminate' as const) : false
              }
              disabled={allRowSKUs.length === 0 || !onExportSelectedSKUsChange}
              onCheckedChange={() => {
                if (!onExportSelectedSKUsChange) return;
                if (allRowsSelected) onExportSelectedSKUsChange(new Set());
                else onExportSelectedSKUsChange(new Set(allRowSKUs));
              }}
            />
          </div>
        ),
        cell: ({ row }) => {
          const sku = row.original.sku;
          const checked = exportSelectedSKUs?.has(sku) ?? false;

          return (
            <div className="flex justify-center w-full">
              <Checkbox
                checked={checked}
                disabled={!onExportSelectedSKUsChange}
                onCheckedChange={(next) => {
                  if (!onExportSelectedSKUsChange) return;
                  const nextSet = new Set(exportSelectedSKUs ? exportSelectedSKUs : []);
                  if (next === true) nextSet.add(sku);
                  else nextSet.delete(sku);
                  onExportSelectedSKUsChange(nextSet);
                }}
              />
            </div>
          );
        },
        size: 36,
      },
      // SKU
      {
        accessorKey: 'sku',
        header: ({ column }) => <SortHeader column={column}>SKU</SortHeader>,
        cell: ({ row }) => (
          <button
            onClick={() => onSKUClick(row.original.sku)}
            className="font-mono text-[13px] text-blue-600 dark:text-blue-400 hover:underline hover:text-blue-800 dark:hover:text-blue-300 transition-colors truncate block text-left w-full"
            title={`${row.original.sku} — ${row.original.product}`}
          >
            {row.original.sku}
          </button>
        ),
        size: 130,
      },
      // ABC
      {
        accessorKey: 'abcClass',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="abcClass">
            ABC
          </SortHeader>
        ),
        cell: ({ row }) => <ABCBadge abcClass={row.original.abcClass} />,
        size: 48,
      },
      // SOH Main WH
      {
        accessorKey: 'sohMainWH',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="sohMainWH" className="justify-end">
            SOH Main
          </SortHeader>
        ),
        cell: ({ row }) => {
          const isLow = row.original.sohMainWH < row.original.reorderPoint;
          return (
            <span
              className={cn(
                'text-[13px] tabular-nums text-right block w-full',
                isLow && 'text-red-600 dark:text-red-400 font-medium'
              )}
            >
              {formatNum(row.original.sohMainWH)}
            </span>
          );
        },
        size: 85,
      },
      // SOH China
      {
        accessorKey: 'sohChina',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="sohChina" className="justify-end">
            SOH China
          </SortHeader>
        ),
        cell: ({ row }) => (
          <span className="text-[13px] tabular-nums text-right block w-full">
            {formatNum(row.original.sohChina)}
          </span>
        ),
        size: 80,
      },
    ];

    // In-transit columns (conditional)
    if (filters.showInTransit) {
      cols.push(
        {
          accessorKey: 'container',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="container" className="justify-end">
              Container
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full text-blue-600 dark:text-blue-400">
              {formatNum(row.original.container)}
            </span>
          ),
          size: 80,
        },
        {
          accessorKey: 'dhl',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="dhl" className="justify-end">
              DHL
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full text-orange-600 dark:text-orange-400">
              {formatNum(row.original.dhl)}
            </span>
          ),
          size: 60,
        },
        {
          accessorKey: 'onProduction',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="onProduction" className="justify-end">
              On Prod.
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full text-purple-600 dark:text-purple-400">
              {formatNum(row.original.onProduction)}
            </span>
          ),
          size: 80,
        }
      );
    }

    // Allocation columns (conditional)
    if (filters.showAllocation) {
      cols.push(
        {
          accessorKey: 'allocatedTotal',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="allocatedMainWH" className="justify-end">
              Allocated
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full">
              {formatNum(row.original.allocatedTotal)}
            </span>
          ),
          size: 80,
        },
        {
          accessorKey: 'availableMainWH',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="availableMainWH" className="justify-end">
              Available
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full font-medium">
              {formatNum(row.original.availableMainWH)}
            </span>
          ),
          size: 80,
        }
      );
    }

    // Demand & reorder columns (always visible)
    if (splitDemand) {
      // B2B demand column
      cols.push({
        id: 'demandB2b',
        accessorFn: (row) => row.demandB2b ?? 0,
        header: ({ column }) => (
          <SortHeader column={column} className="justify-end">
            <span className="text-blue-600 dark:text-blue-400">B2B</span>
          </SortHeader>
        ),
        cell: ({ row }) => (
          <button
            onClick={() => onDemandClick(row.original.sku)}
            className="flex items-center justify-end w-full text-[13px] tabular-nums hover:text-blue-600 dark:hover:text-blue-400 transition-colors font-medium text-blue-600 dark:text-blue-400"
          >
            {formatNum(row.original.demandB2b ?? 0)}
          </button>
        ),
        size: 80,
      });
      // B2C demand column
      cols.push({
        id: 'demandB2c',
        accessorFn: (row) => row.demandB2c ?? 0,
        header: ({ column }) => (
          <SortHeader column={column} className="justify-end">
            <span className="text-violet-600 dark:text-violet-400">B2C</span>
          </SortHeader>
        ),
        cell: ({ row }) => (
          <button
            onClick={() => onDemandClick(row.original.sku)}
            className="flex items-center justify-end w-full text-[13px] tabular-nums hover:text-violet-600 dark:hover:text-violet-400 transition-colors font-medium text-violet-600 dark:text-violet-400"
          >
            {formatNum(row.original.demandB2c ?? 0)}
          </button>
        ),
        size: 80,
      });
    } else {
      cols.push(
        // Projected Demand
        {
          accessorKey: 'projectedDemand',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="projectedDemand" className="justify-end">
              Demand
            </SortHeader>
          ),
          cell: ({ row }) => (
            <button
              onClick={() => onDemandClick(row.original.sku)}
              className="flex items-center justify-end w-full text-[13px] tabular-nums hover:text-blue-600 dark:hover:text-blue-400 transition-colors group font-medium"
            >
              <span className="w-4 flex-shrink-0 flex justify-center mr-0.5">
                <TrendIndicator
                  direction={row.original.demandTrend}
                  size="sm"
                  className="opacity-60 group-hover:opacity-100"
                />
              </span>
              <span className="text-right">{formatNum(row.original.projectedDemand)}</span>
            </button>
          ),
          size: 90,
        },
      );
    }
    cols.push(
      // Reorder Point
      {
        accessorKey: 'reorderPoint',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="reorderPoint" className="justify-end">
            ROP
          </SortHeader>
        ),
        cell: ({ row }) => (
          <span className="text-[13px] tabular-nums text-right block w-full text-muted-foreground">
            {formatNum(row.original.reorderPoint)}
          </span>
        ),
        size: 70,
      },
      // Suggested Qty
      {
        accessorKey: 'suggestedQty',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="suggestedQty" className="justify-end">
            Sug. Qty
          </SortHeader>
        ),
        cell: ({ row }) => {
          const qty = row.original.suggestedQty;
          const softQty = row.original.softSuggestedQty;
          const isSelected = poSelectedSKUs?.has(row.original.sku);
          const displayQty = qty > 0 ? qty : softQty;
          const isSoft = qty === 0 && softQty > 0;

          if (poBuilderMode) {
            return (
              <button
                onClick={() => onSugQtyClick?.(row.original)}
                className={cn(
                  'text-[13px] tabular-nums text-right block w-full font-semibold transition-all rounded px-1 -mx-1',
                  isSelected
                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                    : isSoft
                    ? 'text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 cursor-pointer'
                    : 'text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 cursor-pointer'
                )}
                title={isSelected ? 'Already in PO draft — click to update' : isSoft ? 'Stock approaching ROP — consider reordering' : 'Click to add to PO'}
              >
                {isSelected ? '✓ ' : ''}{displayQty > 0 ? formatNum(displayQty) : '—'}
              </button>
            );
          }

          return (
            <span
              className={cn(
                'text-[13px] tabular-nums text-right block w-full',
                qty > 0 && 'text-blue-600 dark:text-blue-400 font-semibold',
                isSoft && 'text-amber-500 dark:text-amber-400 font-medium'
              )}
              title={isSoft ? 'Stock approaching ROP — consider reordering' : undefined}
            >
              {displayQty > 0 ? formatNum(displayQty) : '—'}
            </span>
          );
        },
        size: 78,
      },
    );

    // Reorder detail columns (conditional — toggled via "Reorder Detail" in More)
    if (filters.showReorderDetail) {
      cols.push(
        // Target Stock Level
        {
          accessorKey: 'targetStockLevel',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="targetStockLevel" className="justify-end">
              Target
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full text-muted-foreground">
              {formatNum(row.original.targetStockLevel)}
            </span>
          ),
          size: 72,
        },
        // Pipeline
        {
          accessorKey: 'pipeline',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="pipeline" className="justify-end">
              Pipeline
            </SortHeader>
          ),
          cell: ({ row }) => {
            const p = row.original.pipeline;
            return (
              <span
                className={cn(
                  'text-[13px] tabular-nums text-right block w-full',
                  p > 0 && 'text-cyan-600 dark:text-cyan-400'
                )}
              >
                {p > 0 ? formatNum(p) : '—'}
              </span>
            );
          },
          size: 72,
        },
        // Safety Stock
        {
          accessorKey: 'safetyStock',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="safetyStock" className="justify-end">
              Safety
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full text-muted-foreground">
              {formatNum(row.original.safetyStock)}
            </span>
          ),
          size: 68,
        },
        // Lead Time
        {
          accessorKey: 'leadTimeDays',
          header: ({ column }) => (
            <SortHeader column={column} kpiKey="leadTimeDays" className="justify-end">
              L/T
            </SortHeader>
          ),
          cell: ({ row }) => (
            <span className="text-[13px] tabular-nums text-right block w-full text-muted-foreground">
              {row.original.leadTimeDays}d
            </span>
          ),
          size: 55,
        }
      );
    }

    cols.push(
      // Days of Cover
      {
        accessorKey: 'daysOfCover',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="daysOfCover" className="justify-end">
            Cover
          </SortHeader>
        ),
        cell: ({ row }) => (
          <span
            className={cn(
              'text-[13px] tabular-nums text-right block w-full',
              getDaysOfCoverColor(row.original.daysOfCover)
            )}
          >
            {row.original.daysOfCover > 0
              ? `${Math.round(row.original.daysOfCover)}d`
              : '0d'}
          </span>
        ),
        size: 68,
      },
      // Turnover
      {
        accessorKey: 'turnover',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="turnover" className="justify-end">
            Turn.
          </SortHeader>
        ),
        cell: ({ row }) => (
          <span className="text-[13px] tabular-nums text-right block w-full">
            {row.original.turnover > 0 ? row.original.turnover.toFixed(1) : '—'}
          </span>
        ),
        size: 62,
      },
      // Margin
      {
        accessorKey: 'marginPercent',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="marginPercent" className="justify-end">
            Margin
          </SortHeader>
        ),
        cell: ({ row }) => (
          <span
            className={cn(
              'text-[13px] tabular-nums text-right block w-full',
              getMarginColor(row.original.marginPercent)
            )}
          >
            {row.original.marginPercent > 0
              ? `${row.original.marginPercent.toFixed(1)}%`
              : '—'}
          </span>
        ),
        size: 68,
      },
      // GMROI
      {
        accessorKey: 'gmroi',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="gmroi" className="justify-end">
            GMROI
          </SortHeader>
        ),
        cell: ({ row }) => (
          <span
            className={cn(
              'text-[13px] tabular-nums text-right block w-full',
              getGMROIColor(row.original.gmroi)
            )}
          >
            {row.original.gmroi > 100 ? '>100' : row.original.gmroi > 0 ? row.original.gmroi.toFixed(1) : '—'}
          </span>
        ),
        size: 62,
      },
      // Status
      {
        accessorKey: 'status',
        header: ({ column }) => (
          <SortHeader column={column} kpiKey="status">
            Status
          </SortHeader>
        ),
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        size: 105,
        sortingFn: (rowA, rowB) => {
          const order: Record<StockStatus, number> = {
            CRITICAL: 0,
            'LOW STOCK': 1,
            WARNING: 2,
            OK: 3,
            OVERSTOCK: 4,
          };
          return order[rowA.original.status] - order[rowB.original.status];
        },
      }
    );

    // Filter out hidden columns
    const hidden = new Set(filters.hiddenColumns ?? []);
    return cols.filter((c: any) => !hidden.has(c.accessorKey));
  }, [
    filters.showInTransit,
    filters.showAllocation,
    filters.showReorderDetail,
    filters.hiddenColumns,
    onSKUClick,
    onDemandClick,
    poBuilderMode,
    poSelectedSKUs,
    onSugQtyClick,
    allRowSKUs,
    allRowsSelected,
    someRowsSelected,
    exportSelectedSKUs,
    onExportSelectedSKUsChange,
    splitDemand,
  ]);

  // ─── Table instance ──────────────────────────────────────────────────────

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const { rows } = table.getRowModel();

  // ─── Virtualizer ─────────────────────────────────────────────────────────

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) return <SkeletonTable />;

  if (filteredData.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center border rounded-lg bg-muted/20">
        <div className="text-4xl mb-3 opacity-30">📦</div>
        <p className="text-sm font-medium text-muted-foreground">No products found</p>
        <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">
          {data.length === 0
            ? 'Click "Sync with Unleashed" to load inventory data.'
            : 'Try adjusting your filters or search term.'}
        </p>
      </div>
    );
  }

  // Build column widths for consistent sizing
  const headerGroups = table.getHeaderGroups();
  const allHeaders = headerGroups[0]?.headers ?? [];
  const totalDefinedWidth = allHeaders.reduce((sum, h) => sum + h.getSize(), 0);

  // All columns share remaining space proportionally (no single flex column)
  // This prevents SKU from hogging all extra width on wide screens

  return (
    <div
      className={cn(
        'border border-border/60 rounded-2xl overflow-hidden bg-card shadow-[0_2px_8px_rgba(0,0,0,0.04)]',
        fullHeight && 'flex flex-col flex-1 min-h-0'
      )}
    >
      {/* Scrollable container */}
      <div
        ref={parentRef}
        className={cn('overflow-auto', fullHeight && 'flex-1 min-h-0')}
        style={
          fullHeight
            ? { minHeight: '200px' }
            : { maxHeight: 'calc(100vh - 380px)', minHeight: '300px' }
        }
      >
        {/* ── Sticky Header ──────────────────────────────────────── */}
        <div className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm border-b">
          <div className="flex items-center w-full" style={{ minWidth: totalDefinedWidth }}>
            {allHeaders.map((header) => {
              // Each column gets a flex value proportional to its defined size
              const size = header.getSize();
              return (
                <div
                  key={header.id}
                  className="px-3 py-2.5 text-left font-medium flex-shrink-0 min-w-0"
                  style={{ width: size, flex: `${size} 0 0%` }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Virtualized Body ───────────────────────────────────── */}
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
            minWidth: totalDefinedWidth,
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            const isCritical = row.original.status === 'CRITICAL';
            const isLowStock = row.original.status === 'LOW STOCK';

            return (
              <div
                key={row.id}
                className={cn(
                  'flex items-center w-full group transition-colors border-b border-border/40',
                  'hover:bg-accent/30',
                  isCritical && 'bg-red-50/60 dark:bg-red-950/20 shadow-[inset_3px_0_0_0_theme(colors.red.500)]',
                  isLowStock && 'bg-red-50/30 dark:bg-red-950/10'
                )}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.getVisibleCells().map((cell) => {
                  const size = cell.column.getSize();
                  return (
                    <div
                      key={cell.id}
                      className="px-3 flex items-center flex-shrink-0 min-w-0"
                      style={{
                        width: size,
                        flex: `${size} 0 0%`,
                        height: `${virtualRow.size}px`,
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
