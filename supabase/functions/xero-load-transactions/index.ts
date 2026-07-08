// =============================================================================
// Xero Account Transactions loader — populates xero_account_lines from the
// uploaded "Account Transactions" report (xlsx), which already carries the
// AUD-converted amount (Debit/Credit (AUD)) and a clean Contact column.
//
// This is the SOURCE OF TRUTH for the transaction-level split/drill-down. The
// Xero API is too slow/rate-limited to walk tens of thousands of bills, and it
// doesn't hand back per-line AUD; this report does. The API is kept only for
// the P&L monthly totals.
//
// Report layout (row 5 header): Date, Source, Contact, Description, Reference,
// Currency, Debit (Source), Credit (Source), Debit (AUD), Credit (AUD),
// Running Balance. Account sections appear as a lone col-A row
// ("425 - Freight & Courier"); "Total ..." rows close a section.
//
// Behaviour: full REPLACE per account found in the file — delete existing
// lines for those accounts, insert the file's lines. Re-uploading the full FY
// is therefore idempotent. Only WATCHED_ACCOUNTS are stored.
//
//   POST { file?: "xero-account-transactions.xlsx" }  (default name)
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const BUCKET = 'csv-files';
const DEFAULT_FILE = 'xero-account-transactions.xlsx';
const WATCHED = ['Rates & Taxes', 'Freight & Courier'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** "425 - Freight & Courier" → "Freight & Courier"; also handles no prefix. */
function normalizeAccount(raw: string): string {
  return raw.replace(/^\s*\d+\s*-\s*/, '').trim();
}

function num(v: any): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : 0;
}

function toISODate(v: any): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Deterministic UUID from a string, so re-loads produce stable keys. */
async function hashUUID(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const h = [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const file = String(body?.file ?? DEFAULT_FILE);

    const { data: fileData, error: dlErr } = await supabase.storage.from(BUCKET).download(file);
    if (dlErr || !fileData) return json({ success: false, message: `Cannot read ${file}: ${dlErr?.message}` }, 404);

    const wb = XLSX.read(await fileData.arrayBuffer(), { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });

    // Locate the header row (has "Debit (AUD)").
    let headerIdx = rows.findIndex((r) => (r ?? []).some((c) => String(c).trim() === 'Date') && (r ?? []).some((c) => String(c).includes('Debit (AUD)')));
    if (headerIdx < 0) return json({ success: false, message: 'Header row not found (expected Date … Debit (AUD))' }, 400);
    const H = rows[headerIdx].map((c) => String(c ?? '').trim());
    const col = (name: string) => H.findIndex((h) => h === name);
    const cDate = col('Date'), cSource = col('Source'), cContact = col('Contact'),
      cDesc = col('Description'), cRef = col('Reference'), cCur = col('Currency'),
      cDebSrc = col('Debit (Source)'), cCrdSrc = col('Credit (Source)'),
      cDebAUD = col('Debit (AUD)'), cCrdAUD = col('Credit (AUD)');

    const accountsFound = new Set<string>();
    const lines: any[] = [];
    const seenKeys = new Map<string, number>();
    let currentAccount: string | null = null;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const a = r[cDate];
      const isDate = a instanceof Date || /^\d{4}-\d{2}-\d{2}/.test(String(a ?? ''));

      // Section header: only col A populated, no amounts.
      if (a && !isDate && r[cDebAUD] == null && r[cSource] == null) {
        const acct = normalizeAccount(String(a));
        currentAccount = /^total/i.test(acct) ? null : acct;
        continue;
      }
      if (!isDate || !currentAccount) continue;
      if (!WATCHED.includes(currentAccount)) continue;

      const date = toISODate(a);
      if (!date) continue;
      const amountAUD = num(r[cDebAUD]) - num(r[cCrdAUD]);
      const amountSrc = num(r[cDebSrc]) - num(r[cCrdSrc]);
      const contact = String(r[cContact] ?? '').trim() || null;
      const reference = String(r[cRef] ?? '').trim() || null;
      const description = String(r[cDesc] ?? '').trim() || null;
      const currency = String(r[cCur] ?? 'AUD').trim() || 'AUD';

      accountsFound.add(currentAccount);
      // Stable key + occurrence index to disambiguate genuine duplicates.
      const baseKey = [currentAccount, date, contact, reference, description, amountAUD].join('|');
      const occ = (seenKeys.get(baseKey) ?? 0) + 1;
      seenKeys.set(baseKey, occ);
      lines.push({
        _key: `${baseKey}#${occ}`,
        account_name: currentAccount, journal_date: date, contact_name: contact,
        description, reference, net_amount: amountAUD, amount_source: amountSrc,
        currency, source: 'csv',
      });
    }

    if (accountsFound.size === 0) return json({ success: false, message: 'No watched-account transactions found in file' }, 400);

    // Assign deterministic UUIDs.
    for (const l of lines) {
      l.journal_line_id = await hashUUID(l._key);
      delete l._key;
    }

    // Full replace for the accounts present in the file.
    for (const acct of accountsFound) {
      const { error } = await supabase.from('xero_account_lines').delete().eq('account_name', acct);
      if (error) return json({ success: false, message: `delete ${acct}: ${error.message}` }, 500);
    }
    for (let i = 0; i < lines.length; i += 500) {
      const { error } = await supabase.from('xero_account_lines').upsert(lines.slice(i, i + 500), { onConflict: 'journal_line_id' });
      if (error) return json({ success: false, message: `insert: ${error.message}` }, 500);
    }

    const byAccount: Record<string, { count: number; total: number }> = {};
    for (const l of lines) {
      const b = byAccount[l.account_name] ?? { count: 0, total: 0 };
      b.count++; b.total += l.net_amount; byAccount[l.account_name] = b;
    }

    return json({ success: true, file, accounts: [...accountsFound], inserted: lines.length, byAccount });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
