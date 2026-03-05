import { useState, useEffect } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Settings,
  DollarSign,
  Truck,
  Warehouse,
  Clock,
  Shield,
  Save,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Info,
  Calculator,
  HelpCircle,
  Loader2,
  CheckCircle,
  AlertCircle,
  ArrowRight,
  Upload,
  Database,
  FileUp,
  FlaskConical,
  Download,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AIM2026Config } from '@/lib/aim2026/types';
import { DEFAULT_CONFIG, DEFAULT_LANDED_COST_NOTES } from '@/lib/aim2026/types';
import {
  fetchXeroCosts,
  categorizeXeroCosts,
  loadLeadTimesFromCSV,
  recalculateKPIs,
  reloadFromCSVs,
  generatePurchaseCSV,
  fetchSalesForStatus,
  uploadSalesCSV,
  fetchSOHCSV,
  uploadSOHCSV,
  fetchProductionForStatus,
  uploadProductionCSV,
  type XeroCostItem,
  type CostCategorization,
  type CsvReloadProgress,
  type GeneratePurchaseCsvResult,
} from '@/lib/aim2026/api';

// ─── Types ─────────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: AIM2026Config;
  onSave: (config: AIM2026Config) => void;
  onSyncAndDownload?: () => void;
}

// ─── Section Wrapper ───────────────────────────────────────────────────────

function Section({
  title,
  icon: Icon,
  description,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: any;
  description: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
      >
        <Icon size={15} className="text-blue-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold block">{title}</span>
          <span className="text-[10px] text-muted-foreground">{description}</span>
        </div>
        {open ? (
          <ChevronDown size={14} className="text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
        )}
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t space-y-3">{children}</div>}
    </div>
  );
}

// ─── Rate Input ────────────────────────────────────────────────────────────

function RateInput({
  label,
  value,
  onChange,
  suffix = '%',
  step = 0.5,
  min = 0,
  max = 100,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2 mt-1">
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          step={step}
          min={min}
          max={max}
          className="h-8 text-sm tabular-nums"
        />
        <span className="text-xs text-muted-foreground flex-shrink-0 w-6 text-right">{suffix}</span>
      </div>
      {hint && (
        <p className="text-[10px] text-muted-foreground/60 mt-0.5 flex items-start gap-1">
          <Info size={9} className="mt-0.5 flex-shrink-0" />
          {hint}
        </p>
      )}
    </div>
  );
}

// ─── Cost Category Display ──────────────────────────────────────────────

const colorMap: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  blue: {
    bg: 'bg-blue-50 dark:bg-blue-950/30',
    border: 'border-blue-200/40 dark:border-blue-800/40',
    text: 'text-blue-700 dark:text-blue-300',
    badge: 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  },
  purple: {
    bg: 'bg-purple-50 dark:bg-purple-950/30',
    border: 'border-purple-200/40 dark:border-purple-800/40',
    text: 'text-purple-700 dark:text-purple-300',
    badge: 'bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300',
  },
  amber: {
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    border: 'border-amber-200/40 dark:border-amber-800/40',
    text: 'text-amber-700 dark:text-amber-300',
    badge: 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300',
  },
  gray: {
    bg: 'bg-muted/30',
    border: 'border-border/40',
    text: 'text-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
};

function CostCategory({
  label,
  items,
  total,
  color,
  fobValue,
}: {
  label: string;
  items: XeroCostItem[];
  total: number;
  color: string;
  fobValue: number;
}) {
  const c = colorMap[color] ?? colorMap.gray;
  const rate = fobValue > 0 ? (total / fobValue) * 100 : 0;

  return (
    <div className={cn('rounded-md px-3 py-2 border space-y-1', c.bg, c.border)}>
      <div className="flex items-center justify-between">
        <span className={cn('text-[11px] font-semibold', c.text)}>{label}</span>
        <div className="flex items-center gap-2">
          <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded', c.badge)}>
            ${total.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
          {fobValue > 0 && (
            <span className="text-[10px] font-bold tabular-nums text-foreground">
              {rate.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
      {items.length > 0 ? (
        <div className="space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground truncate pr-2">{item.name}</span>
              <span className="tabular-nums text-foreground flex-shrink-0">
                ${Math.abs(item.totalAnnual).toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-muted-foreground/60 italic">No matching items found in P&L</p>
      )}
    </div>
  );
}

// ─── Lead Times Section ─────────────────────────────────────────────────────

function LeadTimesSection({ defaultLeadTimeDays }: { defaultLeadTimeDays: number }) {
  const [ltLoading, setLtLoading] = useState(false);
  const [ltResult, setLtResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleLoadLeadTimes = async () => {
    setLtLoading(true);
    setLtResult(null);
    try {
      // Step 1: Load lead times from ProductList.csv
      const loadResult = await loadLeadTimesFromCSV();
      if (!loadResult.success) {
        setLtResult({ success: false, message: loadResult.message });
        return;
      }

      // Step 2: Recalculate KPIs so the new lead times take effect
      const kpiResult = await recalculateKPIs();
      setLtResult({
        success: kpiResult.success,
        message: `${loadResult.message}. ${kpiResult.message}`,
      });
    } catch (e) {
      setLtResult({ success: false, message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setLtLoading(false);
    }
  };

  return (
    <Section
      title="Lead Times"
      icon={Clock}
      description="Per-SKU lead times from ProductList.csv"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div className="bg-muted/30 rounded-md px-3 py-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Individual SKU lead times are loaded from <strong>ProductList.csv</strong> in the storage bucket.
            The Unleashed sync also updates lead times automatically when available.
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Default lead time: <span className="font-bold">{defaultLeadTimeDays} days</span> (used when no specific lead time is set)
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleLoadLeadTimes}
          disabled={ltLoading}
          className="gap-1.5 text-xs w-full"
        >
          {ltLoading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Upload size={13} />
          )}
          {ltLoading ? 'Loading Lead Times & Recalculating...' : 'Load Lead Times from CSV'}
        </Button>

        {ltResult && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-[10px] flex items-start gap-1.5',
              ltResult.success
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
            )}
          >
            {ltResult.success ? <CheckCircle size={12} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />}
            <span className="leading-relaxed">{ltResult.message}</span>
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── CSV Reload Section ──────────────────────────────────────────────────────

function CSVReloadSection() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<CsvReloadProgress | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string; errors: string[] } | null>(null);

  const handleReload = async () => {
    if (!confirm('This will reload ALL data from CSV files in the Supabase bucket and recalculate KPIs. Existing demand history will be replaced. Continue?')) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await reloadFromCSVs((p) => setProgress(p));
      setResult(res);
    } catch (e) {
      setResult({ success: false, message: e instanceof Error ? e.message : 'Unknown error', errors: [] });
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <Section
      title="CSV Data Reload"
      icon={Database}
      description="Reload all data from CSV files in Supabase Storage"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div className="bg-muted/30 rounded-md px-3 py-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Reloads data from CSV files in the <strong>aim-csv-files</strong> bucket:
            SOHList, SalesEnquiryList, ProductionEnquiryList, PurchaseEnquiryList, costs, and ProductList.
            This replaces existing demand history and recalculates all KPIs.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleReload}
          disabled={loading}
          className="gap-1.5 text-xs w-full"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FileUp size={13} />
          )}
          {loading
            ? progress?.label ?? 'Loading...'
            : 'Reload All Data from CSVs'}
        </Button>

        {loading && progress && (
          <div className="space-y-1">
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300 rounded-full"
                style={{ width: `${progress.progress}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground text-center">
              {progress.label} ({progress.progress}%)
            </p>
          </div>
        )}

        {result && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-[10px] space-y-1',
              result.success
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
            )}
          >
            <div className="flex items-start gap-1.5">
              {result.success ? <CheckCircle size={12} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />}
              <span className="leading-relaxed">{result.message}</span>
            </div>
            {result.errors.length > 0 && (
              <ul className="ml-4 space-y-0.5 list-disc">
                {result.errors.map((err, i) => (
                  <li key={i} className="text-[9px]">{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Generate Purchase CSV Section ─────────────────────────────────────────

function GeneratePurchaseCsvSection() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GeneratePurchaseCsvResult | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await generatePurchaseCSV();
      setResult(res);

      if (res.success && res.csvBase64) {
        const binaryStr = atob(res.csvBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'PurchaseEnquiryList.csv';
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setResult({
        success: false,
        totalOrders: 0,
        totalRows: 0,
        totalQty: 0,
        totalCost: 0,
        csvSizeBytes: 0,
        upload: null,
        sampleRows: [],
        error: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section
      title="Test: Generate Purchase CSV"
      icon={FlaskConical}
      description="Fetch Purchase Orders from Unleashed API and generate PurchaseEnquiryList.csv"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div className="bg-muted/30 rounded-md px-3 py-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Fetches Purchase Orders from the Unleashed API (statuses: Placed, Container,
            DHL-Inbounds, Custom-Projects, Production), cross-references Products for Product Group,
            and generates a CSV matching the Unleashed Purchase Enquiry report format.
            The CSV is uploaded to the <strong>aim-csv-files</strong> bucket.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={loading}
          className="gap-1.5 text-xs w-full"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FlaskConical size={13} />
          )}
          {loading ? 'Generating CSV from Unleashed API...' : 'Test: Generate Purchase Enquiry CSV'}
        </Button>

        {result && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-[10px] space-y-2',
              result.success
                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
            )}
          >
            <div className="flex items-start gap-1.5">
              {result.success ? (
                <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : (
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              )}
              <span className="leading-relaxed font-medium">
                {result.success
                  ? `CSV generated: ${result.totalRows} rows from ${result.totalOrders} orders`
                  : `Error: ${result.error}`}
              </span>
            </div>

            {result.success && (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                  {result.version && (
                    <>
                      <span className="text-muted-foreground">Version:</span>
                      <span className="font-mono tabular-nums">{result.version}</span>
                    </>
                  )}
                  {result.generatedAt && (
                    <>
                      <span className="text-muted-foreground">Generated:</span>
                      <span className="font-mono tabular-nums">{result.generatedAt}</span>
                    </>
                  )}
                  {result.csvBase64 && (
                    <>
                      <span className="text-muted-foreground">Direct Download:</span>
                      <span className="font-mono tabular-nums text-emerald-600">Auto-downloaded to your PC</span>
                    </>
                  )}
                  <span className="text-muted-foreground">Total Qty:</span>
                  <span className="font-mono tabular-nums">{result.totalQty.toLocaleString()}</span>
                  <span className="text-muted-foreground">Total Cost:</span>
                  <span className="font-mono tabular-nums">${result.totalCost.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</span>
                  <span className="text-muted-foreground">CSV Size:</span>
                  <span className="font-mono tabular-nums">{(result.csvSizeBytes / 1024).toFixed(1)} KB</span>
                  <span className="text-muted-foreground">Uploaded to:</span>
                  <span className="font-mono">{result.upload?.success ? `${result.upload.bucket}/${result.upload.file}` : 'Upload failed'}</span>
                </div>

                {result.sampleRows.length > 0 && (
                  <div className="mt-1.5 border-t pt-1.5 border-emerald-200/40 dark:border-emerald-800/40">
                    <p className="text-[9px] font-semibold mb-1">Sample rows:</p>
                    {result.sampleRows.map((row, i) => (
                      <div key={i} className="text-[9px] font-mono flex gap-2 flex-wrap">
                        <span>{row.orderNo}</span>
                        <span className="text-muted-foreground">{row.productCode}</span>
                        <span>{row.orderStatus}</span>
                        <span>qty:{row.qty}</span>
                        {row.orderDate && <span>date:{row.orderDate}</span>}
                        {row.deliveryDate && <span>deliv:{row.deliveryDate}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {result.debug?.sampleOrderDate && (
                  <div className="mt-1.5 border-t pt-1.5 border-emerald-200/40 dark:border-emerald-800/40">
                    <p className="text-[9px] font-semibold mb-1">API Debug:</p>
                    <div className="text-[9px] font-mono space-y-0.5 break-all">
                      <div>OrderDate raw: {JSON.stringify(result.debug.sampleOrderDate)}</div>
                      <div>RequiredDate raw: {JSON.stringify(result.debug.sampleRequiredDate)}</div>
                      {result.debug.sampleDateFields && (
                        <div>Date fields: {JSON.stringify(result.debug.sampleDateFields)}</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Generate Sales CSV Section ─────────────────────────────────────────────

const SALES_STATUSES = ['Completed', 'Placed', 'Backordered', 'Parked'];

interface SalesProgress {
  step: string;
  existingRows?: number;
  latestDate?: string;
  cutoffDate?: string;
  statusesDone?: string[];
  newRows?: number;
  keptRows?: number;
  mergedRows?: number;
  deltaFiltered?: number;
  uploaded?: boolean;
  uploadError?: string;
  deltaDownloaded?: boolean;
  error?: string;
}

function parseDDMMYYYYLocal(s: string): Date | null {
  const p = s.trim().split('/');
  if (p.length !== 3) return null;
  const d = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function extractDateLocal(line: string): string {
  const i = line.indexOf(',');
  return i > 0 ? line.substring(0, i).trim() : '';
}

/** Parse CSV line handling quoted fields. Returns [date, productCode, product, customer, productGroup, warehouse, status, quantity, subTotal, customerType] */
function parseSalesCSVLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Key for row identity (excludes status so we can detect status changes) */
function rowKey(fields: string[]): string {
  if (fields.length < 10) return '';
  return [fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[7], fields[8], fields[9]].join('|');
}

function GenerateSalesCsvSection() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<SalesProgress | null>(null);

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

  const handleGenerate = async () => {
    setLoading(true);
    setProgress(null);

    try {
      // ── 1. Download existing CSV ──
      setProgress({ step: 'Downloading existing CSV...' });
      let existingDataLines: string[] = [];
      let latestDateStr = '';

      const dlRes = await fetch(
        `${supabaseUrl}/storage/v1/object/aim-csv-files/SalesEnquiryList.csv`,
        { headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey } },
      );
      if (dlRes.ok) {
        const text = await dlRes.text();
        const lines = text.split('\n');
        for (let i = 2; i < lines.length; i++) {
          if (lines[i].trim()) {
            existingDataLines.push(lines[i]);
          }
        }
        // Use the most recent date (not first line) for correct cutoff
        let latestMs = 0;
        for (const line of existingDataLines) {
          const ds = extractDateLocal(line);
          const d = parseDDMMYYYYLocal(ds);
          if (d && d.getTime() > latestMs) {
            latestMs = d.getTime();
            latestDateStr = ds;
          }
        }
      }

      // ── 2. Fetch each status sequentially from API ──
      const allNewLines: string[] = [];
      const statusesDone: string[] = [];
      let cutoffDate = '';

      for (const st of SALES_STATUSES) {
        setProgress({
          step: `Fetching ${st} orders...`,
          existingRows: existingDataLines.length,
          latestDate: latestDateStr || '(none)',
          statusesDone: [...statusesDone],
          newRows: allNewLines.length,
        });

        try {
          const res = await fetchSalesForStatus(st, latestDateStr || undefined);
          if (res.success && res.csvLines) {
            allNewLines.push(...res.csvLines);
            if (!cutoffDate && res.cutoffDateAU) cutoffDate = res.cutoffDateAU;
          }
          statusesDone.push(`${st}: ${res.linesCount ?? 0}`);
        } catch (e) {
          statusesDone.push(`${st}: ERROR`);
        }
      }

      // ── 3. Sort new lines desc by date ──
      allNewLines.sort((a, b) => {
        const pa = extractDateLocal(a).split('/');
        const pb = extractDateLocal(b).split('/');
        const da = pa.length === 3 ? `${pa[2]}${pa[1]}${pa[0]}` : '';
        const db = pb.length === 3 ? `${pb[2]}${pb[1]}${pb[0]}` : '';
        return db.localeCompare(da);
      });

      // ── 4. Merge: new lines + kept old lines before cutoff ──
      setProgress({
        step: 'Merging data...',
        existingRows: existingDataLines.length,
        latestDate: latestDateStr,
        cutoffDate,
        statusesDone,
        newRows: allNewLines.length,
      });

      const cutoffISOMatch = cutoffDate ? cutoffDate : null;
      let keptLines: string[] = [];
      const existingInRange = new Map<string, string>(); // key -> status (for delta filtering)

      if (cutoffISOMatch) {
        const cutoffParts = cutoffISOMatch.split('/');
        const cutoffMs = cutoffParts.length === 3
          ? new Date(`${cutoffParts[2]}-${cutoffParts[1]}-${cutoffParts[0]}T00:00:00Z`).getTime()
          : 0;
        const latestMs = latestDateStr
          ? parseDDMMYYYYLocal(latestDateStr)?.getTime() ?? 0
          : 0;

        if (cutoffMs > 0) {
          let cutIdx = -1;
          for (let i = 0; i < existingDataLines.length; i++) {
            const line = existingDataLines[i];
            const ds = extractDateLocal(line);
            const d = parseDDMMYYYYLocal(ds);
            if (d && d.getTime() < cutoffMs) {
              cutIdx = i;
              break;
            }
            if (d && d.getTime() >= cutoffMs && d.getTime() <= latestMs) {
              const f = parseSalesCSVLine(line);
              const k = rowKey(f);
              if (k && f.length >= 7) existingInRange.set(k, f[6].trim());
            }
          }
          keptLines = cutIdx >= 0 ? existingDataLines.slice(cutIdx) : [];
        }
      }

      const today = new Date();
      const todayAU = new Intl.DateTimeFormat('en-AU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        timeZone: 'Australia/Sydney',
      }).format(today);

      const colHeaders = 'Order Date,Product Code,Product,Customer,Product Group,Warehouse,Status,Quantity,Sub Total,Customer Type';
      const mergedCSV = [
        `Sales Enquiry as of ${todayAU},,,,,,,,,`,
        colHeaders,
        ...allNewLines,
        ...keptLines,
        '',
      ].join('\n');
      const totalMerged = allNewLines.length + keptLines.length;

      // Delta: only NEW or CHANGED rows (exclude rows that exist in original with same status)
      const deltaLines = allNewLines.filter((line) => {
        const f = parseSalesCSVLine(line);
        const k = rowKey(f);
        if (!k || f.length < 7) return true;
        const origStatus = existingInRange.get(k);
        if (!origStatus) return true;
        return origStatus !== f[6].trim();
      });

      setProgress({
        step: 'Uploading merged CSV...',
        existingRows: existingDataLines.length,
        latestDate: latestDateStr,
        cutoffDate,
        statusesDone,
        newRows: allNewLines.length,
        keptRows: keptLines.length,
        mergedRows: totalMerged,
        deltaFiltered: deltaLines.length,
      });

      const upRes = await uploadSalesCSV(mergedCSV);

      // ── 6. Auto-download delta CSV (only NEW or CHANGED rows) ──
      const deltaCSV = [
        `Sales Enquiry DELTA (new or status changed) as of ${todayAU},,,,,,,,,`,
        colHeaders,
        ...deltaLines,
        '',
      ].join('\n');
      const blob = new Blob([deltaCSV], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SalesEnquiryList_DELTA.csv';
      a.click();
      URL.revokeObjectURL(url);

      setProgress({
        step: 'Done',
        existingRows: existingDataLines.length,
        latestDate: latestDateStr,
        cutoffDate,
        statusesDone,
        newRows: allNewLines.length,
        keptRows: keptLines.length,
        mergedRows: totalMerged,
        deltaFiltered: deltaLines.length,
        uploaded: upRes.success,
        uploadError: upRes.error,
        deltaDownloaded: true,
      });
    } catch (e) {
      setProgress({
        step: 'Error',
        error: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section
      title="Test: Generate Sales CSV"
      icon={FlaskConical}
      description="Incremental update of SalesEnquiryList.csv from Unleashed API"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div className="bg-muted/30 rounded-md px-3 py-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Downloads <strong>SalesEnquiryList.csv</strong> from Storage, finds latest date,
            fetches new/updated Sales Orders from Unleashed (one status at a time:
            Completed, Placed, Backordered, Parked), merges client-side,
            re-uploads, and auto-downloads the <strong>delta CSV</strong>.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={loading}
          className="gap-1.5 text-xs w-full"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FlaskConical size={13} />
          )}
          {loading
            ? progress?.step ?? 'Processing...'
            : 'Test: Update Sales Enquiry CSV'}
        </Button>

        {progress && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-[10px] space-y-2',
              progress.error
                ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                : progress.step === 'Done'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
            )}
          >
            <div className="flex items-start gap-1.5">
              {progress.error ? (
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : progress.step === 'Done' ? (
                <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : (
                <Loader2 size={12} className="mt-0.5 flex-shrink-0 animate-spin" />
              )}
              <span className="leading-relaxed font-medium">
                {progress.error
                  ? `Error: ${progress.error}`
                  : progress.step === 'Done'
                    ? `Merged: ${(progress.mergedRows ?? 0).toLocaleString()} total rows (${(progress.newRows ?? 0).toLocaleString()} new from API)`
                    : progress.step}
              </span>
            </div>

            {(progress.existingRows != null || progress.newRows != null) && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                {progress.existingRows != null && (
                  <>
                    <span className="text-muted-foreground">Existing Rows:</span>
                    <span className="font-mono tabular-nums">{progress.existingRows.toLocaleString()}</span>
                  </>
                )}
                {progress.latestDate && (
                  <>
                    <span className="text-muted-foreground">Latest Date:</span>
                    <span className="font-mono tabular-nums">{progress.latestDate}</span>
                  </>
                )}
                {progress.cutoffDate && (
                  <>
                    <span className="text-muted-foreground">Cutoff Date:</span>
                    <span className="font-mono tabular-nums">{progress.cutoffDate}</span>
                  </>
                )}
                {progress.statusesDone && progress.statusesDone.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Statuses:</span>
                    <span className="font-mono tabular-nums">{progress.statusesDone.join(' | ')}</span>
                  </>
                )}
                {progress.newRows != null && (
                  <>
                    <span className="text-muted-foreground">New from API:</span>
                    <span className="font-mono tabular-nums">{progress.newRows.toLocaleString()}</span>
                  </>
                )}
                {progress.keptRows != null && (
                  <>
                    <span className="text-muted-foreground">Kept (before cutoff):</span>
                    <span className="font-mono tabular-nums">{progress.keptRows.toLocaleString()}</span>
                  </>
                )}
                {progress.mergedRows != null && (
                  <>
                    <span className="text-muted-foreground">Total Merged:</span>
                    <span className="font-mono tabular-nums">{progress.mergedRows.toLocaleString()}</span>
                  </>
                )}
                {progress.deltaFiltered != null && (
                  <>
                    <span className="text-muted-foreground">Delta (new/changed):</span>
                    <span className="font-mono tabular-nums">{progress.deltaFiltered.toLocaleString()}</span>
                  </>
                )}
                {progress.uploaded != null && (
                  <>
                    <span className="text-muted-foreground">Storage Upload:</span>
                    <span className="font-mono tabular-nums">
                      {progress.uploaded
                        ? 'aim-csv-files/SalesEnquiryList.csv'
                        : progress.uploadError ?? 'Failed'}
                    </span>
                  </>
                )}
                {progress.deltaDownloaded && (
                  <>
                    <span className="text-muted-foreground">Delta Download:</span>
                    <span className="font-mono tabular-nums text-emerald-600">Auto-downloaded</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Generate SOH CSV Section ──────────────────────────────────────────────

interface SOHProgress {
  step: string;
  totalRows?: number;
  existingRows?: number;
  deltaFiltered?: number;
  uploaded?: boolean;
  uploadError?: string;
  deltaDownloaded?: boolean;
  error?: string;
}

function parseSOHCSVLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function GenerateSOHCsvSection() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<SOHProgress | null>(null);
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

  const handleGenerate = async () => {
    setLoading(true);
    setProgress(null);

    try {
      setProgress({ step: 'Fetching SOH from Unleashed API...' });

      const res = await fetchSOHCSV();
      if (!res.success) {
        setProgress({ step: 'Error', error: res.error ?? 'Unknown error' });
        return;
      }

      const allNewLines = res.csvLines ?? [];
      setProgress({
        step: 'Building CSV and uploading...',
        totalRows: allNewLines.length,
      });

      const today = new Date();
      const todayStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
      const colHeaders = 'Product Code,Product Description,Warehouse,Sale Days,On Purchase,Qty On Hand,Allocated,Available Qty,Avg Cost,Total Cost,Product Group';
      const fullCSV = [
        `Stock On Hand Enquiry as of ${todayStr},,,,,,,,,,`,
        colHeaders,
        ...allNewLines,
        '',
      ].join('\n');

      let existingMap = new Map<string, { qty: string; alloc: string; avail: string }>();
      const dlRes = await fetch(
        `${supabaseUrl}/storage/v1/object/aim-csv-files/SOHList.csv`,
        { headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey } },
      );
      if (dlRes.ok) {
        const text = await dlRes.text();
        const lines = text.split('\n');
        for (let i = 2; i < lines.length; i++) {
          const f = parseSOHCSVLine(lines[i]);
          if (f.length >= 11) {
            const key = `${f[0]}|${f[2]}`;
            existingMap.set(key, { qty: f[5], alloc: f[6], avail: f[7] });
          }
        }
      }

      const deltaLines = allNewLines.filter((line) => {
        const f = parseSOHCSVLine(line);
        if (f.length < 11) return true;
        const key = `${f[0]}|${f[2]}`;
        const ex = existingMap.get(key);
        if (!ex) return true;
        return ex.qty !== f[5] || ex.alloc !== f[6] || ex.avail !== f[7];
      });

      const upRes = await uploadSOHCSV(fullCSV);

      const deltaCSV = [
        `Stock On Hand DELTA (new or changed) as of ${todayStr},,,,,,,,,,`,
        colHeaders,
        ...deltaLines,
        '',
      ].join('\n');
      const blob = new Blob([deltaCSV], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'SOHList_DELTA.csv';
      a.click();
      URL.revokeObjectURL(url);

      setProgress({
        step: 'Done',
        totalRows: allNewLines.length,
        existingRows: existingMap.size,
        deltaFiltered: deltaLines.length,
        uploaded: upRes.success,
        uploadError: upRes.error,
        deltaDownloaded: true,
      });
    } catch (e) {
      setProgress({
        step: 'Error',
        error: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section
      title="Test: Generate SOH CSV"
      icon={FlaskConical}
      description="Stock On Hand from Unleashed API (Main Warehouse + China-W)"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div className="bg-muted/30 rounded-md px-3 py-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Fetches Stock On Hand from Unleashed for <strong>Main Warehouse</strong> and <strong>China-W</strong>,
            uploads to <strong>SOHList.csv</strong> in Storage, and auto-downloads the <strong>delta CSV</strong>.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={loading}
          className="gap-1.5 text-xs w-full"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FlaskConical size={13} />
          )}
          {loading ? progress?.step ?? 'Processing...' : 'Test: Update SOH CSV'}
        </Button>

        {progress && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-[10px] space-y-2',
              progress.error
                ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                : progress.step === 'Done'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
            )}
          >
            <div className="flex items-start gap-1.5">
              {progress.error ? (
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : progress.step === 'Done' ? (
                <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : (
                <Loader2 size={12} className="mt-0.5 flex-shrink-0 animate-spin" />
              )}
              <span className="leading-relaxed font-medium">
                {progress.error
                  ? `Error: ${progress.error}`
                  : progress.step === 'Done'
                    ? `Total: ${(progress.totalRows ?? 0).toLocaleString()} rows (${(progress.deltaFiltered ?? 0).toLocaleString()} new/changed)`
                    : progress.step}
              </span>
            </div>
            {(progress.totalRows != null || progress.deltaFiltered != null) && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                {progress.totalRows != null && (
                  <>
                    <span className="text-muted-foreground">Total Rows:</span>
                    <span className="font-mono tabular-nums">{progress.totalRows.toLocaleString()}</span>
                  </>
                )}
                {progress.existingRows != null && (
                  <>
                    <span className="text-muted-foreground">Existing (before):</span>
                    <span className="font-mono tabular-nums">{progress.existingRows.toLocaleString()}</span>
                  </>
                )}
                {progress.deltaFiltered != null && (
                  <>
                    <span className="text-muted-foreground">Delta (new/changed):</span>
                    <span className="font-mono tabular-nums">{progress.deltaFiltered.toLocaleString()}</span>
                  </>
                )}
                {progress.uploaded != null && (
                  <>
                    <span className="text-muted-foreground">Storage Upload:</span>
                    <span className="font-mono tabular-nums">
                      {progress.uploaded ? 'aim-csv-files/SOHList.csv' : progress.uploadError ?? 'Failed'}
                    </span>
                  </>
                )}
                {progress.deltaDownloaded && (
                  <>
                    <span className="text-muted-foreground">Delta Download:</span>
                    <span className="font-mono tabular-nums text-emerald-600">Auto-downloaded</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Generate Production Enquiry CSV Section ───────────────────────────────

const PRODUCTION_STATUSES = ['Completed', 'Parked'];

interface ProductionProgress {
  step: string;
  existingRows?: number;
  latestDate?: string;
  cutoffDate?: string;
  statusesDone?: string[];
  newRows?: number;
  keptRows?: number;
  mergedRows?: number;
  deltaFiltered?: number;
  uploaded?: boolean;
  uploadError?: string;
  deltaDownloaded?: boolean;
  error?: string;
}

function parseProductionCSVLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function escProductionCSV(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n'))
    return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function GenerateProductionCsvSection() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProductionProgress | null>(null);
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
  const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

  const handleGenerate = async () => {
    setLoading(true);
    setProgress(null);

    if (!supabaseUrl || !supabaseKey) {
      setProgress({ step: 'Error', error: 'VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY no configurados.' });
      setLoading(false);
      return;
    }

    try {
      setProgress({ step: 'Downloading existing CSV...' });
      let existingDataLines: string[] = [];
      let latestDateStr = '';

      try {
        const dlRes = await fetch(
          `${supabaseUrl}/storage/v1/object/aim-csv-files/ProductionEnquiryList.csv`,
          { headers: { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey } },
        );
        if (dlRes.ok) {
          const text = await dlRes.text();
          const lines = text.split('\n');
          for (let i = 2; i < lines.length; i++) {
            if (lines[i].trim()) {
              existingDataLines.push(lines[i]);
            }
          }
          // Use the most recent Assembly Date (col 2) for correct cutoff
          let latestMs = 0;
          for (const line of existingDataLines) {
            const f = parseProductionCSVLine(line);
            const ds = f.length >= 2 ? f[1].trim() : '';
            const d = parseDDMMYYYYLocal(ds);
            if (d && d.getTime() > latestMs) {
              latestMs = d.getTime();
              latestDateStr = ds;
            }
          }
        }
      } catch {
        // File may not exist yet — continue with empty data
      }

      let cutoffStr = '2025-01-01';
      if (latestDateStr) {
        const d = parseDDMMYYYYLocal(latestDateStr);
        if (d) {
          const cut = new Date(d);
          cut.setDate(cut.getDate() - 3);
          cutoffStr = cut.toISOString().slice(0, 10);
        }
      }
      const endDate = new Date().toISOString().slice(0, 10);

      const allNewLines: string[] = [];
      const statusesDone: string[] = [];

      for (const st of PRODUCTION_STATUSES) {
        setProgress({
          step: `Fetching ${st} assemblies...`,
          existingRows: existingDataLines.length,
          latestDate: latestDateStr || '(none)',
          statusesDone: [...statusesDone],
          newRows: allNewLines.length,
        });
        try {
          const res = await fetchProductionForStatus(st, cutoffStr, endDate);
          if (res.success && res.csvLines) allNewLines.push(...res.csvLines);
          statusesDone.push(`${st}: ${res.linesCount ?? 0}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          const hint = msg.includes('Failed to fetch')
            ? ' — Despliega las Edge Functions: supabase functions deploy aim2026-generate-production-csv aim2026-upload-production-csv'
            : '';
          throw new Error(`Error al obtener assemblies (${st}): ${msg}${hint}`);
        }
      }

      allNewLines.sort((a, b) => {
        const fa = parseProductionCSVLine(a), fb = parseProductionCSVLine(b);
        const da = fa.length >= 2 ? fa[1].split('/').reverse().join('') : '';
        const db = fb.length >= 2 ? fb[1].split('/').reverse().join('') : '';
        return db.localeCompare(da);
      });

      const cutoffMs = new Date(cutoffStr + 'T00:00:00Z').getTime();
      let keptLines: string[] = [];
      const existingInRange = new Map<string, string>();

      if (cutoffMs > 0) {
        let cutIdx = -1;
        for (let i = 0; i < existingDataLines.length; i++) {
          const f = parseProductionCSVLine(existingDataLines[i]);
          const ds = f.length >= 2 ? f[1] : '';
          const d = parseDDMMYYYYLocal(ds);
          if (d && d.getTime() < cutoffMs) { cutIdx = i; break; }
          if (d && d.getTime() >= cutoffMs) {
            const k = `${f[0]}|${f[1]}|${f[3]}`;
            if (f.length >= 10) existingInRange.set(k, `${f[7]}|${f[8]}|${f[9]}`);
          }
        }
        keptLines = cutIdx >= 0 ? existingDataLines.slice(cutIdx) : [];
      }

      // Re-sign kept lines: if a component SKU appears with negative qty in new data
      // but with positive qty in the old kept file, correct it.
      // Always re-escape all kept lines to avoid bare-quote CSV parse errors.
      if (keptLines.length > 0) {
        const componentSKUs = new Set<string>();
        for (const line of allNewLines) {
          const f = parseProductionCSVLine(line);
          if (f.length >= 8 && parseFloat(f[7]) < 0) componentSKUs.add(f[3]);
        }
        keptLines = keptLines.map((line) => {
          const f = parseProductionCSVLine(line);
          if (f.length < 10) return f.map(escProductionCSV).join(',');
          const qty = parseFloat(f[7]);
          const cost = parseFloat(f[8]);
          if (componentSKUs.has(f[3]) && qty > 0) {
            f[7] = String(Math.round(-qty));
            f[8] = (-Math.abs(cost)).toFixed(2);
          }
          return f.map(escProductionCSV).join(',');
        });
      }

      const today = new Date();
      const todayAU = new Intl.DateTimeFormat('en-AU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        timeZone: 'Australia/Sydney',
      }).format(today);

      const colHeaders = 'Assembly Number,Assembly Date,Assemble By,Product Code,Product Description,Product Group,Warehouse,Quantity,Total Cost,Assembly Status';
      const totalMerged = allNewLines.length + keptLines.length;

      // #region agent log
      fetch('http://127.0.0.1:7243/ingest/b38be47e-507c-4d05-9e9f-2280ddcea66d',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'567404'},body:JSON.stringify({sessionId:'567404',runId:'run1',hypothesisId:'H-A-H-D',location:'SettingsPanel.tsx:allNewLines-before-merge',message:'allNewLines first 3 lines before merge',data:{total:allNewLines.length,first3:allNewLines.slice(0,3),keptCount:keptLines.length,keptFirst3:keptLines.slice(0,3)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      const deltaLines = allNewLines.filter((line) => {
        const f = parseProductionCSVLine(line);
        if (f.length < 10) return true;
        const k = `${f[0]}|${f[1]}|${f[3]}`;
        const ex = existingInRange.get(k);
        if (!ex) return true;
        return ex !== `${f[7]}|${f[8]}|${f[9]}`;
      });

      const mergedCSVToUpload = [
        `Production Enquiry as of ${todayAU},,,,,,,,,`,
        colHeaders,
        ...allNewLines,
        ...keptLines,
        '',
      ].join('\n');

      // #region agent log
      const mergedDataLines = mergedCSVToUpload.split('\n').slice(2).filter(l => l.trim());
      fetch('http://127.0.0.1:7243/ingest/b38be47e-507c-4d05-9e9f-2280ddcea66d',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'567404'},body:JSON.stringify({sessionId:'567404',runId:'run1',hypothesisId:'H-B-H-C',location:'SettingsPanel.tsx:mergedCSV-built',message:'mergedCSVToUpload first 3 data lines',data:{totalLines:mergedDataLines.length,first3:mergedDataLines.slice(0,3),deltaFirst3:deltaLines.slice(0,3)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      setProgress({
        step: 'Uploading merged CSV...',
        existingRows: existingDataLines.length,
        latestDate: latestDateStr,
        cutoffDate: cutoffStr,
        statusesDone,
        newRows: allNewLines.length,
        keptRows: keptLines.length,
        mergedRows: totalMerged,
        deltaFiltered: deltaLines.length,
      });

      // #region agent log
      const uploadPreviewLines = mergedCSVToUpload.split('\n').slice(2,5);
      fetch('http://127.0.0.1:7243/ingest/b38be47e-507c-4d05-9e9f-2280ddcea66d',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'567404'},body:JSON.stringify({sessionId:'567404',runId:'run1',hypothesisId:'H-C',location:'SettingsPanel.tsx:before-upload',message:'content being sent to uploadProductionCSV',data:{lines2to4:uploadPreviewLines,totalChars:mergedCSVToUpload.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      let upRes;
      try {
        upRes = await uploadProductionCSV(mergedCSVToUpload);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        const hint = msg.includes('Failed to fetch')
          ? ' — Despliega: supabase functions deploy aim2026-upload-production-csv'
          : '';
        throw new Error(`Error al subir CSV: ${msg}${hint}`);
      }

      const deltaCSV = [
        `Production Enquiry DELTA (new or changed) as of ${todayAU},,,,,,,,,`,
        colHeaders,
        ...deltaLines,
        '',
      ].join('\n');
      const blob = new Blob([deltaCSV], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ProductionEnquiryList_DELTA.csv';
      a.click();
      URL.revokeObjectURL(url);

      setProgress({
        step: 'Done',
        existingRows: existingDataLines.length,
        latestDate: latestDateStr,
        cutoffDate: cutoffStr,
        statusesDone,
        newRows: allNewLines.length,
        keptRows: keptLines.length,
        mergedRows: totalMerged,
        deltaFiltered: deltaLines.length,
        uploaded: upRes.success,
        uploadError: upRes.error,
        deltaDownloaded: true,
      });
    } catch (e) {
      setProgress({
        step: 'Error',
        error: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section
      title="Test: Generate Production Enquiry CSV"
      icon={FlaskConical}
      description="Assemblies from Unleashed API (Main Warehouse + China-W)"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div className="bg-muted/30 rounded-md px-3 py-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Downloads <strong>ProductionEnquiryList.csv</strong> from Storage, finds latest date,
            fetches Assemblies (Completed, Parked) from Unleashed for <strong>Main Warehouse</strong> and <strong>China-W</strong>,
            merges, uploads, and auto-downloads the <strong>delta CSV</strong>.
            Si falla con &quot;Failed to fetch&quot;, despliega las Edge Functions.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={loading}
          className="gap-1.5 text-xs w-full"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <FlaskConical size={13} />
          )}
          {loading ? progress?.step ?? 'Processing...' : 'Test: Update Production Enquiry CSV'}
        </Button>

        {progress && (
          <div
            className={cn(
              'rounded-md px-3 py-2 text-[10px] space-y-2',
              progress.error
                ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                : progress.step === 'Done'
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
            )}
          >
            <div className="flex items-start gap-1.5">
              {progress.error ? (
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : progress.step === 'Done' ? (
                <CheckCircle size={12} className="mt-0.5 flex-shrink-0" />
              ) : (
                <Loader2 size={12} className="mt-0.5 flex-shrink-0 animate-spin" />
              )}
              <span className="leading-relaxed font-medium">
                {progress.error
                  ? `Error: ${progress.error}`
                  : progress.step === 'Done'
                    ? `Merged: ${(progress.mergedRows ?? 0).toLocaleString()} total rows (${(progress.newRows ?? 0).toLocaleString()} new from API)`
                    : progress.step}
              </span>
            </div>
            {(progress.existingRows != null || progress.newRows != null) && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
                {progress.existingRows != null && (
                  <>
                    <span className="text-muted-foreground">Existing Rows:</span>
                    <span className="font-mono tabular-nums">{progress.existingRows.toLocaleString()}</span>
                  </>
                )}
                {progress.latestDate && (
                  <>
                    <span className="text-muted-foreground">Latest Date:</span>
                    <span className="font-mono tabular-nums">{progress.latestDate}</span>
                  </>
                )}
                {progress.cutoffDate && (
                  <>
                    <span className="text-muted-foreground">Cutoff Date:</span>
                    <span className="font-mono tabular-nums">{progress.cutoffDate}</span>
                  </>
                )}
                {progress.statusesDone && progress.statusesDone.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Statuses:</span>
                    <span className="font-mono tabular-nums">{progress.statusesDone.join(' | ')}</span>
                  </>
                )}
                {progress.newRows != null && (
                  <>
                    <span className="text-muted-foreground">New from API:</span>
                    <span className="font-mono tabular-nums">{progress.newRows.toLocaleString()}</span>
                  </>
                )}
                {progress.keptRows != null && (
                  <>
                    <span className="text-muted-foreground">Kept (before cutoff):</span>
                    <span className="font-mono tabular-nums">{progress.keptRows.toLocaleString()}</span>
                  </>
                )}
                {progress.mergedRows != null && (
                  <>
                    <span className="text-muted-foreground">Total Merged:</span>
                    <span className="font-mono tabular-nums">{progress.mergedRows.toLocaleString()}</span>
                  </>
                )}
                {progress.deltaFiltered != null && (
                  <>
                    <span className="text-muted-foreground">Delta (new/changed):</span>
                    <span className="font-mono tabular-nums">{progress.deltaFiltered.toLocaleString()}</span>
                  </>
                )}
                {progress.uploaded != null && (
                  <>
                    <span className="text-muted-foreground">Storage Upload:</span>
                    <span className="font-mono tabular-nums">
                      {progress.uploaded
                        ? 'aim-csv-files/ProductionEnquiryList.csv'
                        : progress.uploadError ?? 'Failed'}
                    </span>
                  </>
                )}
                {progress.deltaDownloaded && (
                  <>
                    <span className="text-muted-foreground">Delta Download:</span>
                    <span className="font-mono tabular-nums text-emerald-600">Auto-downloaded</span>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

const CSV_DOWNLOAD_KEY = 'aim2026_enableCsvDownloadAfterSync';

export function SettingsPanel({ open, onOpenChange, config, onSave, onSyncAndDownload }: SettingsPanelProps) {
  const [draft, setDraft] = useState<AIM2026Config>(config);
  const [saved, setSaved] = useState(false);
  const [enableCsvDownload, setEnableCsvDownload] = useState(
    () => (typeof window !== 'undefined' ? localStorage.getItem(CSV_DOWNLOAD_KEY) === 'true' : false)
  );
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const [xeroCosts, setXeroCosts] = useState<CostCategorization | null>(null);
  const [xeroLoading, setXeroLoading] = useState(false);
  const [xeroError, setXeroError] = useState<string | null>(null);
  const [xeroFobValue, setXeroFobValue] = useState<number>(0);

  // Sync draft with incoming config when opened
  useEffect(() => {
    if (open) {
      setDraft(config);
      setSaved(false);
      setEnableCsvDownload(localStorage.getItem(CSV_DOWNLOAD_KEY) === 'true');
    }
  }, [open, config]);

  // Fetch Xero costs when the breakdown is shown
  const handleFetchXeroCosts = async () => {
    if (xeroCosts) {
      // Already fetched, just toggle
      setShowCostBreakdown((v) => !v);
      return;
    }

    setShowCostBreakdown(true);
    setXeroLoading(true);
    setXeroError(null);

    try {
      const data = await fetchXeroCosts();
      const categorized = categorizeXeroCosts(data.items);
      setXeroCosts(categorized);

      // Estimate FOB value: we use totalCOGS - freight - duty - insurance as a rough FOB base
      const estimatedFOB = categorized.totalCOGS - categorized.freight.total - categorized.duty.total - categorized.insurance.total;
      setXeroFobValue(estimatedFOB > 0 ? estimatedFOB : categorized.totalCOGS);
    } catch (err) {
      console.error('Failed to fetch Xero costs:', err);
      setXeroError(err instanceof Error ? err.message : 'Failed to load costs data');
    } finally {
      setXeroLoading(false);
    }
  };

  // Apply calculated rates from Xero data
  const handleApplyXeroRates = () => {
    if (!xeroCosts || xeroFobValue <= 0) return;

    const freightRate = xeroCosts.freight.total / xeroFobValue;
    const dutyRate = xeroCosts.duty.total / xeroFobValue;
    const insuranceRate = xeroCosts.insurance.total / xeroFobValue;

    setDraft((prev) => ({
      ...prev,
      landedCost: {
        ...prev.landedCost,
        default: {
          ...prev.landedCost.default,
          freightRate: Math.round(freightRate * 10000) / 10000,
          dutyRate: Math.round(dutyRate * 10000) / 10000,
          insuranceRate: Math.round(insuranceRate * 10000) / 10000,
        },
      },
    }));
  };

  const handleSave = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setDraft(DEFAULT_CONFIG);
  };

  const updateLandedCost = (field: string, value: number) => {
    setDraft((prev) => ({
      ...prev,
      landedCost: {
        ...prev.landedCost,
        default: {
          ...prev.landedCost.default,
          [field]: value / 100, // Convert from percentage display to decimal
        },
      },
    }));
  };

  const updateHoldingCost = (field: string, value: number) => {
    setDraft((prev) => ({
      ...prev,
      holdingCost: {
        ...prev.holdingCost,
        [field]: value,
      },
    }));
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-5">
          <SheetTitle className="flex items-center gap-2">
            <Settings size={18} className="text-blue-500" />
            AIM 2026 Settings
          </SheetTitle>
          <SheetDescription>
            Configure calculation parameters, cost rates, and defaults.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4">
          {/* ── Landed Cost ─────────────────────────────────────────── */}
          <Section
            title="Landed Cost Rates"
            icon={Truck}
            description="Rates applied to China FOB cost to calculate landed cost in AUD"
          >
            <div className="bg-muted/30 rounded-md px-3 py-2 mb-2">
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                <strong>Formula:</strong> Landed Cost AUD = Product Cost (China AUD) × (1 + Freight + Duty + Insurance)
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <RateInput
                label="Freight Rate"
                value={Math.round(draft.landedCost.default.freightRate * 10000) / 100}
                onChange={(v) => updateLandedCost('freightRate', v)}
                hint="Sea freight + DHL restocking"
              />
              <RateInput
                label="Duty Rate"
                value={Math.round(draft.landedCost.default.dutyRate * 10000) / 100}
                onChange={(v) => updateLandedCost('dutyRate', v)}
                hint="Import duty (disbursements)"
              />
              <RateInput
                label="Insurance Rate"
                value={Math.round(draft.landedCost.default.insuranceRate * 10000) / 100}
                onChange={(v) => updateLandedCost('insuranceRate', v)}
                hint="Cargo insurance"
              />
            </div>
            {/* Preview */}
            <div className="bg-blue-50 dark:bg-blue-950/30 rounded-md px-3 py-2 mt-2 border border-blue-200/40 dark:border-blue-800/40">
              <p className="text-[10px] text-blue-700 dark:text-blue-300 font-medium">
                Preview: AUD 10 China cost →{' '}
                <span className="font-bold tabular-nums">
                  AUD{' '}
                  {(
                    10 *
                    (1 +
                      draft.landedCost.default.freightRate +
                      draft.landedCost.default.dutyRate +
                      draft.landedCost.default.insuranceRate)
                  ).toFixed(2)}
                </span>{' '}
                landed ({((draft.landedCost.default.freightRate + draft.landedCost.default.dutyRate + draft.landedCost.default.insuranceRate) * 100).toFixed(1)}% markup)
              </p>
            </div>

            {/* Notes / calculation basis */}
            <div className="mt-3 space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Calculation Notes</Label>
              <Textarea
                value={draft.landedCostNotes ?? DEFAULT_LANDED_COST_NOTES}
                onChange={(e) => setDraft((prev) => ({ ...prev, landedCostNotes: e.target.value }))}
                rows={8}
                className="text-[11px] leading-relaxed font-mono resize-y"
                placeholder="Document the source of freight, duty and insurance rates..."
              />
              <p className="text-[10px] text-muted-foreground/60 flex items-start gap-1">
                <Info size={9} className="mt-0.5 flex-shrink-0" />
                These notes are saved with the config. Update when you recalculate rates from new FY data.
              </p>
            </div>

            {showCostBreakdown && (
              <div className="mt-2 bg-muted/40 rounded-lg px-4 py-3 border border-border/50 space-y-3">
                {/* Error state */}
                {xeroError && (
                  <div className="bg-red-50 dark:bg-red-950/30 rounded-md px-3 py-2 border border-red-200/40 dark:border-red-800/40 flex items-start gap-2">
                    <AlertCircle size={13} className="text-red-500 mt-0.5 flex-shrink-0" />
                    <p className="text-[11px] text-red-600 dark:text-red-400">{xeroError}</p>
                  </div>
                )}

                {/* Loading state */}
                {xeroLoading && (
                  <div className="flex items-center justify-center py-6 gap-2 text-muted-foreground">
                    <Loader2 size={16} className="animate-spin" />
                    <span className="text-xs">Reading Xero P&L data...</span>
                  </div>
                )}

                {/* Real data */}
                {xeroCosts && !xeroLoading && (
                  <>
                    <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <CheckCircle size={13} className="text-emerald-500" />
                      Cost items detected from Xero P&L
                    </p>

                    {/* Freight Items */}
                    <CostCategory
                      label="Freight Costs"
                      items={xeroCosts.freight.items}
                      total={xeroCosts.freight.total}
                      color="blue"
                      fobValue={xeroFobValue}
                    />

                    {/* Duty Items */}
                    <CostCategory
                      label="Duty Costs"
                      items={xeroCosts.duty.items}
                      total={xeroCosts.duty.total}
                      color="purple"
                      fobValue={xeroFobValue}
                    />

                    {/* Insurance Items */}
                    <CostCategory
                      label="Insurance Costs"
                      items={xeroCosts.insurance.items}
                      total={xeroCosts.insurance.total}
                      color="amber"
                      fobValue={xeroFobValue}
                    />

                    {/* Other / unmatched */}
                    {xeroCosts.other.items.length > 0 && (
                      <CostCategory
                        label="Other / Uncategorized"
                        items={xeroCosts.other.items}
                        total={xeroCosts.other.total}
                        color="gray"
                        fobValue={xeroFobValue}
                      />
                    )}

                    {/* FOB Value input */}
                    <div className="bg-background/60 rounded-md px-3 py-2 border border-border/30 space-y-1.5">
                      <Label className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
                        <Info size={9} />
                        Total FOB Purchase Value (denominator for rate calculation)
                      </Label>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">$</span>
                        <Input
                          type="number"
                          value={xeroFobValue}
                          onChange={(e) => setXeroFobValue(parseFloat(e.target.value) || 0)}
                          className="h-7 text-xs tabular-nums"
                          step={1000}
                          min={0}
                        />
                        <span className="text-[10px] text-muted-foreground">AUD</span>
                      </div>
                      <p className="text-[9px] text-muted-foreground/60">
                        Auto-estimated from P&L. Adjust if you know the exact annual FOB purchase value.
                      </p>
                    </div>

                    {/* Calculated rates summary */}
                    {xeroFobValue > 0 && (
                      <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-md px-3 py-2 border border-emerald-200/40 dark:border-emerald-800/40 space-y-1">
                        <p className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                          Calculated Rates:
                        </p>
                        <div className="grid grid-cols-3 gap-2 text-[10px] tabular-nums">
                          <div>
                            <span className="text-muted-foreground">Freight: </span>
                            <span className="font-bold text-foreground">
                              {((xeroCosts.freight.total / xeroFobValue) * 100).toFixed(2)}%
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Duty: </span>
                            <span className="font-bold text-foreground">
                              {((xeroCosts.duty.total / xeroFobValue) * 100).toFixed(2)}%
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Insurance: </span>
                            <span className="font-bold text-foreground">
                              {((xeroCosts.insurance.total / xeroFobValue) * 100).toFixed(2)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Apply button */}
                    <Button
                      size="sm"
                      className="w-full gap-1.5 text-xs"
                      onClick={handleApplyXeroRates}
                      disabled={xeroFobValue <= 0}
                    >
                      <ArrowRight size={13} />
                      Apply Calculated Rates
                    </Button>
                  </>
                )}
              </div>
            )}
          </Section>

          {/* ── Holding Cost ────────────────────────────────────────── */}
          <Section
            title="Holding / Carrying Cost"
            icon={Warehouse}
            description="Annual cost of holding inventory as a percentage of value"
          >
            <div className="bg-muted/30 rounded-md px-3 py-2 mb-2">
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                <strong>Total Holding Rate</strong> = Capital Rate + Risk Rate + Storage Rate (from Xero P&L)
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <RateInput
                label="Capital Rate"
                value={draft.holdingCost.capitalRatePercent}
                onChange={(v) => updateHoldingCost('capitalRatePercent', v)}
                hint="Opportunity cost of capital"
              />
              <RateInput
                label="Risk Rate"
                value={draft.holdingCost.riskRatePercent}
                onChange={(v) => updateHoldingCost('riskRatePercent', v)}
                hint="Obsolescence & damage risk"
              />
            </div>
            <div className="bg-amber-50 dark:bg-amber-950/30 rounded-md px-3 py-2 mt-2 border border-amber-200/40 dark:border-amber-800/40">
              <p className="text-[10px] text-amber-700 dark:text-amber-300">
                Total holding rate:{' '}
                <span className="font-bold tabular-nums">
                  {(
                    draft.holdingCost.capitalRatePercent +
                    draft.holdingCost.riskRatePercent
                  ).toFixed(1)}
                  % per year
                </span>{' '}
                (excl. storage)
              </p>
            </div>
          </Section>

          {/* ── Reorder Parameters ──────────────────────────────────── */}
          <Section
            title="Reorder Parameters"
            icon={Shield}
            description="Default values for reorder point & safety stock calculations"
          >
            <div className="bg-muted/30 rounded-md px-3 py-2 mb-2">
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                <strong>ROP</strong> = (Avg Daily Demand × Lead Time) + Safety Stock
                <br />
                <strong>Safety Stock</strong> = Z × σ × √(Lead Time / 30)
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <RateInput
                label="Default Lead Time"
                value={draft.defaultLeadTimeDays}
                onChange={(v) =>
                  setDraft((prev) => ({ ...prev, defaultLeadTimeDays: v }))
                }
                suffix="days"
                step={1}
                min={1}
                max={365}
                hint="Production + shipping days"
              />
              <div>
                <Label className="text-xs font-medium text-muted-foreground">Service Level (Z)</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="number"
                    value={draft.defaultServiceLevelZ}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        defaultServiceLevelZ: parseFloat(e.target.value) || 1.65,
                      }))
                    }
                    step={0.05}
                    min={1}
                    max={3}
                    className="h-8 text-sm tabular-nums"
                  />
                  <span className="text-xs text-muted-foreground flex-shrink-0 w-6 text-right">Z</span>
                </div>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5 flex items-start gap-1">
                  <Info size={9} className="mt-0.5 flex-shrink-0" />
                  1.28=90%, 1.65=95%, 2.33=99%
                </p>
              </div>
            </div>
          </Section>

          {/* ── Lead Times ──────────────────────────────────────────── */}
          <LeadTimesSection defaultLeadTimeDays={draft.defaultLeadTimeDays} />

          {/* ── CSV Data Reload ────────────────────────────────────── */}
          <CSVReloadSection />

          {/* ── Test: Generate Purchase CSV ─────────────────────────── */}
          <GeneratePurchaseCsvSection />

          {/* ── Test: Generate Sales CSV ──────────────────────────────── */}
          <GenerateSalesCsvSection />

          {/* ── Test: Generate SOH CSV ─────────────────────────────────── */}
          <GenerateSOHCsvSection />

          {/* ── Test: Generate Production Enquiry CSV ───────────────────── */}
          <GenerateProductionCsvSection />

          {/* ── Sync & CSV Download ───────────────────────────────────────── */}
          <Section
            title="Sync & CSV Download"
            icon={Download}
            description="Control CSV download behavior after sync"
            defaultOpen={false}
          >
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={enableCsvDownload}
                  onCheckedChange={(checked) => {
                    const val = checked === true;
                    localStorage.setItem(CSV_DOWNLOAD_KEY, val ? 'true' : 'false');
                    setEnableCsvDownload(val);
                  }}
                />
                <span className="text-sm">Auto-download CSVs after sync</span>
              </label>
              <p className="text-[10px] text-muted-foreground">
                When enabled, delta CSV files are downloaded automatically after each sync. When disabled, use the button below to download when needed.
              </p>
              {onSyncAndDownload && (
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    onSyncAndDownload();
                  }}
                  variant="outline"
                  size="sm"
                  className="w-full gap-2"
                >
                  <Download size={14} />
                  Sync and Download CSVs
                </Button>
              )}
            </div>
          </Section>
        </div>

        {/* ── Footer Buttons ──────────────────────────────────────── */}
        <div className="flex items-center gap-2 mt-6 pt-4 border-t sticky bottom-0 bg-background">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            className="gap-1.5 text-xs"
          >
            <RotateCcw size={13} />
            Reset Defaults
          </Button>
          <div className="flex-1" />
          <Button
            onClick={handleSave}
            size="sm"
            className={cn(
              'gap-1.5 text-xs transition-all',
              saved && 'bg-emerald-600 hover:bg-emerald-600'
            )}
          >
            <Save size={13} />
            {saved ? 'Saved!' : 'Save Changes'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
