// =============================================================================
// Starshipit market data for the Freight by Market report.
//
// Returns:
//  - markets:   FY totals by destination market (AU / US / Other): orders,
//               freight paid, price quoted.
//  - monthly:   month × market (for the trend + paid-vs-quoted charts).
//  - usByCarrier: month × carrier for the US market only — the DHL eCommerce →
//               Australia Post switch comparison.
//  - zonosPaid: what we paid ZONOS (US import taxes), pulled from the Xero
//               Freight lines (contact ZONOS) so the US market view can show it.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: rows } = await supabase
      .from('starshipit_market_monthly')
      .select('year, month, carrier, carrier_key, market, orders, freight_charge, price_quoted');
    const data = rows ?? [];

    // Month axis (sorted).
    const monthSet = new Map<string, { year: number; month: number }>();
    for (const r of data) monthSet.set(`${r.year}-${String(r.month).padStart(2, '0')}`, { year: r.year, month: r.month });
    const months = [...monthSet.values()]
      .sort((a, b) => (a.year - b.year) || (a.month - b.month))
      .map((m) => ({ year: m.year, month: m.month, label: `${MONTH_LABELS[m.month - 1]} ${String(m.year).slice(2)}` }));

    // FY totals by market.
    const mkt = new Map<string, { orders: number; freight: number; price: number }>();
    for (const r of data) {
      const cur = mkt.get(r.market) ?? { orders: 0, freight: 0, price: 0 };
      cur.orders += Number(r.orders) || 0;
      cur.freight += Number(r.freight_charge) || 0;
      cur.price += Number(r.price_quoted) || 0;
      mkt.set(r.market, cur);
    }
    const markets = ['AU', 'US', 'Other']
      .filter((m) => mkt.has(m))
      .map((m) => ({ market: m, ...mkt.get(m)! }));

    // Monthly by market.
    const monthly = months.map((m) => {
      const row: Record<string, any> = { label: m.label };
      for (const market of ['AU', 'US', 'Other']) {
        const cells = data.filter((r: any) => r.year === m.year && r.month === m.month && r.market === market);
        row[`${market}_freight`] = cells.reduce((s: number, r: any) => s + (Number(r.freight_charge) || 0), 0);
        row[`${market}_price`] = cells.reduce((s: number, r: any) => s + (Number(r.price_quoted) || 0), 0);
        row[`${market}_orders`] = cells.reduce((s: number, r: any) => s + (Number(r.orders) || 0), 0);
      }
      return row;
    });

    // US market by carrier over time (DHL eCommerce vs Australia Post switch).
    const usByCarrier = months.map((m) => {
      const cells = data.filter((r: any) => r.year === m.year && r.month === m.month && r.market === 'US');
      const dhl = cells.filter((r: any) => r.carrier_key === 'dhl_ecommerce').reduce((s: number, r: any) => s + Number(r.freight_charge || 0), 0);
      const ausPost = cells.filter((r: any) => r.carrier_key === 'auspost').reduce((s: number, r: any) => s + Number(r.freight_charge || 0), 0);
      const other = cells.filter((r: any) => !['dhl_ecommerce', 'auspost'].includes(r.carrier_key)).reduce((s: number, r: any) => s + Number(r.freight_charge || 0), 0);
      return { label: m.label, dhl_ecommerce: Math.round(dhl), auspost: Math.round(ausPost), other: Math.round(other) };
    });

    // ZONOS paid (US import taxes) from Xero freight lines.
    let zonosPaid = 0;
    const { data: zlines } = await supabase
      .from('xero_account_lines')
      .select('net_amount')
      .eq('account_name', 'Freight & Courier')
      .ilike('contact_name', '%zonos%');
    for (const l of zlines ?? []) zonosPaid += Number(l.net_amount) || 0;

    return json({ success: true, months, markets, monthly, usByCarrier, zonosPaid });
  } catch (e) {
    return json({ success: false, message: e instanceof Error ? e.message : 'Unknown error' }, 500);
  }
});
