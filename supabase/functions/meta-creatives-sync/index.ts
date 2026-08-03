// Meta creatives sync (DB-first, per ad per day).
//
// Why this exists: ecommerce_meta_daily_ads stopped updating on 2026-05-12. The
// only writer was ecommerce-sync-meta, which requires an admin user's JWT and so
// only ever runs when someone presses a button in the UI. meta_ads_daily kept
// flowing because meta-ads-sync runs unattended from the orchestrator — but that
// one is ACCOUNT level, so "which creative is working" was unanswerable for
// nearly three months.
//
// This function is the ad-level twin of meta-ads-sync: service-role only, no
// user session, safe to run from the orchestrator.
//
// Modes:
//   {}                 -> incremental: re-pull the trailing LOOKBACK_DAYS window.
//   {since, until}     -> backfill an explicit range (history load).
//   {days: N}          -> trailing N days.
//
// The window is DELETED and re-inserted on every run rather than upserted alone.
// Meta keeps revising purchase values for weeks as attribution windows close,
// and an ad that stops spending must disappear from the window rather than keep
// its stale row — an upsert alone would leave it there for ever.

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const V = 'v25.0';
const LOOKBACK_DAYS = 30;
const MAX_PAGES = 400; // backstop; at limit=500 this is far more than a month holds

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const num = (v: unknown) => { const n = parseFloat(String(v ?? '')); return isNaN(n) ? 0 : n; };
const int = (v: unknown) => { const n = parseInt(String(v ?? ''), 10); return isNaN(n) ? 0 : n; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// EXACTLY 'omni_purchase', matching meta-ads-sync, whose probe confirmed it
// equals the manual CSV's "Purchases conversion value" to the cent.
//
// The retired ecommerce-sync-meta summed every action_type CONTAINING
// "purchase". Meta returns several overlapping types per row — omni_purchase,
// offsite_conversion.fb_pixel_purchase, web_in_store_purchase and others — so
// that filter counted the same sale two or three times. It produced ad-level
// ROAS around 10-16x against an account ROAS of 1.9x, which is how the error
// gave itself away. Anything but an exact match here silently inflates revenue.

type AdRow = {
  date: string; account_id: string; ad_id: string; ad_name: string; campaign_name: string | null;
  spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });

  const started = Date.now();
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const errors: string[] = [];

  try {
    const body = await req.json().catch(() => ({}));
    const today = new Date();
    const days = int(body.days) || LOOKBACK_DAYS;
    const until: string = body.until ?? ymd(today);
    const since: string = body.since ?? ymd(new Date(today.getTime() - days * 86400000));
    if (since > until) return json({ error: 'since > until' }, 400);

    const { data: creds } = await supabase
      .from('api_credentials')
      .select('ad_account_ids, access_token')
      .eq('provider', 'meta')
      .maybeSingle();
    if (!creds?.access_token || !creds?.ad_account_ids) throw new Error('Meta credentials not configured');

    const token = creds.access_token as string;
    const accounts = String(creds.ad_account_ids).split(',').map((s) => s.trim()).filter(Boolean);

    const rows: AdRow[] = [];
    const perAccount: Record<string, { pages: number; rows: number; err: string | null }> = {};

    for (const acct of accounts) {
      let pages = 0, got = 0, err: string | null = null;
      let next: string | null = `https://graph.facebook.com/${V}/${acct}/insights?` + new URLSearchParams({
        access_token: token,
        level: 'ad',
        fields: 'ad_id,ad_name,campaign_name,spend,impressions,clicks,actions,action_values',
        time_range: JSON.stringify({ since, until }),
        time_increment: '1',
        limit: '500',
      });

      while (next && pages < MAX_PAGES) {
        const res = await fetch(next, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) {
          const raw = await res.text();
          let msg = raw.slice(0, 200);
          try { msg = JSON.parse(raw)?.error?.message ?? msg; } catch { /* keep raw */ }
          err = `${res.status} — ${msg}`;
          break;
        }
        const data = await res.json();
        pages++;

        for (const a of data.data ?? []) {
          const spend = num(a.spend);
          // No spend means the ad did not run that day. Storing those rows would
          // multiply the table by every paused ad in the account for no signal.
          if (spend <= 0) continue;
          const date = String(a.date_start ?? '').slice(0, 10);
          if (!date) continue;

          let purchases = 0, purchaseValue = 0;
          for (const act of a.actions ?? []) if (act.action_type === 'omni_purchase') purchases = int(act.value);
          for (const av of a.action_values ?? []) if (av.action_type === 'omni_purchase') purchaseValue = num(av.value);

          rows.push({
            date,
            account_id: acct,
            ad_id: String(a.ad_id ?? ''),
            ad_name: String(a.ad_name ?? 'Unnamed'),
            campaign_name: a.campaign_name ? String(a.campaign_name) : null,
            spend: r2(spend),
            impressions: int(a.impressions),
            clicks: int(a.clicks),
            purchases,
            purchase_value: r2(purchaseValue),
          });
          got++;
        }
        next = data.paging?.next ?? null;
      }

      if (pages >= MAX_PAGES && next) {
        err = `stopped at ${MAX_PAGES} pages with more to fetch — narrow the range`;
      }
      if (err) errors.push(`${acct}: ${err}`);
      perAccount[acct] = { pages, rows: got, err };
    }

    // Only rewrite the window if the pull succeeded for every account. A partial
    // pull that deleted first would leave a hole in the table and look like the
    // ads simply stopped running.
    let written = 0;
    if (errors.length === 0 && rows.length > 0) {
      const { error: delErr } = await supabase
        .from('ecommerce_meta_daily_ads')
        .delete().gte('date', since).lte('date', until);
      if (delErr) throw new Error(`delete window: ${delErr.message}`);

      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabase
          .from('ecommerce_meta_daily_ads')
          .upsert(chunk, { onConflict: 'date,account_id,ad_id' });
        if (error) throw new Error(`insert chunk ${i}: ${error.message}`);
        written += chunk.length;
      }
    }

    return json({
      success: errors.length === 0,
      since, until,
      accounts: perAccount,
      rowsFetched: rows.length,
      rowsWritten: written,
      skippedWriteBecauseOfErrors: errors.length > 0,
      errors,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : String(e), errors, durationMs: Date.now() - started }, 500);
  }
});
