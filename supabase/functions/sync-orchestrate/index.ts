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
// A step lock older than this is treated as dead and reclaimed. MUST exceed the
// edge wall-clock ceiling (~400s = 6.7 min) so a reclaim NEVER races a live
// background task — that guarantees a step never runs twice concurrently.
const LOCK_MINUTES = 10;
// Retries for a step whose worker keeps dying before it can complete. After this
// many claims the run is failed (in the claim RPC) so a fresh kickoff can start
// instead of the subsystem wedging forever.
const MAX_ATTEMPTS = 3;
// Backstop: a run still 'running' this long after it started is considered wedged
// (e.g. the driver cron died mid-run) and is failed so a new run can be created.
// Well above a healthy run (~8-12 min) and above the give-up ceiling.
const STUCK_MINUTES = 40;

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

    // Current active run. Backstop: if it's been 'running' far longer than any
    // healthy run (started_at is immutable — unlike updated_at it can't be refreshed
    // by lock reclaims), the driver likely died mid-run, so fail it and free the
    // single-running slot. A genuinely stuck step is already capped by MAX_ATTEMPTS
    // in the claim RPC; this only catches a dead driver.
    const { data: active } = await supabase
      .from('sync_runs').select('*').eq('status', 'running').order('started_at', { ascending: false }).limit(1).maybeSingle();
    let run = active;
    const lockAgeMs = run?.locked_at ? Date.now() - new Date(run.locked_at).getTime() : Infinity;
    if (
      run &&
      Date.now() - new Date(run.started_at).getTime() > STUCK_MINUTES * 60_000 &&
      lockAgeMs > LOCK_MINUTES * 60_000 // only if no live worker holds the lock — never abandon a run mid-step
    ) {
      const steps = [...(run.steps ?? []), { name: 'run abandoned', status: 'error', message: `no completion after ${STUCK_MINUTES}m`, at: new Date().toISOString() }];
      await supabase.from('sync_runs').update({ status: 'error', steps, locked_at: null, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', run.id);
      run = null;
    }

    // Kickoff: create a run if none active. The partial unique index
    // (status='running') makes this atomic — if a concurrent kickoff already
    // inserted, our insert fails and we just report the run that won.
    if (!run) {
      if (!kickoff) return json({ success: true, idle: true });
      const { data: created, error: insErr } = await supabase
        .from('sync_runs').insert({ status: 'running', cursor: 0, total_steps: STEPS.length, trigger }).select().maybeSingle();
      if (insErr) {
        const { data: cur } = await supabase
          .from('sync_runs').select('id').eq('status', 'running').order('started_at', { ascending: false }).limit(1).maybeSingle();
        return json({ success: true, runId: cur?.id, status: 'running', alreadyRunning: true });
      }
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
    const { data: claimedRows } = await supabase.rpc('sync_claim_step', { p_run_id: run.id, p_lock_minutes: LOCK_MINUTES, p_max_attempts: MAX_ATTEMPTS });
    const claimed = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
    if (!claimed) return json({ success: true, busy: true, runId: run.id });
    run = claimed; // authoritative cursor + lock token at claim time
    const cursor = run.cursor;
    const lockToken = run.locked_at; // used to prove we still own the lock at completion
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
      // Only advance if we still own the lock (defense-in-depth: if a reclaim ran
      // this step in another worker, our stale write must not clobber it). Reset
      // attempts to 0 so the next step starts with a full retry budget.
      await supabase.from('sync_runs').update({
        cursor: nextCursor,
        steps,
        attempts: 0,
        status: done ? (steps.some((s: any) => s.status === 'error') ? 'error' : 'done') : 'running',
        locked_at: null, // release for the next tick
        finished_at: done ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq('id', run!.id).eq('locked_at', lockToken);
    })();

    const er = (globalThis as any).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(work); else await work;
    return json({ success: true, runId: run.id, startedStep: step.name, cursor, total: STEPS.length });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
