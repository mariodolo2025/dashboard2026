// =============================================================================
// wu-events-archive — backs up raw upgrade_events to Storage, then purges them.
//
// The raw table held 40 days / ~707k rows / 662MB on a 1GB-RAM instance and
// nothing reads it for reporting (the panel reads the daily rollups). This
// function archives every event older than a cutoff to the private
// `wu-archive` bucket as gzipped NDJSON parts plus a manifest, VERIFIES the
// exported row count equals what the purge will delete, and only then deletes
// — through wu_events_purge_batch, the RPC that sets the rollup_skip GUC so
// the delete does not cascade-decrement the rollups (documented invariant).
//
//   POST { phase:'export', before, cursor?, partStart?, pages? } → one slice
//   POST { phase:'purge',  before, batches? }                     → one slice
//   The operator loops on the returned cursor until done:true, verifies the
//   exported total against a fresh count, and only then starts the purge.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BUCKET = 'wu-archive';
const PAGE = 5000;

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    // The edge worker cannot export 700k rows in one life (WORKER_RESOURCE_LIMIT
    // at the first attempt), so each call does ONE bounded slice and returns a
    // cursor; the operator loops. Phases: 'export' (archive some pages) and
    // 'purge' (delete some batches, only ever through the GUC-guarded RPC).
    const body = await req.json().catch(() => ({}));
    const keepDays = Number(body?.keepDays) > 0 ? Number(body.keepDays) : 14;
    const before: string = typeof body?.before === 'string' ? body.before
      : new Date(Date.now() - keepDays * 86400_000).toISOString();
    const phase: string = body?.phase === 'purge' ? 'purge' : 'export';

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── auto mode: one self-driving slice per call (hourly cron) ──────────────
    // Cycle state lives in wu_archive_state. export: a few pages to Storage,
    // cursor advances. purge: delete ONLY ids <= the exported cursor - a row is
    // provably in the backup before it can die. idle: start a new cycle when
    // rows older than keepDays exist.
    if (body?.auto === true) {
      const { data: st } = await supabase.from('wu_archive_state').select('*').eq('id', 1).maybeSingle();
      if (!st) return json({ success: false, message: 'no wu_archive_state row' }, 500);

      if (st.phase === 'idle') {
        const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
        const { count } = await supabase.from('upgrade_events')
          .select('id', { count: 'exact', head: true }).lt('event_timestamp', cutoff);
        if (!count || count < 5000) return json({ success: true, auto: true, phase: 'idle', pending: count ?? 0 });
        await supabase.from('wu_archive_state').update({
          phase: 'export', before_ts: cutoff, cursor_id: 0, part: 0, exported: 0, updated_at: new Date().toISOString(),
        }).eq('id', 1);
        return json({ success: true, auto: true, started: cutoff, pending: count });
      }

      if (st.phase === 'export') {
        await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
        const dir = `until-${String(st.before_ts).slice(0, 10).replaceAll('-', '')}`;
        let lastId = Number(st.cursor_id) || 0;
        let part = Number(st.part) || 0;
        let exported = 0;
        for (let i = 0; i < 5; i++) {
          const { data: rows, error } = await supabase
            .from('upgrade_events').select('*')
            .lt('event_timestamp', st.before_ts).gt('id', lastId)
            .order('id', { ascending: true }).limit(PAGE);
          if (error) return json({ success: false, auto: true, message: `read: ${error.message}` }, 500);
          if (!rows?.length) {
            await supabase.from('wu_archive_state').update({ phase: 'purge', updated_at: new Date().toISOString() }).eq('id', 1);
            return json({ success: true, auto: true, phase: 'export-done', exportedTotal: Number(st.exported) + exported });
          }
          lastId = rows[rows.length - 1].id as number;
          part++;
          const gz = await gzip(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
          const { error: upErr } = await supabase.storage.from(BUCKET)
            .upload(`${dir}/part-${String(part).padStart(4, '0')}.ndjson.gz`, gz, { contentType: 'application/gzip', upsert: true });
          if (upErr) return json({ success: false, auto: true, message: `upload: ${upErr.message}` }, 500);
          exported += rows.length;
        }
        await supabase.from('wu_archive_state').update({
          cursor_id: lastId, part, exported: Number(st.exported) + exported, updated_at: new Date().toISOString(),
        }).eq('id', 1);
        return json({ success: true, auto: true, phase: 'export', cursor: lastId, exportedThisSlice: exported });
      }

      // phase 'purge': only ids the export provably wrote to Storage
      let deleted = 0;
      for (let i = 0; i < 3; i++) {
        const { data: n, error } = await supabase.rpc('wu_events_purge_batch', {
          p_before: st.before_ts, p_limit: 10000, p_max_id: st.cursor_id,
        });
        if (error) return json({ success: false, auto: true, message: `purge: ${error.message}`, deleted }, 500);
        deleted += n as number;
        if (!n) {
          await supabase.from('wu_archive_state').update({ phase: 'idle', updated_at: new Date().toISOString() }).eq('id', 1);
          return json({ success: true, auto: true, phase: 'purge-done', deleted });
        }
      }
      return json({ success: true, auto: true, phase: 'purge', deleted });
    }

    if (phase === 'purge') {
      const batches = Math.min(Number(body?.batches) || 4, 10);
      let deleted = 0;
      for (let i = 0; i < batches; i++) {
        const { data: n, error } = await supabase.rpc('wu_events_purge_batch', { p_before: before, p_limit: 10000 });
        if (error) return json({ success: false, message: `purge: ${error.message}`, deleted }, 500);
        deleted += n as number;
        if (!n) return json({ success: true, phase, before, deleted, done: true });
      }
      return json({ success: true, phase, before, deleted, done: false });
    }

    // ── export slice ──────────────────────────────────────────────────────────
    await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
    // Stragglers: late-ingested rows whose ids sit far past the dense range make
    // the cursor walk time out scanning for them — fetched by explicit id instead.
    if (Array.isArray(body?.ids) && body.ids.length) {
      const { data: rows, error } = await supabase.from('upgrade_events').select('*').in('id', body.ids);
      if (error) return json({ success: false, message: `read ids: ${error.message}` }, 500);
      const part = Number(body?.partStart) || 9000;
      const name = `until-${before.slice(0, 10).replaceAll('-', '')}/part-${String(part).padStart(4, '0')}.ndjson.gz`;
      const gz = await gzip((rows ?? []).map((r) => JSON.stringify(r)).join('\n') + '\n');
      const { error: upErr } = await supabase.storage.from(BUCKET)
        .upload(name, gz, { contentType: 'application/gzip', upsert: true });
      if (upErr) return json({ success: false, message: `upload: ${upErr.message}` }, 500);
      return json({ success: true, phase, before, exported: rows?.length ?? 0, part, done: true });
    }
    const pages = Math.min(Number(body?.pages) || 6, 12);
    let lastId = Number(body?.cursor) || 0;
    let part = Number(body?.partStart) || 0;
    const stamp = before.slice(0, 10).replaceAll('-', '');
    const dir = `until-${stamp}`;
    let exported = 0, bytes = 0;
    for (let i = 0; i < pages; i++) {
      const { data: rows, error } = await supabase
        .from('upgrade_events').select('*')
        .lt('event_timestamp', before).gt('id', lastId)
        .order('id', { ascending: true }).limit(PAGE);
      if (error) return json({ success: false, message: `read: ${error.message}`, exported, cursor: lastId }, 500);
      if (!rows?.length) {
        return json({ success: true, phase, before, exported, bytes, cursor: lastId, part, done: true });
      }
      lastId = rows[rows.length - 1].id as number;
      part++;
      const name = `${dir}/part-${String(part).padStart(4, '0')}.ndjson.gz`;
      const gz = await gzip(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const { error: upErr } = await supabase.storage.from(BUCKET)
        .upload(name, gz, { contentType: 'application/gzip', upsert: true });
      if (upErr) return json({ success: false, message: `upload: ${upErr.message}`, exported, cursor: lastId }, 500);
      exported += rows.length;
      bytes += gz.byteLength;
    }
    return json({ success: true, phase, before, exported, bytes, cursor: lastId, part, done: false });
  } catch (e) {
    return json({ success: false, message: String(e) }, 500);
  }
});
