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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const API_BASE = 'https://api.xero.com/api.xro/2.0';

/** Accounts whose transaction lines we persist for breakdown rules. */
const WATCHED_ACCOUNTS = ['Rates & Taxes', 'Freight & Courier'];

/** History start for the first transactions pull (prior FY start, for YoY). */
const TRANSACTIONS_SINCE = '2024-07-01';

/** Max BankTransactions pages (100 each) per invocation. */
const MAX_TX_PAGES_PER_RUN = 60;
/** Invoices carry many nested line items — a much heavier payload than bank
 *  transactions — so page far fewer per invocation to stay under the edge
 *  function's CPU/memory limit. The cursor resumes across invocations. */
const MAX_INVOICE_PAGES_PER_RUN = 2;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function getAccessToken(supabase: any): Promise<{ accessToken: string; tenantId: string }> {
  const clientId = Deno.env.get('XERO_CLIENT_ID')!;
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')!;

  const { data: row, error } = await supabase
    .from('xero_oauth_tokens')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error || !row) {
    throw new Error('Xero is not connected yet — run the xero-oauth flow first.');
  }

  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Xero token refresh failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const tokens = await res.json();

  // Rotating refresh token: persist the new one IMMEDIATELY.
  const { error: upErr } = await supabase
    .from('xero_oauth_tokens')
    .update({ refresh_token: tokens.refresh_token, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (upErr) {
    // If this fails we'd lose the session on next run — surface loudly.
    throw new Error(`CRITICAL: could not persist rotated refresh token: ${upErr.message}`);
  }

  return { accessToken: tokens.access_token, tenantId: row.tenant_id };
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

async function syncProfitAndLoss(supabase: any, accessToken: string, tenantId: string): Promise<number> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();

  const collect = (rep: any, upserts: any[]) => {
    const headerRow = rep.Rows?.find((r: any) => r.RowType === 'Header');
    const periods: ({ year: number; month: number } | null)[] = (headerRow?.Cells ?? [])
      .map((c: any) => parseHeaderCell(String(c?.Value ?? '')));
    const walk = (rows: any[], section: string) => {
      for (const row of rows ?? []) {
        if (row.RowType === 'Section') {
          walk(row.Rows, String(row.Title ?? section ?? '').trim());
          continue;
        }
        if (row.RowType !== 'Row') continue; // skip SummaryRow (totals)
        const cells = row.Cells ?? [];
        const accountName = String(cells[0]?.Value ?? '').trim();
        if (!accountName) continue;
        for (let i = 1; i < cells.length; i++) {
          const period = periods[i];
          if (!period) continue;
          const amount = parseFloat(String(cells[i]?.Value ?? '0')) || 0;
          upserts.push({
            account_name: accountName,
            year: period.year,
            month: period.month,
            amount,
            section: section || null,
            synced_at: new Date().toISOString(),
          });
        }
      }
    };
    walk(rep.Rows, '');
  };

  // Single-period report (one value column): assign every account row to a
  // KNOWN (year, month) instead of parsing the header.
  const collectSingleMonth = (rep: any, year: number, month: number, out: any[]) => {
    const walk = (rows: any[], section: string) => {
      for (const row of rows ?? []) {
        if (row.RowType === 'Section') {
          walk(row.Rows, String(row.Title ?? section ?? '').trim());
          continue;
        }
        if (row.RowType !== 'Row') continue;
        const cells = row.Cells ?? [];
        const accountName = String(cells[0]?.Value ?? '').trim();
        if (!accountName) continue;
        const amount = parseFloat(String(cells[cells.length - 1]?.Value ?? '0')) || 0;
        out.push({ account_name: accountName, year, month, amount, section: section || null, synced_at: new Date().toISOString() });
      }
    };
    walk(rep.Rows, '');
  };

  // Xero caps monthly P&L at 11 periods (12 columns), and rejects a past
  // toDate with periods ("fromDate must be before toDate"). So:
  //  A) rolling 12 months ending this month (toDate + periods=11), then
  //  B) fetch each still-missing month of the closed FY as a single-period
  //     report (fromDate..toDate for that one month), which is accepted.
  const upserts: any[] = [];
  const windowErrors: string[] = [];
  const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0); // end of this month

  const reportA = await xeroGet(
    `Reports/ProfitAndLoss?toDate=${fmt(toDate)}&periods=11&timeframe=MONTH&standardLayout=true`,
    accessToken,
    tenantId,
  );
  const repA = reportA?.Reports?.[0];
  if (!repA) throw new Error('Unexpected P&L response shape');
  collect(repA, upserts);
  const have = new Set(upserts.map((u) => `${u.year}-${u.month}`));

  // CLOSED fiscal year (the one that ended most recently): 1 Jul .. 30 Jun.
  // now = Jul 2026 → current FY start 2026 → closed FY start 2025. Fetch any of
  // its months window A didn't cover — normally just July of that year.
  const currentFYStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const closedFYStartYear = currentFYStartYear - 1;
  const nowKey = now.getFullYear() * 12 + now.getMonth();
  for (let k = 0; k < 12; k++) {
    const mIdx = 6 + k; // 6=Jul(0-idx) ... 17=Jun of the next year
    const year = closedFYStartYear + Math.floor(mIdx / 12);
    const month = (mIdx % 12) + 1;
    if (year * 12 + (month - 1) > nowKey) continue; // never fetch future months
    if (have.has(`${year}-${month}`)) continue;
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0);
    try {
      const rep = (await xeroGet(
        `Reports/ProfitAndLoss?fromDate=${fmt(from)}&toDate=${fmt(to)}&standardLayout=true`,
        accessToken,
        tenantId,
      ))?.Reports?.[0];
      if (rep) collectSingleMonth(rep, year, month, upserts);
    } catch (e) {
      windowErrors.push(`${year}-${month}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (windowErrors.length) console.warn('P&L single-month errors:', windowErrors.join(' | '));

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase
      .from('xero_pl_monthly')
      .upsert(upserts.slice(i, i + 500), { onConflict: 'account_name,year,month' });
    if (error) throw new Error(`xero_pl_monthly upsert failed: ${error.message}`);
  }
  return { rows: upserts.length, windowErrors };
}

// ─── Step: BankTransactions (watched accounts only, If-Modified-Since) ──────

function parseXeroDate(v: string): string | null {
  const s = String(v ?? '');
  // Prefer plain "2026-05-05T00:00:00" (DateString), fall back to /Date(ms)/.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/\/Date\((\d+)/);
  if (!m) return null;
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

async function syncBankTransactions(supabase: any, accessToken: string, tenantId: string): Promise<{ lines: number; pages: number; done: boolean }> {
  // Chart of accounts: resolve the account CODES for the watched names —
  // BankTransactions line items carry AccountCode, not AccountName.
  const accountsBody = await xeroGet('Accounts', accessToken, tenantId);
  const codeToName = new Map<string, string>();
  for (const a of accountsBody?.Accounts ?? []) {
    if (a.Code) codeToName.set(String(a.Code), String(a.Name ?? '').trim());
  }
  const watchedCodes = new Set(
    [...codeToName.entries()].filter(([, name]) => WATCHED_ACCOUNTS.includes(name)).map(([code]) => code),
  );
  if (watchedCodes.size === 0) {
    return { lines: 0, pages: 0, done: true };
  }

  // Incremental: only transactions modified since the last completed walk,
  // resuming from the saved page when a walk spans multiple invocations.
  const { data: stateRow } = await supabase
    .from('xero_sync_state')
    .select('value')
    .eq('key', 'banktx_since')
    .maybeSingle();
  const modifiedSince: string | null = stateRow?.value?.modifiedSince ?? null;
  const startPage: number = stateRow?.value?.nextPage ?? 1;
  const runStartedAt: string = stateRow?.value?.walkStartedAt ?? new Date().toISOString();

  const headers: Record<string, string> = modifiedSince
    ? { 'If-Modified-Since': new Date(modifiedSince).toUTCString() }
    : {};
  const whereDate = `Date >= DateTime(${TRANSACTIONS_SINCE.split('-').map(Number).join(',')})`;

  let stored = 0;
  let page = startPage;
  let done = false;

  for (; page < startPage + MAX_TX_PAGES_PER_RUN; page++) {
    const body = await xeroGet(
      `BankTransactions?where=${encodeURIComponent(whereDate)}&page=${page}`,
      accessToken,
      tenantId,
      headers,
    );
    const txs: any[] = body?.BankTransactions ?? [];
    if (txs.length === 0) {
      done = true;
      break;
    }

    const rows: any[] = [];
    for (const tx of txs) {
      if (tx.Status === 'DELETED' || tx.Status === 'VOIDED') continue;
      const txDate = parseXeroDate(tx.DateString ?? tx.Date);
      const contact = String(tx.Contact?.Name ?? '').trim() || null;
      const currency = String(tx.CurrencyCode ?? 'AUD');
      const rate = tx.CurrencyRate;
      // RECEIVE money against an expense account = refund → negative.
      const sign = String(tx.Type ?? '').startsWith('RECEIVE') ? -1 : 1;
      for (const line of tx.LineItems ?? []) {
        const code = String(line.AccountCode ?? '');
        if (!watchedCodes.has(code)) continue;
        rows.push({
          journal_line_id: line.LineItemID,
          journal_number: null,
          journal_date: txDate,
          account_name: codeToName.get(code),
          contact_name: contact,
          description: line.Description ?? null,
          net_amount: sign * toAUD(line.LineAmount, rate), // stored in AUD
          amount_source: sign * Number(line.LineAmount ?? 0),
          currency,
          source: 'banktx',
        });
      }
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from('xero_account_lines')
        .upsert(rows, { onConflict: 'journal_line_id' });
      if (error) throw new Error(`xero_account_lines upsert failed: ${error.message}`);
      stored += rows.length;
    }

    if (txs.length < 100) {
      done = true;
      break;
    }
  }

  if (done) {
    // Walk finished: next run only needs deltas modified after this walk began.
    await supabase.from('xero_sync_state').upsert({
      key: 'banktx_since',
      value: { modifiedSince: runStartedAt },
      updated_at: new Date().toISOString(),
    });
  } else {
    // Walk incomplete: persist the page cursor so the next invocation resumes
    // instead of re-reading from page 1. Keep the original walk start time so
    // the eventual modifiedSince doesn't miss transactions created mid-walk.
    await supabase.from('xero_sync_state').upsert({
      key: 'banktx_since',
      value: { modifiedSince, nextPage: page, walkStartedAt: runStartedAt },
      updated_at: new Date().toISOString(),
    });
  }

  return { lines: stored, pages: page - startPage, done };
}

// ─── Step: Bills / ACCPAY invoices (watched accounts, by supplier) ──────────
// Freight/inbound costs are booked as supplier bills whose amounts may be in
// USD. The org has tens of thousands of ACCPAY bills, so walking them all to
// find the few hundred watched-account lines is infeasible in the edge
// runtime. Instead we fetch bills ONLY for the suppliers that already appear
// in the watched accounts (from xero_account_lines) — a bounded set — and keep
// their watched-account lines converted to AUD (LineAmount × CurrencyRate).
// A supplier that only ever bills (never a bank txn) and is brand-new would be
// missed until it appears once; acceptable, and the P&L reconciliation anchors
// the totals regardless.

async function fetchDistinctContacts(supabase: any): Promise<string[]> {
  const set = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('xero_account_lines')
      .select('contact_name')
      .in('account_name', WATCHED_ACCOUNTS)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const r of data ?? []) if (r.contact_name) set.add(r.contact_name);
    if (!data || data.length < pageSize) break;
  }
  return [...set];
}

async function syncInvoices(supabase: any, accessToken: string, tenantId: string, contactsOverride?: string[]): Promise<{ lines: number; contacts: any; done: boolean }> {
  const accountsBody = await xeroGet('Accounts', accessToken, tenantId);
  const codeToName = new Map<string, string>();
  for (const a of accountsBody?.Accounts ?? []) {
    if (a.Code) codeToName.set(String(a.Code), String(a.Name ?? '').trim());
  }
  const watchedCodes = new Set(
    [...codeToName.entries()].filter(([, name]) => WATCHED_ACCOUNTS.includes(name)).map(([code]) => code),
  );
  if (watchedCodes.size === 0) return { lines: 0, contacts: 0, done: true };

  const contacts = contactsOverride && contactsOverride.length
    ? contactsOverride
    : (await fetchDistinctContacts(supabase)).sort();
  const sinceArgs = TRANSACTIONS_SINCE.split('-').map(Number).join(',');

  // Process a few suppliers per invocation (cursor) so one invocation stays
  // well under the edge limits; resume from the saved index. An override list
  // (used to re-fetch only specific suppliers, e.g. USD ones) runs in full.
  const { data: stateRow } = await supabase
    .from('xero_sync_state').select('value').eq('key', 'invoices_since').maybeSingle();
  const startIdx: number = contactsOverride ? 0 : (stateRow?.value?.contactIdx ?? 0);
  const BATCH = contactsOverride ? contacts.length : 4;
  const endIdx = Math.min(contacts.length, startIdx + BATCH);
  let stored = 0;

  for (const contact of contacts.slice(startIdx, endIdx)) {
    // Xero where string; escape any embedded double-quotes in the name.
    const safe = contact.replace(/"/g, '\\"');
    const where = `Type=="ACCPAY" AND Contact.Name=="${safe}" AND Date>=DateTime(${sinceArgs})`;
    for (let page = 1; page <= 5; page++) {
      let body: any;
      try {
        body = await xeroGet(`Invoices?where=${encodeURIComponent(where)}&page=${page}`, accessToken, tenantId);
      } catch {
        break; // skip a problematic contact rather than failing the whole run
      }
      const invoices: any[] = body?.Invoices ?? [];
      if (invoices.length === 0) break;

      const rows: any[] = [];
      for (const inv of invoices) {
        if (inv.Status === 'DELETED' || inv.Status === 'VOIDED') continue;
        const invDate = parseXeroDate(inv.DateString ?? inv.Date);
        const cName = String(inv.Contact?.Name ?? '').trim() || null;
        const currency = String(inv.CurrencyCode ?? 'AUD');
        const rate = inv.CurrencyRate;
        for (const line of inv.LineItems ?? []) {
          const code = String(line.AccountCode ?? '');
          if (!watchedCodes.has(code)) continue;
          rows.push({
            journal_line_id: line.LineItemID,
            journal_number: null,
            journal_date: invDate,
            account_name: codeToName.get(code),
            contact_name: cName,
            description: line.Description ?? null,
            net_amount: toAUD(line.LineAmount, rate), // AUD
            amount_source: Number(line.LineAmount ?? 0),
            currency,
            source: 'invoice',
          });
        }
      }
      if (rows.length > 0) {
        const { error } = await supabase.from('xero_account_lines').upsert(rows, { onConflict: 'journal_line_id' });
        if (error) throw new Error(`xero_account_lines (invoices) upsert failed: ${error.message}`);
        stored += rows.length;
      }
      if (invoices.length < 100) break;
    }
  }

  const done = endIdx >= contacts.length;
  if (!contactsOverride) {
    await supabase.from('xero_sync_state').upsert({
      key: 'invoices_since',
      value: done ? { modifiedSince: new Date().toISOString(), contactIdx: 0 } : { contactIdx: endIdx },
      updated_at: new Date().toISOString(),
    });
  }
  return { lines: stored, contacts: `${startIdx}-${endIdx}/${contacts.length}`, done };
}

// ─── Step: incremental detail (forward-only append past the CSV boundary) ───
// The closed FY (≤ boundary, default 2026-06-30) is owned by the uploaded
// Account Transactions CSV. This step keeps the CURRENT FY current with tiny
// daily deltas: it fetches only watched-account lines that (a) were MODIFIED
// since the last run (If-Modified-Since watermark) AND (b) have a transaction
// date AFTER the boundary — so it never touches the CSV's domain and can't
// duplicate. Amounts converted to AUD (LineAmount / CurrencyRate). Upsert by
// the real Xero LineItemID. Because the window is post-boundary + modified-
// since, the volume stays small regardless of the org's full history — this is
// what makes it safe where the 2-year backfill was not.
async function syncDetailIncremental(supabase: any, accessToken: string, tenantId: string): Promise<any> {
  const accountsBody = await xeroGet('Accounts', accessToken, tenantId);
  const codeToName = new Map<string, string>();
  for (const a of accountsBody?.Accounts ?? []) if (a.Code) codeToName.set(String(a.Code), String(a.Name ?? '').trim());
  const watchedCodes = new Set([...codeToName.entries()].filter(([, n]) => WATCHED_ACCOUNTS.includes(n)).map(([c]) => c));
  if (watchedCodes.size === 0) return { lines: 0, done: true };

  const { data: st } = await supabase.from('xero_sync_state').select('value').eq('key', 'detail_incremental').maybeSingle();
  const boundary: string = st?.value?.boundary ?? '2026-06-30';       // CSV covers through here
  const since: string = st?.value?.since ?? `${boundary}T00:00:00Z`;   // modified-since watermark
  const runStart = new Date().toISOString();
  const boundaryDay = boundary; // 'YYYY-MM-DD' string compare is safe for dates
  const fromArgs = boundary.split('-').map(Number); // [y,m,d]
  const dateWhere = `Date>DateTime(${fromArgs[0]},${fromArgs[1]},${fromArgs[2]})`;
  const modHeader = { 'If-Modified-Since': new Date(since).toUTCString() };

  const rows: any[] = [];

  // Bank transactions (Spend/Receive Money) modified since watermark, post-boundary.
  for (let page = 1; page <= 2; page++) {
    const body = await xeroGet(`BankTransactions?where=${encodeURIComponent(dateWhere)}&page=${page}`, accessToken, tenantId, modHeader);
    const txs: any[] = body?.BankTransactions ?? [];
    if (txs.length === 0) break;
    for (const tx of txs) {
      if (tx.Status === 'DELETED' || tx.Status === 'VOIDED') continue;
      const d = parseXeroDate(tx.DateString ?? tx.Date);
      if (!d || d <= boundaryDay) continue;
      const contact = String(tx.Contact?.Name ?? '').trim() || null;
      const sign = String(tx.Type ?? '').startsWith('RECEIVE') ? -1 : 1;
      for (const line of tx.LineItems ?? []) {
        const code = String(line.AccountCode ?? '');
        if (!watchedCodes.has(code)) continue;
        rows.push({
          journal_line_id: line.LineItemID, journal_number: null, journal_date: d,
          account_name: codeToName.get(code), contact_name: contact, description: line.Description ?? null,
          reference: tx.Reference ?? null, net_amount: sign * toAUD(line.LineAmount, tx.CurrencyRate),
          amount_source: sign * Number(line.LineAmount ?? 0), currency: String(tx.CurrencyCode ?? 'AUD'), source: 'api',
        });
      }
    }
    if (txs.length < 100) break;
  }

  // ACCPAY invoices (bills) modified since watermark, post-boundary.
  for (let page = 1; page <= 2; page++) {
    const body = await xeroGet(`Invoices?where=${encodeURIComponent(`Type=="ACCPAY" AND ${dateWhere}`)}&page=${page}`, accessToken, tenantId, modHeader);
    const invs: any[] = body?.Invoices ?? [];
    if (invs.length === 0) break;
    for (const inv of invs) {
      if (inv.Status === 'DELETED' || inv.Status === 'VOIDED') continue;
      const d = parseXeroDate(inv.DateString ?? inv.Date);
      if (!d || d <= boundaryDay) continue;
      const contact = String(inv.Contact?.Name ?? '').trim() || null;
      for (const line of inv.LineItems ?? []) {
        const code = String(line.AccountCode ?? '');
        if (!watchedCodes.has(code)) continue;
        rows.push({
          journal_line_id: line.LineItemID, journal_number: null, journal_date: d,
          account_name: codeToName.get(code), contact_name: contact, description: line.Description ?? null,
          reference: inv.InvoiceNumber ?? null, net_amount: toAUD(line.LineAmount, inv.CurrencyRate),
          amount_source: Number(line.LineAmount ?? 0), currency: String(inv.CurrencyCode ?? 'AUD'), source: 'api',
        });
      }
    }
    if (invs.length < 100) break;
  }

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('xero_account_lines').upsert(rows.slice(i, i + 500), { onConflict: 'journal_line_id' });
      if (error) throw new Error(`incremental upsert failed: ${error.message}`);
    }
  }

  await supabase.from('xero_sync_state').upsert({
    key: 'detail_incremental',
    value: { boundary, since: runStart },
    updated_at: new Date().toISOString(),
  });
  return { lines: rows.length, boundary, since, done: true };
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

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const step = body?.step ?? 'all';

    const result: Record<string, unknown> = { success: true, step };

    try {
      const { accessToken, tenantId } = await getAccessToken(supabase);

      // 'all' (the daily cron) = P&L totals + incremental detail. The old
      // full-history walks ('transactions'/'invoices') stay callable manually
      // but are NOT in 'all' — the CSV owns the closed-FY backfill.
      if (step === 'pl' || step === 'all') {
        result.pl = await syncProfitAndLoss(supabase, accessToken, tenantId);
      }
      if (step === 'detail' || step === 'all') {
        result.detail = await syncDetailIncremental(supabase, accessToken, tenantId);
      }
      if (step === 'transactions') {
        result.transactions = await syncBankTransactions(supabase, accessToken, tenantId);
      }
      if (step === 'invoices') {
        result.invoices = await syncInvoices(supabase, accessToken, tenantId, body?.contacts);
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

    // Record success for the Connections panel.
    await supabase.from('xero_sync_state').upsert({
      key: 'last_sync',
      value: { at: new Date().toISOString(), ok: true, step, summary: result },
      updated_at: new Date().toISOString(),
    });

    return json(result);
  } catch (e) {
    console.error('xero-sync error:', e);
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
