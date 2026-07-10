// =============================================================================
// FX rates sync — keeps currency_exchange_rates (monthly USD→AUD) current so the
// dashboard's USD→AUD conversion (and the Shopify sync's AUD→USD) uses real market
// rates instead of the 1.54 fallback.
//
// Source: frankfurter.dev (ECB data, free, no key). rate = AUD per 1 USD, matching
// the table's convention. Always refreshes the current month; backfills any missing
// recent months (mid-month rate as the monthly proxy).
//
//   POST {}                → refresh current month + backfill missing (last 18 mo)
//   POST { months: 24 }    → widen the backfill window
// Service-role only.
// =============================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const pad = (n: number) => String(n).padStart(2, '0');

async function fetchRate(dateOrLatest: string): Promise<number | null> {
  const url = `https://api.frankfurter.dev/v1/${dateOrLatest}?base=USD&symbols=AUD`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const rate = j?.rates?.AUD;
    return typeof rate === 'number' && rate > 0 ? rate : null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const backfillMonths = Number.isInteger(body?.months) ? body.months : 18;

    const now = new Date();
    const curY = now.getUTCFullYear(), curM = now.getUTCMonth() + 1;

    const { data: existing } = await supabase.from('currency_exchange_rates').select('year, month');
    const have = new Set((existing ?? []).map((r: any) => `${r.year}-${r.month}`));

    // Targets: ONLY months not already stored (current + missing past). A month's
    // rate is IMMUTABLE once set — the Shopify sync bakes *_usd at that rate, so
    // overwriting it later would desync stored amounts from the view's conversion.
    const targets: { y: number; m: number; latest: boolean }[] = [];
    if (!have.has(`${curY}-${curM}`)) targets.push({ y: curY, m: curM, latest: true });
    for (let i = 1; i <= backfillMonths; i++) {
      const d = new Date(Date.UTC(curY, curM - 1 - i, 1));
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
      if (!have.has(`${y}-${m}`)) targets.push({ y, m, latest: false });
    }

    const updated: any[] = [];
    const failed: string[] = [];
    for (const t of targets) {
      const rate = await fetchRate(t.latest ? 'latest' : `${t.y}-${pad(t.m)}-15`);
      if (rate == null) { failed.push(`${t.y}-${pad(t.m)}`); continue; }
      // insert-only: never overwrite an existing month.
      const { error } = await supabase.from('currency_exchange_rates').upsert({ year: t.y, month: t.m, rate }, { onConflict: 'year,month', ignoreDuplicates: true });
      if (error) { failed.push(`${t.y}-${pad(t.m)}:${error.message}`); continue; }
      updated.push({ month: `${t.y}-${pad(t.m)}`, rate });
    }

    return json({ success: failed.length === 0, updatedCount: updated.length, updated, failed });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
