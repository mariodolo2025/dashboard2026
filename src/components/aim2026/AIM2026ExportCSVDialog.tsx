import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AIM2026Filters, SKURow } from '@/lib/aim2026/types';
import { downloadCSV, type CSVColumn } from '@/lib/utils';
import ModalDateRangePicker from '@/components/ModalDateRangePicker';

type ExportScope = 'selected' | 'filtered';

function formatNum(v: number, decimals = 0): string {
  if (v === 0) return '—';
  return v.toLocaleString('en-AU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSuggestedQty(row: SKURow): string {
  const qty = row.suggestedQty;
  const softQty = row.softSuggestedQty;
  const displayQty = qty > 0 ? qty : softQty;
  return displayQty > 0 ? formatNum(displayQty) : '—';
}

function formatTurnover(v: number): string {
  return v > 0 ? v.toFixed(1) : '—';
}

function formatMarginPercent(v: number): string {
  return v > 0 ? `${v.toFixed(1)}%` : '—';
}

function formatGMROI(v: number): string {
  if (v > 100) return '>100';
  if (v > 0) return v.toFixed(1);
  return '—';
}

export function AIM2026ExportCSVDialog({
  open,
  onOpenChange,
  filters,
  filteredRows,
  selectedRowSKUs,
  dateRange,
  setDateRange,
  splitDemand,
  warehouseDemandFilter,
  warehouseDemandMap,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: AIM2026Filters;
  filteredRows: SKURow[];
  selectedRowSKUs: Set<string>;
  dateRange?: { from?: Date; to?: Date };
  setDateRange?: (range: { from?: Date; to?: Date }) => void;
  splitDemand?: boolean;
  warehouseDemandFilter?: string | null;
  warehouseDemandMap?: Map<string, number> | null;
}) {
  const [scope, setScope] = useState<ExportScope>('filtered');
  const [selectedColumnKeys, setSelectedColumnKeys] = useState<Set<string>>(new Set());

  const visibleColumns = useMemo<CSVColumn[]>(() => {
    const hidden = new Set(filters.hiddenColumns ?? []);
    const cols: CSVColumn[] = [];

    const push = (key: string, header: string, formatter?: CSVColumn['formatter']) => {
      if (key !== 'sku' && hidden.has(key)) return;
      cols.push({ key, header, formatter });
    };

    // Table columns order mirrors InventoryTable
    push('sku', 'SKU', (v) => String(v ?? ''));

    push('abcClass', 'ABC', (v) => String(v ?? ''));
    push('sohMainWH', 'SOH Main', (v) => formatNum(Number(v ?? 0)));
    push('sohChina', 'SOH China', (v) => formatNum(Number(v ?? 0)));

    if (filters.showInTransit) {
      push('container', 'Container', (v) => formatNum(Number(v ?? 0)));
      push('dhl', 'DHL', (v) => formatNum(Number(v ?? 0)));
      push('onProduction', 'On Prod.', (v) => formatNum(Number(v ?? 0)));
    }

    if (filters.showAllocation) {
      push('allocatedTotal', 'Allocated', (v) => formatNum(Number(v ?? 0)));
      push('availableMainWH', 'Available', (v) => formatNum(Number(v ?? 0)));
    }

    if (splitDemand) {
      push('demandB2b', 'B2B', (v) => formatNum(Number(v ?? 0)));
      push('demandB2c', 'B2C', (v) => formatNum(Number(v ?? 0)));
    } else {
      push('projectedDemand', 'Demand', (v) => formatNum(Number(v ?? 0)));
    }

    // Same as InventoryTable: show when a warehouse is selected (values from map when loaded).
    if (warehouseDemandFilter) {
      cols.push({
        key: 'warehouseDemand',
        header: warehouseDemandFilter,
        formatter: (v) => {
          const qty = Number(v ?? 0);
          return qty > 0 ? formatNum(qty) : '—';
        },
      });
    }

    push('reorderPoint', 'ROP', (v) => formatNum(Number(v ?? 0)));
    // "Sug. Qty" en la tabla muestra qty>0 ? qty : softQty (con '—' si es 0)
    // Respetamos la key real "suggestedQty" para que el ocultar columnas funcione igual que en InventoryTable.
    push('suggestedQty', 'Sug. Qty', (v) => String(v ?? ''));

    if (filters.showReorderDetail) {
      push('targetStockLevel', 'Target', (v) => formatNum(Number(v ?? 0)));
      push('pipeline', 'Pipeline', (v) => {
        const num = Number(v ?? 0);
        return num > 0 ? formatNum(num) : '—';
      });
      push('safetyStock', 'Safety', (v) => formatNum(Number(v ?? 0)));
      push('leadTimeDays', 'L/T', (v) => `${Number(v ?? 0)}d`);
    }

    // A null metric exports as an empty cell, not as 0 — a spreadsheet that
    // reads "0" cannot tell a measured zero from a missing landed cost.
    push('daysOfCover', 'Cover', (v) => (v === null || v === undefined ? '' : `${Math.round(Number(v))}d`));
    push('turnover', 'Turn.', (v) => (v === null || v === undefined ? '' : formatTurnover(Number(v))));
    push('marginPercent', 'Margin', (v) => (v === null || v === undefined ? '' : formatMarginPercent(Number(v))));
    push('gmroi', 'GMROI', (v) => (v === null || v === undefined ? '' : formatGMROI(Number(v))));
    push('status', 'Status', (v) => String(v ?? ''));

    return cols;
  }, [
    filters.hiddenColumns,
    filters.showAllocation,
    filters.showInTransit,
    filters.showReorderDetail,
    splitDemand,
    warehouseDemandFilter,
  ]);

  const visibleColumnKeys = useMemo(() => visibleColumns.map((c) => c.key), [visibleColumns]);
  const filteredCount = filteredRows.length;

  const selectedCountInView = useMemo(() => {
    return filteredRows.reduce((acc, r) => (selectedRowSKUs.has(r.sku) ? acc + 1 : acc), 0);
  }, [filteredRows, selectedRowSKUs]);

  useEffect(() => {
    if (!open) return;
    setScope('filtered');
    setSelectedColumnKeys(new Set(visibleColumnKeys));
  }, [open, visibleColumnKeys]);

  const selectedColumns = useMemo(
    () => visibleColumns.filter((c) => selectedColumnKeys.has(c.key)),
    [selectedColumnKeys, visibleColumns]
  );

  const rowsToExport = useMemo((): any[] => {
    const base =
      scope === 'selected' ? filteredRows.filter((r) => selectedRowSKUs.has(r.sku)) : filteredRows;

    return base.map((r) => ({
      ...r,
      suggestedQty: formatSuggestedQty(r),
      warehouseDemand: warehouseDemandMap?.get(r.sku) ?? 0,
    }));
  }, [scope, filteredRows, selectedRowSKUs, warehouseDemandMap]);

  const canDownload = rowsToExport.length > 0 && selectedColumns.length > 0;

  const filename = useMemo(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
      now.getHours()
    )}${pad(now.getMinutes())}`;
    return `AIM_2026_Export_${scope === 'selected' ? 'selected' : 'filtered'}_${stamp}.csv`;
  }, [scope]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl z-[60]">
        <DialogHeader>
          <DialogTitle>Export CSV - AIM 2026</DialogTitle>
          <DialogDescription>
            Exporta las filas y columnas que estás viendo en la tabla.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Keep the date range picker consistent with the rest of the AIM 2026 UI */}
            <ModalDateRangePicker dateRange={dateRange} setDateRange={setDateRange} />
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Filas</p>
              <Select value={scope} onValueChange={(v) => setScope(v as ExportScope)}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Selecciona el alcance" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="filtered">
                    Todas las filtradas ({filteredCount})
                  </SelectItem>
                  <SelectItem value="selected">
                    Seleccionadas ({selectedCountInView})
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="text-xs text-muted-foreground">
              Columnas: <span className="tabular-nums text-foreground font-medium">{selectedColumns.length}</span> /{' '}
              <span className="tabular-nums">{visibleColumns.length}</span>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Columnas visibles</p>
            <div className="border rounded-lg p-3 max-h-[320px] overflow-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {visibleColumns.map((col) => {
                  const checked = selectedColumnKeys.has(col.key);
                  return (
                    <label
                      key={col.key}
                      className="flex items-center gap-2 px-1 py-1 rounded cursor-pointer hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => {
                          const isChecked = next === true;
                          setSelectedColumnKeys((prev) => {
                            const nextSet = new Set(prev);
                            if (isChecked) nextSet.add(col.key);
                            else nextSet.delete(col.key);
                            return nextSet;
                          });
                        }}
                      />
                      <span className="text-sm">{col.header}</span>
                    </label>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => setSelectedColumnKeys(new Set(visibleColumnKeys))}
                >
                  Seleccionar todo
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => setSelectedColumnKeys(new Set())}
                >
                  Ninguna
                </Button>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!canDownload) return;
              downloadCSV(rowsToExport, filename, selectedColumns);
              onOpenChange(false);
            }}
            disabled={!canDownload}
          >
            Descargar CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

