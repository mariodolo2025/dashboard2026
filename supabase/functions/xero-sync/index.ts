// =============================================================================
// Xero API sync — pulls accounting data into Supabase tables.
//
// Steps (POST body { step?: "pl" | "journals" | "all" }, default "all"):
//   pl        → Reports/ProfitAndLoss by account × month (rolling 12 months)
//               → upserts xero_pl_monthly. 1:1 replacement for the manual
//               "Profit and Loss Mario" xlsx.
//   journals  → walks the Journals endpoint incrementally (offset cursor in
//               xero_sync_state) and stores lines for WATCHED_ACCOUNTS only
//               (accounts that need transaction-level breakdown, e.g.
//               "Rates & Taxes") → xero_account_lines.
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

/** Accounts whose journal lines we persist for breakdown rules. */
const WATCHED_ACCOUNTS = ['Rates & Taxes'];

/** Max journal pages (100 journals each) per invocation — the first full walk
 *  resumes across runs via the cursor instead of hitting edge CPU limits. */
const MAX_JOURNAL_PAGES_PER_RUN = 60;

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

async function xeroGet(path: string, accessToken: string, tenantId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept': 'application/json',
    },
  });
  if (res.status === 429) {
    // Basic backoff on rate limit, single retry.
    const wait = Number(res.headers.get('Retry-After') ?? 2);
    await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
    return xeroGet(path, accessToken, tenantId);
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
  // Rolling 12 months ending this month.
  const now = new Date();
  const toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const report = await xeroGet(
    `Reports/ProfitAndLoss?toDate=${fmt(toDate)}&periods=11&timeframe=MONTH&standardLayout=true`,
    accessToken,
    tenantId,
  );

  const rep = report?.Reports?.[0];
  if (!rep) throw new Error('Unexpected P&L response shape');

  // Header row gives the period end date per column (col 0 is the row title).
  const headerRow = rep.Rows?.find((r: any) => r.RowType === 'Header');
  const periods: ({ year: number; month: number } | null)[] = (headerRow?.Cells ?? [])
    .map((c: any) => parseHeaderCell(String(c?.Value ?? '')));

  const upserts: any[] = [];
  const walk = (rows: any[]) => {
    for (const row of rows ?? []) {
      if (row.RowType === 'Section') {
        walk(row.Rows);
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
          synced_at: new Date().toISOString(),
        });
      }
    }
  };
  walk(rep.Rows);

  for (let i = 0; i < upserts.length; i += 500) {
    const { error } = await supabase
      .from('xero_pl_monthly')
      .upsert(upserts.slice(i, i + 500), { onConflict: 'account_name,year,month' });
    if (error) throw new Error(`xero_pl_monthly upsert failed: ${error.message}`);
  }
  return upserts.length;
}

// ─── Step: Journals (incremental cursor, watched accounts only) ─────────────

function parseXeroDate(v: string): string | null {
  // "/Date(1783295311986+0000)/" → ISO date
  const m = String(v ?? '').match(/\/Date\((\d+)/);
  if (!m) return null;
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}

async function syncJournals(supabase: any, accessToken: string, tenantId: string): Promise<{ lines: number; cursor: number; done: boolean }> {
  const { data: stateRow } = await supabase
    .from('xero_sync_state')
    .select('value')
    .eq('key', 'journals_cursor')
    .maybeSingle();
  let offset: number = stateRow?.value?.offset ?? 0;

  let stored = 0;
  let done = false;

  for (let page = 0; page < MAX_JOURNAL_PAGES_PER_RUN; page++) {
    const body = await xeroGet(`Journals?offset=${offset}`, accessToken, tenantId);
    const journals: any[] = body?.Journals ?? [];
    if (journals.length === 0) {
      done = true;
      break;
    }

    const rows: any[] = [];
    for (const j of journals) {
      const jDate = parseXeroDate(j.JournalDate);
      for (const line of j.JournalLines ?? []) {
        const account = String(line.AccountName ?? '').trim();
        if (!WATCHED_ACCOUNTS.includes(account)) continue;
        rows.push({
          journal_line_id: line.JournalLineID,
          journal_number: j.JournalNumber,
          journal_date: jDate,
          account_name: account,
          description: line.Description ?? null,
          net_amount: Number(line.NetAmount ?? 0),
        });
      }
      offset = Math.max(offset, Number(j.JournalNumber ?? offset));
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from('xero_account_lines')
        .upsert(rows, { onConflict: 'journal_line_id' });
      if (error) throw new Error(`xero_account_lines upsert failed: ${error.message}`);
      stored += rows.length;
    }

    if (journals.length < 100) {
      done = true;
      break;
    }
  }

  await supabase.from('xero_sync_state').upsert({
    key: 'journals_cursor',
    value: { offset },
    updated_at: new Date().toISOString(),
  });

  return { lines: stored, cursor: offset, done };
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

    const { accessToken, tenantId } = await getAccessToken(supabase);

    const result: Record<string, unknown> = { success: true, step };

    if (step === 'pl' || step === 'all') {
      result.plRows = await syncProfitAndLoss(supabase, accessToken, tenantId);
    }
    if (step === 'journals' || step === 'all') {
      result.journals = await syncJournals(supabase, accessToken, tenantId);
    }

    return json(result);
  } catch (e) {
    console.error('xero-sync error:', e);
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
