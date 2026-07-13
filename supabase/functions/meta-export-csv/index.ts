// Rebuild the dashboard's Meta CSV ("2-Mario-for-Danshboard.csv") from
// meta_ads_daily. Emits one row per (day, account) in the account's native
// currency + currency code, matching the columns parseMetaData reads
// (Day, Currency, Amount spent, Purchases conversion value) — so parseMetaData
// converts per-row to AUD exactly as it did with Mario's manual export. Native +
// per-row currency is preserved so no FX assumption is baked into the file.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const CSV_NAME = '2-Mario-for-Danshboard.csv';
const BACKUP_NAME = '2-Mario-for-Danshboard.manual-backup.csv';
// "Amount Spent" (capital S) matches parseMetaData's named lookup so spend never
// depends on column position; "Currency" stays native per row so the reader does the
// single USD->AUD conversion. Columns line up positionally with Mario's manual export.
const HEADER = ['Account name', 'Campaign name', 'Day', 'Reach', 'Impressions', 'Frequency', 'Currency', 'Amount Spent', 'Attribution setting', 'Purchases conversion value', 'Reporting starts', 'Reporting ends'];
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Guard: only overwrite when the last sync succeeded and rows exist.
    const { data: state } = await supabase.from('meta_ads_sync_state').select('last_run_status').eq('id', 1).maybeSingle();
    if (state?.last_run_status && String(state.last_run_status).startsWith('error')) return json({ error: `meta sync in error state: ${state.last_run_status}` }, 409);

    // Page through all rows — supabase-js caps a single select at 1000.
    const rows: Array<{ date: string; account_id: string; currency: string; spend: number; conversion_value: number }> = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase.from('meta_ads_daily').select('date, account_id, currency, spend, conversion_value').order('date', { ascending: true }).order('account_id', { ascending: true }).range(from, from + 999);
      if (error) throw new Error(error.message);
      if (!page || page.length === 0) break;
      rows.push(...page as typeof rows);
      if (page.length < 1000) break;
    }
    if (rows.length === 0) return json({ error: 'meta_ads_daily empty; refusing to overwrite CSV' }, 409);

    // One-time backup of Mario's manual export — a HARD precondition. Never overwrite
    // the irreplaceable manual CSV without a confirmed backup. If the backup already
    // exists we skip; if the original is genuinely absent there's nothing to lose;
    // any other download/upload failure THROWS before the overwrite.
    const { data: existingBackup } = await supabase.storage.from('csv-files').list('', { search: BACKUP_NAME });
    if (!existingBackup?.some((f) => f.name === BACKUP_NAME)) {
      const { data: orig, error: dlErr } = await supabase.storage.from('csv-files').download(CSV_NAME);
      if (dlErr && !/not found|does not exist/i.test(dlErr.message)) throw new Error(`backup precheck failed, refusing to overwrite: ${dlErr.message}`);
      if (orig) {
        const { error: bkErr } = await supabase.storage.from('csv-files').upload(BACKUP_NAME, orig, { upsert: false, contentType: 'text/csv' });
        if (bkErr) throw new Error(`backup upload failed, refusing to overwrite: ${bkErr.message}`);
      }
    }

    const lines = [HEADER.map(esc).join(',')];
    for (const r of rows) {
      const d = String(r.date).slice(0, 10);
      lines.push([r.account_id, 'All campaigns', d, '', '', '', r.currency, String(r.spend), '', String(r.conversion_value), d, d].map((c) => esc(String(c))).join(','));
    }
    const csv = lines.join('\n') + '\n';

    const { error: upErr } = await supabase.storage.from('csv-files').upload(CSV_NAME, new Blob([csv], { type: 'text/csv' }), { upsert: true, contentType: 'text/csv' });
    if (upErr) throw new Error(`upload: ${upErr.message}`);

    return json({ ok: true, rows: rows.length, bytes: csv.length, file: CSV_NAME });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
