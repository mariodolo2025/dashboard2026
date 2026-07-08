// =============================================================================
// Shipping Performance — serves the pre-aggregated Starshipit delivery metrics
// (starshipit_delivery_perf) for the Shipping Performance report.
//
// Delivered rate, on-time / early / late split (Delivered vs Starshipit's
// estimated delivery date), handling time (label → pickup), transit time
// (pickup → delivered), by market / carrier / shipment type / month.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FY = 'FY25-26';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_LABELS[m - 1]} ${String(y).slice(2)}`;
}

/** Turn a stored bucket row into ratios/averages.
 *
 *  IMPORTANT: Starshipit only supplies an estimated delivery date for Australia
 *  Post — DHL eCommerce / UPS / DHL Express parcels have none. For those, `est`
 *  is 0 and the early/on-time/late ratios are meaningless (they'd read as a
 *  perfect 0% late). We return `null` for those ratios and expose `estCoverage`
 *  so the UI can show "—" instead of a fake number. */
function metrics(r: any) {
  const num = (v: any) => Number(v) || 0;
  const shipped = num(r.shipped), delivered = num(r.delivered), est = num(r.est);
  const early = num(r.early), ontime = num(r.ontime), late = num(r.late);
  const hn = num(r.handle_n), tn = num(r.transit_n), ton = num(r.total_n);
  const hasEst = est > 0;
  return {
    shipped, delivered, est, early, ontime, late,
    estCoverage: shipped > 0 ? est / shipped : 0,
    deliveredPct: shipped > 0 ? delivered / shipped : 0,
    earlyPct: hasEst ? early / est : null,
    ontimePct: hasEst ? ontime / est : null,
    latePct: hasEst ? late / est : null,
    onTimeOrBetterPct: hasEst ? (early + ontime) / est : null,
    handleHours: hn > 0 ? num(r.handle_sum) / hn : 0,
    transitDays: tn > 0 ? num(r.transit_sum) / tn : 0,
    totalDays: ton > 0 ? num(r.total_sum) / ton : 0,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: rows } = await supabase.from('starshipit_delivery_perf').select('*');
    const all = rows ?? [];
    const byDim = (dim: string) => all.filter((r: any) => r.dim === dim);
    const one = (dim: string, key: string) => all.find((r: any) => r.dim === dim && r.key === key);

    const overall = one('overall', 'all');
    const overview = overall ? metrics(overall) : null;

    const markets = ['AU', 'US', 'Other']
      .map((m) => one('market', m))
      .filter(Boolean)
      .map((r: any) => ({ market: r.key, ...metrics(r) }));

    const byType = ['Domestic', 'International']
      .map((t) => one('type', t))
      .filter(Boolean)
      .map((r: any) => ({ type: r.key, ...metrics(r) }));

    const carriers = byDim('carrier')
      .map((r: any) => ({ carrier: r.key, ...metrics(r) }))
      .sort((a, b) => b.shipped - a.shipped);

    const monthly = byDim('month')
      .sort((a: any, b: any) => String(a.key).localeCompare(String(b.key)))
      .map((r: any) => ({ month: r.key, label: monthLabel(r.key), ...metrics(r) }));

    // Market × month, shaped for stacked/line charts by market.
    const mmMap = new Map<string, any>();
    for (const r of byDim('market_month')) {
      const [market, ym] = String(r.key).split('|');
      if (!mmMap.has(ym)) mmMap.set(ym, { month: ym, label: monthLabel(ym) });
      mmMap.get(ym)[market] = metrics(r);
    }
    const marketMonthly = [...mmMap.values()].sort((a, b) => a.month.localeCompare(b.month));

    const carrierMarket = byDim('carrier_market').map((r: any) => {
      const [carrier, market] = String(r.key).split('|');
      return { carrier, market, ...metrics(r) };
    });

    // The US carrier switch, seen from the delivery side: what the cheaper
    // Australia Post lane costs in speed vs the DHL eCommerce lane it replaced.
    const usLeg = (c: string) => carrierMarket.find((x) => x.carrier === c && x.market === 'US') ?? null;
    const dhlUs = usLeg('DHL eCommerce'), ausUs = usLeg('Australia Post');
    const usSwitch = dhlUs && ausUs ? {
      dhl: { parcels: dhlUs.shipped, transitDays: dhlUs.transitDays, handleHours: dhlUs.handleHours },
      auspost: { parcels: ausUs.shipped, transitDays: ausUs.transitDays, handleHours: ausUs.handleHours },
      transitDelta: ausUs.transitDays - dhlUs.transitDays, // + = slower now
    } : null;

    return json({ success: true, fy: FY, overview, markets, byType, carriers, monthly, marketMonthly, carrierMarket, usSwitch });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
