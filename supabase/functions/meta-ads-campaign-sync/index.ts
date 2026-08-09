// Meta ads campaign sync (Advertising Bloque 2 — DB-first, mirrors
// meta-ads-sync at level=campaign). Native currency per row; omni_purchase
// last-wins (probe-verified convention); UPSERT never delete; per-account
// error isolation; success:false on any account error so the orchestrator
// flags the step while healthy accounts stay committed.
//
//   {}              -> incremental: trailing LOOKBACK_DAYS re-pull (attribution revisions)
//   {since, until}  -> backfill an explicit range
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

    type Row = { date: string; account_id: string; campaign_id: string; campaign_name: string | null; currency: string; spend: number; claimed_purchases: number; claimed_value: number };
    const rows: Row[] = [];
    const perAccount: Record<string, { pages: number; rows: number; err: string | null }> = {};

    for (const acct of accounts) {
      let pages = 0, count = 0, err: string | null = null;
      let next: string | null = `https://graph.facebook.com/${V}/${acct}/insights?` + new URLSearchParams({
        access_token: token, level: 'campaign', time_increment: '1',
        time_range: JSON.stringify({ since, until }),
        fields: 'campaign_id,campaign_name,spend,account_currency,actions,action_values', limit: '500',
      });
      while (next && pages < 40) {
        const r = await fetch(next, { signal: AbortSignal.timeout(25000) });
        if (!r.ok) { err = `${r.status}: ${(await r.text()).slice(0, 200)}`; break; }
        const j = await r.json();
        for (const row of (j.data || [])) {
          const date = String(row.date_start || '').slice(0, 10);
          const cid = String(row.campaign_id || '');
          if (!date || !cid) continue;
          // Same convention as the account-level sync: single omni_* entry per
          // action type when no attribution breakdown is requested — last wins,
          // never sum (summing double-counts).
          let value = 0, purchases = 0;
          for (const av of (row.action_values || [])) if (av.action_type === 'omni_purchase') value = num(av.value);
          for (const a of (row.actions || [])) if (a.action_type === 'omni_purchase') purchases = num(a.value);
          rows.push({
            date, account_id: acct, campaign_id: cid,
            campaign_name: row.campaign_name ?? null,
            currency: row.account_currency || 'USD',
            spend: r2(num(row.spend)), claimed_purchases: Math.round(purchases), claimed_value: r2(value),
          });
          count++;
        }
        next = j.paging?.next ?? null; pages++;
      }
      if (next && !err) err = `pagination cap hit at ${pages} pages (truncated)`;
      perAccount[acct] = { pages, rows: count, err };
    }

    const failed = Object.entries(perAccount).filter(([, a]) => a.err).map(([acct, a]) => `${acct}: ${a.err}`);
    const partialErr = failed.length ? failed.join('; ') : null;
    if (rows.length === 0 && partialErr) throw new Error(partialErr);

    // UPSERT, never delete — same reasoning as meta-ads-sync: spend is final,
    // re-pulls only revise attribution, and a failed account must never wipe
    // a healthy account's window.
    for (let i = 0; i < rows.length; i += 500) {
      const { error: upErr } = await supabase.from('meta_ads_campaign_daily').upsert(rows.slice(i, i + 500), { onConflict: 'date,account_id,campaign_id' });
      if (upErr) throw new Error(`upsert: ${upErr.message}`);
    }

    const { count } = await supabase.from('meta_ads_campaign_daily').select('*', { count: 'exact', head: true });
    await supabase.from('meta_ads_campaign_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: partialErr ? `partial: ${partialErr}` : 'ok', rows_total: count ?? null });

    return json({ ok: true, success: !partialErr, since, until, upserted: rows.length, rows_total: count, perAccount, partialError: partialErr });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase.from('meta_ads_campaign_sync_state').upsert({ id: 1, last_run_at: new Date().toISOString(), last_run_status: `error: ${msg}` });
    return json({ error: msg }, 500);
  }
});
