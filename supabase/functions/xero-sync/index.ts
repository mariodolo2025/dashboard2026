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

async function xeroGet(path: string, accessToken: string, tenantId: string, extraHeaders: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
      ...extraHeaders,
    },
  });
  if (res.status === 429) {
    // Basic backoff on rate limit, single retry.
    const wait = Number(res.headers.get('Retry-After') ?? 2);
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    return xeroGet(path, accessToken, tenantId, extraHeaders);
  }
  if (!res.ok) {
    throw new Error(`Xero GET ${path.split('?')[0]} failed: HTTP ${res.status}`);
  }
  return res.json();
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

  // Xero caps monthly P&L at 12 columns per call. Fetch two 12-month windows
  // so the closed FY (Jul–Jun) has every month AND the current partial month
  // is present: window A ends at the current month, window B ends at the last
  // completed June (FY close). Each is best-effort — if one 400s (e.g. no data
  // that far back) we keep the other rather than failing the whole sync.
  const upserts: any[] = [];
  const fyEndYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // FY ends 30 Jun
  const windows = [
    new Date(now.getFullYear(), now.getMonth() + 1, 0), // end of this month
    new Date(fyEndYear, 6, 0),                          // 30 Jun of the last closed FY
  ];
  let ok = 0;
  for (const toDate of windows) {
    try {
      const report = await xeroGet(
        `Reports/ProfitAndLoss?toDate=${fmt(toDate)}&periods=11&timeframe=MONTH&standardLayout=true`,
        accessToken,
        tenantId,
      );
      const rep = report?.Reports?.[0];
      if (rep) { collect(rep, upserts); ok++; }
    } catch (e) {
      console.warn(`P&L window ${fmt(toDate)} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (ok === 0) throw new Error('All P&L windows failed');

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase
      .from('xero_pl_monthly')
      .upsert(upserts.slice(i, i + 500), { onConflict: 'account_name,year,month' });
    if (error) throw new Error(`xero_pl_monthly upsert failed: ${error.message}`);
  }
  return upserts.length;
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
          net_amount: sign * Number(line.LineAmount ?? 0),
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

// ─── Step: Bills / ACCPAY invoices (watched accounts, line descriptions) ────
// Freight & inbound costs are largely booked as supplier bills (Payable
// Invoices), whose LINE DESCRIPTION carries the real category ("Diamond
// Freight Services - freight", "DHL - International Freight", ...). Bank
// transactions can't provide this (their lines are description-less), so we
// pull ACCPAY invoices and keep the watched-account lines with their text.

async function syncInvoices(supabase: any, accessToken: string, tenantId: string): Promise<{ lines: number; pages: number; done: boolean }> {
  const accountsBody = await xeroGet('Accounts', accessToken, tenantId);
  const codeToName = new Map<string, string>();
  for (const a of accountsBody?.Accounts ?? []) {
    if (a.Code) codeToName.set(String(a.Code), String(a.Name ?? '').trim());
  }
  const watchedCodes = new Set(
    [...codeToName.entries()].filter(([, name]) => WATCHED_ACCOUNTS.includes(name)).map(([code]) => code),
  );
  if (watchedCodes.size === 0) return { lines: 0, pages: 0, done: true };

  const { data: stateRow } = await supabase
    .from('xero_sync_state')
    .select('value')
    .eq('key', 'invoices_since')
    .maybeSingle();
  const modifiedSince: string | null = stateRow?.value?.modifiedSince ?? null;
  const startPage: number = stateRow?.value?.nextPage ?? 1;
  const runStartedAt: string = stateRow?.value?.walkStartedAt ?? new Date().toISOString();

  const headers: Record<string, string> = modifiedSince ? { 'If-Modified-Since': new Date(modifiedSince).toUTCString() } : {};
  const where = `Type=="ACCPAY" AND Date>=DateTime(${TRANSACTIONS_SINCE.split('-').map(Number).join(',')})`;

  let stored = 0;
  let page = startPage;
  let done = false;

  for (; page < startPage + MAX_TX_PAGES_PER_RUN; page++) {
    const body = await xeroGet(`Invoices?where=${encodeURIComponent(where)}&page=${page}`, accessToken, tenantId, headers);
    const invoices: any[] = body?.Invoices ?? [];
    if (invoices.length === 0) { done = true; break; }

    const rows: any[] = [];
    for (const inv of invoices) {
      if (inv.Status === 'DELETED' || inv.Status === 'VOIDED') continue;
      const invDate = parseXeroDate(inv.DateString ?? inv.Date);
      const contact = String(inv.Contact?.Name ?? '').trim() || null;
      // ACCPAY credit note comes back as Type=ACCPAYCREDIT via a different
      // endpoint; standard ACCPAY line amounts are positive expenses.
      for (const line of inv.LineItems ?? []) {
        const code = String(line.AccountCode ?? '');
        if (!watchedCodes.has(code)) continue;
        rows.push({
          journal_line_id: line.LineItemID,
          journal_number: null,
          journal_date: invDate,
          account_name: codeToName.get(code),
          contact_name: contact,
          description: line.Description ?? null,
          net_amount: Number(line.LineAmount ?? 0),
          source: 'invoice',
        });
      }
    }

    if (rows.length > 0) {
      const { error } = await supabase.from('xero_account_lines').upsert(rows, { onConflict: 'journal_line_id' });
      if (error) throw new Error(`xero_account_lines (invoices) upsert failed: ${error.message}`);
      stored += rows.length;
    }

    if (invoices.length < 100) { done = true; break; }
  }

  await supabase.from('xero_sync_state').upsert({
    key: 'invoices_since',
    value: done ? { modifiedSince: runStartedAt } : { modifiedSince, nextPage: page, walkStartedAt: runStartedAt },
    updated_at: new Date().toISOString(),
  });

  return { lines: stored, pages: page - startPage, done };
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

      if (step === 'pl' || step === 'all') {
        result.plRows = await syncProfitAndLoss(supabase, accessToken, tenantId);
      }
      if (step === 'transactions' || step === 'all') {
        result.transactions = await syncBankTransactions(supabase, accessToken, tenantId);
      }
      if (step === 'invoices' || step === 'all') {
        result.invoices = await syncInvoices(supabase, accessToken, tenantId);
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
