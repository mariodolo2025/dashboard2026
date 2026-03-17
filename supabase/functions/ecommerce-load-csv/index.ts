import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const BUCKET = "ecom";
// Try multiple filenames (date range may vary)
const SHOPIFY_FILES = [
  "Orders by day MARIO DASH 2026 - 2025-07-01 - 2026-03-16.csv",
  "Orders by day MARIO DASH 2026 - 2025-07-01 - 2026-02-28.csv",
];
const META_FILE = "Mario-dash-2026.csv";
const AUD_TO_USD = 0.65;
const ADMIN_EMAILS = ["mario@dolo.com.au"];

/** Map Order checkout currency → market: USD→usa, AUD→australia, else→other */
function currencyToMarket(currency: string): "usa" | "australia" | "other" {
  const c = (currency || "").toUpperCase().trim();
  if (c === "USD") return "usa";
  if (c === "AUD") return "australia";
  return "other";
}

/** Convert amount to USD (approximate). Used for backfill consistency. */
function toUsd(amount: number, currency: string): number {
  const c = (currency || "").toUpperCase().trim();
  if (c === "USD") return amount;
  if (c === "AUD") return amount * AUD_TO_USD;
  // Common rates to USD (approx)
  const rates: Record<string, number> = {
    EUR: 1.08, GBP: 1.27, CAD: 0.74, CHF: 1.13, SGD: 0.74, HKD: 0.13,
    JPY: 0.0067, CNY: 0.14, KRW: 0.00075, INR: 0.012, MYR: 0.22, THB: 0.029,
    PLN: 0.25, CZK: 0.044, SEK: 0.096, DKK: 0.14, NOK: 0.09, SAR: 0.27,
    AED: 0.27, QAR: 0.27, ILS: 0.27, EGP: 0.02, PHP: 0.017, IDR: 0.000063,
    BND: 0.74, PEN: 0.26, COP: 0.00024, MXN: 0.06, BRL: 0.2, RON: 0.22,
    BGN: 0.55, HUF: 0.0027, RSD: 0.009, UAH: 0.025, KZT: 0.0021,
  };
  const rate = rates[c] ?? 0.5; // fallback for unknown
  return amount * rate;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Parse CSV leniently: skip rows with wrong column count (e.g. summary row) */
function parseCSV(text: string): Record<string, string>[] {
  const raw = parse(text, { skipFirstRow: false }) as string[][];
  if (raw.length < 2) return [];
  const headers = raw[0].map((h) => String(h || "").trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || row.length !== headers.length) continue; // skip summary / malformed rows
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      if (headers[j]) obj[headers[j]] = String(row[j] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const startMs = Date.now();
  const result: { shopify_days: number; meta_days: number; meta_top_ads: number; meta_daily_ads: number; errors: string[] } = {
    shopify_days: 0,
    meta_days: 0,
    meta_top_ads: 0,
    meta_daily_ads: 0,
    errors: [],
  };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Authorization required" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: userError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !user?.email) {
      return jsonResponse({ error: "Invalid session" }, 401);
    }

    if (!ADMIN_EMAILS.includes(user.email.toLowerCase())) {
      return jsonResponse({ error: "Admin only" }, 403);
    }

    // Get store_url from credentials
    const { data: shopifyCreds } = await supabase
      .from("api_credentials")
      .select("store_url")
      .eq("provider", "shopify")
      .maybeSingle();
    let storeUrl = (shopifyCreds?.store_url || "mario-dash.myshopify.com") as string;
    if (storeUrl.startsWith("http")) storeUrl = storeUrl.replace(/^https?:\/\//, "").split("/")[0];
    if (!storeUrl.includes(".")) storeUrl += ".myshopify.com";

    // ─── Download & parse Shopify ─────────────────────────────────────────
    let shopifyBlob: Blob | null = null;
    let shopifyErr: { message: string } | null = null;
    for (const f of SHOPIFY_FILES) {
      const res = await supabase.storage.from(BUCKET).download(f);
      if (res.data) {
        shopifyBlob = res.data;
        break;
      }
      shopifyErr = res.error;
    }

    if (!shopifyBlob) {
      result.errors.push(`Shopify: ${shopifyErr?.message || "File not found"}`);
    } else {
      const shopifyText = await shopifyBlob.text();
      const shopifyRows = parseCSV(shopifyText);
      const dateCol = shopifyRows[0]?.Month ? "Month" : shopifyRows[0]?.Day ? "Day" : "Month";
      const hasCurrency = shopifyRows[0] && "Order checkout currency" in shopifyRows[0];

      if (hasCurrency) {
        // Per-market backfill: group by (date, market), convert to USD
        const dailyByMarket: Record<string, Record<string, { orders: number; revenueUsd: number }>> = {};
        for (const r of shopifyRows) {
          const dateStr = r[dateCol] || r.Day || r.Month;
          if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).slice(0, 10))) continue;
          const date = String(dateStr).slice(0, 10);
          const currency = String(r["Order checkout currency"] || "").trim();
          const market = currencyToMarket(currency);
          const orders = parseInt(String(r.Orders || r["Orders"] || 0), 10) || 0;
          const revenue = parseFloat(String(r["Total sales"] || 0).replace(/,/g, "")) || 0;
          const revenueUsd = toUsd(revenue, currency);
          if (!dailyByMarket[date]) dailyByMarket[date] = {};
          if (!dailyByMarket[date][market]) dailyByMarket[date][market] = { orders: 0, revenueUsd: 0 };
          dailyByMarket[date][market].orders += orders;
          dailyByMarket[date][market].revenueUsd += revenueUsd;
        }
        const shopifyUpsert: Array<{ date: string; store_url: string; market: string; order_count: number; total_revenue: number; currency: string }> = [];
        for (const [date, markets] of Object.entries(dailyByMarket)) {
          for (const [market, d] of Object.entries(markets)) {
            shopifyUpsert.push({
              date,
              store_url: storeUrl,
              market,
              order_count: d.orders,
              total_revenue: Math.round(d.revenueUsd * 100) / 100,
              currency: "USD",
            });
          }
        }
        if (shopifyUpsert.length > 0) {
          const { error } = await supabase.from("ecommerce_shopify_daily").upsert(shopifyUpsert, {
            onConflict: "date,store_url,market",
          });
          if (error) result.errors.push(`Shopify upsert: ${error.message}`);
          else result.shopify_days = shopifyUpsert.length;
        }
      } else {
        // Legacy: aggregate all into market="all"
        const daily: Record<string, { orders: number; revenue: number }> = {};
        for (const r of shopifyRows) {
          const dateStr = r[dateCol] || r.Day || r.Month;
          if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).slice(0, 10))) continue;
          const date = String(dateStr).slice(0, 10);
          const orders = parseInt(String(r.Orders || r["Orders"] || 0), 10) || 0;
          const revenue = parseFloat(String(r["Total sales"] || 0).replace(/,/g, "")) || 0;
          if (!daily[date]) daily[date] = { orders: 0, revenue: 0 };
          daily[date].orders += orders;
          daily[date].revenue += revenue;
        }
        const shopifyUpsert = Object.entries(daily).map(([date, d]) => ({
          date,
          store_url: storeUrl,
          market: "all",
          order_count: d.orders,
          total_revenue: Math.round(d.revenue * 100) / 100,
          currency: "USD",
        }));
        if (shopifyUpsert.length > 0) {
          const { error } = await supabase.from("ecommerce_shopify_daily").upsert(shopifyUpsert, {
            onConflict: "date,store_url,market",
          });
          if (error) result.errors.push(`Shopify upsert: ${error.message}`);
          else result.shopify_days = shopifyUpsert.length;
        }
      }
    }

    // ─── Download & parse Meta ────────────────────────────────────────────
    const { data: metaBlob, error: metaErr } = await supabase.storage
      .from(BUCKET)
      .download(META_FILE);

    if (metaErr || !metaBlob) {
      result.errors.push(`Meta: ${metaErr?.message || "File not found"}`);
    } else {
      const metaText = await metaBlob.text();
      const metaRows = parseCSV(metaText);

      const dailyByAccount: Record<string, Record<string, { spend: number; impressions: number; clicks: number }>> = {};
      const adByAccount: Record<string, Record<string, { spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number; campaign?: string }>> = {};
      const dailyAdsByKey: Record<string, { date: string; account_id: string; ad_id: string; ad_name: string; campaign_name: string; spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number }> = {};

      for (const r of metaRows) {
        const accountIdRaw = r["Account ID"];
        if (!accountIdRaw || !/^\d+$/.test(String(accountIdRaw).trim())) continue;
        const accountId = `act_${String(accountIdRaw).trim()}`;
        const dateStr = r.Day || r["Day"];
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).slice(0, 10))) continue;
        const date = String(dateStr).slice(0, 10);

        const currency = (r.Currency || r["Currency"] || "USD").toUpperCase();
        let spend = parseFloat(String(r["Amount spent"] || 0).replace(/,/g, "")) || 0;
        if (currency === "AUD") spend *= AUD_TO_USD;

        const impressions = parseInt(String(r.Impressions || r["Impressions"] || 0).replace(/,/g, ""), 10) || 0;
        const clicks = parseInt(String(r["Link clicks"] || 0).replace(/,/g, ""), 10) || 0;
        const purchases = parseInt(String(r.Purchases || r["Purchases"] || 0).replace(/,/g, ""), 10) || 0;
        const purchaseValue = parseFloat(String(r["Purchases conversion value"] || r["Purchase value"] || 0).replace(/,/g, "")) || 0;
        const adName = r["Ad name"] || "Unnamed";
        const campaign = r["Campaign name"] || "";

        if (!dailyByAccount[accountId]) dailyByAccount[accountId] = {};
        if (!dailyByAccount[accountId][date]) dailyByAccount[accountId][date] = { spend: 0, impressions: 0, clicks: 0 };
        dailyByAccount[accountId][date].spend += spend;
        dailyByAccount[accountId][date].impressions += impressions;
        dailyByAccount[accountId][date].clicks += clicks;

        if (!adByAccount[accountId]) adByAccount[accountId] = {};
        if (!adByAccount[accountId][adName]) {
          adByAccount[accountId][adName] = { spend: 0, impressions: 0, clicks: 0, purchases: 0, purchase_value: 0, campaign: campaign || undefined };
        }
        const ad = adByAccount[accountId][adName];
        ad.spend += spend;
        ad.impressions += impressions;
        ad.clicks += clicks;
        ad.purchases += purchases;
        ad.purchase_value += purchaseValue;

        const adId = `csv-${accountId}-${adName.replace(/\W/g, "_")}`;
        const dailyKey = `${date}|${accountId}|${adId}`;
        if (!dailyAdsByKey[dailyKey]) {
          dailyAdsByKey[dailyKey] = {
            date,
            account_id: accountId,
            ad_id: adId,
            ad_name: adName,
            campaign_name: campaign || "",
            spend: 0,
            impressions: 0,
            clicks: 0,
            purchases: 0,
            purchase_value: 0,
          };
        }
        const da = dailyAdsByKey[dailyKey];
        da.spend += spend;
        da.impressions += impressions;
        da.clicks += clicks;
        da.purchases += purchases;
        da.purchase_value += purchaseValue;
      }

      const metaUpsert: Array<{ date: string; account_id: string; spend: number; impressions: number; clicks: number }> = [];
      for (const [accId, dates] of Object.entries(dailyByAccount)) {
        for (const [date, d] of Object.entries(dates)) {
          metaUpsert.push({
            date,
            account_id: accId,
            spend: Math.round(d.spend * 100) / 100,
            impressions: d.impressions,
            clicks: d.clicks,
          });
        }
      }

      if (metaUpsert.length > 0) {
        const { error } = await supabase.from("ecommerce_meta_daily").upsert(metaUpsert, {
          onConflict: "date,account_id",
        });
        if (error) result.errors.push(`Meta upsert: ${error.message}`);
        else result.meta_days = metaUpsert.length;
      }

      const dailyAdsRows = Object.values(dailyAdsByKey)
        .filter((d) => d.spend > 0)
        .map((d) => ({
          date: d.date,
          account_id: d.account_id,
          ad_id: d.ad_id,
          ad_name: d.ad_name,
          campaign_name: d.campaign_name || null,
          spend: Math.round(d.spend * 100) / 100,
          impressions: d.impressions,
          clicks: d.clicks,
          purchases: d.purchases,
          purchase_value: Math.round(d.purchase_value * 100) / 100,
        }));
      if (dailyAdsRows.length > 0) {
        const { error: dailyAdsErr } = await supabase.from("ecommerce_meta_daily_ads").upsert(dailyAdsRows, {
          onConflict: "date,account_id,ad_id",
        });
        if (dailyAdsErr) result.errors.push(`Meta daily ads: ${dailyAdsErr.message}`);
        else result.meta_daily_ads = dailyAdsRows.length;
      }

      // Top ads: use CSV data ONLY (replace, don't merge - merging caused double-counting)
      for (const accountId of Object.keys(adByAccount)) {
        const csvAds = Object.entries(adByAccount[accountId])
          .map(([adName, d]) => ({
            ad_id: `csv-${accountId}-${adName.replace(/\W/g, "_")}`,
            ad_name: adName,
            spend: Math.round(d.spend * 100) / 100,
            impressions: d.impressions,
            clicks: d.clicks,
            purchases: d.purchases,
            purchase_value: Math.round(d.purchase_value * 100) / 100,
            permalink: null as string | null,
            campaign_name: d.campaign || null,
          }))
          .filter((a) => a.spend > 0);

        const top3 = Array.from(csvAds)
          .sort((a, b) => b.spend - a.spend)
          .slice(0, 3);

        // Replace (don't merge): delete existing for this account, then insert fresh
        const { error: delErr } = await supabase.from("ecommerce_meta_top_ads").delete().eq("account_id", accountId);
        if (delErr) {
          result.errors.push(`Top ads delete ${accountId}: ${delErr.message}`);
        } else {
          for (let i = 0; i < top3.length; i++) {
            const a = top3[i];
            const row = {
              account_id: accountId,
              ad_id: a.ad_id,
              ad_name: a.ad_name,
              spend: a.spend,
              impressions: a.impressions,
              clicks: a.clicks,
              purchases: Math.round(a.purchases || 0),
              purchase_value: Math.round((a.purchase_value || 0) * 100) / 100,
              permalink: a.permalink,
              campaign_name: a.campaign_name || null,
              rank: i + 1,
            };
            const { error: insErr } = await supabase.from("ecommerce_meta_top_ads").insert(row);
            if (insErr) {
              result.errors.push(`Top ads insert ${a.ad_name}: ${insErr.message}`);
            } else {
              result.meta_top_ads += 1;
            }
          }
        }
      }
    }

    const durationMs = Date.now() - startMs;
    await supabase.from("ecommerce_sync_log").insert({
      status: result.errors.length === 0 ? "success" : "partial",
      records_synced: { shopify_days: result.shopify_days, meta_days: result.meta_days, meta_top_ads: result.meta_top_ads, meta_daily_ads: result.meta_daily_ads },
      errors: result.errors,
      duration_ms: durationMs,
    });

    return jsonResponse({
      success: result.errors.length === 0,
      ...result,
      duration_ms: durationMs,
    });
  } catch (err) {
    console.error("ecommerce-load-csv:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error", success: false },
      500
    );
  }
});
