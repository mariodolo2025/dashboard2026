// =============================================================================
// AIM 2026 — Full CSV Sync Orchestrator
// Runs the four CSV update steps sequentially:
//   1. SOH       (SOHList.csv)
//   2. Sales     (SalesEnquiryList.csv)
//   3. Production (ProductionEnquiryList.csv)
//   4. Purchase  (PurchaseEnquiryList.csv)
// Then recalculates KPIs.
// =============================================================================

import {
  fetchSOHCSV,
  uploadSOHCSV,
  fetchSalesForStatus,
  uploadSalesCSV,
  fetchProductionForStatus,
  uploadProductionCSV,
  generatePurchaseCSV,
  reloadFromCSVs,
} from './api';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

// ─── Types ─────────────────────────────────────────────────────────────────

export type CSVSyncPhase = 'soh' | 'sales' | 'production' | 'purchase' | 'kpis' | 'done' | 'error';

export interface CSVSyncProgress {
  step: string;
  phase: CSVSyncPhase;
  progress: number; // 0–100
}

export interface CSVSyncResult {
  success: boolean;
  errors: string[];
  message: string;
  deltaFiles: { name: string; blob: Blob }[];
}

// ─── CSV Parsing Helpers ───────────────────────────────────────────────────

function parseDDMMYYYY(s: string): Date | null {
  const p = s.trim().split('/');
  if (p.length !== 3) return null;
  const d = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function extractFirstField(line: string): string {
  const i = line.indexOf(',');
  return i > 0 ? line.substring(0, i).trim() : '';
}

function parseCSVLine(line: string): string[] {
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

function escCSV(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n'))
    return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function salesRowKey(f: string[]): string {
  if (f.length < 10) return '';
  return [f[0], f[1], f[2], f[3], f[4], f[5], f[7], f[8], f[9]].join('|');
}

function todayAU(): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Australia/Sydney',
  }).format(new Date());
}

async function fetchExistingCSV(filename: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/aim-csv-files/${filename}`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } },
    );
    return res.ok ? res.text() : null;
  } catch {
    return null;
  }
}

// ─── Step 1: SOH (progress 0 → 18) ────────────────────────────────────────

async function updateSOH(
  onProgress: (p: CSVSyncProgress) => void,
): Promise<{ blob: Blob | null; error?: string }> {
  onProgress({ step: 'Fetching SOH from Unleashed...', phase: 'soh', progress: 2 });

  const res = await fetchSOHCSV();
  if (!res.success) return { blob: null, error: res.error ?? 'SOH fetch failed' };

  const allNewLines = res.csvLines ?? [];

  // Fetch existing for delta comparison
  const existingMap = new Map<string, { qty: string; alloc: string; avail: string }>();
  const existingText = await fetchExistingCSV('SOHList.csv');
  if (existingText) {
    const lines = existingText.split('\n');
    for (let i = 2; i < lines.length; i++) {
      const f = parseCSVLine(lines[i]);
      if (f.length >= 11) existingMap.set(`${f[0]}|${f[2]}`, { qty: f[5], alloc: f[6], avail: f[7] });
    }
  }

  onProgress({ step: 'Uploading SOH CSV...', phase: 'soh', progress: 10 });

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  const colHeaders = 'Product Code,Product Description,Warehouse,Sale Days,On Purchase,Qty On Hand,Allocated,Available Qty,Avg Cost,Total Cost,Product Group';
  const fullCSV = [`Stock On Hand Enquiry as of ${todayStr},,,,,,,,,,`, colHeaders, ...allNewLines, ''].join('\n');

  await uploadSOHCSV(fullCSV);

  const deltaLines = allNewLines.filter((line) => {
    const f = parseCSVLine(line);
    if (f.length < 11) return true;
    const ex = existingMap.get(`${f[0]}|${f[2]}`);
    if (!ex) return true;
    return ex.qty !== f[5] || ex.alloc !== f[6] || ex.avail !== f[7];
  });

  const deltaCSV = [`Stock On Hand DELTA (new or changed) as of ${todayStr},,,,,,,,,,`, colHeaders, ...deltaLines, ''].join('\n');

  onProgress({ step: `SOH: ${allNewLines.length} rows, ${deltaLines.length} changed`, phase: 'soh', progress: 18 });

  return { blob: new Blob([deltaCSV], { type: 'text/csv;charset=utf-8;' }) };
}

// ─── Step 2: Sales (progress 18 → 45) ─────────────────────────────────────

const SALES_STATUSES = ['Completed', 'Placed', 'Backordered', 'Parked'];

async function updateSales(
  onProgress: (p: CSVSyncProgress) => void,
): Promise<{ blob: Blob | null; error?: string }> {
  onProgress({ step: 'Downloading Sales CSV...', phase: 'sales', progress: 19 });

  let existingDataLines: string[] = [];
  let latestDateStr = '';

  const existingText = await fetchExistingCSV('SalesEnquiryList.csv');
  if (existingText) {
    const lines = existingText.split('\n');
    for (let i = 2; i < lines.length; i++) {
      if (lines[i].trim()) {
        existingDataLines.push(lines[i]);
      }
    }
    // Use the most recent date (not first line) for correct cutoff
    let latestMs = 0;
    for (const line of existingDataLines) {
      const ds = extractFirstField(line);
      const d = parseDDMMYYYY(ds);
      if (d && d.getTime() > latestMs) {
        latestMs = d.getTime();
        latestDateStr = ds;
      }
    }
  }

  const allNewLines: string[] = [];
  let cutoffDate = '';

  for (let si = 0; si < SALES_STATUSES.length; si++) {
    const st = SALES_STATUSES[si];
    onProgress({ step: `Fetching Sales (${st})...`, phase: 'sales', progress: 20 + si * 4 });
    try {
      const res = await fetchSalesForStatus(st, latestDateStr || undefined);
      if (res.success && res.csvLines) allNewLines.push(...res.csvLines);
      if (!cutoffDate && res.cutoffDateAU) cutoffDate = res.cutoffDateAU;
    } catch { /* continue */ }
  }

  // Sort new lines desc by date
  allNewLines.sort((a, b) => {
    const pa = extractFirstField(a).split('/');
    const pb = extractFirstField(b).split('/');
    const da = pa.length === 3 ? `${pa[2]}${pa[1]}${pa[0]}` : '';
    const db = pb.length === 3 ? `${pb[2]}${pb[1]}${pb[0]}` : '';
    return db.localeCompare(da);
  });

  onProgress({ step: 'Merging Sales CSV...', phase: 'sales', progress: 37 });

  let keptLines: string[] = [];
  const existingInRange = new Map<string, string>();

  if (cutoffDate) {
    const cutoffParts = cutoffDate.split('/');
    const cutoffMs = cutoffParts.length === 3
      ? new Date(`${cutoffParts[2]}-${cutoffParts[1]}-${cutoffParts[0]}T00:00:00Z`).getTime()
      : 0;
    const latestMs = latestDateStr ? parseDDMMYYYY(latestDateStr)?.getTime() ?? 0 : 0;

    if (cutoffMs > 0) {
      let cutIdx = -1;
      for (let i = 0; i < existingDataLines.length; i++) {
        const ds = extractFirstField(existingDataLines[i]);
        const d = parseDDMMYYYY(ds);
        if (d && d.getTime() < cutoffMs) { cutIdx = i; break; }
        if (d && d.getTime() >= cutoffMs && d.getTime() <= latestMs) {
          const f = parseCSVLine(existingDataLines[i]);
          const k = salesRowKey(f);
          if (k && f.length >= 7) existingInRange.set(k, f[6].trim());
        }
      }
      keptLines = cutIdx >= 0 ? existingDataLines.slice(cutIdx) : [];
    }
  }

  onProgress({ step: 'Uploading Sales CSV...', phase: 'sales', progress: 42 });

  const au = todayAU();
  const colHeaders = 'Order Date,Product Code,Product,Customer,Product Group,Warehouse,Status,Quantity,Sub Total,Customer Type';
  const mergedCSV = [`Sales Enquiry as of ${au},,,,,,,,,`, colHeaders, ...allNewLines, ...keptLines, ''].join('\n');

  await uploadSalesCSV(mergedCSV);

  const deltaLines = allNewLines.filter((line) => {
    const f = parseCSVLine(line);
    const k = salesRowKey(f);
    if (!k || f.length < 7) return true;
    const origStatus = existingInRange.get(k);
    if (!origStatus) return true;
    return origStatus !== f[6].trim();
  });

  const deltaCSV = [`Sales Enquiry DELTA (new or status changed) as of ${au},,,,,,,,,`, colHeaders, ...deltaLines, ''].join('\n');

  onProgress({ step: `Sales: ${allNewLines.length} new rows, ${deltaLines.length} changed`, phase: 'sales', progress: 45 });

  return { blob: new Blob([deltaCSV], { type: 'text/csv;charset=utf-8;' }) };
}

// ─── Step 3: Production (progress 45 → 70) ────────────────────────────────

const PRODUCTION_STATUSES = ['Completed', 'Parked'];

async function updateProduction(
  onProgress: (p: CSVSyncProgress) => void,
): Promise<{ blob: Blob | null; error?: string }> {
  onProgress({ step: 'Downloading Production CSV...', phase: 'production', progress: 46 });

  let existingDataLines: string[] = [];
  let latestDateStr = '';

  const existingText = await fetchExistingCSV('ProductionEnquiryList.csv');
  if (existingText) {
    const lines = existingText.split('\n');
    for (let i = 2; i < lines.length; i++) {
      if (lines[i].trim()) {
        existingDataLines.push(lines[i]);
      }
    }
    // Use the most recent Assembly Date (col 2) for correct cutoff
    let latestMs = 0;
    for (const line of existingDataLines) {
      const f = parseCSVLine(line);
      const ds = f.length >= 2 ? f[1].trim() : '';
      const d = parseDDMMYYYY(ds);
      if (d && d.getTime() > latestMs) {
        latestMs = d.getTime();
        latestDateStr = ds;
      }
    }
  }

  let cutoffStr = '2025-01-01';
  if (latestDateStr) {
    const d = parseDDMMYYYY(latestDateStr);
    if (d) {
      const cut = new Date(d);
      cut.setDate(cut.getDate() - 3);
      cutoffStr = cut.toISOString().slice(0, 10);
    }
  }
  const endDate = new Date().toISOString().slice(0, 10);

  const allNewLines: string[] = [];
  for (let si = 0; si < PRODUCTION_STATUSES.length; si++) {
    const st = PRODUCTION_STATUSES[si];
    onProgress({ step: `Fetching Production (${st})...`, phase: 'production', progress: 48 + si * 8 });
    try {
      const res = await fetchProductionForStatus(st, cutoffStr, endDate);
      if (res.success && res.csvLines) allNewLines.push(...res.csvLines);
    } catch { /* continue */ }
  }

  // Sort desc by date (field[1])
  allNewLines.sort((a, b) => {
    const fa = parseCSVLine(a), fb = parseCSVLine(b);
    const da = fa.length >= 2 ? fa[1].split('/').reverse().join('') : '';
    const db = fb.length >= 2 ? fb[1].split('/').reverse().join('') : '';
    return db.localeCompare(da);
  });

  onProgress({ step: 'Merging Production CSV...', phase: 'production', progress: 64 });

  const cutoffMs = new Date(cutoffStr + 'T00:00:00Z').getTime();
  let keptLines: string[] = [];
  const existingInRange = new Map<string, string>();

  if (cutoffMs > 0) {
    let cutIdx = -1;
    for (let i = 0; i < existingDataLines.length; i++) {
      const f = parseCSVLine(existingDataLines[i]);
      const ds = f.length >= 2 ? f[1] : '';
      const d = parseDDMMYYYY(ds);
      if (d && d.getTime() < cutoffMs) { cutIdx = i; break; }
      if (d && d.getTime() >= cutoffMs) {
        const k = `${f[0]}|${f[1]}|${f[3]}`;
        if (f.length >= 10) existingInRange.set(k, `${f[7]}|${f[8]}|${f[9]}`);
      }
    }
    keptLines = cutIdx >= 0 ? existingDataLines.slice(cutIdx) : [];
  }

  // Re-sign kept lines: correct any component rows that have wrong positive values.
  // Always re-escape all kept lines to avoid bare-quote CSV parse errors.
  if (keptLines.length > 0) {
    const componentSKUs = new Set<string>();
    for (const line of allNewLines) {
      const f = parseCSVLine(line);
      if (f.length >= 8 && parseFloat(f[7]) < 0) componentSKUs.add(f[3]);
    }
    keptLines = keptLines.map((line) => {
      const f = parseCSVLine(line);
      if (f.length < 10) return f.map(escCSV).join(',');
      const qty = parseFloat(f[7]);
      const cost = parseFloat(f[8]);
      if (componentSKUs.has(f[3]) && qty > 0) {
        f[7] = String(Math.round(-qty));
        f[8] = (-Math.abs(cost)).toFixed(2);
      }
      return f.map(escCSV).join(',');
    });
  }

  const au = todayAU();
  const colHeaders = 'Assembly Number,Assembly Date,Assemble By,Product Code,Product Description,Product Group,Warehouse,Quantity,Total Cost,Assembly Status';

  const deltaLines = allNewLines.filter((line) => {
    const f = parseCSVLine(line);
    if (f.length < 10) return true;
    const k = `${f[0]}|${f[1]}|${f[3]}`;
    const ex = existingInRange.get(k);
    if (!ex) return true;
    return ex !== `${f[7]}|${f[8]}|${f[9]}`;
  });

  onProgress({ step: 'Uploading Production CSV...', phase: 'production', progress: 67 });

  const mergedCSV = [`Production Enquiry as of ${au},,,,,,,,,`, colHeaders, ...allNewLines, ...keptLines, ''].join('\n');
  await uploadProductionCSV(mergedCSV);

  const deltaCSV = [`Production Enquiry DELTA (new or changed) as of ${au},,,,,,,,,`, colHeaders, ...deltaLines, ''].join('\n');

  onProgress({ step: `Production: ${allNewLines.length} new rows, ${deltaLines.length} changed`, phase: 'production', progress: 70 });

  return { blob: new Blob([deltaCSV], { type: 'text/csv;charset=utf-8;' }) };
}

// ─── Step 4: Purchase (progress 70 → 84) ──────────────────────────────────

async function updatePurchase(
  onProgress: (p: CSVSyncProgress) => void,
): Promise<{ blob: Blob | null; error?: string }> {
  onProgress({ step: 'Fetching Purchase Orders...', phase: 'purchase', progress: 71 });

  const res = await generatePurchaseCSV();
  if (!res.success) return { blob: null, error: res.error ?? 'Purchase CSV failed' };

  onProgress({ step: `Purchase: ${res.totalRows} rows`, phase: 'purchase', progress: 84 });

  if (res.csvBase64) {
    const binaryStr = atob(res.csvBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return { blob: new Blob([bytes], { type: 'text/csv;charset=utf-8;' }) };
  }

  return { blob: null };
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export async function runFullCSVSync(
  onProgress: (p: CSVSyncProgress) => void,
): Promise<CSVSyncResult> {
  const errors: string[] = [];
  const deltaFiles: { name: string; blob: Blob }[] = [];

  // 1. SOH
  try {
    const r = await updateSOH(onProgress);
    if (r.error) errors.push(`SOH: ${r.error}`);
    else if (r.blob) deltaFiles.push({ name: 'SOHList_DELTA.csv', blob: r.blob });
  } catch (e) {
    errors.push(`SOH: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Sales
  try {
    const r = await updateSales(onProgress);
    if (r.error) errors.push(`Sales: ${r.error}`);
    else if (r.blob) deltaFiles.push({ name: 'SalesEnquiryList_DELTA.csv', blob: r.blob });
  } catch (e) {
    errors.push(`Sales: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Production
  try {
    const r = await updateProduction(onProgress);
    if (r.error) errors.push(`Production: ${r.error}`);
    else if (r.blob) deltaFiles.push({ name: 'ProductionEnquiryList_DELTA.csv', blob: r.blob });
  } catch (e) {
    errors.push(`Production: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. Purchase
  try {
    const r = await updatePurchase(onProgress);
    if (r.error) errors.push(`Purchase: ${r.error}`);
    else if (r.blob) deltaFiles.push({ name: 'PurchaseEnquiryList.csv', blob: r.blob });
  } catch (e) {
    errors.push(`Purchase: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5. Reload CSV data into DB tables + recalculate KPIs (same as "Reload All Data from CSVs")
  const csvLoadSteps = [
    { label: 'Loading SOH into database...', progress: 86 },
    { label: 'Loading Sales into database...', progress: 88 },
    { label: 'Loading Production into database...', progress: 90 },
    { label: 'Loading Costs into database...', progress: 92 },
    { label: 'Loading Purchase Orders into database...', progress: 94 },
    { label: 'Loading Lead Times into database...', progress: 95 },
    { label: 'Recalculating KPIs...', progress: 96 },
  ];
  let stepIdx = 0;
  onProgress({ step: csvLoadSteps[0].label, phase: 'kpis', progress: 85 });
  try {
    await reloadFromCSVs((p) => {
      const pct = csvLoadSteps[stepIdx]?.progress ?? 96;
      onProgress({ step: p.label, phase: 'kpis', progress: pct });
      stepIdx++;
    });
  } catch (e) {
    errors.push(`DB reload: ${e instanceof Error ? e.message : String(e)}`);
  }

  onProgress({ step: 'Done', phase: 'done', progress: 100 });

  return {
    success: errors.length === 0,
    errors,
    message: errors.length === 0
      ? `All CSVs updated. ${deltaFiles.length} delta files ready.`
      : `Completed with ${errors.length} error(s): ${errors.join('; ')}`,
    deltaFiles,
  };
}
