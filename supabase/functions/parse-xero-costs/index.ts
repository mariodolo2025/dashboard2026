import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

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

    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from('csv-files')
      .download('Dolo_Ent_PTY_Ltd_-_Profit_and_Loss_Mario_2026.xlsx');

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