// =============================================================================
// FY Operations extras — order volume + B2B payment reference for the FY Report
// Operations view.
//
//  - shopifyOrders: FY25-26 vs FY24-25 order count & gross, daily average, and
//    the monthly series (from shopify_orders_monthly).
//  - b2bPayment: wholesale receivables payment behaviour (from xero_b2b_payment,
//    retail excluded) — DSO, avg/median days-to-pay, on-time %.
//  - marketSplit: shipped parcels by destination (AU / US / Other), from the
//    Starshipit delivery data (starshipit_delivery_perf) — AU vs international.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FY_DAYS = 365;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
const inFY = (ym: number, startYm: number, endYm: number) => ym >= startYm && ym <= endYm;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Shopify order volume ──────────────────────────────────────────────────
    const { data: ord } = await supabase.from('shopify_orders_monthly').select('year, month, orders, gross_sales');
    const orderRows = ord ?? [];
    const agg = (startYm: number, endYm: number) => {
      const rows = orderRows.filter((r: any) => inFY(r.year * 100 + r.month, startYm, endYm));
      return {
        orders: rows.reduce((s: number, r: any) => s + (Number(r.orders) || 0), 0),
        gross: rows.reduce((s: number, r: any) => s + (Number(r.gross_sales) || 0), 0),
      };
    };
    const current = agg(202507, 202606);
    const prior = agg(202407, 202506);
    const monthly = [...orderRows]
      .filter((r: any) => inFY(r.year * 100 + r.month, 202507, 202606))
      .sort((a: any, b: any) => (a.year - b.year) || (a.month - b.month))
      .map((r: any) => ({ label: `${MONTH_LABELS[r.month - 1]} ${String(r.year).slice(2)}`, orders: Number(r.orders) || 0 }));
    const shopifyOrders = {
      current, prior,
      ordersYoYPct: prior.orders > 0 ? ((current.orders - prior.orders) / prior.orders) * 100 : null,
      currentDaily: current.orders / FY_DAYS,
      priorDaily: prior.orders / FY_DAYS,
      monthly,
    };

    // ── B2B payment reference ─────────────────────────────────────────────────
    const { data: pay } = await supabase.from('xero_b2b_payment').select('*').eq('fy', 'FY25-26').maybeSingle();
    const b2bPayment = pay ?? null;

    // ── Market split (shipped parcels AU / US / Other) ────────────────────────
    const { data: mk } = await supabase
      .from('starshipit_delivery_perf')
      .select('key, shipped')
      .eq('dim', 'market');
    const marketSplit: Record<string, number> = { AU: 0, US: 0, Other: 0 };
    for (const r of mk ?? []) if (r.key in marketSplit) marketSplit[r.key] = Number(r.shipped) || 0;
    const totalShipped = marketSplit.AU + marketSplit.US + marketSplit.Other;

    return json({
      success: true,
      shopifyOrders,
      b2bPayment,
      marketSplit: {
        au: marketSplit.AU,
        international: marketSplit.US + marketSplit.Other,
        us: marketSplit.US,
        other: marketSplit.Other,
        total: totalShipped,
      },
    });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
