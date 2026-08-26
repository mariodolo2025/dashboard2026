// =============================================================================
// ddp-sync — fills ddp_shipments for the DDP Markets tab.
//
// Three passes over the window (default: 2026-08-01 → today, the life of the
// DDP European markets). Each pass writes ONLY its own columns so a partial
// run can never null out another source (the PostgREST full-row-upsert trap).
// Rows are never deleted.
//
//   1. Shopify  — orders shipped to DE / DK / CH: what the CUSTOMER was charged
//      (shipping, duties, taxes; shop_money USD → AUD with the monthly rate in
//      currency_exchange_rates, same convention as the rest of the dashboard)
//      plus the fulfillment tracking number.
//   2. Starshipit — what the label really COST us (total_shipping_price, AUD).
//      Matched by order_number. Also fills tracking when Shopify had none.
//   3. ZONOS — what ZONOS BILLED us (duty / tax / fees, AUD). Matched by
//      tracking number. ZONOS rows with no local order land in
//      ddp_zonos_unmatched (derived cache, rebuilt every run).
//
//   POST {}                          → sync the default window
//   POST { "since": "2026-08-01" }   → override the window start
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const DDP_START = '2026-08-01';
const COUNTRIES = new Set(['DE', 'DK', 'CH']);
const SS_COUNTRIES: Record<string, string> = { Germany: 'DE', Denmark: 'DK', Switzerland: 'CH' };
const FX_FALLBACK = 1.54; // USD→AUD, same fallback the rest of the project uses

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const since: string = typeof body?.since === 'string' ? body.since : DDP_START;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── Monthly USD→AUD rates (currency_exchange_rates: rate = AUD per 1 USD) ──
    const { data: fxRows } = await supabase.from('currency_exchange_rates').select('year, month, rate');
    const fxByMonth = new Map<string, number>();
    for (const r of fxRows ?? []) fxByMonth.set(`${r.year}-${String(r.month).padStart(2, '0')}`, num(r.rate));
    const usdToAud = (isoDate: string): number => fxByMonth.get(isoDate.slice(0, 7)) || FX_FALLBACK;

    // ════════════════════════════ 1. SHOPIFY ════════════════════════════════
    const { data: creds } = await supabase
      .from('api_credentials').select('store_url, access_token').eq('provider', 'shopify').maybeSingle();
    if (!creds?.access_token) return json({ success: false, message: 'no shopify creds' }, 400);
    let store = String(creds.store_url).replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!store.includes('.')) store += '.myshopify.com';
    const shopifyHeaders = { 'X-Shopify-Access-Token': creds.access_token as string, 'Content-Type': 'application/json' };

    type ShopRow = Record<string, unknown>;
    const shopifyRows: ShopRow[] = [];
    let scanned = 0;
    let url: string | null =
      `https://${store}/admin/api/2024-01/orders.json?status=any&limit=250` +
      `&created_at_min=${since}T00:00:00Z` +
      `&fields=id,name,created_at,cancelled_at,test,presentment_currency,shipping_address,` +
      `subtotal_price_set,total_shipping_price_set,total_tax_set,current_total_duties_set,fulfillments`;
    while (url) {
      const res: Response = await fetch(url, { headers: shopifyHeaders });
      if (!res.ok) return json({ success: false, message: `shopify ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502);
      const page = (await res.json())?.orders ?? [];
      scanned += page.length;
      for (const o of page) {
        const cc = o?.shipping_address?.country_code;
        if (!COUNTRIES.has(cc) || o.cancelled_at || o.test) continue;
        const fx = usdToAud(String(o.created_at));
        const shop = (set: any) => num(set?.shop_money?.amount);           // USD
        const pres = (set: any) => num(set?.presentment_money?.amount);    // EUR/DKK/CHF
        const tracking = (o.fulfillments ?? [])
          .flatMap((f: any) => [f?.tracking_number, ...(f?.tracking_numbers ?? [])])
          .find((t: unknown) => typeof t === 'string' && t.length > 5) ?? null;
        shopifyRows.push({
          shopify_order_id: o.id,
          order_name: o.name,
          order_date: o.created_at,
          country_code: cc,
          presentment_currency: o.presentment_currency ?? null,
          subtotal_aud: shop(o.subtotal_price_set) * fx,
          charged_shipping_aud: shop(o.total_shipping_price_set) * fx,
          charged_taxes_aud: shop(o.total_tax_set) * fx,
          charged_duties_aud: shop(o.current_total_duties_set) * fx,
          charged_shipping_native: pres(o.total_shipping_price_set),
          charged_taxes_native: pres(o.total_tax_set),
          charged_duties_native: pres(o.current_total_duties_set),
          fx_rate: fx,
          tracking_number: tracking,
          updated_at: new Date().toISOString(),
        });
      }
      const link = res.headers.get('Link');
      const next = link?.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    // Same key set on every row → the upsert can't null-out unrelated columns.
    if (shopifyRows.length) {
      const { error } = await supabase.from('ddp_shipments')
        .upsert(shopifyRows, { onConflict: 'shopify_order_id' });
      if (error) return json({ success: false, message: `upsert: ${error.message}` }, 500);
    }

    // ════════════════════════════ 2. STARSHIPIT ═════════════════════════════
    const ssKey = Deno.env.get('STARSHIPIT_API_KEY');
    const ssSub = Deno.env.get('STARSHIPIT_SUBSCRIPTION_KEY');
    let freightMatched = 0, freightMissing = 0;
    if (ssKey && ssSub) {
      const ssHeaders = { 'StarShipIT-Api-Key': ssKey, 'Ocp-Apim-Subscription-Key': ssSub };
      // Which orders still need a freight cost?
      const { data: pending } = await supabase.from('ddp_shipments')
        .select('shopify_order_id, order_name, tracking_number')
        .is('freight_cost_aud', null);
      // Look each pending order up by its order number. The shipped-orders list
      // IGNORES since_order_date (page 1 spans ~4 days), so walking it misses
      // anything older; /orders/search is exact and two calls per order.
      const ssGet = async (url: string): Promise<Response> => {
        await new Promise((r) => setTimeout(r, 150));
        let res = await fetch(url, { headers: ssHeaders });
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 1500));
          res = await fetch(url, { headers: ssHeaders });
        }
        return res;
      };
      for (const local of pending ?? []) {
        const q = encodeURIComponent(local.order_name);
        const sRes = await ssGet(`https://api.starshipit.com/api/orders/search?phrase=${q}&limit=5`);
        if (!sRes.ok) { freightMissing++; continue; }
        const hit = ((await sRes.json())?.orders ?? []).find((o: any) => o?.order_number === local.order_name);
        if (!hit) { freightMissing++; continue; }
        const dRes = await ssGet(`https://api.starshipit.com/api/orders?order_id=${hit.order_id}`);
        if (!dRes.ok) { freightMissing++; continue; }
        const detail = (await dRes.json())?.order;
        const cost = num(detail?.total_shipping_price);      // AUD (label price)
        if (cost <= 0) { freightMissing++; continue; }       // no label yet — stay pending
        const { error } = await supabase.from('ddp_shipments').update({
          freight_cost_aud: cost,
          ss_order_id: hit.order_id,
          ss_carrier: hit.carrier_name ?? hit.carrier ?? null,
          freight_matched_at: new Date().toISOString(),
          // Starshipit fills the tracking gap when Shopify had none
          ...(local.tracking_number ? {} : { tracking_number: hit.tracking_number ?? null }),
          updated_at: new Date().toISOString(),
        }).eq('shopify_order_id', local.shopify_order_id);
        if (error) freightMissing++; else freightMatched++;
      }
    }

    // ════════════════════════════ 3. ZONOS ══════════════════════════════════
    const zKey = Deno.env.get('ZONOS_API_KEY');
    let zonosMatched = 0, zonosUnmatched = 0;
    if (zKey) {
      const { data: rows } = await supabase.from('ddp_shipments')
        .select('shopify_order_id, tracking_number, zonos_matched_at')
        .not('tracking_number', 'is', null);
      const byTracking = new Map((rows ?? []).map((r) => [r.tracking_number, r]));

      const unmatchedRows: Record<string, unknown>[] = [];
      let after: string | null = null;
      const zonosPage = (a: string | null) => fetch('https://api.zonos.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', credentialToken: zKey },
        body: JSON.stringify({
          query: `query($f: OrdersFilter, $n: Int, $a: String) {
            orders(filter: $f, first: $n, after: $a) {
              edges { cursor node {
                createdAt destinationCountryCode currencyCode trackingNumbers
                amountSubtotals { duties taxes fees }
              } }
              pageInfo { hasNextPage endCursor }
            } }`,
          variables: {
            f: { between: { after: `${since}T00:00:00Z`, before: new Date().toISOString() } },
            n: 50, a,
          },
        }),
      });
      for (let page = 0; page < 100; page++) {
        // Zonos rate-limits by query complexity — pace the pages and retry once.
        await new Promise((r) => setTimeout(r, 250));
        let res = await zonosPage(after);
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 2500));
          res = await zonosPage(after);
          if (!res.ok) break;
        }
        const data = (await res.json())?.data?.orders;
        if (!data) break;
        for (const e of data.edges ?? []) {
          const nOrd = e.node;
          if (!COUNTRIES.has(nOrd?.destinationCountryCode)) continue;
          const sub = nOrd.amountSubtotals ?? {};
          const track = (nOrd.trackingNumbers ?? []).find((t: unknown) => typeof t === 'string');
          if (!track) continue;
          const local = byTracking.get(track);
          if (local) {
            const { error } = await supabase.from('ddp_shipments').update({
              zonos_duty_aud: num(sub.duties),
              zonos_tax_aud: num(sub.taxes),
              zonos_fee_aud: num(sub.fees),
              zonos_matched_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('shopify_order_id', local.shopify_order_id);
            if (!error) zonosMatched++;
          } else {
            zonosUnmatched++;
            unmatchedRows.push({
              tracking_number: track,
              country_code: nOrd.destinationCountryCode,
              zonos_duty_aud: num(sub.duties),
              zonos_tax_aud: num(sub.taxes),
              zonos_fee_aud: num(sub.fees),
              zonos_created_at: nOrd.createdAt,
              seen_at: new Date().toISOString(),
            });
          }
        }
        if (!data.pageInfo?.hasNextPage) break;
        after = data.pageInfo.endCursor;
      }
      // Derived cache: rebuild wholesale (NOT stock data; replacing is safe).
      await supabase.from('ddp_zonos_unmatched').delete().gte('seen_at', '1970-01-01');
      if (unmatchedRows.length) await supabase.from('ddp_zonos_unmatched').upsert(unmatchedRows, { onConflict: 'tracking_number' });
    }

    return json({
      success: true,
      window: { since },
      shopify: { scanned, ddpOrders: shopifyRows.length },
      starshipit: { matched: freightMatched, failed: freightMissing, connected: !!(ssKey && ssSub) },
      zonos: { matched: zonosMatched, unmatched: zonosUnmatched, connected: !!zKey },
    });
  } catch (e) {
    return json({ success: false, message: String(e) }, 500);
  }
});
