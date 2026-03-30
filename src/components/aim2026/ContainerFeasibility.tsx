import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { supabase } from '@/lib/supabase';
import { fetchContainerFeasibilityManifest } from '@/lib/aim2026/api';
import Papa from 'papaparse';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Bundled worker — CDN version numbers do not match `pdfjs-dist`, which caused 404 and empty PO list. */
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContainerFeasibilityProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface POLine {
  sku: string;
  eta: string;
  qty: number;
}

interface ParsedPO {
  id: string;
  fullId: string;
  label: string;
  orderDate: string;
  ref: string;
  isDraft: boolean;
  lines: POLine[];
  totalUnits: number;
}

interface CSVRow {
  soh_main: number;
  soh_china: number;
  demand: number;
  china_w: number;
}

interface ProjectionRow {
  /** Stable per line in the selected container PO (avoids duplicate SKU React keys). */
  rowKey: string;
  sku: string;
  soh_main: number;
  soh_china: number;
  soh_total: number;
  demand: number;
  china_w: number;
  totalDemand: number;
  inbound: number;
  projected: number;
  need: number;
  surplus: number;
  canFill: boolean;
  inCsv: boolean;
  /** All future inbound lines for this SKU from enabled POs; `afterContainer` only affects label + projection sum. */
  inboundEvents: { date: Date; poLabel: string; qty: number; afterContainer: boolean }[];
}

// ─── SKU Mapping ──────────────────────────────────────────────────────────────

const SKU_MAP: Record<string, string> = {
  'V2-PSDcrusher-St': 'V2-PSDcrusher-Stand',
  'V2-PSDring-58m': 'V2-PSDring-58mm',
  'V2-PSDring-54m': 'V2-PSDring-54mm',
  'WH-V2-PSDring-58': 'WH-V2-PSDring-58mm',
  'WH-V2-PSDring-58m': 'WH-V2-PSDring-58mm',
  /** PDF truncates before "8mm" / confuses with 54 — this line is the 58mm WH ring */
  'WH-V2-PSDring-5': 'WH-V2-PSDring-58mm',
  'WH-V2-PSDring-54': 'WH-V2-PSDring-54mm',
  'V2-PSD-54mm-dis': 'V2-PSD-54mm-distributor',
  'PSDdosingCup-B58': 'PSDdosingCup-BK',
  'PSDdosingCup-B54': 'PSDdosingCup-BK-54',
  /** PDF often truncates the Unleashed code before the size suffix */
  'PSDdosingCup-B': 'PSDdosingCup-BK',
  'PSD-HD-54v2': 'PSD-HD-54',
  'WH-PSDHFullPO': 'WH-PSDHFullPOM',
  'V2-PSDdosingCu': 'PSDdosingCup-WH',
  'V2-PSDdosingCup-WH': 'PSDdosingCup-WH',
  'PSDTMOD2-Silve': 'PSDTMOD2-Silver',
  /** PDF / font cuts "White", "Silver", etc. */
  'PSDTMOD1-Whit': 'PSDTMOD1-White',
  /** Truncated before -WH (AIM CSV: PSDdosingCup-WH) */
  'PSD-DosingCup-W': 'PSDdosingCup-WH',
  'PSD-TampingStati': 'PSD-TampingStation',
  'V2-PSDleva-bronz': 'V2-PSDleva-bronze',
};

const mapSku = (sku: string): string => SKU_MAP[sku] || sku;

/** Same logical product across PO PDFs (aliases map to same code). */
function skuMatches(a: string, b: string): boolean {
  return mapSku(a) === mapSku(b);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** True if ETA calendar day is strictly after the container ETA day. */
function isAfterContainerDay(eta: Date, cDate: Date): boolean {
  return startOfDay(eta).getTime() > startOfDay(cDate).getTime();
}

/** AIM CSV SKU may differ in casing; PDF line is already mapSku’d. */
function csvRowForSku(sku: string, csvMap: Map<string, CSVRow>): { row: CSVRow | undefined; inCsv: boolean } {
  const direct = csvMap.get(sku);
  if (direct) return { row: direct, inCsv: true };
  const mapped = SKU_MAP[sku];
  if (mapped) {
    const r = csvMap.get(mapped);
    if (r) return { row: r, inCsv: true };
  }
  const lower = sku.toLowerCase();
  for (const [k, v] of csvMap) {
    if (k.toLowerCase() === lower) return { row: v, inCsv: true };
  }
  /** PDF truncated mid-code: if exactly one CSV SKU extends this prefix, use it. */
  if (sku.length >= 8) {
    const extensions = [...csvMap.keys()].filter(k => k.startsWith(sku) && k.length > sku.length);
    if (extensions.length === 1) return { row: csvMap.get(extensions[0]), inCsv: true };
  }
  return { row: undefined, inCsv: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseNum(s: string): number {
  if (!s || s === '—' || s.trim() === '') return 0;
  return parseInt(s.replace(/,/g, '').replace(/"/g, ''), 10) || 0;
}

function parseDDMMYYYY(s: string): Date | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1]);
}

function fmtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear());
  return `${dd}/${mm}/${yy}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-AU');
}

function fmtDisplay(n: number): string {
  if (n === 0) return '—';
  return n.toLocaleString('en-AU');
}

const PO_COLOR_PALETTE = ['#f59e0b', '#4ade80', '#a78bfa', '#22d3ee', '#f472b6', '#ef4444', '#94a3b8', '#eab308'];

function poColor(poId: string, allIds: string[]): string {
  const idx = allIds.indexOf(poId);
  return idx >= 0 ? PO_COLOR_PALETTE[idx % PO_COLOR_PALETTE.length] : '#666';
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Basename for matching; paths may be `folder/Purchase Order_PO-….pdf`. */
function storageBasename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** AIM export CSV — matches `AIM_2026_Export…`, `…Export_filtered…`, etc. */
function isAimCsvExport(pathOrName: string): boolean {
  const n = storageBasename(pathOrName).toLowerCase();
  if (!n.endsWith('.csv')) return false;
  if (n.startsWith('aim_2026_export')) return true;
  if (n.includes('aim') && n.includes('export')) return true;
  return /^aim[_\s-]*2026/i.test(n);
}

/** Any Unleashed-style PO PDF in the bucket (filename contains PO-…). */
function isPoPdf(pathOrName: string): boolean {
  const n = storageBasename(pathOrName);
  if (!/\.pdf$/i.test(n)) return false;
  return /PO-\d/i.test(n);
}

/**
 * List all object paths in a bucket (recursive). Supabase only returns one level per call;
 * folders have `metadata === null` (and are not .pdf/.csv names) and must be traversed.
 */
async function listAllStorageObjectPaths(bucket: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: pageSize,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;
    const batch = data ?? [];
    if (batch.length === 0) break;
    for (const item of batch) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      const looksLikeFile = /\.(pdf|csv)$/i.test(item.name);
      // Folders have metadata === null; always treat .pdf/.csv names as files (never recurse into them).
      const isFolder = item.metadata === null && !looksLikeFile;
      if (isFolder) {
        const sub = await listAllStorageObjectPaths(bucket, path);
        out.push(...sub);
      } else {
        out.push(path);
      }
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

// ─── PDF Parsing ──────────────────────────────────────────────────────────────

/**
 * Unleashed splits long SKUs across text runs; joined text may contain spaces and stray symbols
 * from the next column (e.g. ">"). Collapse spaces and strip junk.
 */
function normalizeSkuFromPdf(raw: string): string {
  let s = raw.replace(/\s+/g, '');
  s = s.replace(/[>›»‹«]+/g, '');
  s = s.replace(/\?+$/g, '');
  return s.trim();
}

/**
 * Table row shape: line# … SKU … DD/MM/YYYY … — SKU may contain spaces when PDF splits runs.
 * Do not use a single \\S+ token (truncates at first space).
 */
function parseLineFieldsBeforeDate(row: string): { lineNo: string; skuRaw: string; eta: string; tail: string } | null {
  const dm = row.match(/(\d{2}\/\d{2}\/\d{4})/);
  if (!dm || dm.index === undefined) return null;
  const eta = dm[1];
  const before = row.slice(0, dm.index).trimEnd();
  const lm = before.match(/^\s*(\d{1,4})\s+(.+)$/);
  if (!lm) return null;
  const tail = row.slice(dm.index + dm[0].length);
  return { lineNo: lm[1], skuRaw: lm[2].trim(), eta, tail };
}

/** Group pdf.js text items into visual rows (Y within tolerance), left→right. */
function buildRowStringsFromPageItems(items: any[], yTol = 6): string[] {
  if (items.length === 0) return [];
  type It = { str: string; y: number; x: number };
  const flat: It[] = items.map((it) => ({
    str: String(it.str ?? ''),
    y: it.transform[5],
    x: it.transform[4],
  }));
  flat.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: It[][] = [];
  for (const it of flat) {
    let row = rows.find((r) => Math.abs(r[0].y - it.y) <= yTol);
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(it);
  }
  return rows.map((r) =>
    [...r].sort((a, b) => a.x - b.x).map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim(),
  );
}

function parsePolinesFromRowStrings(rowStrings: string[]): POLine[] {
  const lines: POLine[] = [];
  const seen = new Set<string>();
  const pushLine = (sku: string, eta: string, qty: number) => {
    if (qty <= 0) return;
    const ms = mapSku(sku);
    const k = `${ms}|${eta}|${qty}`;
    if (seen.has(k)) return;
    seen.add(k);
    lines.push({ sku: ms, eta, qty });
  };

  for (const row of rowStrings) {
    const parsed = parseLineFieldsBeforeDate(row);
    if (!parsed) continue;
    const sku = normalizeSkuFromPdf(parsed.skuRaw);
    const eta = parsed.eta;
    const nums = [...parsed.tail.matchAll(/([\d,]+(?:\.\d{1,2})?)/g)].map((m) => m[1]);
    if (nums.length === 0) continue;
    const qty = Math.round(parseFloat(nums[nums.length - 1].replace(/,/g, '')));
    pushLine(sku, eta, qty);
  }
  return lines;
}

function extractPolinesFromFullText(textBeforeSubtotal: string): POLine[] {
  const patterns: RegExp[] = [
    /\b(\d{1,4})\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+.+?\s+([\d,]+\.\d{2})\b/g,
    /\b(\d{1,4})\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+.+?\s+([\d,]+(?:\.\d{1,2})?)\b/g,
  ];
  const lines: POLine[] = [];
  const seen = new Set<string>();
  for (const lineRegex of patterns) {
    lineRegex.lastIndex = 0;
    let match;
    while ((match = lineRegex.exec(textBeforeSubtotal)) !== null) {
      const sku = mapSku(normalizeSkuFromPdf(match[2]));
      const eta = match[3];
      const qty = Math.round(parseFloat(String(match[4]).replace(/,/g, '')));
      if (qty > 0) {
        const k = `${sku}|${eta}|${qty}`;
        if (!seen.has(k)) {
          seen.add(k);
          lines.push({ sku, eta, qty });
        }
      }
    }
    if (lines.length > 0) break;
  }
  return lines;
}

async function parsePOPdf(fileBlob: Blob, fileName: string): Promise<ParsedPO> {
  const arrayBuffer = await fileBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;

  const pageItemArrays: any[][] = [];
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items as any[];
    pageItemArrays.push(items);
    const sorted = [...items].sort((a: any, b: any) => {
      const yDiff = b.transform[5] - a.transform[5];
      if (Math.abs(yDiff) > 6) return yDiff;
      return a.transform[4] - b.transform[4];
    });
    fullText += sorted.map((item: any) => item.str).join(' ') + '\n';
  }

  const fnMatch = fileName.match(/PO-(\d{8})/i);
  const poMatch = fullText.match(/PO-(\d{8}(?:\/\d)?)/);
  const numFromFile = fnMatch ? fnMatch[1] : null;
  const numFromText = poMatch ? poMatch[1] : null;
  const rawNum = numFromText ?? numFromFile ?? '';
  const fullId = rawNum ? `PO-${rawNum}` : 'UNKNOWN';
  const shortNum = rawNum ? rawNum.replace(/^0+/, '') : '?';
  const id = `PO-${shortNum}`;

  const dateMatch = fullText.match(/Order Date\s*(\d{2}\/\d{2}\/\d{4})/);
  const orderDate = dateMatch ? dateMatch[1] : '';

  const refMatch = fullText.match(/Reference #\s*\n?\s*(.+)/);
  const ref = refMatch ? refMatch[1].trim() : '';

  const isDraft = fileName.toLowerCase().includes('draft');

  const textBeforeSubtotal = fullText.split(/Sub\s*Total/i)[0];
  let lines = extractPolinesFromFullText(textBeforeSubtotal);

  if (lines.length === 0) {
    for (const items of pageItemArrays) {
      const rowStrs = buildRowStringsFromPageItems(items);
      lines = parsePolinesFromRowStrings(rowStrs);
      if (lines.length > 0) break;
    }
  }

  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  return {
    id, fullId,
    label: isDraft ? `${id} (Draft)` : id,
    orderDate, ref, isDraft, lines, totalUnits,
  };
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

function parseCSVData(text: string): { csvMap: Map<string, CSVRow>; sohDate: string } {
  const result = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy' });
  const rows = result.data;
  if (rows.length < 2) return { csvMap: new Map(), sohDate: '' };

  const header = rows[0].map((h: string) => h.trim());
  const iSku = header.indexOf('SKU');
  const iSohMain = header.indexOf('SOH Main');
  const iSohChina = header.indexOf('SOH China');
  const iDemand = header.indexOf('Demand');
  const iChinaW = header.indexOf('China-W');

  const csvMap = new Map<string, CSVRow>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const sku = (row[iSku] ?? '').trim();
    if (!sku) continue;
    csvMap.set(sku, {
      soh_main: iSohMain >= 0 ? parseNum(row[iSohMain]) : 0,
      soh_china: iSohChina >= 0 ? parseNum(row[iSohChina]) : 0,
      demand: iDemand >= 0 ? parseNum(row[iDemand]) : 0,
      china_w: iChinaW >= 0 ? parseNum(row[iChinaW]) : 0,
    });
  }

  return { csvMap, sohDate: new Date().toLocaleDateString('en-AU') };
}

// ─── SKU expanded timeline (prototype-style: area fill, ticks, markers) ───────

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function SkuTimelineChart({
  row,
  cDate,
  today,
  inboundEvents,
}: {
  row: ProjectionRow;
  cDate: Date;
  today: Date;
  inboundEvents: { date: Date; poLabel: string; qty: number; afterContainer?: boolean }[];
}) {
  const W = 820, H = 220, PAD_L = 55, PAD_R = 20, PAD_T = 30, PAD_B = 40;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const dailyDemand = row.demand / 30 + row.china_w / 30;
  const events = [...inboundEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
  let endMs = cDate.getTime() + 7 * 86400000;
  for (const e of events) endMs = Math.max(endMs, e.date.getTime());
  const endDate = new Date(Math.max(endMs, today.getTime() + 7 * 86400000));
  const totalDays = Math.max(daysBetween(today, endDate), 1);

  const points: {
    day: number;
    date: Date;
    stock: number;
    inbound: number;
    isContainerDate: boolean;
  }[] = [];
  let stock = row.soh_main + row.soh_china;
  let minStock = stock, maxStock = stock;

  for (let d = 0; d <= totalDays; d++) {
    const date = new Date(today.getTime() + d * 86400000);
    const dayEvents = events.filter(e => sameDay(e.date, date));
    let inbound = 0;
    for (const e of dayEvents) inbound += e.qty;
    stock += inbound;
    if (d > 0) stock -= dailyDemand;
    stock = Math.round(stock);
    minStock = Math.min(minStock, stock);
    maxStock = Math.max(maxStock, stock);
    points.push({
      day: d,
      date,
      stock,
      inbound,
      isContainerDate: sameDay(date, cDate),
    });
  }

  const yMin = Math.min(minStock, 0, row.projected - row.need);
  const yMax = Math.max(maxStock, row.soh_total, row.need) * 1.1;
  const yRange = yMax - yMin || 1;

  const toX = (i: number) => PAD_L + (i / Math.max(points.length - 1, 1)) * chartW;
  const toY = (v: number) => PAD_T + chartH - ((v - yMin) / yRange) * chartH;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(p.stock).toFixed(1)}`).join(' ');
  const areaD = `${pathD} L${toX(points.length - 1).toFixed(1)},${toY(0).toFixed(1)} L${PAD_L},${toY(0).toFixed(1)} Z`;
  const needY = toY(row.need);
  const cIdx = points.findIndex(p => p.isContainerDate);
  const inboundPts = points.filter(p => p.inbound > 0);
  const fmtShort = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;

  const yTicks: number[] = [];
  const step = Math.ceil(yRange / 5 / 100) * 100 || 100;
  for (let v = Math.floor(yMin / step) * step; v <= yMax; v += step) yTicks.push(v);

  return (
    <svg width={W} height={H} style={{ background: '#080e08', borderRadius: 6, border: '1px solid #1a2a1a', maxWidth: '100%' }}>
      <defs>
        <linearGradient id="stockGradCf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4ade80" />
          <stop offset="100%" stopColor="#0a0f0a" />
        </linearGradient>
      </defs>
      {yTicks.map(v => (
        <g key={v}>
          <line x1={PAD_L} x2={W - PAD_R} y1={toY(v)} y2={toY(v)} stroke="#1a251a" strokeWidth={0.5} strokeDasharray={v === 0 ? 'none' : '2,3'} />
          <text x={PAD_L - 4} y={toY(v) + 3} textAnchor="end" fill="#4a6a4a" fontSize={8} fontFamily="monospace">{v.toLocaleString()}</text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - PAD_R} y1={needY} y2={needY} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4,3" opacity={0.7} />
      <text x={W - PAD_R + 2} y={needY + 3} fill="#f59e0b" fontSize={7} fontFamily="monospace">NEED {row.need.toLocaleString()}</text>
      {cIdx >= 0 && (
        <g>
          <line x1={toX(cIdx)} x2={toX(cIdx)} y1={PAD_T} y2={H - PAD_B} stroke="#4ade80" strokeWidth={1.5} strokeDasharray="3,2" />
          <text x={toX(cIdx)} y={PAD_T - 6} textAnchor="middle" fill="#4ade80" fontSize={8} fontWeight="bold" fontFamily="monospace">
            CONTAINER {fmtShort(cDate)}
          </text>
        </g>
      )}
      <path d={areaD} fill="url(#stockGradCf)" opacity={0.3} />
      <path d={pathD} fill="none" stroke="#4ade80" strokeWidth={1.8} />
      {inboundPts.map((p, i) => (
        <g key={i}>
          <line x1={toX(p.day)} x2={toX(p.day)} y1={toY(p.stock)} y2={toY(p.stock) - 18} stroke="#22d3ee" strokeWidth={1} />
          <circle cx={toX(p.day)} cy={toY(p.stock)} r={4} fill="#22d3ee" stroke="#0a0f0a" strokeWidth={1.5} />
          <text x={toX(p.day)} y={toY(p.stock) - 22} textAnchor="middle" fill="#22d3ee" fontSize={7} fontWeight="bold" fontFamily="monospace">
            +{p.inbound.toLocaleString()}
          </text>
        </g>
      ))}
      {yMin < 0 && (
        <line x1={PAD_L} x2={W - PAD_R} y1={toY(0)} y2={toY(0)} stroke="#ef4444" strokeWidth={1} opacity={0.5} />
      )}
      {points.filter((p, i) => i % 10 === 0 || p.isContainerDate).map((p, i) => (
        <text key={i} x={toX(p.day)} y={H - PAD_B + 14} textAnchor="middle" fill="#4a6a4a" fontSize={7} fontFamily="monospace">
          {fmtShort(p.date)}
        </text>
      ))}
      {cIdx >= 0 && (
        <circle
          cx={toX(cIdx)}
          cy={toY(points[cIdx].stock)}
          r={5}
          fill={points[cIdx].stock >= row.need ? '#4ade80' : '#ef4444'}
          stroke="#0a0f0a"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}

// ─── Optimal chart (weighted + simple %) ─────────────────────────────────────

function OptimalDualChart({
  dateResults,
  optThreshold,
  cDays,
}: {
  dateResults: { day: number; date: Date; fillPct: number; simplePct: number }[];
  optThreshold: number;
  cDays: number;
}) {
  if (dateResults.length === 0) return null;
  const W = 860, H = 200, PAD_L = 50, PAD_R = 20, PAD_T = 25, PAD_B = 35;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const toX = (d: number) => PAD_L + ((d - 7) / (150 - 7)) * chartW;
  const toY = (v: number) => PAD_T + chartH - (v / 100) * chartH;
  const weightedPath = dateResults.map((r, i) => `${i === 0 ? 'M' : 'L'}${toX(r.day).toFixed(1)},${toY(r.fillPct).toFixed(1)}`).join(' ');
  const simplePath = dateResults.map((r, i) => `${i === 0 ? 'M' : 'L'}${toX(r.day).toFixed(1)},${toY(r.simplePct).toFixed(1)}`).join(' ');
  const fmtD = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;

  return (
    <svg width={W} height={H} style={{ background: '#080e08', borderRadius: 6, border: '1px solid #1a2a1a', maxWidth: '100%' }}>
      {[0, 25, 50, 75, 100].map(v => (
        <g key={v}>
          <line x1={PAD_L} x2={W - PAD_R} y1={toY(v)} y2={toY(v)} stroke="#1a251a" strokeWidth={0.5} strokeDasharray="2,3" />
          <text x={PAD_L - 4} y={toY(v) + 3} textAnchor="end" fill="#4a6a4a" fontSize={8} fontFamily="monospace">{v}%</text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - PAD_R} y1={toY(optThreshold)} y2={toY(optThreshold)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
      <text x={W - PAD_R + 2} y={toY(optThreshold) + 3} fill="#f59e0b" fontSize={7} fontFamily="monospace">{optThreshold}%</text>
      <path d={simplePath} fill="none" stroke="#6b8f6b" strokeWidth={1} opacity={0.5} />
      <path d={weightedPath} fill="none" stroke="#4ade80" strokeWidth={2} />
      {cDays >= 7 && cDays <= 150 && (
        <g>
          <line x1={toX(cDays)} x2={toX(cDays)} y1={PAD_T} y2={H - PAD_B} stroke="#22d3ee" strokeWidth={1.5} strokeDasharray="3,2" />
          <text x={toX(cDays)} y={PAD_T - 4} textAnchor="middle" fill="#22d3ee" fontSize={7} fontWeight="bold" fontFamily="monospace">
            NOW
          </text>
        </g>
      )}
      {dateResults.filter((_, i) => i % 15 === 0).map(r => (
        <text key={r.day} x={toX(r.day)} y={H - PAD_B + 14} textAnchor="middle" fill="#4a6a4a" fontSize={7} fontFamily="monospace">
          {fmtD(r.date)}
        </text>
      ))}
      <line x1={PAD_L + 10} x2={PAD_L + 30} y1={PAD_T + 6} y2={PAD_T + 6} stroke="#4ade80" strokeWidth={2} />
      <text x={PAD_L + 34} y={PAD_T + 9} fill="#4ade80" fontSize={7} fontFamily="monospace">Weighted by demand</text>
      <line x1={PAD_L + 170} x2={PAD_L + 190} y1={PAD_T + 6} y2={PAD_T + 6} stroke="#6b8f6b" strokeWidth={1} opacity={0.5} />
      <text x={PAD_L + 194} y={PAD_T + 9} fill="#6b8f6b" fontSize={7} fontFamily="monospace">Simple SKU count %</text>
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ContainerFeasibility({ open, onOpenChange }: ContainerFeasibilityProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvMap, setCsvMap] = useState<Map<string, CSVRow>>(new Map());
  const [sohDate, setSohDate] = useState('');
  const [allPOs, setAllPOs] = useState<ParsedPO[]>([]);
  const [containerDate, setContainerDate] = useState('');
  const [containerPO, setContainerPO] = useState('');
  const [enabledPOs, setEnabledPOs] = useState<Set<string>>(new Set());
  /** When true, row is excluded from table, stats, optimizer, export (keyed by rowKey, not sku — duplicates OK) */
  const [hiddenRowKeys, setHiddenRowKeys] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'shortfall' | 'fill'>('all');
  const [sort, setSort] = useState<'surplus' | 'sku' | 'need' | 'projected'>('surplus');
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [showOptimizer, setShowOptimizer] = useState(false);
  const [optThreshold, setOptThreshold] = useState(95);
  const [showGantt, setShowGantt] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const today = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }, []);

  // ── Load data from bucket ─────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        let csvText: string;
        const parsedPOs: ParsedPO[] = [];

        const manifest = await fetchContainerFeasibilityManifest();
        if (manifest.ok) {
          const m = manifest.manifest;
          const csvRes = await fetch(m.csvSignedUrl);
          if (!csvRes.ok) throw new Error(`CSV download failed (HTTP ${csvRes.status})`);
          csvText = await csvRes.text();
          for (const p of m.pdfs) {
            try {
              const pdfRes = await fetch(p.signedUrl);
              if (!pdfRes.ok) {
                console.warn(`PDF skip ${p.path}: HTTP ${pdfRes.status}`);
                continue;
              }
              const po = await parsePOPdf(await pdfRes.blob(), storageBasename(p.path));
              if (po.lines.length > 0) parsedPOs.push(po);
            } catch (e) {
              console.warn(`Failed to parse PDF ${p.path}:`, e);
            }
          }
        } else {
          let allPaths: string[] = [];
          try {
            allPaths = await listAllStorageObjectPaths('container');
          } catch (listErr: any) {
            throw new Error(
              `Cannot list bucket "container": ${listErr?.message ?? listErr}. ` +
                `Edge function: ${manifest.message}. ` +
                'Deploy `supabase functions deploy aim2026-container-bucket` (uses service role + signed URLs), or add Storage SELECT policies for the anon key.',
            );
          }
          if (allPaths.length === 0) {
            throw new Error(
              'No files visible in bucket "container". ' +
                `Edge function: ${manifest.message}. ` +
                'Deploy `supabase functions deploy aim2026-container-bucket`, or add Storage policies: SELECT on `storage.objects` for role `anon` where bucket_id = \'container\'.',
            );
          }

          const csvPaths = allPaths.filter(isAimCsvExport).sort((a, b) => storageBasename(a).localeCompare(storageBasename(b)));
          const poPaths = allPaths.filter(isPoPdf);

          if (csvPaths.length === 0) {
            throw new Error(
              'No AIM CSV export found. Expected a file whose name starts with "AIM_2026_Export" and ends with ".csv" (any subfolder is OK).',
            );
          }

          const { data: csvBlob } = await supabase.storage.from('container').download(csvPaths[0]);
          if (!csvBlob) throw new Error('Failed to download CSV');
          csvText = await csvBlob.text();

          for (const pf of poPaths) {
            try {
              const { data: pdfBlob } = await supabase.storage.from('container').download(pf);
              if (!pdfBlob) continue;
              const po = await parsePOPdf(pdfBlob, storageBasename(pf));
              if (po.lines.length > 0) parsedPOs.push(po);
            } catch (e) {
              console.warn(`Failed to parse PDF ${pf}:`, e);
            }
          }
        }

        const parsed = parseCSVData(csvText);
        if (cancelled) return;
        setCsvMap(parsed.csvMap);
        setSohDate(parsed.sohDate);

        if (cancelled) return;

        parsedPOs.sort((a, b) => {
          if (a.isDraft !== b.isDraft) return a.isDraft ? -1 : 1;
          return a.id.localeCompare(b.id);
        });
        setAllPOs(parsedPOs);

        const draft = parsedPOs.find(p => p.isDraft);
        if (draft) {
          setContainerPO(draft.id);
          const firstEta = draft.lines[0]?.eta;
          if (firstEta) {
            const d = parseDDMMYYYY(firstEta);
            if (d) setContainerDate(d.toISOString().slice(0, 10));
          }
        } else if (parsedPOs.length > 0) {
          setContainerPO(parsedPOs[0].id);
        }
        if (!containerDate) setContainerDate('2026-06-01');

        const allIds = new Set(parsedPOs.map(p => p.id));
        setEnabledPOs(allIds);
        setHiddenRowKeys({});
        setSelectedRowKey(null);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHiddenRowKeys({});
    setSelectedRowKey(null);
  }, [containerPO]);

  // ── Derived values ────────────────────────────────────────────────────────

  const selectedPO = useMemo(() => allPOs.find(p => p.id === containerPO), [allPOs, containerPO]);
  const inboundPOs = useMemo(() => allPOs.filter(p => p.id !== containerPO), [allPOs, containerPO]);

  const cDate = useMemo(() => {
    if (!containerDate) return new Date('2026-06-01');
    return new Date(containerDate + 'T00:00:00');
  }, [containerDate]);

  const daysToContainer = useMemo(() => Math.max(0, daysBetween(today, cDate)), [today, cDate]);

  // ── Projection ────────────────────────────────────────────────────────────

  const projectionRows: ProjectionRow[] = useMemo(() => {
    if (!selectedPO) return [];
    return selectedPO.lines.map((poLine, lineIdx) => {
      const rowKey = `${containerPO}-${lineIdx}`;
      const { row: csv, inCsv } = csvRowForSku(poLine.sku, csvMap);
      const soh_main = csv?.soh_main ?? 0;
      const soh_china = csv?.soh_china ?? 0;
      const soh_total = soh_main + soh_china;
      const demand = csv?.demand ?? 0;
      const china_w = csv?.china_w ?? 0;
      const dailyMain = demand / 30;
      const dailyChina = china_w / 30;
      const totalDemand = Math.round((dailyMain + dailyChina) * daysToContainer);

      const inboundEvents: { date: Date; poLabel: string; qty: number; afterContainer: boolean }[] = [];
      let inbound = 0;
      for (const po of inboundPOs) {
        if (!enabledPOs.has(po.id)) continue;
        for (const line of po.lines) {
          if (!skuMatches(line.sku, poLine.sku)) continue;
          const eta = parseDDMMYYYY(line.eta);
          if (!eta) continue;
          if (startOfDay(eta).getTime() < startOfDay(today).getTime()) continue;
          const afterContainer = isAfterContainerDay(eta, cDate);
          inboundEvents.push({ date: eta, poLabel: po.label, qty: line.qty, afterContainer });
          if (!afterContainer) inbound += line.qty;
        }
      }
      inboundEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

      const projected = soh_total + inbound - totalDemand;
      const need = poLine.qty;
      const surplus = projected - need;

      return {
        rowKey,
        sku: poLine.sku,
        soh_main, soh_china, soh_total,
        demand, china_w, totalDemand,
        inbound, projected, need, surplus,
        canFill: surplus >= 0,
        inCsv,
        inboundEvents,
      };
    });
  }, [selectedPO, containerPO, csvMap, inboundPOs, enabledPOs, today, cDate, daysToContainer]);

  // ── Filtered/sorted rows ──────────────────────────────────────────────────

  const visibleRows = useMemo(() => {
    let rows = projectionRows.filter(r => !hiddenRowKeys[r.rowKey]);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r => r.sku.toLowerCase().includes(q));
    }
    if (filter === 'shortfall') rows = rows.filter(r => !r.canFill);
    else if (filter === 'fill') rows = rows.filter(r => r.canFill);

    rows.sort((a, b) => {
      switch (sort) {
        case 'surplus': return a.surplus - b.surplus;
        case 'sku': return a.sku.localeCompare(b.sku);
        case 'need': return b.need - a.need;
        case 'projected': return a.projected - b.projected;
        default: return 0;
      }
    });
    return rows;
  }, [projectionRows, hiddenRowKeys, search, filter, sort]);

  const stats = useMemo(() => {
    const vis = projectionRows.filter(r => !hiddenRowKeys[r.rowKey]);
    return {
      canFill: vis.filter(r => r.canFill).length,
      shortfall: vis.filter(r => !r.canFill).length,
      totalUnits: vis.reduce((s, r) => s + r.need, 0),
    };
  }, [projectionRows, hiddenRowKeys]);

  const inboundIdsSorted = useMemo(() => inboundPOs.map(p => p.id), [inboundPOs]);

  const inboundGanttData = useMemo(() => {
    type Cell = { po: string; qty: number };
    const skuMap: Record<string, { total: number; byDate: Record<string, Cell[]> }> = {};
    const allDates = new Set<string>();
    for (const po of inboundPOs) {
      if (!enabledPOs.has(po.id)) continue;
      for (const line of po.lines) {
        const csvSku = line.sku;
        allDates.add(line.eta);
        if (!skuMap[csvSku]) skuMap[csvSku] = { total: 0, byDate: {} };
        skuMap[csvSku].total += line.qty;
        if (!skuMap[csvSku].byDate[line.eta]) skuMap[csvSku].byDate[line.eta] = [];
        skuMap[csvSku].byDate[line.eta].push({ po: po.id, qty: line.qty });
      }
    }
    const sortedDates = [...allDates].sort((a, b) => {
      const da = parseDDMMYYYY(a)!;
      const db = parseDDMMYYYY(b)!;
      return da.getTime() - db.getTime();
    });
    const sortedSkus = Object.keys(skuMap).sort((a, b) => {
      const da = Object.keys(skuMap[a].byDate).map(d => parseDDMMYYYY(d)!.getTime());
      const db = Object.keys(skuMap[b].byDate).map(d => parseDDMMYYYY(d)!.getTime());
      return Math.min(...da) - Math.min(...db);
    });
    return { skuMap, sortedDates, sortedSkus };
  }, [inboundPOs, enabledPOs]);

  const optimalAnalysis = useMemo(() => {
    if (!showOptimizer || !selectedPO) return null;
    const cLines = selectedPO.lines.filter((l, idx) => !hiddenRowKeys[`${containerPO}-${idx}`]);
    if (cLines.length === 0) return null;

    const skuWeights = cLines.map(l => {
      const { row: csv } = csvRowForSku(l.sku, csvMap);
      const c = csv ?? { demand: 0, china_w: 0 };
      return { poSku: l.sku, csvSku: l.sku, need: l.qty, weight: c.demand + (c.china_w ?? 0) };
    });
    const totalWeight = skuWeights.reduce((s, w) => s + w.weight, 0) || 1;

    const dateResults: {
      day: number;
      date: Date;
      fillPct: number;
      simplePct: number;
      canFill: number;
      total: number;
      totalShort: number;
      criticalMisses: { sku: string; short: number; demand: number }[];
    }[] = [];

    for (let d = 7; d <= 150; d++) {
      const testDate = new Date(today);
      testDate.setDate(testDate.getDate() + d);
      let weightedFill = 0;
      let canFillAll = 0;
      let totalShort = 0;
      const criticalMisses: { sku: string; short: number; demand: number }[] = [];

      for (const { poSku, csvSku, need, weight } of skuWeights) {
        const { row: cr } = csvRowForSku(csvSku, csvMap);
        const info = cr ?? { soh_main: 0, soh_china: 0, demand: 0, china_w: 0 };
        const sohTotal = info.soh_main + info.soh_china;
        const dailyDemand = info.demand / 30 + (info.china_w ?? 0) / 30;
        const totalDemand = Math.round(dailyDemand * d);

        let totalInbound = 0;
        for (const po of inboundPOs) {
          if (!enabledPOs.has(po.id)) continue;
          for (const line of po.lines) {
            if (!skuMatches(line.sku, csvSku)) continue;
            const eta = parseDDMMYYYY(line.eta);
            if (eta && eta > today && eta <= testDate) totalInbound += line.qty;
          }
        }

        const projected = sohTotal + totalInbound - totalDemand;
        const surplus = projected - need;
        if (surplus >= 0) {
          weightedFill += weight;
          canFillAll++;
        } else {
          totalShort += Math.abs(surplus);
          if (weight > 50) criticalMisses.push({ sku: poSku, short: Math.abs(surplus), demand: weight });
        }
      }

      const fillPct = (weightedFill / totalWeight) * 100;
      const simplePct = (canFillAll / skuWeights.length) * 100;
      const cm = criticalMisses.sort((a, b) => b.demand - a.demand).slice(0, 3);
      dateResults.push({
        day: d,
        date: testDate,
        fillPct,
        simplePct,
        canFill: canFillAll,
        total: skuWeights.length,
        totalShort,
        criticalMisses: cm,
      });
    }

    const best100 = dateResults.find(r => r.simplePct === 100) ?? null;
    const bestWeighted =
      dateResults.length === 0
        ? null
        : dateResults.reduce((best, r) =>
            r.fillPct > best.fillPct ? r : r.fillPct === best.fillPct && r.day < best.day ? r : best,
          dateResults[0]);
    const thresholdDate = dateResults.find(r => r.fillPct >= optThreshold) ?? null;

    return { dateResults, best100, bestWeighted, thresholdDate, skuWeights, totalWeight };
  }, [showOptimizer, selectedPO, containerPO, hiddenRowKeys, csvMap, inboundPOs, enabledPOs, today, optThreshold]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const togglePO = useCallback((poId: string) => {
    setEnabledPOs(prev => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId); else next.add(poId);
      return next;
    });
  }, []);

  const toggleHiddenRow = useCallback((rowKey: string) => {
    setHiddenRowKeys(prev => ({ ...prev, [rowKey]: !prev[rowKey] }));
  }, []);

  const exportCSV = useCallback(() => {
    const header = 'SKU,SOH Main,SOH China,SOH Total,Demand/mo,China-W,Total Demand,Inbound,Projected,Need,Surplus,Can Fill';
    const rows = visibleRows.map(r =>
      [r.sku, r.soh_main, r.soh_china, r.soh_total, r.demand, r.china_w, r.totalDemand, r.inbound, r.projected, r.need, r.surplus, r.canFill ? 'YES' : 'NO'].join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const d = new Date();
    a.download = `container_feasibility_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [visibleRows]);

  const applyDate = useCallback((d: Date) => {
    setContainerDate(d.toISOString().slice(0, 10));
  }, []);

  const cDays = daysBetween(today, cDate);

  const shell: React.CSSProperties = {
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    background: '#0a0f0a',
    color: '#c8d6c8',
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[100vw] w-[100vw] max-h-[100vh] h-[100vh] rounded-none p-0 border-none overflow-hidden gap-0"
        style={shell}
      >
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
          .cf-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
          .cf-scroll::-webkit-scrollbar-track { background: #1a251a; }
          .cf-scroll::-webkit-scrollbar-thumb { background: #2d4a2d; border-radius: 3px; }
        `}</style>
        <div className="flex flex-col h-full overflow-hidden">

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px', borderBottom: '1px solid #2d4a2d', flexShrink: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#4ade80', letterSpacing: 1 }}>
              DOLO<span style={{ color: '#2d4a2d' }}> / </span>CONTAINER FEASIBILITY
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ background: '#1a251a', border: '1px solid #2d4a2d', borderRadius: 6, padding: '6px 12px', fontSize: 11, color: '#6b8f6b' }}>
              SOH Date: {sohDate || '—'} &nbsp;|&nbsp; {daysToContainer}d to container
            </div>
            <button type="button" onClick={() => onOpenChange(false)} style={{ fontSize: 11, color: '#6b8f6b', padding: '4px 8px' }}>Close</button>
          </div>

          {loading ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#6b8f6b' }}>
              <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="30 70" /></svg>
              Loading files from bucket…
            </div>
          ) : error ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <div style={{ maxWidth: 480, textAlign: 'center' }}>
                <p style={{ color: '#ef4444', fontSize: 14, marginBottom: 8 }}>Error</p>
                <p style={{ fontSize: 12, color: '#8b9b8b', lineHeight: 1.5 }}>{error}</p>
              </div>
            </div>
          ) : (
            <div className="cf-scroll flex-1 overflow-y-auto" style={{ padding: '16px 20px 24px' }}>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
                <div style={{ background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 10, color: '#4ade80', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1.5 }}>Container ETA</div>
                  <input type="date" value={containerDate} onChange={e => setContainerDate(e.target.value)} style={{ width: '100%', padding: '8px 10px', background: '#0a0f0a', border: '1px solid #2d4a2d', borderRadius: 4, color: '#4ade80', fontSize: 14, fontWeight: 600 }} />
                </div>
                <div style={{ background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 10, color: '#4ade80', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1.5 }}>Container Load (PO)</div>
                  <select value={containerPO} onChange={e => setContainerPO(e.target.value)} style={{ width: '100%', padding: '8px 10px', background: '#0a0f0a', border: '1px solid #2d4a2d', borderRadius: 4, color: '#4ade80', fontSize: 13, fontWeight: 600 }}>
                    {allPOs.map(po => (
                      <option key={po.id} value={po.id}>{po.label} — {po.lines.length} lines</option>
                    ))}
                  </select>
                </div>
                <div style={{ background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 8, padding: 14, display: 'flex', gap: 16, alignItems: 'center' }}>
                  <div style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#4ade80' }}>{stats.canFill}</div>
                    <div style={{ fontSize: 9, color: '#6b8f6b', textTransform: 'uppercase' }}>Can Fill</div>
                  </div>
                  <div style={{ width: 1, height: 36, background: '#2d4a2d' }} />
                  <div style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: stats.shortfall > 0 ? '#ef4444' : '#4ade80' }}>{stats.shortfall}</div>
                    <div style={{ fontSize: 9, color: '#6b8f6b', textTransform: 'uppercase' }}>Shortfall</div>
                  </div>
                  <div style={{ width: 1, height: 36, background: '#2d4a2d' }} />
                  <div style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#c8d6c8' }}>{fmtDisplay(stats.totalUnits)}</div>
                    <div style={{ fontSize: 9, color: '#6b8f6b', textTransform: 'uppercase' }}>Total Units</div>
                  </div>
                </div>
              </div>

              {inboundPOs.length > 0 && (
                <div style={{ background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 8, padding: 14, marginBottom: 20 }}>
                  <div style={{ fontSize: 10, color: '#4ade80', fontWeight: 600, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1.5 }}>
                    Inbound POs (toggle to include/exclude from projection)
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {inboundPOs.map(po => {
                      const on = enabledPOs.has(po.id);
                      return (
                        <button
                          key={po.id}
                          type="button"
                          onClick={() => togglePO(po.id)}
                          style={{
                            padding: '6px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                            background: on ? '#1a3a1a' : '#1a1a1a',
                            border: `1px solid ${on ? '#4ade80' : '#333'}`,
                            color: on ? '#4ade80' : '#555',
                          }}
                        >
                          {on ? '✓ ' : ''}{po.label}
                          <span style={{ fontSize: 9, marginLeft: 6, opacity: 0.6 }}>{fmtDisplay(po.totalUnits)} units</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 8, padding: 14, marginBottom: 20 }}>
                <button
                  type="button"
                  onClick={() => setShowGantt(!showGantt)}
                  style={{
                    padding: '8px 18px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 0.5,
                    background: showGantt ? '#1a3a1a' : 'linear-gradient(135deg, #0a1a2a, #1a2a3a)',
                    border: `1px solid ${showGantt ? '#22d3ee' : '#1a2a3a'}`,
                    color: '#22d3ee',
                  }}
                >
                  {showGantt ? '▼' : '▶'} INBOUND TIMELINE
                </button>
                {showGantt && inboundGanttData.sortedDates.length > 0 && (
                  <div style={{ marginTop: 14, overflowX: 'auto' }}>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                      {inboundPOs.filter(p => enabledPOs.has(p.id)).map(p => (
                        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: poColor(p.id, inboundIdsSorted) }} />
                          <span style={{ color: '#6b8f6b' }}>{p.label}</span>
                        </div>
                      ))}
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                      <thead>
                        <tr style={{ background: '#0d1a1d' }}>
                          <th style={{ padding: '6px 8px', textAlign: 'left', color: '#22d3ee', fontWeight: 600, fontSize: 9, borderBottom: '1px solid #1a2a3a', position: 'sticky', left: 0, background: '#0d1a1d', zIndex: 1, minWidth: 130 }}>SKU</th>
                          <th style={{ padding: '6px 6px', textAlign: 'right', color: '#22d3ee', fontWeight: 600, fontSize: 9, borderBottom: '1px solid #1a2a3a', minWidth: 50 }}>TOTAL</th>
                          {inboundGanttData.sortedDates.map(d => {
                            const dt = parseDDMMYYYY(d)!;
                            const after = dt > cDate;
                            return (
                              <th key={d} style={{ padding: '6px 4px', textAlign: 'center', color: '#22d3ee', fontWeight: 600, fontSize: 8, borderBottom: '1px solid #1a2a3a', minWidth: 58, whiteSpace: 'nowrap', background: after ? '#0d0d0d' : '#0d1a1d' }}>
                                {d.slice(0, 5)}{after && <span style={{ color: '#555', fontSize: 7 }}> ⟩</span>}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {inboundGanttData.sortedSkus.map((sku, ri) => {
                          const info = inboundGanttData.skuMap[sku];
                          const isAlt = ri % 2 === 0;
                          return (
                            <tr key={sku} style={{ background: isAlt ? '#0a1014' : '#0a0f0a' }}>
                              <td style={{ padding: '4px 8px', fontWeight: 600, fontSize: 10, color: '#c8d6c8', borderBottom: '1px solid #111a1a', position: 'sticky', left: 0, background: isAlt ? '#0a1014' : '#0a0f0a', zIndex: 1 }}>{sku}</td>
                              <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700, fontSize: 10, color: '#22d3ee', borderBottom: '1px solid #111a1a' }}>{info.total.toLocaleString()}</td>
                              {inboundGanttData.sortedDates.map(d => {
                                const entries = info.byDate[d];
                                const afterContainer = parseDDMMYYYY(d)! > cDate;
                                if (!entries) return <td key={d} style={{ borderBottom: '1px solid #111a1a', background: afterContainer ? '#0a0a0a' : undefined }} />;
                                const totalQty = entries.reduce((s, e) => s + e.qty, 0);
                                return (
                                  <td key={d} style={{ padding: '3px 4px', textAlign: 'center', borderBottom: '1px solid #111a1a', background: afterContainer ? '#1a1a0a' : '#0a1a0d' }}>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: afterContainer ? '#8b6b3f' : '#4ade80' }}>{totalQty.toLocaleString()}</div>
                                    <div style={{ display: 'flex', gap: 1, justifyContent: 'center', marginTop: 1 }}>
                                      {entries.map((e, i) => (
                                        <div key={i} title={`${e.po}: ${e.qty}`} style={{ width: 6, height: 6, borderRadius: 1, background: poColor(e.po, inboundIdsSorted) }} />
                                      ))}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div style={{ background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 8, padding: 14, marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: showOptimizer ? 14 : 0, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setShowOptimizer(!showOptimizer)}
                    style={{
                      padding: '8px 18px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: 0.5,
                      background: showOptimizer ? '#1a3a1a' : 'linear-gradient(135deg, #1a3a1a, #2d4a2d)',
                      border: `1px solid ${showOptimizer ? '#4ade80' : '#2d4a2d'}`,
                      color: '#4ade80',
                    }}
                  >
                    {showOptimizer ? '▼' : '▶'} OPTIMAL DATE FINDER
                  </button>
                  {showOptimizer && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: '#6b8f6b' }}>Fill target:</span>
                      {[90, 95, 98, 100].map(v => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setOptThreshold(v)}
                          style={{
                            padding: '3px 10px', borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
                            background: optThreshold === v ? '#2d4a2d' : 'transparent',
                            border: `1px solid ${optThreshold === v ? '#f59e0b' : '#1a251a'}`,
                            color: optThreshold === v ? '#f59e0b' : '#6b8f6b',
                          }}
                        >
                          {v}%
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {showOptimizer && optimalAnalysis && (
                  <div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                      {optimalAnalysis.thresholdDate && (
                        <div style={{ flex: 1, minWidth: 200, padding: 12, borderRadius: 6, background: '#1a2a0a', border: '1px solid #f59e0b' }}>
                          <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>≥{optThreshold}% Fill (weighted)</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: '#f59e0b' }}>{fmtDate(optimalAnalysis.thresholdDate.date)}</div>
                          <div style={{ fontSize: 10, color: '#8b6b3f', marginTop: 2 }}>{optimalAnalysis.thresholdDate.day} days — {optimalAnalysis.thresholdDate.canFill}/{optimalAnalysis.thresholdDate.total} SKUs</div>
                          <button type="button" onClick={() => applyDate(optimalAnalysis.thresholdDate!.date)} style={{ marginTop: 8, padding: '4px 14px', borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, background: '#2a1a00', border: '1px solid #f59e0b', color: '#f59e0b' }}>← Apply this date</button>
                        </div>
                      )}
                      {optimalAnalysis.best100 ? (
                        <div style={{ flex: 1, minWidth: 200, padding: 12, borderRadius: 6, background: '#0a2a0a', border: '1px solid #4ade80' }}>
                          <div style={{ fontSize: 9, color: '#4ade80', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>100% Fill (all SKUs)</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: '#4ade80' }}>{fmtDate(optimalAnalysis.best100.date)}</div>
                          <div style={{ fontSize: 10, color: '#6b8f6b', marginTop: 2 }}>{optimalAnalysis.best100.day} days — all {optimalAnalysis.best100.total} SKUs</div>
                          <button type="button" onClick={() => applyDate(optimalAnalysis.best100!.date)} style={{ marginTop: 8, padding: '4px 14px', borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, background: '#0a2a0a', border: '1px solid #4ade80', color: '#4ade80' }}>← Apply this date</button>
                        </div>
                      ) : (
                        <div style={{ flex: 1, minWidth: 200, padding: 12, borderRadius: 6, background: '#2a0a0a', border: '1px solid #ef4444' }}>
                          <div style={{ fontSize: 9, color: '#ef4444', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>100% Fill</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444' }}>Not achievable within 150 days</div>
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 200, padding: 12, borderRadius: 6, background: '#0a1a2a', border: '1px solid #22d3ee' }}>
                        <div style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Current selection</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: '#22d3ee' }}>{stats.canFill}/{projectionRows.filter(r => !hiddenRowKeys[r.rowKey]).length || 1} SKUs</div>
                        <div style={{ fontSize: 10, color: '#4a8a9a', marginTop: 2 }}>Weighted + simple % in chart</div>
                      </div>
                    </div>
                    <OptimalDualChart dateResults={optimalAnalysis.dateResults} optThreshold={optThreshold} cDays={cDays} />
                    {optimalAnalysis.thresholdDate && optimalAnalysis.thresholdDate.criticalMisses.length > 0 && (
                      <div style={{ marginTop: 10, fontSize: 10, color: '#8b6b3f' }}>
                        <span style={{ fontWeight: 700, color: '#f59e0b' }}>Gaps at {optThreshold}%: </span>
                        {optimalAnalysis.thresholdDate.criticalMisses.map((m, i) => (
                          <span key={m.sku}>
                            {i > 0 ? ' · ' : ''}
                            <span style={{ color: '#ef4444', fontWeight: 600 }}>{m.sku}</span>
                            <span style={{ color: '#6b8f6b' }}> (−{m.short.toLocaleString()})</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <input ref={searchRef} type="text" placeholder="Search SKU..." value={search} onChange={e => setSearch(e.target.value)} style={{ padding: '6px 12px', background: '#111a11', border: '1px solid #2d4a2d', borderRadius: 4, color: '#c8d6c8', fontSize: 12, width: 200, fontFamily: 'inherit' }} />
                {(['all', 'shortfall', 'fill'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '5px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
                      background: filter === f ? '#2d4a2d' : 'transparent',
                      border: `1px solid ${filter === f ? '#4ade80' : '#2d4a2d'}`,
                      color: filter === f ? '#4ade80' : '#6b8f6b',
                    }}
                  >
                    {f === 'all' ? 'All' : f === 'shortfall' ? `Shortfalls (${stats.shortfall})` : 'Can Fill'}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <button type="button" onClick={exportCSV} style={{ padding: '5px 14px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, background: '#1a2a1a', border: '1px solid #22d3ee', color: '#22d3ee' }}>↓ Export CSV</button>
                <div style={{ fontSize: 10, color: '#6b8f6b' }}>Sort:</div>
                {(['surplus', 'sku', 'need', 'projected'] as const).map(v => (
                  <button key={v} type="button" onClick={() => setSort(v)} style={{ padding: '4px 10px', borderRadius: 4, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', background: sort === v ? '#1a3a1a' : 'transparent', border: `1px solid ${sort === v ? '#4ade80' : '#1a251a'}`, color: sort === v ? '#4ade80' : '#6b8f6b' }}>
                    {v === 'surplus' ? 'Surplus' : v === 'sku' ? 'SKU' : v === 'need' ? 'Need' : 'Projected'}
                  </button>
                ))}
              </div>

              <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #2d4a2d', maxHeight: 'min(55vh, 520px)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: '#1a2e1a' }}>
                      {['☐', 'SKU', 'SOH Main', 'SOH China', 'SOH Total', 'Demand/mo', 'China-W', 'Demand →', 'Inbound POs', 'Projected', 'Need', 'Surplus', 'Status'].map(h => (
                        <th key={h} style={{ padding: '10px 8px', textAlign: h === 'SKU' || h === '☐' ? 'left' : 'right', color: '#4ade80', fontWeight: 600, fontSize: 10, borderBottom: '2px solid #2d4a2d', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r, i) => {
                      const bg = r.canFill ? (i % 2 === 0 ? '#0a0f0a' : '#0d140d') : '#1a0a0a';
                      const sel = selectedRowKey === r.rowKey;
                      return (
                        <React.Fragment key={r.rowKey}>
                          <tr
                            style={{ background: sel ? '#1a2e1a' : bg, cursor: 'pointer', transition: 'background 0.1s' }}
                            onClick={() => setSelectedRowKey(sel ? null : r.rowKey)}
                          >
                            <td style={{ padding: '4px 6px', borderBottom: '1px solid #1a251a', width: 28 }} onClick={e => e.stopPropagation()}>
                              <input type="checkbox" checked={!hiddenRowKeys[r.rowKey]} onChange={() => toggleHiddenRow(r.rowKey)} style={{ accentColor: '#4ade80', cursor: 'pointer' }} />
                            </td>
                            <td style={{ padding: '7px 8px', fontWeight: 600, color: r.inCsv ? '#c8d6c8' : '#555', borderBottom: '1px solid #1a251a', userSelect: 'none' }}>
                              <span style={{ color: sel ? '#22d3ee' : '#4ade80', marginRight: 5, fontSize: 8, display: 'inline-block', transform: sel ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                              {r.sku}
                              {!r.inCsv && <span style={{ fontSize: 8, color: '#666', marginLeft: 4 }}>?</span>}
                            </td>
                            <TDCell right>{fmtDisplay(r.soh_main)}</TDCell>
                            <TDCell right>{fmtDisplay(r.soh_china)}</TDCell>
                            <TDCell right bold>{fmtDisplay(r.soh_total)}</TDCell>
                            <TDCell right>{fmtDisplay(r.demand)}</TDCell>
                            <TDCell right color={r.china_w > 0 ? '#8b6b3f' : '#333'}>{r.china_w > 0 ? fmtDisplay(r.china_w) : '—'}</TDCell>
                            <TDCell right color={r.totalDemand > r.soh_total ? '#ef4444' : '#8b6b3f'}>{fmtDisplay(r.totalDemand)}</TDCell>
                            <TDCell right color={r.inbound > 0 ? '#4ade80' : '#333'}>{r.inbound > 0 ? `+${fmtDisplay(r.inbound)}` : '—'}</TDCell>
                            <TDCell right bold color={r.projected < 0 ? '#ef4444' : r.projected < r.need ? '#f59e0b' : '#4ade80'}>{fmtDisplay(r.projected)}</TDCell>
                            <TDCell right bold>{fmtDisplay(r.need)}</TDCell>
                            <TDCell right bold color={r.surplus < 0 ? '#ef4444' : r.surplus === 0 ? '#f59e0b' : '#4ade80'}>{r.surplus > 0 ? '+' : ''}{fmtDisplay(r.surplus)}</TDCell>
                            <td style={{ padding: '7px 8px', textAlign: 'center', borderBottom: '1px solid #1a251a', fontWeight: 700, fontSize: 10, color: r.canFill ? '#4ade80' : '#ef4444' }}>
                              {r.canFill ? '✓ OK' : `✗ −${fmtDisplay(Math.abs(r.surplus))}`}
                            </td>
                          </tr>
                          {sel && (
                            <tr>
                              <td colSpan={13} style={{ padding: 0, background: '#0d1a0d', borderBottom: '2px solid #2d4a2d' }}>
                                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', padding: '12px 8px 12px 24px' }}>
                                  <SkuTimelineChart row={r} cDate={cDate} today={today} inboundEvents={r.inboundEvents} />
                                  <div style={{ minWidth: 220, fontSize: 10, lineHeight: 1.8 }}>
                                    <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Inbound Events</div>
                                    <div style={{ color: '#c8d6c8', marginBottom: 6 }}>
                                      <span style={{ color: '#6b8f6b' }}>SOH Today:</span> {fmtDisplay(r.soh_total)}
                                      <span style={{ color: '#6b8f6b', marginLeft: 12 }}>Demand/day:</span> {((r.demand + r.china_w) / 30).toFixed(1)}
                                      {r.china_w > 0 && (
                                        <span style={{ color: '#8b6b3f', marginLeft: 4, fontSize: 9 }}>
                                          (Main:{(r.demand / 30).toFixed(1)} + CN:{(r.china_w / 30).toFixed(1)})
                                        </span>
                                      )}
                                    </div>
                                    {r.inboundEvents.length === 0 && <div style={{ color: '#555' }}>No inbound from active POs</div>}
                                    {r.inboundEvents.map((ev, j) => {
                                      const after = ev.afterContainer;
                                      return (
                                        <div key={j} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid #1a251a', color: after ? '#8b6b3f' : '#22d3ee' }}>
                                          <span style={{ fontWeight: 600, minWidth: 60 }}>{fmtDate(ev.date)}</span>
                                          <span style={{ color: '#4ade80', fontWeight: 700 }}>+{fmtDisplay(ev.qty)}</span>
                                          <span style={{ color: '#6b8f6b' }}>{ev.poLabel}</span>
                                          {after && <span style={{ color: '#f59e0b', fontSize: 8 }}>after container</span>}
                                        </div>
                                      );
                                    })}
                                    <div style={{ marginTop: 10, padding: '6px 10px', borderRadius: 4, background: r.canFill ? '#0a2a0a' : '#2a0a0a', border: `1px solid ${r.canFill ? '#4ade80' : '#ef4444'}`, fontWeight: 700, fontSize: 11, color: r.canFill ? '#4ade80' : '#ef4444' }}>
                                      Projected @ container: {fmtDisplay(r.projected)}
                                      {r.canFill ? ` → Surplus: +${fmtDisplay(r.surplus)}` : ` → SHORT: ${fmtDisplay(r.surplus)}`}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={13} style={{ textAlign: 'center', padding: 24, opacity: 0.4 }}>{selectedPO ? 'No matching SKUs' : 'Select a Container Load PO'}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 16, padding: 12, background: '#111a11', borderRadius: 8, border: '1px solid #2d4a2d', fontSize: 10, color: '#6b8f6b', lineHeight: 1.6 }}>
                <strong style={{ color: '#4ade80' }}>Formula:</strong> Projected = SOH Main + SOH China + Inbound (ETA ≤ container, from enabled POs) − (Demand/30 + China-W/30) × days to container.
                <br />
                <strong style={{ color: '#4ade80' }}>Surplus:</strong> Projected − Need. Daily demand uses monthly Demand and China-W ÷ 30 each.
                <br />
                SKUs missing from the AIM CSV show &quot;?&quot; in the table.
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TDCell({ children, right, bold, color }: { children: React.ReactNode; right?: boolean; bold?: boolean; color?: string }) {
  return (
    <td style={{ padding: '7px 8px', textAlign: right ? 'right' : 'left', borderBottom: '1px solid #1a251a', fontWeight: bold ? 600 : 400, color: color ?? '#6b8f6b', fontVariantNumeric: 'tabular-nums' }}>{children}</td>
  );
}

