import { useState, useRef, useEffect } from 'react';
import { Search, X, Filter, SlidersHorizontal, Columns3, Maximize2, Minimize2, SplitSquareHorizontal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { AIM2026Filters, ABCClass, StockStatus } from '@/lib/aim2026/types';
import { DEFAULT_FILTERS, TOGGLEABLE_COLUMNS, DEMAND_MODE_OPTIONS } from '@/lib/aim2026/types';

// ─── Column Picker Dropdown ──────────────────────────────────────────────

function ColumnPicker({
  hiddenColumns,
  onChange,
}: {
  hiddenColumns: string[];
  onChange: (cols: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = (key: string) => {
    if (hiddenColumns.includes(key)) {
      onChange(hiddenColumns.filter((c) => c !== key));
    } else {
      onChange([...hiddenColumns, key]);
    }
  };

  const hiddenCount = hiddenColumns.length;

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
        className="h-9 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Columns3 size={14} />
        Columns
        {hiddenCount > 0 && (
          <span className="ml-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-[10px] font-bold rounded-full px-1.5 leading-4">
            {TOGGLEABLE_COLUMNS.length - hiddenCount}/{TOGGLEABLE_COLUMNS.length}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute top-full mt-1 right-0 z-50 bg-popover border rounded-lg shadow-lg py-2 px-1 min-w-[160px]">
          <p className="text-[10px] text-muted-foreground px-2 pb-1.5 font-medium uppercase tracking-wider">
            Visible Columns
          </p>
          {TOGGLEABLE_COLUMNS.map((col) => {
            const visible = !hiddenColumns.includes(col.key);
            return (
              <label
                key={col.key}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50 cursor-pointer select-none text-xs"
              >
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => toggle(col.key)}
                  className="rounded border-border h-3.5 w-3.5 accent-blue-500"
                />
                <span className={visible ? 'text-foreground' : 'text-muted-foreground'}>
                  {col.label}
                </span>
              </label>
            );
          })}
          <div className="border-t mt-1.5 pt-1.5 px-2">
            <button
              onClick={() => onChange([])}
              className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              Show all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Filter Bar ──────────────────────────────────────────────────────────

interface FilterBarProps {
  filters: AIM2026Filters;
  onFiltersChange: (filters: AIM2026Filters) => void;
  productGroups: string[];
  suppliers: string[];
  totalCount: number;
  filteredCount: number;
  showAssembledProducts?: boolean;
  onShowAssembledProductsChange?: (show: boolean) => void;
  assembledCount?: number;
  onMaximizeClick?: () => void;
  onRestoreClick?: () => void;
  isMaximized?: boolean;
  splitDemand?: boolean;
  onToggleSplit?: () => void;
}

export function FilterBar({
  filters,
  onFiltersChange,
  productGroups,
  suppliers,
  totalCount,
  filteredCount,
  showAssembledProducts = false,
  onShowAssembledProductsChange,
  assembledCount = 0,
  onMaximizeClick,
  onRestoreClick,
  isMaximized = false,
  splitDemand = false,
  onToggleSplit,
}: FilterBarProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (partial: Partial<AIM2026Filters>) => {
    onFiltersChange({ ...filters, ...partial });
  };

  const hasActiveFilters =
    filters.search !== '' ||
    filters.abcClass !== 'all' ||
    filters.status !== 'all' ||
    filters.productGroup !== 'all' ||
    filters.supplier !== 'all';

  const clearFilters = () => onFiltersChange(DEFAULT_FILTERS);

  return (
    <div className="space-y-3">
      {/* Main row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Search */}
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            placeholder="Search SKU or product..."
            value={filters.search}
            onChange={(e) => update({ search: e.target.value })}
            className="pl-9 pr-8 h-9 text-sm bg-muted/30 border-border/50 focus:bg-background transition-colors"
          />
          {filters.search && (
            <button
              onClick={() => update({ search: '' })}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Quick filters */}
        <Select
          value={filters.status}
          onValueChange={(v) => update({ status: v as StockStatus | 'all' })}
        >
          <SelectTrigger className="w-[140px] h-9 text-sm bg-muted/30 border-border/50">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="CRITICAL">Critical</SelectItem>
            <SelectItem value="LOW STOCK">Low Stock</SelectItem>
            <SelectItem value="WARNING">Warning</SelectItem>
            <SelectItem value="OK">OK</SelectItem>
            <SelectItem value="OVERSTOCK">Overstock</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.abcClass}
          onValueChange={(v) => update({ abcClass: v as ABCClass | 'all' })}
        >
          <SelectTrigger className="w-[110px] h-9 text-sm bg-muted/30 border-border/50">
            <SelectValue placeholder="ABC" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ABC</SelectItem>
            <SelectItem value="A">A — Top 80%</SelectItem>
            <SelectItem value="B">B — Next 15%</SelectItem>
            <SelectItem value="C">C — Bottom 5%</SelectItem>
          </SelectContent>
        </Select>

        {/* Toggle advanced */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="h-9 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <SlidersHorizontal size={14} />
          {showAdvanced ? 'Less' : 'More'}
        </Button>

        {/* Column visibility picker */}
        <ColumnPicker
          hiddenColumns={filters.hiddenColumns}
          onChange={(cols) => update({ hiddenColumns: cols })}
        />

        {/* Clear */}
        <AnimatePresence>
          {hasActiveFilters && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-9 gap-1 text-xs text-muted-foreground hover:text-destructive"
              >
                <X size={14} />
                Clear
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Count chip */}
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <Filter size={12} className="opacity-50" />
          <span>
            {filteredCount === totalCount
              ? `${totalCount} products`
              : `${filteredCount} of ${totalCount}`}
            {!showAssembledProducts && assembledCount > 0 && (
              <span className="text-muted-foreground/80"> (excluding {assembledCount} assembled)</span>
            )}
          </span>
        </div>

        {/* Maximize / Restore */}
        {isMaximized && onRestoreClick && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs font-medium"
            onClick={onRestoreClick}
            title="Restore (Esc)"
          >
            <Minimize2 size={14} />
            Restore
          </Button>
        )}
        {!isMaximized && onMaximizeClick && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs font-medium"
            onClick={onMaximizeClick}
            title="Maximize table"
          >
            <Maximize2 size={14} />
            Maximize table
          </Button>
        )}
      </div>

      {/* Advanced filters row */}
      <AnimatePresence>
        {showAdvanced && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-3 flex-wrap pt-1 pb-1">
              <Select
                value={filters.productGroup}
                onValueChange={(v) => update({ productGroup: v })}
              >
                <SelectTrigger className="w-[180px] h-9 text-sm bg-muted/30 border-border/50">
                  <SelectValue placeholder="Product Group" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Groups</SelectItem>
                  {productGroups.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.supplier}
                onValueChange={(v) => update({ supplier: v })}
              >
                <SelectTrigger className="w-[180px] h-9 text-sm bg-muted/30 border-border/50">
                  <SelectValue placeholder="Supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Suppliers</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Column toggle switches */}
              <div className="flex items-center gap-4 ml-4">
                <label className="flex items-center gap-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={filters.showInTransit}
                    onChange={(e) => update({ showInTransit: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="relative w-8 h-[18px] bg-muted rounded-full transition-colors peer-checked:bg-blue-500 peer-focus-visible:ring-2 ring-ring ring-offset-2">
                    <div className="absolute top-[2px] left-[2px] w-[14px] h-[14px] bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-[14px] group-has-[:checked]:translate-x-[14px]" />
                  </div>
                  <Label className="text-xs font-normal text-muted-foreground cursor-pointer group-has-[:checked]:text-foreground transition-colors">
                    In Transit & Production
                  </Label>
                </label>

                <label className="flex items-center gap-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={filters.showAllocation}
                    onChange={(e) => update({ showAllocation: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="relative w-8 h-[18px] bg-muted rounded-full transition-colors peer-checked:bg-blue-500 peer-focus-visible:ring-2 ring-ring ring-offset-2">
                    <div className="absolute top-[2px] left-[2px] w-[14px] h-[14px] bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-[14px] group-has-[:checked]:translate-x-[14px]" />
                  </div>
                  <Label className="text-xs font-normal text-muted-foreground cursor-pointer group-has-[:checked]:text-foreground transition-colors">
                    Allocation Detail
                  </Label>
                </label>

                <label className="flex items-center gap-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={filters.showReorderDetail}
                    onChange={(e) => update({ showReorderDetail: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="relative w-8 h-[18px] bg-muted rounded-full transition-colors peer-checked:bg-blue-500 peer-focus-visible:ring-2 ring-ring ring-offset-2">
                    <div className="absolute top-[2px] left-[2px] w-[14px] h-[14px] bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-[14px] group-has-[:checked]:translate-x-[14px]" />
                  </div>
                  <Label className="text-xs font-normal text-muted-foreground cursor-pointer group-has-[:checked]:text-foreground transition-colors">
                    Reorder Detail
                  </Label>
                </label>

                <div className="flex items-center gap-2">
                  <Label className="text-xs font-normal text-muted-foreground whitespace-nowrap">
                    Demand mode
                  </Label>
                  <Select
                    value={filters.demandMode}
                    onValueChange={(v) => update({ demandMode: v as AIM2026Filters['demandMode'] })}
                  >
                    <SelectTrigger className="h-8 w-[180px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEMAND_MODE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="text-xs">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {onToggleSplit && (
                  <button
                    onClick={onToggleSplit}
                    className={cn(
                      'flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md border transition-colors h-8',
                      splitDemand
                        ? 'bg-violet-100 dark:bg-violet-900/40 border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300'
                        : 'bg-muted/40 border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/70'
                    )}
                    title="Split Demand column into B2B and B2C"
                  >
                    <SplitSquareHorizontal size={12} />
                    B2B / B2C split
                  </button>
                )}

                {onShowAssembledProductsChange != null && (
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="show-assembled-aim2026"
                      checked={showAssembledProducts}
                      onCheckedChange={(checked) => onShowAssembledProductsChange(!!checked)}
                    />
                    <Label
                      htmlFor="show-assembled-aim2026"
                      className="text-xs font-normal text-muted-foreground cursor-pointer hover:text-foreground"
                      title="Products built from a BOM (assembled). Uncheck to hide them from the table."
                    >
                      Show Assembled Products
                      {assembledCount > 0 && (
                        <span className="text-muted-foreground/70 ml-0.5">({assembledCount})</span>
                      )}
                    </Label>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
