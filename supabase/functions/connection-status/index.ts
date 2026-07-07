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
  /** Reads connection-specific liveness/last-sync info. */
  readStatus: (supabase: any) => Promise<{
    connected: boolean;
    detail?: string;
    lastSync?: unknown;
    tokenUpdatedAt?: string | null;
  }>;
}

const CONNECTIONS: ConnectionDef[] = [
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
        let cron: { schedule: string; active: boolean; aest: { days: number[]; hourAest: number } | null } | null = null;
        if (def.cronJobName) {
          const { data } = await supabase.rpc('connection_cron_get', { p_jobname: def.cronJobName });
          const row = Array.isArray(data) ? data[0] : data;
          if (row) {
            cron = {
              schedule: row.schedule,
              active: row.active,
              aest: parseCronToAest(String(row.schedule)),
            };
          }
        }
        connections.push({ id: def.id, name: def.name, ...status, cron });
      }
      return json({ success: true, connections });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const def = CONNECTIONS.find((c) => c.id === body?.id);
      if (!def) return json({ success: false, message: 'Unknown connection id' }, 400);

      if (body?.action === 'set-schedule') {
        if (!def.cronJobName) return json({ success: false, message: 'Connection has no schedule' }, 400);
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
