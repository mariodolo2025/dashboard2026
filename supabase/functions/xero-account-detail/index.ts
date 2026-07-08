// =============================================================================
// Xero account detail — drill-down for split accounts.
//
// Returns the individual transaction lines behind a virtual account bucket
// (e.g. "Freight & Courier" → "Outbound — B2B"), classified with the SAME
// rules that built the totals (../_shared/xeroSplitRules.ts). Lets the user
// click a freight category and see exactly which supplier transactions
// compose it, to validate the classification.
//
//   POST { account: "Freight & Courier", bucket?: "Outbound — B2B" }
//     → { success, account, bucket, lines: [...], total, byContact: [...] }
//   Omit bucket to get every line with its computed bucket.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { classifyLine, SPLIT_RULES } from '../_shared/xeroSplitRules.ts';
import { loadStarshipitRatios, auShare, carrierKeyForContact } from '../_shared/starshipitReallocation.ts';

// The two freight buckets whose card total differs from the raw supplier lines,
// because the Starshipit market reallocation moves the US share of Australia
// Post + DHL eCommerce (booked under B2C AU by supplier) into B2C USA.
const REALLOC_BUCKETS = new Set(['Outbound — B2C AU', 'Outbound — B2C USA']);
const REALLOC_CARRIER_NAME: Record<string, string> = { auspost: 'Australia Post', dhl_ecommerce: 'DHL eCommerce', ups: 'UPS' };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const account = String(body?.account ?? '');
    const bucket = body?.bucket ? String(body.bucket) : null;
    // Optional single-month filter (e.g. year=2025, month=11 → Nov 2025 only).
    const year = Number.isInteger(body?.year) ? body.year as number : null;
    const month = Number.isInteger(body?.month) ? body.month as number : null;
    if (!SPLIT_RULES[account]) {
      return json({ success: false, message: `Account "${account}" is not a split account` }, 400);
    }

    // PostgREST caps a response at 1000 rows (max-rows) regardless of .limit(),
    // so page with .range() to get every line.
    const rows: any[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('xero_account_lines')
        .select('journal_date, contact_name, description, reference, net_amount, currency, source')
        .eq('account_name', account)
        .order('journal_date', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) return json({ success: false, message: error.message }, 500);
      rows.push(...(data ?? []));
      if (!data || data.length < pageSize) break;
    }

    const lines = (rows ?? [])
      .map((r: any) => ({
        date: r.journal_date,
        contact: r.contact_name,
        description: r.description,
        reference: r.reference ?? null,
        amount: Number(r.net_amount) || 0,
        currency: r.currency ?? 'AUD',
        source: r.source ?? 'csv',
        bucket: classifyLine(account, r.contact_name) ?? 'Review',
      }))
      .filter((l: any) => {
        if (bucket && l.bucket !== bucket) return false;
        if (year !== null && month !== null) {
          const d = new Date(l.date);
          if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month) return false;
        }
        return true;
      });

    // Contact rollup for a quick "what's inside" view.
    const byContactMap = new Map<string, { total: number; count: number }>();
    for (const l of lines) {
      const key = l.contact || '(no contact)';
      const cur = byContactMap.get(key) || { total: 0, count: 0 };
      byContactMap.set(key, { total: cur.total + l.amount, count: cur.count + 1 });
    }
    const byContact = [...byContactMap.entries()]
      .map(([contact, v]) => ({ contact, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);

    const total = lines.reduce((s: number, l: any) => s + l.amount, 0);

    // Reconciliation bridge: when the drill-down is a reallocated freight bucket,
    // the raw supplier lines shown here won't sum to the card total. Compute the
    // Starshipit reallocation across BOTH B2C buckets (from the full row set, not
    // the filtered lines) so the modal can explain the gap.
    let reallocation: any = null;
    if (account === 'Freight & Courier' && bucket && REALLOC_BUCKETS.has(bucket)) {
      const ratios = await loadStarshipitRatios(supabase);
      let auCard = 0, usaCard = 0, auBucketRaw = 0, usaBucketRaw = 0;
      const carriers = new Map<string, { carrier: string; raw: number; au: number; us: number }>();
      for (const r of rows) {
        const b = classifyLine(account, r.contact_name);
        if (b !== 'Outbound — B2C AU' && b !== 'Outbound — B2C USA') continue;
        const amt = Number(r.net_amount) || 0;
        if (b === 'Outbound — B2C AU') auBucketRaw += amt; else usaBucketRaw += amt;
        const [y, mo] = String(r.journal_date).slice(0, 7).split('-').map(Number);
        const ck = carrierKeyForContact(r.contact_name);
        const share = ck ? auShare(ratios, ck, y, mo) : null;
        if (ck && share !== null) {
          const au = amt * share, us = amt * (1 - share);
          auCard += au; usaCard += us;
          // Only carriers booked under B2C AU actually cross into B2C USA (their
          // US share). UPS is booked under USA natively and stays — don't list it
          // as "moved".
          if (b === 'Outbound — B2C AU') {
            const cur = carriers.get(ck) ?? { carrier: REALLOC_CARRIER_NAME[ck] ?? ck, raw: 0, au: 0, us: 0 };
            cur.raw += amt; cur.au += au; cur.us += us; carriers.set(ck, cur);
          }
        } else if (b === 'Outbound — B2C AU') { auCard += amt; } else { usaCard += amt; }
      }
      const isAU = bucket === 'Outbound — B2C AU';
      reallocation = {
        applies: true,
        direction: isAU ? 'out' : 'in',       // AU loses its US share; USA gains it
        rawShown: isAU ? auBucketRaw : usaBucketRaw,
        cardTotal: isAU ? auCard : usaCard,
        moved: Math.max(0, auBucketRaw - auCard), // US share transferred AU → USA
        carriers: [...carriers.values()].sort((a, b) => b.raw - a.raw),
      };
    }

    return json({ success: true, account, bucket, total, count: lines.length, byContact, lines, reallocation });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
