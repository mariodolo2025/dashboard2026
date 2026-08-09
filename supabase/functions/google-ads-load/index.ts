// Google Ads manual/CSV load (Advertising Bloque 2). The ONLY write path into
// google_ads_daily until the Google Ads API token arrives. Requires a logged-in
// dashboard session (Authorization: Bearer <access_token>) — audit identity
// (updated_by) is derived server-side from the session, never client-supplied.
// Validates hard: closed campaign enum, real calendar dates in a plausible
// range, non-negative numbers. Upsert by (date, campaign), deduped last-wins
// within a payload; missing days are simply absent (motor renders MER null).
//
//   POST (Authorization: Bearer <session token>)
//   { rows: [{ date, campaign, spend_aud,
//     claimed_conversions?, claimed_value_aud? }] }
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const CAMPAIGNS = ['brand-search', 'non-brand', 'shopping'];
const MIN_DATE = '2024-01-01';
const MAX_FUTURE_DAYS = 7;
// Catches both unparseable strings (2026-13-45) and calendar overflow
// (2026-02-30 silently normalizes to 2026-03-02) by requiring an exact
// round-trip back to the same YYYY-MM-DD.
const isRealCalendarDate = (date: string) => {
  const d = new Date(date + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

    // Auth gate (house pattern — see supabase/functions/invite-user/index.ts):
    // the anon key alone is not enough, a real logged-in user is required.
    // The audit identity (updated_by) is derived from this session server-side
    // so the client can never spoof who made a change.
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const anonClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data: { user } } = token ? await anonClient.auth.getUser(token) : { data: { user: null } };
    if (!user) return json({ success: false, message: 'authentication required' }, 401);
    const updatedBy = user.email ?? user.id;

    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!rows?.length) return json({ success: false, message: 'rows[] is required' }, 400);
    if (rows.length > 500) return json({ success: false, message: 'max 500 rows per call' }, 400);

    const maxDate = new Date(Date.now() + MAX_FUTURE_DAYS * 86400000).toISOString().slice(0, 10);
    const clean: any[] = [];
    const errors: string[] = [];
    rows.forEach((r: any, i: number) => {
      const date = String(r?.date ?? '');
      const campaign = String(r?.campaign ?? '');
      const spend = r?.spend_aud;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return errors.push(`row ${i}: bad date '${date}'`);
      if (!isRealCalendarDate(date)) return errors.push(`row ${i}: bad date '${date}'`);
      if (date < MIN_DATE || date > maxDate) return errors.push(`row ${i}: date must be between ${MIN_DATE} and ${maxDate}`);
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
      clean.push({ date, campaign, ...nums, source: 'manual', updated_by: updatedBy, updated_at: new Date().toISOString() });
    });
    if (errors.length) return json({ success: false, message: 'validation failed', errors }, 400);

    // Dedupe within one payload by (date, campaign) — last value wins, the
    // same overwrite semantics the upsert already applies across calls.
    const byKey = new Map<string, any>();
    for (const row of clean) byKey.set(`${row.date}|${row.campaign}`, row);
    const deduped = clean.length - byKey.size;
    const finalRows = Array.from(byKey.values());

    const { error } = await supabase.from('google_ads_daily').upsert(finalRows, { onConflict: 'date,campaign' });
    if (error) return json({ success: false, message: error.message }, 500);
    return json({ success: true, upserted: finalRows.length, deduped });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
