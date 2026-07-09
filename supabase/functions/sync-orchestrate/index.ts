// =============================================================================
// Sync orchestrate — the self-driving refresh chain.
//
// One "run" refreshes every automated source. Because each step must finish
// under the 150s edge limit, the run advances ONE step per call:
//   kickoff cron (N/day)  → POST { kickoff:true }  → creates a run, runs step 0
//   driver cron (1/min)   → POST {}                → runs the run's next step
//   main Update button    → POST { kickoff:true, trigger:'button' }
//
// Every step's result (ok/error, rows, ms) is logged in sync_runs.steps, so the
// whole thing runs unattended and each update is auditable. Steps keep their own
// incremental watermark; a failing step is logged and the run continues.
// Service-role only.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

// Ordered steps of a full refresh. Each underlying call finishes under 150s.
const STEPS: { name: string; fn: string; body: unknown }[] = [
  { name: 'Unleashed sales', fn: 'unleashed-sales-sync', body: {} },
  { name: 'Inventory · products', fn: 'aim2026-sync-unleashed', body: { step: 'products' } },
  { name: 'Inventory · stock on hand', fn: 'aim2026-sync-unleashed', body: { step: 'soh' } },
  { name: 'Inventory · sales/demand', fn: 'aim2026-sync-unleashed', body: { step: 'sales' } },
  { name: 'Inventory · purchase orders', fn: 'aim2026-sync-unleashed', body: { step: 'purchase' } },
  { name: 'Inventory · assemblies', fn: 'aim2026-sync-unleashed', body: { step: 'assemblies' } },
];
const STALE_MINUTES = 12;   // a run with no progress this long is abandoned so a new one can start
const LOCK_MINUTES = 4;     // a step lock older than this is considered dead and can be reclaimed

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
// Best-effort row count from a step's varied response shape.
function rowsOf(p: any): number | null {
  if (!p || typeof p !== 'object') return null;
  for (const k of ['linesUpserted', 'liveRowsTotal', 'rows', 'inserted', 'total', 'count']) {
    if (typeof p[k] === 'number') return p[k];
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const base = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(base, key);
    const body = await req.json().catch(() => ({}));
    const kickoff = body?.kickoff === true;
    const trigger = typeof body?.trigger === 'string' ? body.trigger : (kickoff ? 'cron' : 'driver');

    // Current active run (+ stale guard).
    const { data: active } = await supabase
      .from('sync_runs').select('*').eq('status', 'running').order('started_at', { ascending: false }).limit(1).maybeSingle();
    let run = active;
    if (run && (Date.now() - new Date(run.updated_at).getTime()) > STALE_MINUTES * 60_000) {
      const steps = [...(run.steps ?? []), { name: 'stalled', status: 'error', message: `no progress > ${STALE_MINUTES}m`, at: new Date().toISOString() }];
      await supabase.from('sync_runs').update({ status: 'error', steps, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', run.id);
      run = null;
    }

    // Kickoff: create a run if none active. (Kickoff only creates it — the driver
    // ticks run the steps — so the caller returns instantly and no cron/browser
    // connection needs to stay open for a whole step.)
    if (!run) {
      if (!kickoff) return json({ success: true, idle: true });
      const { data: created } = await supabase
        .from('sync_runs').insert({ status: 'running', cursor: 0, total_steps: STEPS.length, trigger }).select().maybeSingle();
      return json({ success: true, runId: created?.id, status: 'running', cursor: 0, total: STEPS.length, created: true });
    }

    // Nothing left → mark done.
    if (run.cursor >= STEPS.length) {
      await supabase.from('sync_runs').update({ status: 'done', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', run.id);
      return json({ success: true, runId: run.id, status: 'done' });
    }

    // Atomically claim the next step via a SECURITY DEFINER RPC so two overlapping
    // ticks can't run it twice (a step can take longer than the 1-minute driver
    // interval). The claim succeeds only if the lock is free or dead; otherwise
    // another tick owns it → no-op. (Done in raw SQL because a supabase-js
    // update+select re-filters on the just-set locked_at and returns no row.)
    const { data: claimedRows } = await supabase.rpc('sync_claim_step', { p_run_id: run.id, p_lock_minutes: LOCK_MINUTES });
    const claimed = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
    if (!claimed) return json({ success: true, busy: true, runId: run.id });
    run = claimed; // authoritative cursor at claim time
    const cursor = run.cursor;
    const step = STEPS[cursor];

    // Execute the step as a BACKGROUND task and return immediately. pg_net (the
    // driver) kills a function that keeps its connection busy with long work, so
    // the request must return in a few hundred ms; EdgeRuntime.waitUntil keeps the
    // worker alive past the response to finish the step (each well under 150s),
    // advance the cursor and release the lock. The next tick runs the next step.
    const work = (async () => {
      const started = Date.now();
      let entry: any;
      try {
        const r = await fetch(`${base}/functions/v1/${step.fn}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(step.body),
        });
        const payload = await r.json().catch(() => ({}));
        const ok = r.ok && payload?.success !== false;
        entry = { name: step.name, status: ok ? 'ok' : 'error', rows: rowsOf(payload), ms: Date.now() - started, message: ok ? null : (payload?.message ?? `HTTP ${r.status}`), at: new Date().toISOString() };
      } catch (e) {
        entry = { name: step.name, status: 'error', rows: null, ms: Date.now() - started, message: e instanceof Error ? e.message : 'failed', at: new Date().toISOString() };
      }
      const nextCursor = cursor + 1;
      const steps = [...(run!.steps ?? []), entry];
      const done = nextCursor >= STEPS.length;
      await supabase.from('sync_runs').update({
        cursor: nextCursor,
        steps,
        status: done ? (steps.some((s: any) => s.status === 'error') ? 'error' : 'done') : 'running',
        locked_at: null, // release for the next tick
        finished_at: done ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq('id', run!.id);
    })();

    const er = (globalThis as any).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(work); else await work;
    return json({ success: true, runId: run.id, startedStep: step.name, cursor, total: STEPS.length });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
