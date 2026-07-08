import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';
import { SPLIT_RULES, classifyLine } from '../_shared/xeroSplitRules.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface MonthData {
  index: number;
  label: string;
  year: number;
  month: number;
}

interface RawMonthData extends MonthData {
  colIndex: number;
}

interface CostItem {
  name: string;
  monthly: number[];
}

interface CostsResponse {
  months: MonthData[];
  items: CostItem[];
  periodEnd?: string;
}

function parseMonthLabel(label: string): { year: number; month: number } | null {
  const monthMap: Record<string, number> = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
  };

  const lowerLabel = label.toLowerCase().trim();

  const match = lowerLabel.match(/([a-z]+)\s*(\d{4})/);
  if (match) {
    // Xero mixes short and long month names in the same export
    // ("Apr 2026" but "July 2026", "June 2026", "Sept 2025"), so match
    // on the first 3 letters, which are unambiguous for English months.
    const monthStr = match[1].slice(0, 3);
    const year = parseInt(match[2], 10);
    const month = monthMap[monthStr];
    if (month) {
      return { year, month };
    }
  }

  return null;
}

function cleanNumber(value: any): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    let cleaned = value.trim();

    const isNegative = cleaned.includes('(') && cleaned.includes(')');

    cleaned = cleaned.replace(/[$,()]/g, '');

    const num = parseFloat(cleaned);

    if (!isNaN(num)) {
      return isNegative ? -num : num;
    }
  }

  return 0;
}

function extractPeriodEndDate(worksheet: any, range: XLSX.Range): string | undefined {
  const monthMap: Record<string, number> = {
    'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
    'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
    'aug': 8, 'august': 8, 'sep': 9, 'sept': 9, 'september': 9, 'oct': 10,
    'october': 10, 'nov': 11, 'november': 11, 'dec': 12, 'december': 12
  };

  for (let row = 0; row <= 3; row++) {
    for (let col = 0; col <= Math.min(range.e.c, 5); col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[cellAddress];

      if (!cell || !cell.v) continue;

      const text = String(cell.v).toLowerCase().trim();

      const asAtMatch = text.match(/as\s+at\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (asAtMatch) {
        const day = parseInt(asAtMatch[1], 10);
        const month = monthMap[asAtMatch[2].toLowerCase()];
        const year = parseInt(asAtMatch[3], 10);
        if (month && day >= 1 && day <= 31) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }

      const periodToMatch = text.match(/to\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (periodToMatch) {
        const day = parseInt(periodToMatch[1], 10);
        const month = monthMap[periodToMatch[2].toLowerCase()];
        const year = parseInt(periodToMatch[3], 10);
        if (month && day >= 1 && day <= 31) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }

      const monthEndedMatch = text.match(/month\s+ended\s+(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (monthEndedMatch) {
        const day = parseInt(monthEndedMatch[1], 10);
        const month = monthMap[monthEndedMatch[2].toLowerCase()];
        const year = parseInt(monthEndedMatch[3], 10);
        if (month && day >= 1 && day <= 31) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }

      const ddmmyyyyMatch = text.match(/(\d{1,2})[\s\/-](\d{1,2})[\s\/-](\d{4})/);
      if (ddmmyyyyMatch) {
        const day = parseInt(ddmmyyyyMatch[1], 10);
        const month = parseInt(ddmmyyyyMatch[2], 10);
        const year = parseInt(ddmmyyyyMatch[3], 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }
    }
  }

  return undefined;
}

/** P&L summary / section rows — not individual expense lines */
function shouldSkipPlAccountRow(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  const lower = n.toLowerCase();
  if (lower.startsWith('total ')) return true;
  if (lower === 'net profit' || lower.startsWith('net profit ')) return true;
  if (lower === 'gross profit' || lower.startsWith('gross profit ')) return true;
  if (
    lower === 'operating expenses' ||
    lower === 'trading income' ||
    lower === 'cost of sales'
  ) {
    return true;
  }
  return false;
}

// Split rules live in ../_shared/xeroSplitRules.ts (single source of truth,
// shared with the drill-down function xero-account-detail).

/** Fetch every line for an account. PostgREST caps a single response at 1000
 *  rows (max-rows) regardless of .limit(), so we page with .range(). */
async function fetchAllLines(supabase: any, account: string): Promise<any[]> {
  const all: any[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('xero_account_lines')
      .select('journal_date, contact_name, net_amount')
      .eq('account_name', account)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return all;
}

// ─── Starshipit market reallocation ─────────────────────────────────────────
// Xero classifies freight by supplier contact, so Australia Post (which ships
// to AU AND US) lands entirely in "Outbound — B2C AU". Starshipit knows each
// carrier's real AU/US split. We reallocate the outbound B2C carrier lines
// (Australia Post, DHL eCommerce, UPS) by that carrier's monthly market ratio:
// the AU share stays in B2C AU, the rest goes to B2C USA. ZONOS/Hoon Choi
// aren't carriers with a market → they stay in B2C USA unchanged.

interface StarshipitRatios { monthly: Map<string, Map<string, { au: number; total: number }>>; fy: Map<string, { au: number; total: number }>; }

async function loadStarshipitRatios(supabase: any): Promise<StarshipitRatios> {
  const monthly = new Map<string, Map<string, { au: number; total: number }>>();
  const fy = new Map<string, { au: number; total: number }>();
  const { data } = await supabase.from('starshipit_market_monthly').select('year, month, carrier_key, market, freight_charge');
  for (const r of data ?? []) {
    const ck = String(r.carrier_key);
    const fc = Number(r.freight_charge) || 0;
    const isAU = r.market === 'AU';
    const mkKey = `${r.year}-${r.month}`;
    if (!monthly.has(ck)) monthly.set(ck, new Map());
    const mm = monthly.get(ck)!;
    if (!mm.has(mkKey)) mm.set(mkKey, { au: 0, total: 0 });
    const cell = mm.get(mkKey)!; cell.total += fc; if (isAU) cell.au += fc;
    if (!fy.has(ck)) fy.set(ck, { au: 0, total: 0 });
    const f = fy.get(ck)!; f.total += fc; if (isAU) f.au += fc;
  }
  return { monthly, fy };
}

/** AU share for a carrier in a month; falls back to the FY-blended share, or
 *  null when there's no Starshipit data (→ don't reallocate). */
function auShare(ratios: StarshipitRatios, ck: string, year: number, month: number): number | null {
  const cell = ratios.monthly.get(ck)?.get(`${year}-${month}`);
  if (cell && cell.total > 0) return cell.au / cell.total;
  const f = ratios.fy.get(ck);
  if (f && f.total > 0) return f.au / f.total;
  return null;
}

function carrierKeyForContact(contact: string | null): string | null {
  const n = (contact ?? '').toLowerCase();
  if (/australia\s*post/.test(n)) return 'auspost';
  if (/dhl\s*e-?commerce/.test(n)) return 'dhl_ecommerce';
  if (/\bups\b/.test(n)) return 'ups';
  return null;
}

/** Build the CostsResponse from the xero_pl_monthly / xero_account_lines
 *  tables (populated daily by xero-sync). Returns null when the tables are
 *  empty (Xero not synced yet) so the caller can fall back to the xlsx. */
async function loadFromDatabase(supabase: any): Promise<CostsResponse | null> {
  const { data: allRows, error } = await supabase
    .from('xero_pl_monthly')
    .select('account_name, year, month, amount, section');
  if (error || !allRows || allRows.length === 0) return null;

  // The costs canvas is about COSTS: only expense sections qualify. Income
  // and Cost of Sales accounts (Sales, cost of goods sold, ...) must never
  // reach the canvas — the manual xlsx only exported expenses and the API
  // path has to match that contract. Rows without a section (pre-section
  // syncs) are treated as unusable so the caller falls back to the xlsx
  // until a fresh sync fills the column.
  const plRows = allRows.filter((r: any) => /expens/i.test(String(r.section ?? '')));
  if (plRows.length === 0) return null;

  // Months present, sorted ascending.
  const monthKeys = new Map<string, { year: number; month: number }>();
  for (const r of plRows) {
    monthKeys.set(`${r.year}-${String(r.month).padStart(2, '0')}`, { year: r.year, month: r.month });
  }
  const sorted = [...monthKeys.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month));
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months: MonthData[] = sorted.map((m, idx) => ({
    index: idx,
    label: `${MONTH_LABELS[m.month - 1]} ${m.year}`,
    year: m.year,
    month: m.month,
  }));
  const monthIndex = new Map(sorted.map((m, idx) => [`${m.year}-${m.month}`, idx]));

  // Base items from the P&L.
  const byAccount = new Map<string, number[]>();
  for (const r of plRows) {
    const name = String(r.account_name).trim();
    if (!name || shouldSkipPlAccountRow(name)) continue;
    if (!byAccount.has(name)) byAccount.set(name, new Array(months.length).fill(0));
    const idx = monthIndex.get(`${r.year}-${r.month}`);
    if (idx !== undefined) byAccount.get(name)![idx] = Number(r.amount) || 0;
  }

  // Starshipit per-carrier market ratios (for the outbound B2C reallocation).
  const ratios = await loadStarshipitRatios(supabase);

  // Split watched accounts into virtual accounts by transaction lines.
  for (const account of Object.keys(SPLIT_RULES)) {
    if (!byAccount.has(account)) continue;
    const plMonthly = byAccount.get(account)!;

    let lines: any[];
    try {
      lines = await fetchAllLines(supabase, account);
    } catch {
      continue; // keep the raw account if detail is unavailable
    }

    const buckets = new Map<string, number[]>();
    const ensure = (bucket: string) => {
      const key = `${account} — ${bucket}`;
      if (!buckets.has(key)) buckets.set(key, new Array(months.length).fill(0));
      return buckets.get(key)!;
    };

    const coveredByLines = new Array(months.length).fill(0);
    for (const line of lines) {
      const d = new Date(line.journal_date);
      const idx = monthIndex.get(`${d.getFullYear()}-${d.getMonth() + 1}`);
      if (idx === undefined) continue; // line outside the P&L window
      const bucket = classifyLine(account, line.contact_name) ?? 'Review';
      const amt = Number(line.net_amount) || 0;

      // Starshipit market reallocation for outbound B2C carrier lines.
      if (account === 'Freight & Courier' && (bucket === 'Outbound — B2C AU' || bucket === 'Outbound — B2C USA')) {
        const ck = carrierKeyForContact(line.contact_name);
        const share = ck ? auShare(ratios, ck, d.getFullYear(), d.getMonth() + 1) : null;
        if (share !== null) {
          ensure('Outbound — B2C AU')[idx] += amt * share;
          ensure('Outbound — B2C USA')[idx] += amt * (1 - share);
          coveredByLines[idx] += amt;
          continue;
        }
      }

      ensure(bucket)[idx] += amt;
      coveredByLines[idx] += amt;
    }

    // Reconcile each month to the authoritative P&L total.
    for (let i = 0; i < months.length; i++) {
      const covered = coveredByLines[i];
      const pl = plMonthly[i];
      if (covered > pl + 0.01) {
        // Lines over-count the P&L (GST-inclusive amounts, or an expense
        // booked as both a bill and a direct payment). Scale the buckets down
        // proportionally so they sum exactly to the P&L for the month.
        const factor = covered > 0 ? pl / covered : 0;
        for (const monthly of buckets.values()) monthly[i] *= factor;
      } else if (pl - covered > 0.01) {
        // Lines under-count: the gap is spend not captured by transaction
        // lines (e.g. accountant manual journals). Surface it, never estimate.
        ensure('Unclassified')[i] += pl - covered;
      }
    }

    byAccount.delete(account);
    for (const [name, monthly] of buckets) byAccount.set(name, monthly);
  }

  const items: CostItem[] = [...byAccount.entries()].map(([name, monthly]) => ({ name, monthly }));

  // Data is synced daily — the current month is partial up to today.
  const periodEnd = new Date().toISOString().slice(0, 10);

  return { months, items, periodEnd };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Optional snapshot folder (e.g. "fy2025-26"). Only fiscal-year folders
    // are accepted; anything else falls back to the live bucket root.
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const folder = /^fy\d{4}-\d{2}$/.test(body?.prefix ?? '') ? `${body.prefix}/` : '';

    // Live path: Xero API tables first (synced daily by xero-sync), with the
    // manually-uploaded xlsx as fallback. Snapshot path (prefix set): ALWAYS
    // the frozen xlsx — the closed FY must never drift with new syncs.
    if (!folder) {
      const fromDb = await loadFromDatabase(supabase);
      if (fromDb) {
        return new Response(JSON.stringify(fromDb), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      console.warn('xero_pl_monthly empty — falling back to xlsx');
    }

    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from('csv-files')
      .download(`${folder}Dolo_Ent_PTY_Ltd_-_Profit_and_Loss_Mario_2026.xlsx`);

    if (downloadError) {
      throw new Error(`Failed to download file: ${downloadError.message}`);
    }

    const arrayBuffer = await fileData.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });

    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];

    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');

    const rawMonths: RawMonthData[] = [];
    for (let col = 1; col <= Math.min(range.e.c, 13); col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: 4, c: col });
      const cell = worksheet[cellAddress];

      if (cell && cell.v) {
        const label = String(cell.v).trim();
        if (label) {
          const parsed = parseMonthLabel(label);
          if (!parsed) {
            // Skip non-month header columns (e.g. "Total") instead of
            // silently misfiling them into January.
            console.warn(`Skipping unrecognized month column header: "${label}"`);
            continue;
          }
          rawMonths.push({
            index: rawMonths.length,
            colIndex: col,
            label,
            year: parsed.year,
            month: parsed.month
          });
        }
      }
    }

    const sortedMonths = [...rawMonths].sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });

    const months: MonthData[] = sortedMonths.map((m, idx) => ({
      index: idx,
      label: m.label,
      year: m.year,
      month: m.month
    }));

    const items: CostItem[] = [];

    const firstAccountRow = 18;
    const lastAccountRow = Math.min(range.e.r, 200);

    for (let row = firstAccountRow; row <= lastAccountRow; row++) {
      const nameCell = worksheet[XLSX.utils.encode_cell({ r: row, c: 0 })];

      if (!nameCell || !nameCell.v) {
        continue;
      }

      const itemName = String(nameCell.v).trim();
      if (!itemName || shouldSkipPlAccountRow(itemName)) {
        continue;
      }

      const monthlyRaw: number[] = [];
      for (let i = 0; i < rawMonths.length; i++) {
        const valueCell = worksheet[XLSX.utils.encode_cell({ r: row, c: rawMonths[i].colIndex })];
        const value = valueCell ? cleanNumber(valueCell.v) : 0;
        monthlyRaw.push(value);
      }

      const monthlySorted: number[] = sortedMonths.map(sortedMonth => {
        const rawIndex = rawMonths.findIndex(rm =>
          rm.year === sortedMonth.year && rm.month === sortedMonth.month
        );
        return rawIndex >= 0 ? monthlyRaw[rawIndex] : 0;
      });

      items.push({
        name: itemName,
        monthly: monthlySorted
      });
    }

    let periodEnd = extractPeriodEndDate(worksheet, range);

    if (!periodEnd && months.length > 0) {
      const lastMonth = months[months.length - 1];
      const lastDay = new Date(lastMonth.year, lastMonth.month, 0).getDate();
      periodEnd = `${lastMonth.year}-${String(lastMonth.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    const response: CostsResponse = {
      months,
      items,
      periodEnd
    };

    return new Response(
      JSON.stringify(response),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );

  } catch (error) {
    console.error('Error processing XLSX:', error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      }
    );
  }
});