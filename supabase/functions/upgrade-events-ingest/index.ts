// Ingest endpoint for the Pesado Web Upgrade Custom Pixel. The pixel POSTs one
// 'pesado_upgrade' event as flat JSON; we store the typed query dimensions plus the
// full payload in upgrade_events. Public (deployed with --no-verify-jwt) because a
// Shopify Web Pixel can't present a real JWT; it's an anonymous analytics beacon
// (no PII), and commercial stats filter environment='production' downstream.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, authorization, x-client-info',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad body' }, 400);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const rawTs = (body as Record<string, unknown>).timestamp;
    const ts = rawTs ? new Date(String(rawTs)) : null;

    const { error } = await supabase.from('upgrade_events').insert({
      event_timestamp: ts && !isNaN(ts.getTime()) ? ts.toISOString() : null,
      action: (body as Record<string, unknown>).action ?? null,
      attribution_id: (body as Record<string, unknown>).attribution_id ?? null,
      environment: (body as Record<string, unknown>).environment ?? null,
      payload: body,
    });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'failed' }, 500);
  }
});
