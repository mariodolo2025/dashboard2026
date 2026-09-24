// ============================================================================
// dashboard-data — the front page and By Channel, straight from the database
// ============================================================================
// Mario, 2026-09-24: "audita porque hay info que no esta mostrando en by channel
// o en la portada del dashboard", then: "implementa la 1".
//
// WHAT WAS WRONG. Those two screens read parse-csv-data, which rebuilds an
// 11.6 MB parsed-snapshot.json out of five CSVs. Those CSVs are themselves
// written FROM this database by shopify-export-csv, aim2026-generate-sales-csv
// and meta-export-csv. So the round trip was:
//
//     database → CSV in storage → parse → 11.6 MB JSON → screen
//
// On 2026-09-21 the rebuild stopped fitting in an edge function: the Unleashed
// CSV had grown to 26.6 MB, and the step died with "not enough compute
// resources" on every run after parsing 26,643 Shopify records. The read path
// kept serving the last good snapshot, so By Channel and the front page froze
// on 21-Sep while E-commerce — which reads the database — stayed current. By
// Channel showed A$27,248 for 21–24 Sep, which is 21-Sep on its own.
//
// WHAT THIS DOES. The same five arrays, same field names, same units, built by
// querying the tables the CSVs were generated from. No file, nothing to rebuild,
// nothing to grow stale. It is also DATE-BOUNDED: the screens already send the
// range they are showing, and the old path ignored it and shipped all history.
//
// FAITHFULNESS IS THE WHOLE POINT. Every mapping below mirrors what
// parse-csv-data did to the CSV columns, including the quirks:
//   - Shopify netSales is taken EX-TAX with the same k = 1 − taxes/(net+ship),
//     because Australian and European shelf prices carry tax inside them.
//   - The Unleashed "Customer Type = Web" filter keeps its exception for the
//     three *-OnlineSale customers.
//   - channel/brand are derived from the customer name by the same rules.
// The numbers must not move. A window that exists in both paths should tie out.
//
// oldShopify and costs still come from their CSVs: both are frozen and tiny
// (0.23 MB and 0.02 MB), old-shopify-sales.csv has no table behind it, and
// costs.csv is the COGS basis By Channel has always used — swapping it for
// product_cost_china would silently change every margin on the screen.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { parse } from 'https://deno.land/std@0.224.0/csv/mod.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, apikey, authorization, x-client-info',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const BUCKET = 'csv-files';
const PAGE = 1000;   // PostgREST caps every read at 1000 rows and says nothing.

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cleanNumber = (v: unknown) => {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Same three buckets the CSV parser used. Anything else is "Other". */
const regionOf = (country: unknown): string => {
  const c = String(country ?? '').toLowerCase().trim();
  if (c === 'us' || c === 'united states' || c === 'usa') return 'USA';
  if (c === 'au' || c === 'australia') return 'Australia';
  return 'Other';
};

/** Unchanged from parse-csv-data: the customer name decides the channel. */
const getChannelAndBrand = (customer: string): { channel: string; brand: string } => {
  if (!customer || customer.trim() === '') return { channel: 'Unclassified', brand: 'Unknown' };
  const c = customer.trim().toLowerCase();
  if (c.includes('shop sale')) return { channel: 'Shop sale', brand: 'Pesado' };
  if (c.endsWith('-onlinesale')) {
    if (c.startsWith('dolo-')) return { channel: 'Web', brand: 'Dolo' };
    if (c.startsWith('artisanbarista-')) return { channel: 'Web', brand: 'The Artisan Barista' };
    if (c.startsWith('pesado-')) return { channel: 'Web', brand: 'Pesado' };
  }
  return { channel: 'B2B', brand: 'B2B' };
};

/**
 * Read every row of a date-bounded query, page by page.
 *
 * BY KEY, NOT BY OFFSET, wherever the source has a unique column (`keyCol`).
 * Mario, 2026-09-25: "a veces tambien falla al cargar la primera vez", with a
 * 500 on the front page. The cause was aim2026_demand_detail: 194,754 rows, no
 * index on order_date, so every page was a full scan — and `.range(off, …)`
 * asked for thirteen of them to cover one month. Postgres re-walked and re-
 * sorted the same 12,611 rows once per page, 1.37 s each, and whichever page
 * was unlucky got cut off by the statement timeout. Warm cache: it just fit.
 * Cold: it did not. Hence "sometimes".
 *
 * Paging by key asks for rows after the last id seen, so each page starts
 * where the previous one ended and nothing is walked twice. The index added in
 * 20260925090000 is what makes both halves cheap.
 *
 * Without a keyCol — shopify_sales_by_variant is a GROUP BY view with no
 * unique column, and skipping by a repeated order_date would drop rows — it
 * falls back to offsets. That one is small (2,732 rows for a month) and its
 * base table is indexed on (order_date, sku, country).
 */
async function readAll(
  supabase: any, table: string, cols: string, dateCol: string,
  from: string | null, to: string | null, keyCol: string | null = null,
): Promise<any[]> {
  const out: any[] = [];
  const bound = (q: any) => {
    if (from) q = q.gte(dateCol, from);
    if (to) q = q.lte(dateCol, to);
    return q;
  };

  if (keyCol) {
    let after: number | string | null = null;
    for (;;) {
      let q = bound(supabase.from(table).select(cols).order(keyCol, { ascending: true }).limit(PAGE));
      if (after !== null) q = q.gt(keyCol, after);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      if (!data || data.length === 0) break;
      out.push(...data);
      if (data.length < PAGE) break;
      after = data[data.length - 1][keyCol];
      // A page that comes back without its key would loop for ever.
      if (after === null || after === undefined) throw new Error(`${table}: ${keyCol} missing from the page`);
    }
    return out;
  }

  for (let off = 0; ; off += PAGE) {
    const { data, error } = await bound(
      supabase.from(table).select(cols).order(dateCol, { ascending: true }).range(off, off + PAGE - 1));
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const t0 = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    // STORE DAYS in, store days out. The screens send 'yyyy-MM-dd' — the day the
    // picker shows — because they are the only side that knows the viewer's
    // timezone. They used to send toISOString(), and slicing the date off that
    // in Brisbane moved "to = 25 Sep" back to the 24th: every range quietly lost
    // its last day. An ISO instant is still tolerated so an old client or a
    // manual call does not break, but it carries that same ambiguity.
    const day = (v: unknown) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null);
    const from = day(body?.startDate);
    const to = day(body?.endDate);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // ── FX: AUD per 1 USD, by month, exactly as the CSV path resolved it ────
    const { data: fxRows } = await supabase.from('currency_exchange_rates').select('year, month, rate');
    const rateMap: Record<string, number> = {};
    for (const r of fxRows ?? []) rateMap[`${r.year}-${r.month}`] = num(r.rate);
    const rateFor = (d: Date | null) => (d ? rateMap[`${d.getFullYear()}-${d.getMonth() + 1}`] ?? 1.54 : 1.54);

    const readCsv = async (name: string): Promise<string | null> => {
      const { data, error } = await supabase.storage.from(BUCKET).download(name);
      if (error || !data) return null;
      return await data.text();
    };

    // Everything below is independent, so it goes out at once. Run in sequence
    // a four-day window still took ~5s of pure round trips, which is what made
    // changing the period feel broken.
    const [uRaw, sRaw, mRaw, oldText, costText] = await Promise.all([
      readAll(
      supabase, 'aim2026_demand_detail',
      'id, order_date, sku, customer, quantity, amount, status, warehouse, product_group, customer_type',
      'order_date', from, to, 'id'),
      readAll(
        supabase, 'shopify_sales_by_variant',
        'order_date, sku, country, quantity, net_aud, taxes_aud, shipping_aud',
        'order_date', from, to),
      readAll(
        supabase, 'meta_ads_daily', 'id, date, currency, spend, conversion_value', 'date', from, to, 'id'),
      readCsv('old-shopify-sales.csv'),
      readCsv('costs.csv'),
    ]);

    let droppedWeb = 0;
    const unleashed = uRaw.filter((r: any) => {
      const t = String(r.customer_type ?? '').trim().toLowerCase();
      const name = String(r.customer ?? '').trim().toLowerCase();
      if (t !== 'web') return true;
      // The three storefront customers are Web by type but ARE the web channel.
      const online = name.endsWith('-onlinesale') &&
        (name.startsWith('dolo-') || name.startsWith('artisanbarista-') || name.startsWith('pesado-'));
      if (!online) droppedWeb++;
      return online;
    }).map((r: any) => {
      const { channel, brand } = getChannelAndBrand(String(r.customer ?? ''));
      return {
        orderDate: r.order_date,
        product: r.sku ?? '',
        customer: r.customer ?? '',
        quantity: num(r.quantity),
        subTotal: num(r.amount),
        productGroup: r.product_group ?? '',
        channel, brand,
        warehouse: r.warehouse ?? '',
        status: String(r.status ?? '').trim(),
      };
    });

    // ── Shopify: shopify_sales_by_variant, the table shopify-export-csv is
    //    written from. AUD. netSales is taken EX-TAX with the same factor the
    //    CSV parser applied, because AU/EU shelf prices include the tax and the
    //    screens list "Taxes received" as its own line. ────────────────────
    const shopify = sRaw.map((r: any) => {
      const rawNet = num(r.net_aud), taxes = num(r.taxes_aud), shipping = num(r.shipping_aud);
      const base = rawNet + shipping;
      const k = base > 0 ? Math.min(1, Math.max(0, 1 - taxes / base)) : 1;
      return {
        date: r.order_date,
        netSales: Math.round(rawNet * k * 100) / 100,
        sku: r.sku ?? '',
        quantity: num(r.quantity),
        region: regionOf(r.country),
        taxes, shipping,
      };
    }).filter((r: any) => r.netSales > 0 || r.taxes > 0 || r.shipping > 0);

    // ── Meta: meta_ads_daily. USD accounts convert at the month's house rate,
    //    the same rule the CSV path used. ──────────────────────────────────
    const meta = mRaw.map((r: any) => {
      const d = r.date ? new Date(`${String(r.date).slice(0, 10)}T00:00:00`) : null;
      const currency = String(r.currency ?? 'AUD').toUpperCase();
      let spend = num(r.spend), spendUSD = 0;
      if (currency === 'USD') { spendUSD = spend; spend = spend * rateFor(d); }
      return { date: r.date, spend, spendUSD, currency, conversionValue: num(r.conversion_value) };
    });

    // ── The two frozen files. Small, historical, and no table stands behind
    //    them. costs.csv in particular is the COGS basis this screen has always
    //    used; reading product_cost_china instead would move every margin. ──
    let oldShopify: any[] = [];
    if (oldText) {
      const rows: string[][] = parse(oldText, { skipFirstRow: false });
      oldShopify = rows.slice(1).map((row) => ({
        date: row[3], netSales: cleanNumber(row[8]), region: regionOf(row[4]),
      })).filter((r) => r.date && r.netSales > 0)
        .filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
    }

    const costs: Record<string, number> = {};
    if (costText) {
      const rows: string[][] = parse(costText, { skipFirstRow: false });
      for (const row of rows.slice(1)) {
        const sku = String(row[0] ?? '').trim();
        const c = parseFloat(String(row[1]));
        if (sku && Number.isFinite(c) && c > 0) costs[sku] = c;
      }
    }

    console.log(
      `dashboard-data ${from ?? 'all'}..${to ?? 'all'} — unleashed ${unleashed.length} (web dropped ${droppedWeb}), ` +
      `shopify ${shopify.length}, meta ${meta.length}, oldShopify ${oldShopify.length}, costs ${Object.keys(costs).length}, ` +
      `${Date.now() - t0}ms`
    );

    return json({
      unleashed, shopify, oldShopify, meta, costs,
      source: 'database',
      window: { from, to },
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'failed';
    console.error('dashboard-data failed:', message);
    return json({ error: 'dashboard-data failed', details: message }, 500);
  }
});
