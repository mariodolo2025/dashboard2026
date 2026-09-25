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
// THEY DID MOVE, and it took Mario to see it (2026-09-25: "el csv en sale
// amount dice AUD, pero por ej en la SO-00020273 ese valor creo que es en usd",
// then "ya no confio en vos"). The first version of this function read Unleashed
// sales from aim2026_demand_detail instead of the table the CSV came from. That
// table is built for DEMAND: its `amount` is qty x UnitPrice in the order's own
// currency, before discounts, sign stripped, and it only starts in 2025. Over
// 1-25 Sep two of those errors almost cancelled — foreign-currency orders
// undercounted by A$41,420, discounts overcounted by A$47,152 — so the B2B total
// looked plausible while being built wrong. It also brought assembly consumption
// in as B2B. The earlier "1,847 rows both ways" check compared row counts, not
// money, and missed all of it.
//
// Unleashed sales now come from unleashed_sales_lines, the table the
// SalesEnquiryList CSV was written from: sub_total is Unleashed's BCLineTotal,
// AUD after discounts, signed; source 'frozen' holds 2024-07 to 2026-06 and
// 'api' everything since. The mapping is parse-csv-data's, field for field.
//
// oldShopify still comes from its CSV: frozen, tiny, and no table stands
// behind it.
//
// COSTS, since 2026-09-25 (Mario, after auditing the B2B COGS download with
// Codex: "1. si", then "A"). Two things were wrong with the COGS basis:
//
//   - It came from costs.csv, a file uploaded on 3-Aug and never touched
//     again. It predates the 9-Sep clean-up of 882 costs, has no entry for
//     some SKUs (so they cost $0 without saying so), and carries none of the
//     12.24% landing uplift that Mario's rule puts in every COGS.
//   - Every other COGS on the dashboard (AIM tab, margin, GMROI) is
//     Default Purchase Price x (1 + freight + duty + insurance). By Channel
//     was the one screen on a different basis.
//
// So costs are now read from aim2026_sku_parameters.product_cost_china (the
// Default Purchase Price the products sync keeps in step with Unleashed) and
// uplifted with aim2026_cost_config.landed_cost_rates — the same row and the
// same fallbacks aim2026-calc-kpis-v2 uses, so the two cannot drift apart.
// The screen stops subtracting the Xero inbound-freight lines, because that
// freight is now inside this uplift; see App.tsx.
//
// A missing or zero Default Purchase Price is NOT sent as a cost. Zero is
// not free, it is "nobody entered it"; the audit CSV says so per line.

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

// Lines on a B2B order that are charges, not goods. They carry a price in
// Unleashed and even a Default Purchase Price (Courier Fee: 18.94), but
// nothing leaves the shelf, so they have no cost of goods. What the courier
// bills Dolo for those deliveries is already on screen as
// "Freight & Courier — Outbound — B2B", from Xero. Mario, 2026-09-25:
// "quedan fuera". Compared case-insensitively.
const NOT_PRODUCTS = ['Courier Fee', 'Fee'];

// Same fallbacks as aim2026-calc-kpis-v2, so a missing config row cannot put
// the two COGS on different bases.
const RATE_FALLBACK = { freightRate: 0.0592, dutyRate: 0.05, insuranceRate: 0.0132 };

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
  where: ((q: any) => any) | null = null,
): Promise<any[]> {
  const out: any[] = [];
  const bound = (q: any) => {
    if (from) q = q.gte(dateCol, from);
    if (to) q = q.lte(dateCol, to);
    return where ? where(q) : q;
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
    const [uRaw, sRaw, mRaw, oldText, paramRows, rateRes] = await Promise.all([
      // Sales order lines only — no assembly consumption lives in this table.
      // The Web filter below is exact; this one is a cheap SUPERSET of it run
      // in the database, because ~95% of the lines are Shopify orders mirrored
      // into Unleashed under Web customers and the screen throws them away.
      // A month is ~14,000 lines before it and ~700 after.
      readAll(
        supabase, 'unleashed_sales_lines',
        'id, order_date, order_number, product_code, product, customer, quantity, sub_total, status, warehouse, product_group, customer_type',
        'order_date', from, to, 'id',
        (q) => q.in('source', ['frozen', 'api'])
          .or('customer_type.is.null,customer_type.not.ilike.web,customer.ilike.*-onlinesale')),
      readAll(
        supabase, 'shopify_sales_by_variant',
        'order_date, sku, country, quantity, net_aud, taxes_aud, shipping_aud',
        'order_date', from, to),
      readAll(
        supabase, 'meta_ads_daily', 'id, date, currency, spend, conversion_value', 'date', from, to, 'id'),
      readCsv('old-shopify-sales.csv'),
      readAll(supabase, 'aim2026_sku_parameters', 'id, sku, product_cost_china', 'sku', null, null, 'id'),
      supabase.from('aim2026_cost_config').select('config_data').eq('config_type', 'landed_cost_rates').maybeSingle(),
    ]);

    // SKUs the catalogue knows. A line whose code is not one of them AND equals
    // its own description is a charge line: Unleashed gives those no product
    // code and the sync stores the description in both columns ("B2B flat fee",
    // "B2B Pickup/Dropship"). Only used to label the audit CSV.
    const knownSkus = new Set((paramRows as any[]).map((p) => String(p.sku ?? '').trim()));

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
        // Order and Unleashed line id, so any row can be found in Unleashed
        // without guessing by date/customer/SKU/qty — 26 rows in 1-24 Sep
        // had more than one candidate that way. History loaded from the CSV
        // export (ids 'frozen-N') has neither.
        orderNumber: r.order_number ?? '',
        lineId: String(r.id ?? '').startsWith('frozen-') ? '' : (r.id ?? ''),
        product: r.product_code ?? '',
        isCharge: !knownSkus.has(String(r.product_code ?? '').trim()) && (r.product_code ?? '') === (r.product ?? ''),
        customer: r.customer ?? '',
        quantity: num(r.quantity),
        // AUD, after discounts, signed (credits stay negative), as the CSV had it.
        subTotal: num(r.sub_total),
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

    // ── Costs: Default Purchase Price x (1 + landing), per unit, AUD ──
    if (rateRes.error) throw new Error(`aim2026_cost_config: ${rateRes.error.message}`);
    const r0 = (rateRes.data?.config_data as any)?.default ?? {};
    const pick = (v: unknown, fb: number) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fb);
    const rates = {
      freightRate: pick(r0.freightRate, RATE_FALLBACK.freightRate),
      dutyRate: pick(r0.dutyRate, RATE_FALLBACK.dutyRate),
      insuranceRate: pick(r0.insuranceRate, RATE_FALLBACK.insuranceRate),
    };
    const landedRate = rates.freightRate + rates.dutyRate + rates.insuranceRate;
    const notProduct = new Set(NOT_PRODUCTS.map((n) => n.toLowerCase()));

    const costs: Record<string, number> = {};        // landed: what COGS uses
    const costsChina: Record<string, number> = {};   // bare, for the audit CSV
    for (const p of paramRows) {
      const sku = String(p.sku ?? '').trim();
      const china = Number(p.product_cost_china);
      if (!sku || notProduct.has(sku.toLowerCase())) continue;
      if (!Number.isFinite(china) || china <= 0) continue;   // missing, not free
      costsChina[sku] = china;
      costs[sku] = china * (1 + landedRate);
    }

    console.log(
      `dashboard-data ${from ?? 'all'}..${to ?? 'all'} — unleashed ${unleashed.length} (web dropped ${droppedWeb}), ` +
      `shopify ${shopify.length}, meta ${meta.length}, oldShopify ${oldShopify.length}, costs ${Object.keys(costs).length} ` +
      `(landed +${(landedRate * 100).toFixed(2)}%), ` +
      `${Date.now() - t0}ms`
    );

    return json({
      unleashed, shopify, oldShopify, meta, costs, costsChina,
      costBasis: {
        source: 'aim2026_sku_parameters.product_cost_china (Default Purchase Price, Unleashed)',
        landedRate, rates,
        notProducts: NOT_PRODUCTS,
      },
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
