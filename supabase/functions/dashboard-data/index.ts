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
// ONE READ, since 2026-09-28. Mario: "me tiene los huevos al plato este error,
// hace meses que esta y nunca lo arreglas". 21 of 75 loads had failed in the
// previous 24 h, all with "unleashed_sales_lines: canceling statement due to
// statement timeout". This function used to page four tables through PostgREST,
// ~40 requests per period, each cancelled at 8 s; one slow page took the whole
// screen down, and a busy database (the 03:00 UTC sync, the 5-minute Shopify
// sync) made some page slow. Each earlier fix moved the slow spot rather than
// removing the pattern. Now every table is read by dashboard_data() in ONE
// statement, on indexes built for it (migration 20260928090000): a month in
// ~60 ms, a year in ~0.7 s, two years in ~3 s, measured in the database. The
// mapping below is unchanged, so the numbers are too.
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
 * One row per load in dashboard_load_log: how long it took, and why it failed
 * if it did. Mario found the 500s before anyone else did, for months; this is
 * so the Connections panel shows them first. Never throws — a load must not
 * fail because its own log line could not be written.
 */
async function logLoad(
  supabase: any,
  r: { from: string | null; to: string | null; ok: boolean; ms: number; dbMs?: number; unleashed?: number; shopify?: number; message?: string },
): Promise<void> {
  try {
    await supabase.from('dashboard_load_log').insert({
      from_day: r.from, to_day: r.to, ok: r.ok, elapsed_ms: r.ms, db_ms: r.dbMs ?? null,
      rows_unleashed: r.unleashed ?? null, rows_shopify: r.shopify ?? null,
      message: r.message ? r.message.slice(0, 500) : null,
    });
  } catch (_) { /* logging is best-effort */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  const t0 = Date.now();
  const range: { from: string | null; to: string | null } = { from: null, to: null };
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
    range.from = from; range.to = to;

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const readCsv = async (name: string): Promise<string | null> => {
      const { data, error } = await supabase.storage.from(BUCKET).download(name);
      if (error || !data) return null;
      return await data.text();
    };

    // One statement for everything that lives in the database, and the one
    // small frozen file alongside it. Nothing here pages: dashboard_data()
    // returns a single JSON value, so PostgREST's 1,000-row cap never applies,
    // and it carries its own 30 s statement timeout instead of the 8 s default.
    const tDb = Date.now();
    let dbMs = 0;
    const [rpc, oldText] = await Promise.all([
      supabase.rpc('dashboard_data', { p_from: from, p_to: to }).then((r: any) => { dbMs = Date.now() - tDb; return r; }),
      readCsv('old-shopify-sales.csv'),
    ]);
    if (rpc.error) throw new Error(`dashboard_data: ${rpc.error.message}`);
    const db = (rpc.data ?? {}) as any;
    // Rows arrive as ARRAYS (format 'arrays-v1', migration 20260928093000):
    // column names repeated on 30,000 rows were half of a two-year payload.
    // The column order below is the contract with that migration. The object
    // form is still read so a deploy can never meet the other half mid-way.
    const compact = db.format === 'arrays-v1';
    // Sales order lines only (no assembly consumption lives in that table).
    // In the compact form the database has already applied the exact Web rule
    // and decided is_charge; customer_type and the description do not travel.
    const uRaw: any[] = compact
      ? (db.unleashed ?? []).map((a: any[]) => ({
          id: a[0], order_date: a[1], order_number: a[2], product_code: a[3], is_charge: a[4] === true,
          customer: a[5], quantity: a[6], sub_total: a[7], status: a[8], warehouse: a[9], product_group: a[10],
        }))
      : (db.unleashed ?? []);
    const sRaw: any[] = compact
      ? (db.shopify ?? []).map((a: any[]) => ({
          order_date: a[0], sku: a[1], country: a[2], quantity: a[3], net_aud: a[4], taxes_aud: a[5], shipping_aud: a[6],
        }))
      : (db.shopify ?? []);
    const mRaw: any[] = db.meta ?? [];
    const paramRows: any[] = db.params ?? [];

    // ── FX: AUD per 1 USD, by month, exactly as the CSV path resolved it ────
    const rateMap: Record<string, number> = {};
    for (const r of db.fx ?? []) rateMap[`${r.year}-${r.month}`] = num(r.rate);
    const rateFor = (d: Date | null) => (d ? rateMap[`${d.getFullYear()}-${d.getMonth() + 1}`] ?? 1.54 : 1.54);

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
        isCharge: compact
          ? r.is_charge
          : !knownSkus.has(String(r.product_code ?? '').trim()) && (r.product_code ?? '') === (r.product ?? ''),
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
    const r0 = (db.landedRates as any) ?? {};
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

    await logLoad(supabase, { from, to, ok: true, ms: Date.now() - t0, dbMs, unleashed: unleashed.length, shopify: shopify.length });

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
    await logLoad(
      createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),
      { from: range.from, to: range.to, ok: false, ms: Date.now() - t0, message });
    return json({ error: 'dashboard-data failed', details: message }, 500);
  }
});
