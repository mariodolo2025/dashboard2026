// =============================================================================
// Xero API sync — pulls accounting data into Supabase tables.
//
// Steps (POST body { step?: "pl" | "transactions" | "all" }, default "all"):
//   pl           → Reports/ProfitAndLoss by account × month (rolling 12
//                  months) → upserts xero_pl_monthly. 1:1 replacement for the
//                  manual "Profit and Loss Mario" xlsx.
//   transactions → BankTransactions (Spend/Receive Money) whose line items hit
//                  a WATCHED_ACCOUNT (accounts needing transaction-level
//                  breakdown, e.g. "Rates & Taxes") → xero_account_lines.
//                  Incremental via If-Modified-Since (last sync time in
//                  xero_sync_state). The Journals endpoint would be the
//                  canonical source but is premium-gated for post-2026 apps;
//                  Spend Money covers these accounts (validated against the
//                  Apr–Jun 2026 account-transaction exports).
//
// Token handling: Xero refresh tokens ROTATE on every use. The new refresh
// token is persisted immediately after each refresh; the daily cron keeps it
// alive (60-day idle expiry).
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { getXeroAccessToken } from '../_shared/doloXeroToken.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const API_BASE = 'https://api.xero.com/api.xro/2.0';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function getAccessToken(supabase: any): Promise<{ accessToken: string; tenantId: string }> {
  return getXeroAccessToken(supabase);
}

async function xeroGet(path: string, accessToken: string, tenantId: string, extraHeaders: Record<string, string> = {}, attempt = 0): Promise<any> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
      ...extraHeaders,
    },
  });
  if (res.status === 429) {
    // Rate limited. Back off and retry — but CAP the retries (the previous
    // uncapped recursion looped forever when Xero's daily/minute quota was
    // exhausted, killing the worker with a bogus RESOURCE_LIMIT).
    if (attempt >= 3) {
      const limit = res.headers.get('X-Rate-Limit-Problem') ?? 'unknown';
      throw new Error(`Xero rate limit hit (429, ${limit} limit) after ${attempt} retries on ${path.split('?')[0]}`);
    }
    const wait = Number(res.headers.get('Retry-After') ?? 5);
    await new Promise((r) => setTimeout(r, Math.min(wait, 15) * 1000));
    return xeroGet(path, accessToken, tenantId, extraHeaders, attempt + 1);
  }
  if (res.status === 304) return {}; // If-Modified-Since: nothing changed
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Xero GET ${path.split('?')[0]} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** AUD amount for a line. This Xero org's CurrencyRate is expressed as
 *  doc-currency units per 1 AUD (e.g. a USD bill shows ~0.65), so the base
 *  amount is LineAmount / CurrencyRate. Verified against a USD Diamond bill
 *  (639.50 USD @ 0.717 → 891.92 AUD). Rate 1 (or missing) for AUD docs. */
function toAUD(lineAmount: any, currencyRate: any): number {
  const amt = Number(lineAmount ?? 0);
  const rate = Number(currencyRate);
  return isFinite(rate) && rate > 0 ? amt / rate : amt;
}

// ─── Step: Profit & Loss by account × month ─────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseHeaderCell(title: string): { year: number; month: number } | null {
  // Xero report period headers look like "31 May 26" or "31 May 2026".
  const m = title.trim().toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{2,4})/);
  if (!m) return null;
  const month = MONTH_NAMES[m[2].slice(0, 3)];
  if (!month) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return { year, month };
}

// P&L month by month (docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, P0).
//
// Until 27-Oct-2026 this asked for ONE report ending at the end of the current
// month with periods=11. Xero builds the earlier columns on the same day of the
// month as toDate, so when the current month had 30 days every 31st elsewhere
// was cut off (seen 28-Sep: xero_pl_monthly off exactly in the 31-day months).
// Now: one single-period report per month, 1st to last day, from the start of
// the closed fiscal year to the current month (~16 calls). Each response must
// say it is that month, or the step fails. Each month is replaced whole in one
// transaction (xero_pl_replace_month), so an account Xero omits because it is
// zero that month does not keep a stale amount. The MRD reads xero_pl_monthly:
// same table, same columns.
async function syncProfitAndLoss(supabase: any, accessToken: string, tenantId: string): Promise<{ months: number; rows: number; failed: string[] }> {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  // From 1 July of the closed fiscal year (Jul 2025 while now is Jul 2026 - Jun 2027).
  const currentFYStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const first = new Date(currentFYStartYear - 1, 6, 1);
  const months: { year: number; month: number }[] = [];
  for (let d = new Date(first); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  const failed: string[] = [];
  let rowsTotal = 0;
  for (const { year, month } of months) {
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0);
    try {
      const rep = (await xeroGet(
        `Reports/ProfitAndLoss?fromDate=${fmt(from)}&toDate=${fmt(to)}&standardLayout=true`,
        accessToken,
        tenantId,
      ))?.Reports?.[0];
      if (!rep) throw new Error('no report in the response');
      // The value column's header must be this month (e.g. "31 Oct 26").
      const headerRow = rep.Rows?.find((r: any) => r.RowType === 'Header');
      const cells = headerRow?.Cells ?? [];
      const period = parseHeaderCell(String(cells[cells.length - 1]?.Value ?? ''));
      if (!period || period.year !== year || period.month !== month) {
        throw new Error(`report is for ${period ? `${period.year}-${period.month}` : 'an unknown period'}, not ${year}-${month}`);
      }
      // One row per account; a name twice in one month is summed, not overwritten.
      const byAccount = new Map<string, { account_name: string; year: number; month: number; amount: number; section: string | null; synced_at: string }>();
      const stamp = new Date().toISOString();
      const walk = (rows: any[], section: string) => {
        for (const row of rows ?? []) {
          if (row.RowType === 'Section') { walk(row.Rows, String(row.Title ?? section ?? '').trim()); continue; }
          if (row.RowType !== 'Row') continue; // skip SummaryRow (totals)
          const c = row.Cells ?? [];
          const accountName = String(c[0]?.Value ?? '').trim();
          if (!accountName) continue;
          const amount = parseFloat(String(c[c.length - 1]?.Value ?? '0')) || 0;
          const cur = byAccount.get(accountName);
          if (cur) cur.amount += amount;
          else byAccount.set(accountName, { account_name: accountName, year, month, amount, section: section || null, synced_at: stamp });
        }
      };
      walk(rep.Rows, '');
      const rows = [...byAccount.values()].map((r) => ({ ...r, amount: Math.round(r.amount * 100) / 100 }));
      const { error } = await supabase.rpc('xero_pl_replace_month', { p_year: year, p_month: month, p_rows: rows });
      if (error) throw new Error(`replace: ${error.message}`);
      rowsTotal += rows.length;
    } catch (e) {
      failed.push(`${year}-${month}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failed.length) {
    // Loud: the months that worked are stored; the step still fails so the
    // run is red and nobody reads a P&L with holes as if it were whole.
    throw new Error(`P&L: ${failed.length} of ${months.length} months failed — ${failed.join(' | ')}`);
  }
  return { months: months.length, rows: rowsTotal, failed };
}

// ─── Detail of the watched accounts (Freight & Courier, Rates & Taxes) ──────
// docs/PLAN-XERO-DETAIL-SYNC-2026-10-27-v2.md, Fase 2 and Fase 3 (approved by
// Mario 27-Oct-2026), after the external audit
// docs/AUDIT-XERO-SYNC-2026-10-27.md. What changed and why:
//
// * READ EVERYTHING (P1). The old step read at most 2 pages (200) of bills and
//   2 of bank transactions modified since the last run, then moved its
//   watermark to the run's start time anyway. Xero holds ~5-7k ACCPAY bills a
//   month (mostly automatic "Stock Journal" ones), so it lost documents almost
//   every day from its first run on 8-Jul (11 identified). Now each source is
//   read in UpdatedDateUTC order, 1000 per page, until a short page or the
//   time budget; the watermark only moves to the newest UpdatedDateUTC that
//   was actually processed; a run that is cut says partial:true and the next
//   one resumes. Bursts of more than a page in the same instant continue by
//   page number instead of advancing.
// * NET OF GST (P2). net_amount = (LineAmount - TaxAmount if the document is
//   tax-Inclusive) / CurrencyRate, rounded to cents — for bills, bank
//   transactions and credit notes alike. tax_amount, gross_amount and
//   line_amount_types are kept beside it.
// * REPLACE BY DOCUMENT (P3). Every document read replaces all its stored
//   lines in one transaction (xero_lines_replace_documents): a voided,
//   deleted, re-coded or re-dated document drops lines it no longer has.
//   Only documents that hit the ledger count (bills and credit notes
//   AUTHORISED or PAID, bank transactions AUTHORISED); drafts do not.
// * CREDIT NOTES (P3c). Supplier credit notes (ACCPAYCREDIT) were never read;
//   the P&L includes them. Read like bills, negative.
// * ACCOUNTS BY CODE (P3d). 425 = Freight & Courier, 465 = Rates & Taxes. If
//   Xero has another name on either code, the step fails instead of reading
//   nothing.
// * MONTH RE-READ + NIGHTLY CHECK (P4, P3b). A month is read whole by date
//   range (bills, bank transactions, credit notes) and, only if the read
//   finished, replaces that month's API lines in one transaction per account
//   (xero_lines_replace_range). Every night the last three closed months and
//   the current one are compared with the P&L; a month off by more than A$1 is
//   re-read. What is still off after that is reported, never scaled away.
//
// The MRD reads xero_account_lines (journal_date, account_name, net_amount,
// contact_name, reference, description): same table, same columns, account
// names unchanged.

const WATCHED: Record<string, string> = { '425': 'Freight & Courier', '465': 'Rates & Taxes' };
const XERO_PAGE = 1000;
const STEP_BUDGET_MS = 100_000;
// The daily cron runs pl → detail → reconcile → meta_bills in ONE request and
// ops_http_post waits 150 s for it (ops_jobs.http_timeout_ms). detail and
// reconcile stop at whichever comes first: their own budget or this one,
// counted from the start of the request; what is left waits for the next run.
const RUN_BUDGET_MS = 120_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function parseXeroDate(v: string): string | null {
  const s = String(v ?? '');
  // Prefer plain "2026-05-05T00:00:00" (DateString), fall back to /Date(ms)/.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/\/Date\((\d+)/);
  if (!m) return null;
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

/** UpdatedDateUTC ("/Date(1695...+0000)/" or ISO) as epoch ms. */
function parseXeroTs(v: any): number | null {
  const s = String(v ?? '');
  const m = s.match(/\/Date\((\d+)/);
  if (m) return Number(m[1]);
  const t = Date.parse(s.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

type Kind = 'bill' | 'credit' | 'bank';
const SRC: Record<Kind, { endpoint: string; key: string; id: string; where: string; ledger: Set<string> }> = {
  bill: { endpoint: 'Invoices', key: 'Invoices', id: 'InvoiceID', where: 'Type=="ACCPAY"', ledger: new Set(['AUTHORISED', 'PAID']) },
  credit: { endpoint: 'CreditNotes', key: 'CreditNotes', id: 'CreditNoteID', where: 'Type=="ACCPAYCREDIT"', ledger: new Set(['AUTHORISED', 'PAID']) },
  bank: { endpoint: 'BankTransactions', key: 'BankTransactions', id: 'BankTransactionID', where: '', ledger: new Set(['AUTHORISED']) },
};

async function watchedAccounts(accessToken: string, tenantId: string): Promise<Map<string, string>> {
  const body = await xeroGet('Accounts', accessToken, tenantId);
  const byCode = new Map<string, string>();
  for (const a of body?.Accounts ?? []) if (a.Code) byCode.set(String(a.Code), String(a.Name ?? '').trim());
  for (const [code, name] of Object.entries(WATCHED)) {
    if (byCode.get(code) !== name) {
      throw new Error(`watched account ${code} is "${byCode.get(code) ?? 'missing'}" in Xero, expected "${name}": update WATCHED in xero-sync (the MRD and By Channel read these names)`);
    }
  }
  return new Map(Object.entries(WATCHED));
}

/** The watched lines of one document, AUD ex-GST. [] when it does not hit the ledger. */
function docLines(kind: Kind, doc: any, watched: Map<string, string>, boundary: string): any[] {
  if (!SRC[kind].ledger.has(String(doc.Status ?? ''))) return [];
  const date = parseXeroDate(doc.DateString ?? doc.Date);
  if (!date || date <= boundary) return []; // up to the boundary the CSV history owns the account
  const sign = kind === 'credit' ? -1 : kind === 'bank' && String(doc.Type ?? '').startsWith('RECEIVE') ? -1 : 1;
  const inclusive = String(doc.LineAmountTypes ?? '') === 'Inclusive';
  const updated = parseXeroTs(doc.UpdatedDateUTC);
  const out: any[] = [];
  for (const line of doc.LineItems ?? []) {
    const code = String(line.AccountCode ?? '');
    if (!watched.has(code) || !line.LineItemID) continue;
    const gross = Number(line.LineAmount ?? 0);
    const tax = Number(line.TaxAmount ?? 0);
    const netSrc = inclusive ? gross - tax : gross;
    out.push({
      journal_line_id: line.LineItemID,
      journal_number: null,
      journal_date: date,
      account_name: watched.get(code),
      description: line.Description ?? null,
      net_amount: r2(sign * toAUD(netSrc, doc.CurrencyRate)),
      contact_name: String(doc.Contact?.Name ?? '').trim() || null,
      contact_id: doc.Contact?.ContactID ?? null,
      source: 'api',
      currency: String(doc.CurrencyCode ?? 'AUD'),
      amount_source: r2(sign * netSrc),
      reference: (kind === 'bank' ? doc.Reference : doc.InvoiceNumber ?? doc.CreditNoteNumber ?? doc.Reference) ?? null,
      document_id: String(doc[SRC[kind].id] ?? ''),
      document_type: kind === 'bank' ? String(doc.Type ?? 'BANK') : kind === 'bill' ? 'ACCPAY' : 'ACCPAYCREDIT',
      updated_date_utc: updated ? new Date(updated).toISOString() : null,
      tax_amount: r2(sign * toAUD(inclusive ? tax : 0, doc.CurrencyRate)),
      gross_amount: r2(sign * toAUD(gross, doc.CurrencyRate)),
      line_amount_types: doc.LineAmountTypes ?? null,
    });
  }
  return out;
}

async function getState(supabase: any, key: string): Promise<any> {
  const { data, error } = await supabase.from('xero_sync_state').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(`state ${key}: ${error.message}`);
  return data?.value ?? null;
}
async function setState(supabase: any, key: string, value: any) {
  const { error } = await supabase.from('xero_sync_state').upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`state ${key}: ${error.message}`);
}

/** Incremental read of one source. State: { w: ISO watermark, page, maxSeen }. */
async function readModified(kind: Kind, supabase: any, accessToken: string, tenantId: string,
  watched: Map<string, string>, boundary: string, deadline: number, maxPages = Infinity) {
  const key = `detail_v2_${kind}`;
  const st = await getState(supabase, key);
  if (!st?.w) throw new Error(`${key} not initialised: run step "reread" for the months since ${boundary} first`);
  let w = Date.parse(st.w);
  let page = Number(st.page) || 1;
  let maxSeen = st.maxSeen ? Date.parse(st.maxSeen) : w;
  // Resume: if the last cut run had moved past its watermark, restart from
  // there (page 1) — page numbers over a changed set can skip documents.
  if (page > 1 && maxSeen > w) { w = maxSeen; page = 1; }
  const s = SRC[kind];
  let docs = 0, lines = 0, pages = 0, done = false;
  while (Date.now() < deadline && pages < maxPages) {
    const ims = new Date(w - 5 * 60_000).toUTCString(); // 5 min overlap: re-reading is harmless
    const q = `${s.where ? `where=${encodeURIComponent(s.where)}&` : ''}order=${encodeURIComponent('UpdatedDateUTC ASC')}&page=${page}&pageSize=${XERO_PAGE}`;
    const body = await xeroGet(`${s.endpoint}?${q}`, accessToken, tenantId, { 'If-Modified-Since': ims });
    const list: any[] = body?.[s.key] ?? [];
    pages++;
    if (list.length) {
      const ids = list.map((d) => String(d[s.id] ?? '')).filter(Boolean);
      const rows = list.flatMap((d) => docLines(kind, d, watched, boundary));
      const { error } = await supabase.rpc('xero_lines_replace_documents', { p_document_ids: ids, p_rows: rows });
      if (error) throw new Error(`${kind}: replace: ${error.message}`);
      docs += list.length; lines += rows.length;
      for (const d of list) { const t = parseXeroTs(d.UpdatedDateUTC); if (t && t > maxSeen) maxSeen = t; }
    }
    if (list.length < XERO_PAGE) { done = true; break; }
    // A full page: continue. If it moved the watermark, restart from the new
    // one at page 1; if not (a burst in one instant), take the next page.
    if (maxSeen > w) { w = maxSeen; page = 1; } else { page++; }
    await setState(supabase, key, { w: new Date(w).toISOString(), page, maxSeen: new Date(maxSeen).toISOString() });
  }
  if (done) await setState(supabase, key, { w: new Date(maxSeen).toISOString(), page: null, maxSeen: null, lastDone: new Date().toISOString() });
  return { docs, lines, pages, partial: !done, watermark: new Date(done ? maxSeen : w).toISOString() };
}

// maxPages: test hook for the negative test of P1 (force a cut run).
async function syncDetail(supabase: any, accessToken: string, tenantId: string, runDeadline: number, maxPages = Infinity) {
  const watched = await watchedAccounts(accessToken, tenantId);
  const cfg = (await getState(supabase, 'detail_v2')) ?? {};
  const boundary: string = cfg.boundary ?? '2026-06-30';
  const deadline = Math.min(Date.now() + STEP_BUDGET_MS, runDeadline);
  const out: Record<string, unknown> = {};
  let partial = false;
  for (const kind of ['bill', 'credit', 'bank'] as Kind[]) {
    if (Date.now() >= deadline) { out[kind] = { partial: true, skipped: 'time budget' }; partial = true; continue; }
    const r = await readModified(kind, supabase, accessToken, tenantId, watched, boundary, deadline, maxPages);
    out[kind] = r;
    if (r.partial) partial = true;
  }
  const streak = partial ? (Number(cfg.partialStreak) || 0) + 1 : 0;
  await setState(supabase, 'detail_v2', { ...cfg, boundary, partialStreak: streak, lastRun: new Date().toISOString(), lastPartial: partial });
  return { ...out, partial, partialStreak: streak };
}

/** Read one month whole and, if the read finished, replace its API lines. */
async function rereadMonth(supabase: any, accessToken: string, tenantId: string, watched: Map<string, string>,
  boundary: string, year: number, month: number, deadline: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${year}-${pad(month)}-${pad(lastDay)}`;
  if (to <= boundary) return { month: from.slice(0, 7), skipped: 'inside the CSV history' };
  const ny = month === 12 ? year + 1 : year, nm = month === 12 ? 1 : month + 1;
  const dateWhere = `Date>=DateTime(${year},${month},1) AND Date<DateTime(${ny},${nm},1)`;
  const rows: any[] = [];
  const counts: Record<string, number> = {};
  for (const kind of ['bill', 'credit', 'bank'] as Kind[]) {
    const s = SRC[kind];
    const where = s.where ? `${s.where} AND ${dateWhere}` : dateWhere;
    let n = 0;
    for (let page = 1; ; page++) {
      if (Date.now() >= deadline) return { month: from.slice(0, 7), partial: true, read: counts };
      const body = await xeroGet(`${s.endpoint}?where=${encodeURIComponent(where)}&order=${encodeURIComponent('Date ASC')}&page=${page}&pageSize=${XERO_PAGE}`, accessToken, tenantId);
      const list: any[] = body?.[s.key] ?? [];
      n += list.length;
      for (const d of list) rows.push(...docLines(kind, d, watched, boundary));
      if (list.length < XERO_PAGE) break;
    }
    counts[kind] = n;
  }
  const replaced: Record<string, unknown> = {};
  for (const acct of watched.values()) {
    const mine = rows.filter((r) => r.account_name === acct);
    const { data, error } = await supabase.rpc('xero_lines_replace_range', {
      p_accounts: [acct], p_from: from, p_to: to, p_sources: ['api'], p_rows: mine,
    });
    if (error) throw new Error(`reread ${from.slice(0, 7)} ${acct}: ${error.message}`);
    replaced[acct] = { lines: mine.length, net: r2(mine.reduce((s, r) => s + r.net_amount, 0)), ...(data as object) };
  }
  return { month: from.slice(0, 7), read: counts, replaced };
}

/** Lines vs P&L per watched account and month (SQL), from p_from on. */
async function reconcile(supabase: any, fromMonth: string) {
  const { data, error } = await supabase.rpc('xero_lines_reconcile', { p_from: fromMonth });
  if (error) throw new Error(`reconcile: ${error.message}`);
  return (data ?? []) as { account_name: string; month: string; pl: number; lines: number; diff: number }[];
}

/**
 * Nightly check (P3b): the last three closed months and the current one. A
 * month off by more than A$1 in any watched account is re-read whole; the
 * result is stored in xero_sync_state.detail_reconcile for the watchdog.
 */
async function syncReconcile(supabase: any, accessToken: string, tenantId: string, runDeadline: number, opts: { months?: string[] } = {}) {
  const watched = await watchedAccounts(accessToken, tenantId);
  const cfg = (await getState(supabase, 'detail_v2')) ?? {};
  const boundary: string = cfg.boundary ?? '2026-06-30';
  const deadline = Math.min(Date.now() + STEP_BUDGET_MS, runDeadline);
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
  let rec = await reconcile(supabase, first);
  const dirty = opts.months?.length
    ? opts.months
    : [...new Set(rec.filter((r) => Math.abs(Number(r.diff)) > 1).map((r) => r.month))].sort();
  const reread: any[] = [];
  for (const m of dirty) {
    if (Date.now() >= deadline) { reread.push({ month: m, partial: true, skipped: 'time budget' }); continue; }
    const [y, mo] = m.split('-').map(Number);
    reread.push(await rereadMonth(supabase, accessToken, tenantId, watched, boundary, y, mo, deadline));
  }
  if (reread.length) rec = await reconcile(supabase, first);
  const partial = reread.some((r) => r.partial);
  await setState(supabase, 'detail_reconcile', { checkedAt: new Date().toISOString(), months: rec, reread, partial });
  return { months: rec, reread, partial };
}

// ─── Step: Meta bills inside Advertising ─────────────────────────────────────
// Meta is entered as one bill per ad account per month, dated the 1st/2nd of
// the FOLLOWING month ("ads September" dated 1-Oct-2026). Xero's Advertising
// for a month therefore carries the previous month's Meta. This stores, per
// bill month, the AUD of those bills' Advertising lines, so By Channel can
// swap them for Meta's actual spend in the selected dates.
// Bounded: only the Meta contacts' bills (a few a month), filtered in Xero.

// Xero refuses a where-filter on Contact.Name for this organisation
// ("HighVolumeException": too many invoices to scan), so the bills are asked
// for by contact id, the filter Xero indexes. The app has no contacts scope to
// look the ids up, hence the constants (Dolo Ent PTY Ltd, 8-Oct-2026). If Meta
// is ever billed under another contact, add its id here.
const META_CONTACT_IDS = [
  'fa06c8ff-4ec7-4ae6-8db1-ad8f83f19f64', // "facebook" — every Meta bill since 2024
  '00995607-b070-43c2-88cd-ef2f36fc00c5', // "Meta Platforms, Inc."
];
const META_BILLS_SINCE = [2024, 7, 1];

async function syncMetaBills(supabase: any, accessToken: string, tenantId: string): Promise<{ months: number; bills: number }> {
  const accountsBody = await xeroGet('Accounts', accessToken, tenantId);
  const advCodes = new Set(
    (accountsBody?.Accounts ?? [])
      .filter((a: any) => String(a.Name ?? '').trim() === 'Advertising' && a.Code)
      .map((a: any) => String(a.Code)),
  );
  if (advCodes.size === 0) throw new Error('meta_bills: no "Advertising" account in the chart of accounts');

  const where = `Type=="ACCPAY" AND Date>=DateTime(${META_BILLS_SINCE.join(',')})`;
  const contactIds = META_CONTACT_IDS.join(',');
  const byMonth = new Map<string, { year: number; month: number; aud: number; bills: number; detail: any[] }>();
  let bills = 0;
  for (let page = 1; page <= 20; page++) {
    const body = await xeroGet(`Invoices?ContactIDs=${contactIds}&where=${encodeURIComponent(where)}&page=${page}`, accessToken, tenantId);
    const invs: any[] = body?.Invoices ?? [];
    for (const inv of invs) {
      if (inv.Status === 'DELETED' || inv.Status === 'VOIDED') continue;
      const d = parseXeroDate(inv.DateString ?? inv.Date);
      if (!d) continue;
      const inclusive = String(inv.LineAmountTypes ?? '') === 'Inclusive';
      let aud = 0;
      for (const line of inv.LineItems ?? []) {
        if (!advCodes.has(String(line.AccountCode ?? ''))) continue;
        const net = Number(line.LineAmount ?? 0) - (inclusive ? Number(line.TaxAmount ?? 0) : 0);
        aud += toAUD(net, inv.CurrencyRate);
      }
      if (aud === 0) continue;
      bills++;
      const year = Number(d.slice(0, 4)), month = Number(d.slice(5, 7));
      const k = `${year}-${month}`;
      const cur = byMonth.get(k) ?? { year, month, aud: 0, bills: 0, detail: [] };
      cur.aud += aud;
      cur.bills++;
      cur.detail.push({ date: d, number: inv.InvoiceNumber ?? null, currency: inv.CurrencyCode ?? 'AUD', total: inv.Total ?? null, aud: Math.round(aud * 100) / 100 });
      byMonth.set(k, cur);
    }
    if (invs.length < 100) break;
    if (page === 20) throw new Error('meta_bills: more than 20 pages of Meta bills, refusing to store a partial set');
  }

  const rows = [...byMonth.values()].map((m) => ({
    year: m.year, month: m.month, amount_aud: Math.round(m.aud * 100) / 100,
    bills: m.bills, detail: m.detail, synced_at: new Date().toISOString(),
  }));
  if (rows.length) {
    const { error } = await supabase.from('xero_meta_bills_monthly').upsert(rows, { onConflict: 'year,month' });
    if (error) throw new Error(`meta_bills upsert: ${error.message}`);
  }
  // A month whose bills were deleted in Xero must not keep its old total.
  const keep = new Set(rows.map((r) => `${r.year}-${r.month}`));
  const { data: existing } = await supabase.from('xero_meta_bills_monthly').select('year,month');
  for (const e of existing ?? []) {
    if (keep.has(`${e.year}-${e.month}`)) continue;
    const { error } = await supabase.from('xero_meta_bills_monthly').delete().eq('year', e.year).eq('month', e.month);
    if (error) throw new Error(`meta_bills cleanup: ${error.message}`);
  }
  return { months: rows.length, bills };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const runDeadline = Date.now() + RUN_BUDGET_MS;
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const step = body?.step ?? 'all';

    const result: Record<string, unknown> = { success: true, step };

    try {
      const { accessToken, tenantId } = await getAccessToken(supabase);

      // 'all' (the daily cron) = P&L totals + incremental detail + the check
      // against the P&L + Meta bills. The CSV owns the history before Jul-2026.
      if (step === 'pl' || step === 'all') {
        result.pl = await syncProfitAndLoss(supabase, accessToken, tenantId);
      }
      if (step === 'detail' || step === 'all') {
        const maxPages = Number(body?.maxPages) > 0 ? Number(body.maxPages) : Infinity;
        result.detail = await syncDetail(supabase, accessToken, tenantId, runDeadline, maxPages);
      }
      if (step === 'reconcile' || step === 'all') {
        result.reconcile = await syncReconcile(supabase, accessToken, tenantId, runDeadline);
      }
      if (step === 'reread') {
        // Manual: re-read the given months whole, e.g. { months: ["2026-07"] }.
        const months: string[] = Array.isArray(body?.months) ? body.months.map(String) : [];
        if (!months.length || !months.every((m) => /^\d{4}-\d{2}$/.test(m))) throw new Error('reread needs months: ["YYYY-MM", ...]');
        result.reconcile = await syncReconcile(supabase, accessToken, tenantId, runDeadline, { months });
      }
      if (step === 'init_detail') {
        // One-off: start the incremental watermarks at a given instant (the
        // moment before the first month re-read), for every source not set.
        const at = typeof body?.at === 'string' ? new Date(body.at) : new Date();
        if (Number.isNaN(at.getTime())) throw new Error('init_detail: bad "at"');
        const set: string[] = [];
        for (const kind of ['bill', 'credit', 'bank']) {
          const key = `detail_v2_${kind}`;
          if ((await getState(supabase, key))?.w) continue;
          await setState(supabase, key, { w: at.toISOString(), page: null, maxSeen: null });
          set.push(key);
        }
        result.init = { at: at.toISOString(), set };
      }
      if (step === 'meta_bills' || step === 'all') {
        result.metaBills = await syncMetaBills(supabase, accessToken, tenantId);
      }
      if (step === 'transactions' || step === 'invoices') {
        // Removed 27-Oct-2026 (audit finding M): the old full walks paged a
        // changing set and swallowed errors, returning 0 lines "successfully".
        // Use step "reread" with the months instead.
        throw new Error(`step "${step}" was removed: use { step: "reread", months: ["YYYY-MM"] }`);
      }
    } catch (e) {
      // Record the failure for the Connections panel, then rethrow.
      await supabase.from('xero_sync_state').upsert({
        key: 'last_sync',
        value: { at: new Date().toISOString(), ok: false, step, error: e instanceof Error ? e.message : 'Unknown error' },
        updated_at: new Date().toISOString(),
      });
      throw e;
    }

    // Record the result for the Connections panel and the watchdog. A run
    // that could not read everything (time budget) is not "ok", even though
    // it saved its progress and the next run continues.
    const partial = !!((result.detail as any)?.partial || (result.reconcile as any)?.partial);
    result.partial = partial;
    await supabase.from('xero_sync_state').upsert({
      key: 'last_sync',
      value: { at: new Date().toISOString(), ok: !partial, partial, step, summary: result },
      updated_at: new Date().toISOString(),
    });

    return json(result);
  } catch (e) {
    console.error('xero-sync error:', e);
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
