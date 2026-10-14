// =============================================================================
// ddp-sync — fills ddp_shipments for the DDP Markets tab.
//
// Three passes over the window (default: 2026-08-01 → today, the life of the
// DDP European markets). Each pass writes ONLY its own columns so a partial
// run can never null out another source (the PostgREST full-row-upsert trap).
// Rows are never deleted.
//
//   1. Shopify  — orders shipped to DE / DK / CH / SE: what the CUSTOMER was charged
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
//   POST { "days": 14 }              → rolling window (the orchestrator's shape:
//                                      re-reads recent Shopify orders and recent
//                                      ZONOS records; Starshipit always retries
//                                      every pending order regardless of window)
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
// The market list is DATA now, in ddp_markets (migration 20260902090000) —
// read below, once, and shared with ddp_markets_dashboard and the tab. It used
// to be a hardcoded Set here, a second copy in the RPC ('CH' written in as a
// permanent exception) and a third in the tab; that is what let Switzerland be
// carried as a live DDP market for a week.
const FX_FALLBACK = 1.54; // USD→AUD, same fallback the rest of the project uses

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    // {"only":"freight"} — skip the ZONOS walk and spend the budget asking
    // Starshipit what each label cost. That pass is one HTTP call per order with
    // no bulk alternative, so sharing a 140s run with the other two passes left
    // it ~45 orders; the queue grew faster than it drained and the tab showed 8
    // of 86 orders priced. The orchestrator still calls the full sync 3x a day.
    //
    // It DOES still read the last 2 days of Shopify (a handful of pages). First
    // it skipped Shopify entirely, which meant an order placed after the
    // orchestrator's last run did not exist here until the next one - up to
    // nine hours - and an order that does not exist here cannot be priced, so a
    // label printed at 07:00 could not reach the tab until 13:00.
    const freightOnly = body?.only === 'freight';
    const days = Number(body?.days) || (freightOnly ? 2 : NaN);
    const rolling = Number.isFinite(days) && days > 0
      ? new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
      : null;
    const since: string = typeof body?.since === 'string' ? body.since
      : rolling && rolling > DDP_START ? rolling
      : DDP_START;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Wall-clock budget. Edge functions are cut at 150s idle; the USA (3,217
    // orders since 1-Aug) made a single-run backfill impossible, so every pass
    // that can be partial is: it does what fits, reports what is left, and the
    // next run (scheduled or manual) continues. Nothing is ever redone.
    const t0 = Date.now();
    const timeLeft = () => 140_000 - (Date.now() - t0);

    // PostgREST caps EVERY select at 1,000 rows and says nothing. Before the USA
    // no table here came near that; with 3,200 US orders the tracking map was
    // loading a third of the rows, and ZONOS reported the other two thirds as
    // orders that did not exist (57 "unmatched" of which 51 were in the table).
    // Read in pages of 1,000 until a short page.
    const readAll = async <T,>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> => {
      const out: T[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await build(from, from + 999);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) return out;
      }
    };

    // Which markets are live. Gates BOTH ends: which Shopify orders are picked
    // up and which ZONOS records are looked at. Refuse to run on an empty list
    // rather than quietly syncing nothing — a silent no-op here would read as
    // "no new orders" for days.
    const { data: marketRows, error: marketErr } = await supabase
      .from('ddp_markets').select('country_code').eq('active', true);
    if (marketErr) return json({ success: false, message: `ddp_markets: ${marketErr.message}` }, 500);
    if (!marketRows?.length) return json({ success: false, message: 'ddp_markets has no active market' }, 500);
    const COUNTRIES = new Set(marketRows.map((r) => r.country_code as string));

    // ── Monthly USD→AUD rates (currency_exchange_rates: rate = AUD per 1 USD) ──
    const { data: fxRows } = await supabase.from('currency_exchange_rates').select('year, month, rate');
    const fxByMonth = new Map<string, number>();
    for (const r of fxRows ?? []) fxByMonth.set(`${r.year}-${String(r.month).padStart(2, '0')}`, num(r.rate));
    const usdToAud = (isoDate: string): number => fxByMonth.get(isoDate.slice(0, 7)) || FX_FALLBACK;

    // ════════════════════════════ 1. SHOPIFY ════════════════════════════════
    type ShopRow = Record<string, unknown>;
    const shopifyRows: ShopRow[] = [];
    let scanned = 0;
    {
    const { data: creds } = await supabase
      .from('api_credentials').select('store_url, access_token').eq('provider', 'shopify').maybeSingle();
    if (!creds?.access_token) return json({ success: false, message: 'no shopify creds' }, 400);
    let store = String(creds.store_url).replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!store.includes('.')) store += '.myshopify.com';
    const shopifyHeaders = { 'X-Shopify-Access-Token': creds.access_token as string, 'Content-Type': 'application/json' };

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
    // Chunked: the USA turns this into thousands of rows per call. Every row
    // still carries the same key set, so no chunk can null out another
    // source's columns (the PostgREST full-row-upsert trap).
    for (let i = 0; i < shopifyRows.length; i += 500) {
      const { error } = await supabase.from('ddp_shipments')
        .upsert(shopifyRows.slice(i, i + 500), { onConflict: 'shopify_order_id' });
      if (error) return json({ success: false, message: `upsert: ${error.message}` }, 500);
    }
    }

    // ════════════════════════════ 2. STARSHIPIT ═════════════════════════════
    // Two facts shape this pass. (a) The bulk list /api/orders/shipped does NOT
    // carry the label price - Starshipit has an open feature request for
    // exactly that, and its OpenAPI schema for the endpoint lists order_id,
    // order_number, order_date, shipped_date, country, carrier, carrier_name,
    // tracking_number ... and no price - so the price needs one detail call per
    // order, no way round it. (b) The old approach spent TWO calls per order (a
    // search to find the order_id, then the detail) and died at 150s on 23
    // Canadian orders. Now: walk the shipped list in pages of 250 to learn
    // order_id + tracking for every pending order in bulk (a handful of calls
    // for the whole window), then spend what time is left on detail calls,
    // newest first. Whatever does not fit is reported as `remaining` and picked
    // up by the next run - the pending query is "freight still null", so no
    // order is ever fetched twice. Orders the list never shows (booked outside
    // Starshipit) fall back to the per-order search, still within budget.
    const ssKey = Deno.env.get('STARSHIPIT_API_KEY');
    const ssSub = Deno.env.get('STARSHIPIT_SUBSCRIPTION_KEY');
    let freightMatched = 0, freightMissing = 0, freightRemaining = 0, ssPages = 0, pendingTotal = 0, serviceBackfilled = 0, watched = 0, watchHit = 0;
    if (ssKey && ssSub) {
      const ssHeaders = { 'StarShipIT-Api-Key': ssKey, 'Ocp-Apim-Subscription-Key': ssSub };
      const ssGet = async (url: string): Promise<Response> => {
        await new Promise((r) => setTimeout(r, 150));
        let res = await fetch(url, { headers: ssHeaders });
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 1500));
          res = await fetch(url, { headers: ssHeaders });
        }
        return res;
      };

      // The SERVICE on the label, not just the carrier. Everything in the US
      // was "Australia Post" either way, so an IC13 express label and a
      // standard one were the same row and the IC13 rule (14-Oct-2026) could
      // not be measured at all. Starshipit names it carrier_service_code
      // ("IC13"); the other spellings are read too because the bulk list and
      // the detail endpoint do not always use the same key.
      const svcCode = (o: any): string | null =>
        o?.carrier_service_code ?? o?.service_code ?? o?.product_code ?? null;
      const svcName = (o: any): string | null =>
        o?.carrier_service_name ?? o?.service_name ?? o?.carrier_service ?? null;

      // Newest 1,000 pending per run (the drain order), plus the true backlog
      // size so the caller can tell how far it has to go.
      // Record that Starshipit was ASKED and had nothing (not found, or no label
      // cost yet). Only on a real answer - a failed request proves nothing and
      // the order must stay "awaiting". The tab reads this as freightChecked.
      const markChecked = (id: number) => supabase.from('ddp_shipments')
        .update({ freight_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('shopify_order_id', id);

      // Orders whose label we already priced before the service was being
      // recorded, inside the reach of a live service rule. Bounded on purpose:
      // a fixed 30 per run, and only while the budget is still untouched, so it
      // can never be the reason the main drain below starves. It empties by
      // itself - from now on freight and service are written together.
      const { data: segRows } = await supabase
        .from('ddp_service_segments').select('rule_from').eq('active', true);
      const ruleFloor = (segRows ?? [])
        .map((r) => String(r.rule_from))
        .sort()[0] ?? null;
      if (ruleFloor && timeLeft() > 110_000) {
        const { data: noSvc } = await supabase.from('ddp_shipments')
          .select('shopify_order_id, ss_order_id, order_name')
          .not('freight_cost_aud', 'is', null)
          .is('ss_service_code', null)
          .gte('order_date', ruleFloor)
          .order('order_date', { ascending: false })
          .limit(30);
        for (const row of noSvc ?? []) {
          if (timeLeft() < 95_000) break;
          if (!row.ss_order_id) continue;
          const dRes = await ssGet(`https://api.starshipit.com/api/orders?order_id=${row.ss_order_id}`);
          if (!dRes.ok) continue;
          const detail = (await dRes.json())?.order;
          const code = svcCode(detail);
          if (!code) continue;
          await supabase.from('ddp_shipments')
            .update({ ss_service_code: code, ss_service_name: svcName(detail), updated_at: new Date().toISOString() })
            .eq('shopify_order_id', row.shopify_order_id);
          serviceBackfilled++;
        }
      }

      const { count: pendingCount } = await supabase.from('ddp_shipments')
        .select('shopify_order_id', { count: 'exact', head: true })
        .is('freight_cost_aud', null);
      pendingTotal = pendingCount ?? 0;
      const retryBefore = new Date(Date.now() - 6 * 3600_000).toISOString();

      // DRAIN ORDER — the single thing that decides whether this pass is useful.
      //
      // It used to be order_date DESC: newest first. That is backwards. An order
      // placed today has not been packed yet, so Starshipit has no label price
      // to give; an order that has been waiting is precisely the one whose label
      // now exists. Every day's fresh orders piled onto the head of the queue
      // and ate the whole budget (~20-25 detail calls fit in a run), so the ones
      // that DID have a price were never reached. Measured 2026-09-11:
      // PSD#70657 sat at position 28 of 62 with its label sitting in Starshipit
      // since the 9th, last looked at on the 9th, showing "no label" ever since,
      // while the run before it spent every second on 10-Sep orders that had not
      // even shipped.
      //
      // Now, in order:
      //   1. orders that already carry a tracking number — they shipped, so a
      //      label exists and the call will come back with a price;
      //   2. within that, the ones longest since we last asked (never asked
      //      first), so nothing can starve however long the queue gets.
      // Orders with no tracking are still asked about, after the rest: a label
      // can exist in Starshipit before Shopify shows the tracking. They simply
      // stop being the reason the useful ones wait.
      const pendingSel = 'shopify_order_id, order_name, tracking_number, order_date, freight_checked_at';
      const notYet = `freight_checked_at.is.null,freight_checked_at.lt.${retryBefore}`;
      const [shipped, unshipped] = await Promise.all([
        supabase.from('ddp_shipments').select(pendingSel)
          .is('freight_cost_aud', null).not('tracking_number', 'is', null)
          .or(notYet)
          .order('freight_checked_at', { ascending: true, nullsFirst: true })
          .limit(1000),
        supabase.from('ddp_shipments').select(pendingSel)
          .is('freight_cost_aud', null).is('tracking_number', null)
          .or(notYet)
          .order('freight_checked_at', { ascending: true, nullsFirst: true })
          .limit(1000),
      ]);
      const pending = [...(shipped.data ?? []), ...(unshipped.data ?? [])];
      const pendingByName = new Map(pending.map((p) => [String(p.order_name), p]));

      // WATCH LIST — recent orders we asked about inside the last 6 hours and
      // that had no label then. The 6-hour wait exists so an order Starshipit
      // knows nothing about does not cost a call every run; but it also meant a
      // label printed one hour after we asked stayed invisible for five more.
      // Measured 15-Oct-2026: 53 US orders asked at 03:40-04:20 Brisbane, before
      // they were packed, could not come back before 09:40, while Mario was
      // printing their labels and watching the IC13 figure not move.
      //
      // These cost nothing extra: they are only acted on when they turn up in
      // the shipped list the walk below already reads in bulk. Turning up there
      // means a label exists, so the one detail call they then get is never a
      // wasted one. Bounded to the last 7 days of orders.
      const watchFloor = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data: watchRows } = await supabase.from('ddp_shipments').select(pendingSel)
        .is('freight_cost_aud', null)
        .gte('freight_checked_at', retryBefore)
        .gte('order_date', watchFloor)
        .limit(1000);
      const watch = watchRows ?? [];
      const watchByName = new Map(watch.map((w) => [String(w.order_name), w]));
      watched = watch.length;

      // (1) bulk discovery: order_number -> { order_id, tracking, carrier }
      type Hit = {
        order_id: number; tracking: string | null; carrier: string | null; price: number;
        service: string | null; serviceName: string | null;
      };
      const found = new Map<string, Hit>();
      const lookFor = [...pending, ...watch];
      if (lookFor.length) {
        // The real oldest pending DATE. Taking the last element would have done
        // when the list was sorted by date; it is now sorted by how long since
        // we asked, so the minimum has to be computed.
        const oldestPending = lookFor.reduce(
          (min, p) => { const d = String(p.order_date ?? '').slice(0, 10); return d && d < min ? d : min; },
          String(lookFor[0]?.order_date ?? since).slice(0, 10)
        );
        // The API does not promise to honour limit=250 or even `page` - the
        // first runs came back with one short page and the old rule "stop when a
        // page has fewer than 250" ended the walk there, sending every order
        // down the two-call search path. So: stop on an EMPTY page, on a page
        // that adds no order_id we have not seen (the API repeating itself), or
        // when the page is older than anything still pending. Never on size.
        const seenIds = new Set<string>();
        for (let page = 1; page <= 60 && timeLeft() > (freightOnly ? 30_000 : 70_000); page++) {
          const res = await ssGet(`https://api.starshipit.com/api/orders/shipped?limit=250&page=${page}`);
          if (!res.ok) break;
          const list: any[] = (await res.json())?.orders ?? [];
          ssPages++;
          if (!list.length) break;
          let fresh = 0;
          let oldestOnPage = '9999';
          for (const o of list) {
            const key = String(o?.order_id ?? o?.order_number ?? '');
            if (key) { if (seenIds.has(key)) continue; seenIds.add(key); fresh++; }
            const name = String(o?.order_number ?? '');
            const when = String(o?.order_date ?? o?.shipped_date ?? '').slice(0, 10);
            if (when && when < oldestOnPage) oldestOnPage = when;
            if ((pendingByName.has(name) || watchByName.has(name)) && !found.has(name)) {
              found.set(name, {
                order_id: o.order_id,
                tracking: o.tracking_number ?? null,
                carrier: o.carrier_name ?? o.carrier ?? null,
                service: svcCode(o),
                serviceName: svcName(o),
                // if the list ever starts carrying the price, use it and skip the detail call
                price: num(o?.total_shipping_price),
              });
            }
          }
          // Every pending order has been located: reading further buys nothing
          // and the seconds are worth more to the detail calls below, which are
          // what actually produce a price.
          if (found.size >= lookFor.length) break;
          // the list is newest-first: once a whole page predates our oldest
          // pending order there is nothing further back worth reading
          if (fresh === 0 || (oldestOnPage !== '9999' && oldestOnPage < oldestPending)) break;
        }
      }

      // (2) detail calls, inside the budget. Watched orders that just showed up
      // as shipped go FIRST: they are the freshest labels, the ones someone is
      // looking at the screen waiting for, and every one of them has a price.
      // A watched order NOT on the shipped list is skipped - no search call -
      // and waits out its 6 hours like before.
      const watchHits = watch.filter((w) => found.has(String(w.order_name)));
      watchHit = watchHits.length;
      for (const local of [...watchHits, ...pending]) {
        // Leave ZONOS a real slice: it has its own budget below, and a run that
        // spends everything on freight starves the pass that closes the orders.
        if (timeLeft() < (freightOnly ? 6_000 : 45_000)) { freightRemaining++; continue; }
        const name = String(local.order_name);
        let hit = found.get(name);
        if (!hit) {
          // not on the shipped list (booked outside Starshipit, or older than
          // the walk reached): the exact search, one order at a time
          const q = encodeURIComponent(name);
          const sRes = await ssGet(`https://api.starshipit.com/api/orders/search?phrase=${q}&limit=5`);
          if (!sRes.ok) { freightMissing++; continue; }
          const so = ((await sRes.json())?.orders ?? []).find((x: any) => x?.order_number === name);
          if (!so) { freightMissing++; await markChecked(local.shopify_order_id); continue; }
          hit = {
            order_id: so.order_id, tracking: so.tracking_number ?? null,
            carrier: so.carrier_name ?? so.carrier ?? null,
            service: svcCode(so), serviceName: svcName(so), price: 0,
          };
        }
        let cost = hit.price;
        if (!(cost > 0)) {
          const dRes = await ssGet(`https://api.starshipit.com/api/orders?order_id=${hit.order_id}`);
          if (!dRes.ok) { freightMissing++; continue; }
          const detail = (await dRes.json())?.order;
          cost = num(detail?.total_shipping_price);      // AUD (label price)
          if (!hit.tracking) hit.tracking = detail?.tracking_number ?? null;
          // The detail is the authority on the service: the bulk list does not
          // always carry it.
          hit.service = svcCode(detail) ?? hit.service;
          hit.serviceName = svcName(detail) ?? hit.serviceName;
        }
        if (!(cost > 0)) { freightMissing++; await markChecked(local.shopify_order_id); continue; }  // no label yet - stay pending, but say we looked
        const { error } = await supabase.from('ddp_shipments').update({
          freight_cost_aud: cost,
          ss_order_id: hit.order_id,
          ss_carrier: hit.carrier,
          // Only when we actually learnt it — writing null here would erase a
          // service a previous run had already recorded.
          ...(hit.service ? { ss_service_code: hit.service, ss_service_name: hit.serviceName } : {}),
          freight_matched_at: new Date().toISOString(),
          // Starshipit fills the tracking gap when Shopify had none
          ...(local.tracking_number ? {} : { tracking_number: hit.tracking }),
          updated_at: new Date().toISOString(),
        }).eq('shopify_order_id', local.shopify_order_id);
        if (error) freightMissing++; else freightMatched++;
      }
    }

    // ════════════════════════════ 3. ZONOS ══════════════════════════════════
    const zKey = Deno.env.get('ZONOS_API_KEY');
    let zonosMatched = 0, zonosUnmatched = 0, zonosTruncated = false;
    if (zKey && !freightOnly) {
      const rows = await readAll<{ shopify_order_id: number; tracking_number: string; zonos_matched_at: string | null }>(
        (from, to) => supabase.from('ddp_shipments')
          .select('shopify_order_id, tracking_number, zonos_matched_at')
          .not('tracking_number', 'is', null)
          .order('shopify_order_id')
          .range(from, to));
      const byTracking = new Map(rows.map((r) => [r.tracking_number, r]));

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
        // Budget: the 152s death of the first full-window run happened HERE -
        // the freight pass had a clock, this one did not. A truncated walk is
        // fine for matching (idempotent, the next run continues) but must NOT
        // be allowed to rebuild the unmatched cache from a partial view.
        if (timeLeft() < 8_000) { zonosTruncated = true; break; }
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
      // Derived cache: rebuild wholesale (NOT stock data; replacing is safe) -
      // but only from a COMPLETE walk. Half a walk would shrink the list to
      // whatever pages were reached and read as "problems solved".
      if (!zonosTruncated) {
        await supabase.from('ddp_zonos_unmatched').delete().gte('seen_at', '1970-01-01');
        if (unmatchedRows.length) await supabase.from('ddp_zonos_unmatched').upsert(unmatchedRows, { onConflict: 'tracking_number' });
      }
    }

    return json({
      success: true,
      mode: freightOnly ? 'freight-only' : 'full',
      window: { since },
      shopify: { scanned, ddpOrders: shopifyRows.length },
      starshipit: { matched: freightMatched, failed: freightMissing, remaining: freightRemaining, pendingTotal, pages: ssPages, serviceBackfilled, watched, watchHit, connected: !!(ssKey && ssSub) },
      zonos: { matched: zonosMatched, unmatched: zonosUnmatched, truncated: zonosTruncated, connected: !!zKey },
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    return json({ success: false, message: String(e) }, 500);
  }
});
