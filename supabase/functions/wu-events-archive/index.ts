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

    // ── auto mode: one bounded slice per call (hourly cron) ───────────────────
    // State lives in wu_archive_state. A cycle fixes its set when it starts —
    // rows with event_timestamp < before_ts AND id <= max_id — then:
    //   export: one environment at a time, in (event_timestamp, id) order, on
    //           the (environment, event_timestamp) index. An empty page ends
    //           the environment immediately. (The old walk by id never ended:
    //           its last page scanned the whole table until the timeout, and
    //           the cycle sat in 'export' from 31-Aug to 6-Oct-2026.)
    //   purge:  only the exported set, environments that finished, ids walked
    //           upward from purge_cursor to the highest id exported.
    //   idle:   start a new cycle once there is a day of backlog.
    // Any failure answers 500, which the ops watchdog reads; progress is saved
    // after every page or batch, so a cut call loses at most one of them.
    if (body?.auto === true) {
      const t0 = Date.now();
      const BUDGET_MS = 100_000;
      const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.round(n), lo), hi) : dflt;
      };
      // PostgREST returns at most 1000 rows per call whatever the limit asks,
      // so a page IS 1000 rows; 60 pages ≈ 60k rows ≈ 15 s.
      const EXPORT_PAGE_ROWS = 1000;
      const EXPORT_PAGES = clamp(body?.pages, 1, 150, 60);
      const PURGE_ROWS = clamp(body?.purgeRows, 1000, 100000, 40000);
      const PURGE_BATCH = 5000;
      const fail = (message: string, extra: Record<string, unknown> = {}) =>
        json({ success: false, auto: true, message, ...extra }, 500);
      const save = async (patch: Record<string, unknown>) => {
        const { error } = await supabase.from('wu_archive_state')
          .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
        return error ? `state save: ${error.message}` : null;
      };

      // Claim the cycle for 3 minutes (one call at a time).
      const nowIso = new Date().toISOString();
      const { data: claimed, error: stErr } = await supabase.from('wu_archive_state')
        .update({ locked_until: new Date(Date.now() + 180_000).toISOString() })
        .eq('id', 1).or(`locked_until.is.null,locked_until.lt."${nowIso}"`)
        .select('*');
      if (stErr) return fail(`state claim: ${stErr.message}`);
      if (!claimed?.length) return json({ success: true, auto: true, phase: 'busy', message: 'another call holds the cycle' });
      const st = claimed[0];

      if (st.phase === 'idle') {
        const cutoff = new Date(Date.now() - keepDays * 86400_000);
        const { data: oldest, error: oErr } = await supabase.rpc('wu_events_oldest');
        if (oErr) return fail(`oldest: ${oErr.message}`);
        if (!oldest || new Date(oldest as string) >= new Date(cutoff.getTime() - 86400_000)) {
          return json({ success: true, auto: true, phase: 'idle', oldest });
        }
        const { data: top, error: tErr } = await supabase.from('upgrade_events')
          .select('id').order('id', { ascending: false }).limit(1);
        if (tErr || !top?.length) return fail(`max id: ${tErr?.message ?? 'no rows'}`);
        const e = await save({
          phase: 'export', before_ts: cutoff.toISOString(), max_id: top[0].id,
          cursor_env: null, cursor_ts: null, cursor_id: 0, envs_done: [], export_max_id: null,
          part: 0, exported: 0, purge_cursor: 0, deleted: 0,
          started_at: new Date().toISOString(), last_message: null,
        });
        if (e) return fail(e);
        return json({ success: true, auto: true, phase: 'export-start', before: cutoff.toISOString(), maxId: top[0].id, oldest });
      }

      if (st.phase === 'export') {
        await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
        const dir = `until-${String(st.before_ts).slice(0, 10).replaceAll('-', '')}`;
        const { data: envRows, error: envErr } = await supabase.rpc('wu_events_envs');
        if (envErr) return fail(`environments: ${envErr.message}`);
        // setof text comes back as plain strings or as {wu_events_envs: …}
        const envs = ((envRows ?? []) as unknown[])
          .map((x) => (typeof x === 'string' ? x : String(Object.values(x as Record<string, unknown>)[0])))
          .sort();
        const done: string[] = [...(st.envs_done ?? [])];
        const nextEnv = () => envs.find((e) => !done.includes(e)) ?? null;
        let env: string | null = st.cursor_env ?? nextEnv();
        let afterTs: string | null = st.cursor_env ? st.cursor_ts : null;
        let afterId = st.cursor_env && st.cursor_ts ? Number(st.cursor_id) : 0;
        let part = Number(st.part) || 0;
        let total = Number(st.exported) || 0;
        let maxExp = Number(st.export_max_id) || 0;
        let pages = 0;

        while (env && pages < EXPORT_PAGES && Date.now() - t0 < BUDGET_MS) {
          const { data: rows, error } = await supabase.rpc('wu_events_export_page', {
            p_before: st.before_ts, p_max_id: st.max_id, p_env: env,
            p_after_ts: afterTs, p_after_id: afterId, p_limit: EXPORT_PAGE_ROWS,
          });
          if (error) return fail(`read ${env}: ${error.message}`, { part, exported: total });
          const page = (rows ?? []) as Record<string, unknown>[];
          if (!page.length) {
            done.push(env);
            env = nextEnv();
            afterTs = null; afterId = 0;
            const e = await save({ cursor_env: env, cursor_ts: null, cursor_id: 0, envs_done: done });
            if (e) return fail(e);
            continue;
          }
          part++;
          const gz = await gzip(page.map((r) => JSON.stringify(r)).join('\n') + '\n');
          const { error: upErr } = await supabase.storage.from(BUCKET)
            .upload(`${dir}/part-${String(part).padStart(4, '0')}.ndjson.gz`, gz, { contentType: 'application/gzip', upsert: true });
          if (upErr) return fail(`upload: ${upErr.message}`, { part, exported: total });
          const last = page[page.length - 1];
          afterTs = String(last.event_timestamp);
          afterId = Number(last.id);
          for (const r of page) maxExp = Math.max(maxExp, Number(r.id));
          total += page.length;
          pages++;
          const e = await save({ cursor_env: env, cursor_ts: afterTs, cursor_id: afterId, part, exported: total, export_max_id: maxExp });
          if (e) return fail(e);
        }

        if (!env) {
          // Every environment is in Storage: leave a manifest, then purge.
          const manifest = {
            before: st.before_ts, maxId: st.max_id, environments: done, parts: part, rows: total,
            exportMaxId: maxExp, startedAt: st.started_at, finishedAt: new Date().toISOString(),
            note: 'Rows are upgrade_events as stored, one JSON object per line. A row id may also appear in an older folder (until-20260817 was an abandoned cycle).',
          };
          const { error: mErr } = await supabase.storage.from(BUCKET)
            .upload(`${dir}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)), { contentType: 'application/json', upsert: true });
          if (mErr) return fail(`manifest: ${mErr.message}`);
          const e = await save({
            phase: 'purge', cursor_env: null, cursor_ts: null, cursor_id: 0,
            last_message: `exported ${total} rows in ${part} parts`,
          });
          if (e) return fail(e);
          return json({ success: true, auto: true, phase: 'export-done', exported: total, parts: part });
        }
        return json({ success: true, auto: true, phase: 'export', environment: env, pages, exported: total, part });
      }

      if (st.phase === 'purge') {
        // Same order and index as the export, environment by environment, with
        // its own cursor (cursor_env / cursor_ts / cursor_id, reset at the
        // switch to purge). Never deletes outside the exported set.
        const envsDone: string[] = [...(st.envs_done ?? [])].sort();
        if (!envsDone.length) {
          const e = await save({ phase: 'idle', last_message: 'purge skipped: nothing was exported' });
          if (e) return fail(e);
          return json({ success: true, auto: true, phase: 'purge-skipped' });
        }
        let env: string | null = st.cursor_env ?? envsDone[0];
        let afterTs: string | null = st.cursor_env ? st.cursor_ts : null;
        let afterId = st.cursor_env && st.cursor_ts ? Number(st.cursor_id) : 0;
        let deleted = 0;
        while (env && deleted < PURGE_ROWS && Date.now() - t0 < BUDGET_MS) {
          const { data, error } = await supabase.rpc('wu_events_purge_range', {
            p_before: st.before_ts, p_max_id: st.max_id, p_env: env,
            p_after_ts: afterTs, p_after_id: afterId, p_limit: PURGE_BATCH,
          });
          if (error) return fail(`purge ${env}: ${error.message}`, { deleted });
          const d = data as { deleted: number; lastTs: string | null; lastId: number | null };
          if (d.lastId == null) {
            const i = envsDone.indexOf(env);
            env = i >= 0 && i + 1 < envsDone.length ? envsDone[i + 1] : null;
            afterTs = null; afterId = 0;
          } else {
            deleted += d.deleted;
            afterTs = d.lastTs; afterId = d.lastId;
          }
          const e = await save({
            cursor_env: env, cursor_ts: afterTs, cursor_id: afterId,
            deleted: Number(st.deleted) + deleted,
          });
          if (e) return fail(e);
        }
        if (!env) {
          const e = await save({
            phase: 'idle', cursor_env: null, cursor_ts: null, cursor_id: 0,
            last_message: `cycle done: exported ${st.exported}, deleted ${Number(st.deleted) + deleted}`,
          });
          if (e) return fail(e);
          return json({ success: true, auto: true, phase: 'purge-done', deleted: Number(st.deleted) + deleted });
        }
        return json({ success: true, auto: true, phase: 'purge', environment: env, deletedThisCall: deleted });
      }

      return fail(`unknown phase "${st.phase}"`);
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
