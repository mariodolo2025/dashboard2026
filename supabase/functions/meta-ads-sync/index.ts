// Meta ads sync (DB-first). Pulls daily account-level insights (spend +
// "omni_purchase" conversion value + account currency) for every ad account in
// api_credentials(provider='meta') and stores them per (date, account) in native
// currency. meta-export-csv then rebuilds the dashboard's Meta CSV from this table.
//
// Modes:
//   {}                    -> incremental: re-pull the trailing LOOKBACK_DAYS window
//                            (Meta revises purchase-conversion values for weeks as
//                            attribution windows close, so a fixed trailing window is
//                            delete+reinserted every run — idempotent, no drift).
//   {since,until}         -> backfill an explicit range (history load).
// Probe (meta-probe) confirmed omni_purchase == the manual CSV's "Purchases
// conversion value" to the cent for June 2026, both accounts.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const V = 'v25.0';
const LOOKBACK_DAYS = 30;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return isNaN(n) ? 0 : n; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const body = await req.json().catch(() => ({}));
    const today = new Date();
    const until: string = body.until ?? ymd(today);
    const since: string = body.since ?? ymd(new Date(today.getTime() - LOOKBACK_DAYS * 86400000));
    if (since > until) return json({ error: 'since > until' }, 400);

    const { data: creds } = await supabase.from('api_credentials').select('ad_account_ids, access_token').eq('provider', 'meta').maybeSingle();
    if (!creds?.access_token || !creds?.ad_account_ids) throw new Error('Meta credentials not configured');
    const token = creds.access_token as string;
    const accounts = String(creds.ad_account_ids).split(',').map((s) => s.trim()).filter(Boolean);

    // date -> { account -> {currency, spend, conversion_value, funnel...} }
    type Row = { date: string; account_id: string; currency: string; spend: number; conversion_value: number; impressions: number; clicks: number; view_content: number; add_to_cart: number; initiate_checkout: number; purchases: number };
    const rows: Array<Row> = [];
    const perAccount: Record<string, { pages: number; days: number; err: string | null }> = {};

    for (const acct of accounts) {
      let pages = 0, days = 0, err: string | null = null;
      let next: string | null = `https://graph.facebook.com/${V}/${acct}/insights?` + new URLSearchParams({
        access_token: token, level: 'account', time_increment: '1',
        time_range: JSON.stringify({ since, until }),
        fields: 'spend,impressions,clicks,account_currency,actions,action_values', limit: '500',
      });
      while (next && pages < 40) {
        const r = await fetch(next, { signal: AbortSignal.timeout(25000) });
        if (!r.ok) { err = `${r.status}: ${(await r.text()).slice(0, 200)}`; break; }
        const j = await r.json();
        for (const row of (j.data || [])) {
          const date = String(row.date_start || '').slice(0, 10);
          if (!date) continue;
          const currency = row.account_currency || 'USD';
          const spend = num(row.spend);
          // Account-level insights with no attribution-window breakdown return a
          // single omni_* entry per action type (probe matched the manual CSV to the
          // cent); last-wins is exact here. Don't sum — multiple entries double-count.
          let conv = 0, purchases = 0, atc = 0, ic = 0, vc = 0;
          for (const av of (row.action_values || [])) if (av.action_type === 'omni_purchase') conv = num(av.value);
          for (const a of (row.actions || [])) {
            if (a.action_type === 'omni_purchase') purchases = num(a.value);
            else if (a.action_type === 'omni_add_to_cart') atc = num(a.value);
            else if (a.action_type === 'omni_initiated_checkout' || a.action_type === 'omni_initiate_checkout') ic = num(a.value);
            else if (a.action_type === 'omni_view_content') vc = num(a.value);
          }
          rows.push({ date, account_id: acct, currency, spend: r2(spend), conversion_value: r2(conv),
            impressions: Math.round(num(row.impressions)), clicks: Math.round(num(row.clicks)),
            view_content: Math.round(vc), add_to_cart: Math.round(atc), initiate_checkout: Math.round(ic), purchases: Math.round(purchases) });
          days++;
        }
        next = j.paging?.next ?? null; pages++;
      }
      // Stopped by the page cap while more pages remained -> truncated; flag as an
      // error so this account is treated as failed (never partially "committed").
      if (next && !err) err = `pagination cap hit at ${pages} pages (truncated)`;
      perAccount[acct] = { pages, days, err };
    }

    const failed = Object.entries(perAccount).filter(([, a]) => a.err).map(([acct, a]) => `${acct}: ${a.err}`);
    const partialErr = failed.length ? failed.join('; ') : null;
    // Nothing usable AND something errored -> preserve existing data, surface error.
    if (rows.length === 0 && partialErr) throw new Error(partialErr);

    // UPSERT, never delete. Past days' spend is final in Meta; re-pulls only revise
    // conversion attribution, which upsert overwrites in place. So a failed or
    // partially-paginated account never wipes its previously-synced window — the
    // old rows simply aren't touched. (Delete-by-window could erase a healthy
    // account's data when another account failed mid-run — data-loss bug.)
    for (let i = 0; i < rows.length; i += 500) {
      const { error: upErr } = await supabase.from('meta_ads_daily').upsert(rows.slice(i, i + 500), { onConflict: 'date,account_id' });
      if (upErr) throw new Error(`upsert: ${upErr.message}`);
    }

    const { count } = await supabase.from('meta_ads_daily').select('*', { count: 'exact', head: true });
    await supabase.from('meta_ads_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: partialErr ? `partial: ${partialErr}` : 'ok', rows_live: count ?? null });

    // success:false on ANY account error so the orchestrator flags the run (its step
    // gate reads payload.success). Healthy accounts were still committed safely.
    return json({ ok: true, success: !partialErr, since, until, upserted: rows.length, rows_live: count, perAccount, partialError: partialErr });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from('meta_ads_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: `error: ${msg}` });
    return json({ error: msg }, 500);
  }
});
