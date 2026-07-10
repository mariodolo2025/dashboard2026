// =============================================================================
// Connection status — generic registry for the Config → Connections panel.
//
// Reports, per external connection: whether it's connected/alive, when it
// last synced (and the result), and its auto-sync schedule (pg_cron), with
// the ability to reschedule. Designed so future connections (Unleashed,
// Shopify, Meta) just add an entry to CONNECTIONS.
//
//   GET  → { success, connections: [...] }
//   POST { id, action: 'set-schedule', days: number[] (0=Sun..6=Sat, empty =
//          every day), hourAest: 0-23 } → rewrites the cron schedule (input is
//          Brisbane time, stored cron is UTC; Brisbane has no DST).
//
// "Sync now" is NOT here — the frontend calls the connection's own sync
// function directly (e.g. xero-sync) so progress/errors surface unchanged.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const AEST_OFFSET_HOURS = 10; // Australia/Brisbane, no DST

interface ConnectionDef {
  id: string;
  name: string;
  cronJobName: string | null;
  /** Master = the orchestrated full refresh (multi-time schedule + runs log). */
  master?: boolean;
  /** Reads connection-specific liveness/last-sync info. */
  readStatus: (supabase: any) => Promise<{
    connected: boolean;
    detail?: string;
    lastSync?: unknown;
    tokenUpdatedAt?: string | null;
    runs?: unknown;
  }>;
}

const CONNECTIONS: ConnectionDef[] = [
  {
    // The orchestrated full refresh (Unleashed sales + inventory, later Shopify/
    // Meta). One schedule drives everything; the runs log makes each update
    // auditable. Its "Sync now" kicks off a run; the every-minute driver advances it.
    id: 'auto-refresh',
    name: 'Auto-refresh',
    cronJobName: 'sync-refresh-kickoff',
    master: true,
    readStatus: async (supabase) => {
      const { data: runs } = await supabase
        .from('sync_runs')
        .select('id,status,cursor,total_steps,trigger,steps,started_at,finished_at')
        .order('started_at', { ascending: false })
        .limit(6);
      const lastFinished = (runs ?? []).find((r: any) => r.status !== 'running');
      return {
        connected: true,
        detail: 'Unleashed sales + inventory',
        runs: runs ?? [],
        lastSync: lastFinished
          ? { at: lastFinished.finished_at ?? lastFinished.started_at, ok: lastFinished.status === 'done' }
          : null,
      };
    },
  },
  {
    id: 'xero',
    name: 'Xero',
    cronJobName: 'xero-sync-daily',
    readStatus: async (supabase) => {
      const { data: token } = await supabase
        .from('xero_oauth_tokens')
        .select('tenant_name, updated_at')
        .eq('id', 1)
        .maybeSingle();
      const { data: last } = await supabase
        .from('xero_sync_state')
        .select('value')
        .eq('key', 'last_sync')
        .maybeSingle();
      return {
        connected: !!token,
        detail: token?.tenant_name ?? undefined,
        tokenUpdatedAt: token?.updated_at ?? null,
        lastSync: last?.value ?? null,
      };
    },
  },
  {
    id: 'unleashed-sales',
    name: 'Unleashed sales',
    cronJobName: 'unleashed-sales-sync-daily',
    readStatus: async (supabase) => {
      const { data: creds } = await supabase.from('unleashed_credentials').select('api_id').limit(1).maybeSingle();
      const { data: st } = await supabase.from('unleashed_sales_sync_state').select('*').eq('id', 1).maybeSingle();
      return {
        connected: !!creds?.api_id,
        detail: st?.rows_live != null ? `${st.rows_live} live rows since Jul 2026` : 'Sales API',
        tokenUpdatedAt: null,
        lastSync: st?.last_run_at ? { at: st.last_run_at, ok: st.last_run_status === 'ok' } : null,
      };
    },
  },
  {
    id: 'shopify-sales',
    name: 'Shopify sales',
    cronJobName: null, // driven by the master auto-refresh, not its own cron
    readStatus: async (supabase) => {
      const { data: creds } = await supabase.from('api_credentials').select('store_url').eq('provider', 'shopify').maybeSingle();
      const { data: st } = await supabase.from('shopify_sales_sync_state').select('*').eq('id', 1).maybeSingle();
      return {
        connected: !!creds?.store_url,
        detail: st?.rows_live != null ? `${st.rows_live} live rows since Jul 2026` : (creds?.store_url ?? 'Sales API'),
        tokenUpdatedAt: null,
        lastSync: st?.last_run_at ? { at: st.last_run_at, ok: st.last_run_status === 'ok' } : null,
      };
    },
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Convert (days-of-week AEST, hour AEST) to a UTC cron expression. */
function buildUtcCron(daysAest: number[], hourAest: number): string {
  let hourUtc = hourAest - AEST_OFFSET_HOURS;
  let dayShift = 0;
  if (hourUtc < 0) {
    hourUtc += 24;
    dayShift = -1; // the UTC moment falls on the previous day
  }
  if (!daysAest || daysAest.length === 0 || daysAest.length === 7) {
    return `0 ${hourUtc} * * *`;
  }
  const daysUtc = daysAest.map((d) => (((d + dayShift) % 7) + 7) % 7).sort((a, b) => a - b);
  return `0 ${hourUtc} * * ${daysUtc.join(',')}`;
}

/** Convert a stored UTC cron back to AEST parts for display. */
function parseCronToAest(schedule: string): { days: number[]; hourAest: number } | null {
  const m = schedule.trim().match(/^0 (\d{1,2}) \* \* (\*|[\d,]+)$/);
  if (!m) return null;
  let hourAest = (parseInt(m[1], 10) + AEST_OFFSET_HOURS) % 24;
  const dayShift = parseInt(m[1], 10) + AEST_OFFSET_HOURS >= 24 ? 1 : 0;
  if (m[2] === '*') return { days: [], hourAest };
  const days = m[2].split(',').map((d) => ((parseInt(d, 10) + dayShift) % 7 + 7) % 7).sort((a, b) => a - b);
  return { days, hourAest };
}

// --- Multi-time schedule (master auto-refresh) -----------------------------
// The master refresh runs EVERY DAY at N times (Mario's "3x/day"). Every-day
// avoids the day-of-week shift ambiguity when a Brisbane hour crosses midnight
// UTC, so a single cron expression is always correct.
function buildUtcCronMulti(hoursAest: number[]): string {
  const hoursUtc = [...new Set(hoursAest.map((h) => (((h - AEST_OFFSET_HOURS) % 24) + 24) % 24))].sort((a, b) => a - b);
  return `0 ${hoursUtc.join(',')} * * *`;
}
function parseCronMultiToAest(schedule: string): { hoursAest: number[] } | null {
  const m = schedule.trim().match(/^0 ([\d,]+) \* \* \*$/);
  if (!m) return null;
  const hoursAest = [...new Set(m[1].split(',').map((h) => (parseInt(h, 10) + AEST_OFFSET_HOURS) % 24))].sort((a, b) => a - b);
  return { hoursAest };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    if (req.method === 'GET') {
      const connections = [];
      for (const def of CONNECTIONS) {
        const status = await def.readStatus(supabase);
        let cron:
          | { schedule: string; active: boolean; aest: { days: number[]; hourAest: number } | null; hoursAest?: number[]; driverActive?: boolean }
          | null = null;
        if (def.cronJobName) {
          const { data } = await supabase.rpc('connection_cron_get', { p_jobname: def.cronJobName });
          const row = Array.isArray(data) ? data[0] : data;
          if (row) {
            cron = def.master
              ? { schedule: row.schedule, active: row.active, aest: null, hoursAest: parseCronMultiToAest(String(row.schedule))?.hoursAest ?? [] }
              : { schedule: row.schedule, active: row.active, aest: parseCronToAest(String(row.schedule)) };
          }
          if (cron && def.master) {
            // Surface whether the every-minute engine that advances runs is alive.
            const { data: drv } = await supabase.rpc('connection_cron_get', { p_jobname: 'sync-refresh-driver' });
            const drvRow = Array.isArray(drv) ? drv[0] : drv;
            cron.driverActive = !!drvRow?.active;
          }
        }
        connections.push({ id: def.id, name: def.name, master: def.master ?? false, ...status, cron });
      }
      return json({ success: true, connections });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const def = CONNECTIONS.find((c) => c.id === body?.id);
      if (!def) return json({ success: false, message: 'Unknown connection id' }, 400);

      if (body?.action === 'set-schedule') {
        if (!def.cronJobName) return json({ success: false, message: 'Connection has no schedule' }, 400);

        // Master auto-refresh: multiple times/day, every day.
        if (def.master) {
          const hoursAest: number[] = Array.isArray(body?.hoursAest) ? body.hoursAest.map(Number) : [];
          if (hoursAest.length === 0 || hoursAest.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
            return json({ success: false, message: 'hoursAest must be a non-empty list of 0-23' }, 400);
          }
          const schedule = buildUtcCronMulti(hoursAest);
          const { error } = await supabase.rpc('connection_cron_set', { p_jobname: def.cronJobName, p_schedule: schedule });
          if (error) return json({ success: false, message: error.message }, 500);
          return json({ success: true, schedule, hoursAest: [...new Set(hoursAest)].sort((a, b) => a - b) });
        }

        const hourAest = Number(body?.hourAest);
        const days: number[] = Array.isArray(body?.days) ? body.days.map(Number) : [];
        if (!Number.isInteger(hourAest) || hourAest < 0 || hourAest > 23 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          return json({ success: false, message: 'hourAest must be 0-23 and days 0-6' }, 400);
        }
        const schedule = buildUtcCron(days, hourAest);
        const { error } = await supabase.rpc('connection_cron_set', {
          p_jobname: def.cronJobName,
          p_schedule: schedule,
        });
        if (error) return json({ success: false, message: error.message }, 500);
        return json({ success: true, schedule, aest: { days, hourAest } });
      }

      return json({ success: false, message: 'Unknown action' }, 400);
    }

    return json({ success: false, message: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('connection-status error:', e);
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
