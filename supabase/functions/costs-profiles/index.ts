// =============================================================================
// Costs Profiles — named cost-classification presets for the Costs tab.
//
// A profile is a full CostsConfig (boards + sliders + adjustments + excluded)
// with a name. Profiles are stored as one JSON file next to the active config:
//   csv-files/dashboard-settings/costs-profiles-v1.json
//
// Endpoints (single function, switched on method/body):
//   GET  → { success, profiles: CostProfile[] }
//   POST { profiles: CostProfile[] }  → replaces the whole list (validated)
//   POST { action: "freeze-fy" }      → copies the ACTIVE config
//        (dashboard-settings/costs-config-v1.json) over the frozen FY snapshot
//        config (fy2025-26/costs-config-v1.json). Fixed paths only — used once
//        per fiscal-year close so the FY Report reads the curated classification.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const BUCKET = 'csv-files';
const PROFILES_PATH = 'dashboard-settings/costs-profiles-v1.json';
const ACTIVE_CONFIG_PATH = 'dashboard-settings/costs-config-v1.json';
const FY_FROZEN_CONFIG_PATH = 'fy2025-26/costs-config-v1.json';

interface CostProfile {
  id: string;
  name: string;
  description?: string;
  boards: Record<string, 'fixed' | 'variable' | 'andrea' | 'pool'>;
  sliders: Record<string, number>;
  adjustments: Record<string, { percent: number; note: string }>;
  excluded: Record<string, boolean>;
  updatedAt: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isValidProfile(p: any): p is CostProfile {
  return (
    p && typeof p === 'object' &&
    typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 60 &&
    typeof p.boards === 'object' && p.boards !== null &&
    typeof p.sliders === 'object' && p.sliders !== null &&
    typeof p.excluded === 'object' && p.excluded !== null &&
    Object.values(p.boards).every((b: any) => ['fixed', 'variable', 'andrea', 'pool'].includes(b))
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables');
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    if (req.method === 'GET') {
      const { data, error } = await supabase.storage.from(BUCKET).download(PROFILES_PATH);
      if (error || !data) {
        // No profiles saved yet — empty list, not an error.
        return json({ success: true, profiles: [] });
      }
      const parsed = JSON.parse(await data.text());
      return json({ success: true, profiles: parsed.profiles ?? [] });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));

      if (body?.action === 'freeze-fy') {
        // Copy the ACTIVE config over the frozen FY snapshot config so the FY
        // Report uses the curated classification. Fixed source/dest paths.
        const { data, error } = await supabase.storage.from(BUCKET).download(ACTIVE_CONFIG_PATH);
        if (error || !data) {
          return json({ success: false, message: 'Active config not found' }, 404);
        }
        const bytes = await data.arrayBuffer();
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(FY_FROZEN_CONFIG_PATH, bytes, { contentType: 'application/json', upsert: true });
        if (upErr) {
          return json({ success: false, message: `Freeze failed: ${upErr.message}` }, 500);
        }
        return json({ success: true, message: `Copied active config to ${FY_FROZEN_CONFIG_PATH}` });
      }

      const profiles = body?.profiles;
      if (!Array.isArray(profiles) || profiles.length > 50 || !profiles.every(isValidProfile)) {
        return json({ success: false, message: 'profiles must be an array (≤50) of valid CostProfile objects' }, 400);
      }

      const payload = JSON.stringify({ schemaVersion: 1, profiles }, null, 2);
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(PROFILES_PATH, new Blob([payload], { type: 'application/json' }), {
          contentType: 'application/json',
          upsert: true,
        });
      if (upErr) {
        return json({ success: false, message: `Save failed: ${upErr.message}` }, 500);
      }
      return json({ success: true, count: profiles.length });
    }

    return json({ success: false, message: 'Method not allowed' }, 405);
  } catch (error) {
    return json(
      { success: false, message: error instanceof Error ? error.message : 'Unknown error' },
      500,
    );
  }
});
