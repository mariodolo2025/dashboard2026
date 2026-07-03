import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Fixed whitelist: the live source files that feed the main dashboard
// (parse-csv-data + parse-xero-costs) plus the costs canvas config.
// The snapshot freezes these under a fiscal-year prefix so the closed
// year stays immutable while the live files keep being overwritten.
const SOURCE_FILES = [
  'SalesEnquiryList.csv',
  'MARIO Total sales by product variant - 2025-07-01 - 2026-07-03.csv',
  'old-shopify-sales.csv',
  '2-Mario-for-Danshboard.csv',
  'costs.csv',
  'Dolo_Ent_PTY_Ltd_-_Profit_and_Loss_Mario_2026.xlsx',
  'dashboard-settings/costs-config-v1.json',
];

const BUCKET = 'csv-files';

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Missing Supabase environment variables');
    }

    const body = await req.json().catch(() => ({}));
    const prefix = String(body?.prefix ?? '');

    // Only allow fiscal-year prefixes like "fy2025-26" — this function can
    // create snapshots but must never write anywhere else in the bucket.
    if (!/^fy\d{4}-\d{2}$/.test(prefix)) {
      return new Response(
        JSON.stringify({ error: 'prefix must match fyYYYY-YY, e.g. "fy2025-26"' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const results: { file: string; dest: string; status: string }[] = [];

    for (const file of SOURCE_FILES) {
      const base = file.split('/').pop() as string;
      const dest = `${prefix}/${base}`;

      // copy() fails if dest already exists — intentional: a snapshot is
      // written once and never overwritten.
      const { error } = await supabase.storage.from(BUCKET).copy(file, dest);
      results.push({
        file,
        dest,
        status: error ? `error: ${error.message}` : 'copied',
      });
    }

    const failed = results.filter(r => r.status !== 'copied');
    return new Response(
      JSON.stringify({ ok: failed.length === 0, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
