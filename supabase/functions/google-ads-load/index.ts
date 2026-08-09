// Google Ads manual/CSV load (Advertising Bloque 2). The ONLY write path into
// google_ads_daily until the Google Ads API token arrives. Validates hard:
// closed campaign enum, YYYY-MM-DD dates, non-negative numbers. Upsert by
// (date, campaign); missing days are simply absent (motor renders MER null).
//
//   POST { actor: 'juan', rows: [{ date, campaign, spend_aud,
//          claimed_conversions?, claimed_value_aud? }] }
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const CAMPAIGNS = ['brand-search', 'non-brand', 'shopping'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const actor = typeof body?.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 40) : null;
    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!actor) return json({ success: false, message: 'actor is required' }, 400);
    if (!rows?.length) return json({ success: false, message: 'rows[] is required' }, 400);
    if (rows.length > 500) return json({ success: false, message: 'max 500 rows per call' }, 400);

    const clean: any[] = [];
    const errors: string[] = [];
    rows.forEach((r: any, i: number) => {
      const date = String(r?.date ?? '');
      const campaign = String(r?.campaign ?? '');
      const spend = r?.spend_aud;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errors.push(`row ${i}: bad date '${date}'`);
      if (!CAMPAIGNS.includes(campaign)) return errors.push(`row ${i}: campaign must be one of ${CAMPAIGNS.join('|')}`);
      const nums: Record<string, number | null> = {};
      for (const k of ['spend_aud', 'claimed_conversions', 'claimed_value_aud']) {
        const v = r?.[k];
        if (v === null || v === undefined || v === '') { nums[k] = null; continue; }
        const n = parseFloat(String(v));
        if (isNaN(n) || n < 0) return errors.push(`row ${i}: ${k} must be a number >= 0 or null`);
        nums[k] = Math.round(n * 100) / 100;
      }
      if (spend === null || spend === undefined || spend === '') return errors.push(`row ${i}: spend_aud is required (use 0 for a real zero-spend day)`);
      clean.push({ date, campaign, ...nums, source: 'manual', updated_by: actor, updated_at: new Date().toISOString() });
    });
    if (errors.length) return json({ success: false, message: 'validation failed', errors }, 400);

    const { error } = await supabase.from('google_ads_daily').upsert(clean, { onConflict: 'date,campaign' });
    if (error) return json({ success: false, message: error.message }, 500);
    return json({ success: true, upserted: clean.length, actor });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
