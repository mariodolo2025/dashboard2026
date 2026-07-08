// =============================================================================
// Freight by Market — outbound B2C shipping seen by destination market.
//
// The MONEY comes from Xero (what we actually paid each carrier — the reliable
// figure). The DESTINATION SPLIT and ORDER COUNTS come from Starshipit (it
// knows each parcel's country; Xero only knows the carrier). We take each
// outbound-B2C carrier's real Xero spend and split it AU / US / Other by that
// carrier's Starshipit market ratio — the exact same reallocation that feeds
// the Freight by Category "Outbound — B2C AU / USA" totals, so the two reports
// reconcile.
//
// Why not use Starshipit's own Freight Charge for the money? Because Starshipit
// under-captured DHL eCommerce ($88k recorded vs $193k actually invoiced in
// Xero). Xero is the source of truth for spend; Starshipit for the split.
//
// Returns: totals, per-market cards (orders / paid / avg per order), monthly
// order volume, monthly spend, the US DHL→AusPost carrier switch (real Xero $),
// a carrier rollup, and ZONOS (US import taxes, from Xero).
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  loadStarshipitRatios, marketShare, carrierKeyForContact,
} from '../_shared/starshipitReallocation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FY = 'FY25-26';
const FY_START = '2025-07-01';
const FY_END = '2026-06-30';
const MARKETS = ['AU', 'US', 'Other'] as const;
type Market = typeof MARKETS[number];

const CARRIER_NAME: Record<string, string> = {
  auspost: 'Australia Post',
  dhl_ecommerce: 'DHL eCommerce',
  ups: 'UPS',
  dhl_express: 'DHL Express',
  other: 'Other carriers',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Every Freight & Courier line in the FY window (paginated past PostgREST's
 *  1000-row cap). */
async function fetchXeroFreight(supabase: any): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('xero_account_lines')
      .select('journal_date, contact_name, net_amount')
      .eq('account_name', 'Freight & Courier')
      .gte('journal_date', FY_START)
      .lte('journal_date', FY_END)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Starshipit: orders per carrier × market × month, + market ratios ──────
    const { data: ssRows } = await supabase
      .from('starshipit_market_monthly')
      .select('year, month, carrier_key, market, orders');
    const ss = ssRows ?? [];
    const ratios = await loadStarshipitRatios(supabase);

    // Month axis (sorted) from the Starshipit data.
    const monthSet = new Map<string, { year: number; month: number }>();
    for (const r of ss) monthSet.set(`${r.year}-${String(r.month).padStart(2, '0')}`, { year: r.year, month: r.month });
    const months = [...monthSet.values()]
      .sort((a, b) => (a.year - b.year) || (a.month - b.month))
      .map((m) => ({ year: m.year, month: m.month, label: `${MONTH_LABELS[m.month - 1]} ${String(m.year).slice(2)}` }));

    // Orders per market (FY) + per month + per carrier.
    const marketOrders: Record<Market, number> = { AU: 0, US: 0, Other: 0 };
    const ordersByMonth = new Map<string, Record<Market, number>>();
    const carrierOrders = new Map<string, number>();
    for (const r of ss) {
      const o = Number(r.orders) || 0;
      const mk = (MARKETS.includes(r.market) ? r.market : 'Other') as Market;
      marketOrders[mk] += o;
      const key = `${r.year}-${r.month}`;
      if (!ordersByMonth.has(key)) ordersByMonth.set(key, { AU: 0, US: 0, Other: 0 });
      ordersByMonth.get(key)![mk] += o;
      carrierOrders.set(r.carrier_key, (carrierOrders.get(r.carrier_key) || 0) + o);
    }

    // ── Xero: real paid per outbound-B2C carrier per month ────────────────────
    const xero = await fetchXeroFreight(supabase);
    const moneyByMonth = new Map<string, Map<string, number>>(); // carrier_key → "y-m" → amt
    const carrierPaid = new Map<string, number>();               // carrier_key → FY amt
    let zonosPaid = 0;
    let hoonPaid = 0;
    for (const r of xero) {
      const name = (r.contact_name ?? '').toLowerCase();
      const amt = Number(r.net_amount) || 0;
      const ym = String(r.journal_date).slice(0, 7); // 'YYYY-MM'
      const [y, mo] = ym.split('-').map(Number);
      const key = `${y}-${mo}`;
      // ZONOS = US import taxes (a US cost, but not a shipping carrier/order).
      if (/zonos/.test(name)) { zonosPaid += amt; continue; }
      // Hoon Choi = US returns/replacements → US shipping, single-market.
      if (/hoon\s*choi/.test(name)) { hoonPaid += amt; addMoney(moneyByMonth, 'hoon', key, amt); carrierPaid.set('hoon', (carrierPaid.get('hoon') || 0) + amt); continue; }
      const ck = carrierKeyForContact(r.contact_name);
      if (!ck) continue; // inbound / B2B / not an outbound-B2C carrier
      addMoney(moneyByMonth, ck, key, amt);
      carrierPaid.set(ck, (carrierPaid.get(ck) || 0) + amt);
    }

    // ── Split each carrier's real money into markets by Starshipit ratio ──────
    const marketShipping: Record<Market, number> = { AU: 0, US: 0, Other: 0 };
    const moneyMonthMap = new Map<string, Record<Market, number>>();
    const usByCarrierMap = new Map<string, { dhl_ecommerce: number; auspost: number; other: number }>();

    for (const [ck, mm] of moneyByMonth) {
      for (const [key, amt] of mm) {
        const [y, mo] = key.split('-').map(Number);
        // hoon → 100% US; carriers with a Starshipit ratio → that split; else US.
        const share = ck === 'hoon'
          ? { au: 0, us: 1, other: 0 }
          : (marketShare(ratios, ck, y, mo) ?? { au: 0, us: 1, other: 0 });
        marketShipping.AU += amt * share.au;
        marketShipping.US += amt * share.us;
        marketShipping.Other += amt * share.other;
        if (!moneyMonthMap.has(key)) moneyMonthMap.set(key, { AU: 0, US: 0, Other: 0 });
        const c = moneyMonthMap.get(key)!;
        c.AU += amt * share.au; c.US += amt * share.us; c.Other += amt * share.other;
        // US carrier switch: attribute the US portion by carrier.
        if (!usByCarrierMap.has(key)) usByCarrierMap.set(key, { dhl_ecommerce: 0, auspost: 0, other: 0 });
        const u = usByCarrierMap.get(key)!;
        const usAmt = amt * share.us;
        if (ck === 'dhl_ecommerce') u.dhl_ecommerce += usAmt;
        else if (ck === 'auspost') u.auspost += usAmt;
        else u.other += usAmt;
      }
    }

    const totalShipping = marketShipping.AU + marketShipping.US + marketShipping.Other;
    const totalOrders = marketOrders.AU + marketOrders.US + marketOrders.Other;

    // US shipping cost per order: the DHL eCommerce era vs the Australia Post
    // era — "how much did switching carriers save us per US parcel?".
    const usOrdersByCarrier = new Map<string, number>();
    for (const r of ss) if (r.market === 'US') usOrdersByCarrier.set(r.carrier_key, (usOrdersByCarrier.get(r.carrier_key) || 0) + (Number(r.orders) || 0));
    let usDhlPaid = 0, usAusPaid = 0;
    for (const u of usByCarrierMap.values()) { usDhlPaid += u.dhl_ecommerce; usAusPaid += u.auspost; }
    const usDhlOrders = usOrdersByCarrier.get('dhl_ecommerce') || 0;
    const usAusOrders = usOrdersByCarrier.get('auspost') || 0;
    const usComparison = {
      dhl: { orders: usDhlOrders, paid: usDhlPaid, avgPerOrder: usDhlOrders > 0 ? usDhlPaid / usDhlOrders : 0 },
      auspost: { orders: usAusOrders, paid: usAusPaid, avgPerOrder: usAusOrders > 0 ? usAusPaid / usAusOrders : 0 },
    };

    // ── Assemble response ─────────────────────────────────────────────────────
    const markets = MARKETS.map((m) => ({
      market: m,
      orders: marketOrders[m],
      shipping: marketShipping[m],
      avgPerOrder: marketOrders[m] > 0 ? marketShipping[m] / marketOrders[m] : 0,
      pctShipping: totalShipping > 0 ? marketShipping[m] / totalShipping : 0,
      zonos: m === 'US' ? zonosPaid : 0,
    }));

    const monthlyVolume = months.map((m) => {
      const o = ordersByMonth.get(`${m.year}-${m.month}`) ?? { AU: 0, US: 0, Other: 0 };
      return { label: m.label, AU: o.AU, US: o.US, Other: o.Other };
    });
    const monthlyMoney = months.map((m) => {
      const s = moneyMonthMap.get(`${m.year}-${m.month}`) ?? { AU: 0, US: 0, Other: 0 };
      return { label: m.label, AU: Math.round(s.AU), US: Math.round(s.US), Other: Math.round(s.Other) };
    });
    const usByCarrier = months.map((m) => {
      const u = usByCarrierMap.get(`${m.year}-${m.month}`) ?? { dhl_ecommerce: 0, auspost: 0, other: 0 };
      return { label: m.label, dhl_ecommerce: Math.round(u.dhl_ecommerce), auspost: Math.round(u.auspost), other: Math.round(u.other) };
    });

    // Carrier rollup — orders from Starshipit, paid from Xero where mappable.
    const carrierKeys = new Set<string>([...carrierOrders.keys(), ...carrierPaid.keys()]);
    const carriers = [...carrierKeys]
      .filter((ck) => ck !== 'hoon') // folded into "US shipping", too small to list
      .map((ck) => {
        const orders = carrierOrders.get(ck) || 0;
        const paid = carrierPaid.has(ck) ? carrierPaid.get(ck)! : null;
        return {
          carrier: CARRIER_NAME[ck] ?? ck,
          carrier_key: ck,
          orders,
          paid,
          avgPerOrder: paid !== null && orders > 0 ? paid / orders : null,
        };
      })
      .sort((a, b) => b.orders - a.orders);

    return json({
      success: true,
      fy: FY,
      months,
      totals: {
        orders: totalOrders,
        shipping: totalShipping,
        zonos: zonosPaid,
        avgPerOrder: totalOrders > 0 ? totalShipping / totalOrders : 0,
      },
      markets,
      monthlyVolume,
      monthlyMoney,
      usByCarrier,
      usComparison,
      carriers,
      zonosPaid,
    });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});

function addMoney(map: Map<string, Map<string, number>>, ck: string, key: string, amt: number) {
  if (!map.has(ck)) map.set(ck, new Map());
  const mm = map.get(ck)!;
  mm.set(key, (mm.get(key) || 0) + amt);
}
