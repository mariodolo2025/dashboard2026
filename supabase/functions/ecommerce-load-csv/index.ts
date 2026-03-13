import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const BUCKET = "ecom";
const SHOPIFY_FILE = "Orders by day MARIO DASH 2026 - 2025-07-01 - 2026-02-28.csv";
const META_FILE = "Mario-dash-2026.csv";
const AUD_TO_USD = 0.65;
const ADMIN_EMAILS = ["mario@dolo.com.au"];

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
    const { data: shopifyBlob, error: shopifyErr } = await supabase.storage
      .from(BUCKET)
      .download(SHOPIFY_FILE);

    if (shopifyErr || !shopifyBlob) {
      result.errors.push(`Shopify: ${shopifyErr?.message || "File not found"}`);
    } else {
      const shopifyText = await shopifyBlob.text();
      const shopifyRows = parseCSV(shopifyText);
      const dateCol = shopifyRows[0]?.Month ? "Month" : shopifyRows[0]?.Day ? "Day" : "Month";
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
        order_count: d.orders,
        total_revenue: Math.round(d.revenue * 100) / 100,
        currency: "USD",
      }));

      if (shopifyUpsert.length > 0) {
        const { error } = await supabase.from("ecommerce_shopify_daily").upsert(shopifyUpsert, {
          onConflict: "date,store_url",
        });
        if (error) result.errors.push(`Shopify upsert: ${error.message}`);
        else result.shopify_days = shopifyUpsert.length;
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

      // Top ads: aggregate by ad, merge with existing, upsert
      const { data: existingTopAds } = await supabase
        .from("ecommerce_meta_top_ads")
        .select("account_id, ad_id, ad_name, spend, impressions, clicks, purchases, purchase_value, permalink, campaign_name, rank")
        .order("account_id")
        .order("rank");

      const existingByAccount = new Map<string, Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number; permalink: string | null; campaign_name: string | null }>>();
      for (const row of existingTopAds || []) {
        const acc = row.account_id || "";
        if (!existingByAccount.has(acc)) existingByAccount.set(acc, []);
        existingByAccount.get(acc)!.push({
          ad_id: String(row.ad_id || ""),
          ad_name: String(row.ad_name || "Unnamed"),
          spend: Number(row.spend || 0),
          impressions: row.impressions || 0,
          clicks: row.clicks || 0,
          purchases: row.purchases ?? 0,
          purchase_value: Number(row.purchase_value || 0),
          permalink: row.permalink || null,
          campaign_name: row.campaign_name || null,
        });
      }

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
            source: "csv" as const,
          }))
          .filter((a) => a.spend > 0);

        const merged = new Map<string, { spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number; ad_id: string; ad_name: string; permalink: string | null; campaign_name: string | null }>();

        for (const a of csvAds) {
          merged.set(a.ad_name, {
            ad_id: a.ad_id,
            ad_name: a.ad_name,
            spend: a.spend,
            impressions: a.impressions,
            clicks: a.clicks,
            purchases: a.purchases,
            purchase_value: a.purchase_value,
            permalink: a.permalink,
            campaign_name: a.campaign_name,
          });
        }

        for (const ex of existingByAccount.get(accountId) || []) {
          const key = ex.ad_name;
          if (merged.has(key)) {
            const m = merged.get(key)!;
            m.spend += ex.spend;
            m.impressions += ex.impressions;
            m.clicks += ex.clicks;
            m.purchases += ex.purchases;
            m.purchase_value += ex.purchase_value;
            if (ex.permalink) m.permalink = ex.permalink;
            if (ex.ad_id && !ex.ad_id.startsWith("csv-")) m.ad_id = ex.ad_id;
            if (ex.campaign_name && !m.campaign_name) m.campaign_name = ex.campaign_name;
          } else {
            merged.set(key, {
              ad_id: ex.ad_id,
              ad_name: ex.ad_name,
              spend: ex.spend,
              impressions: ex.impressions,
              clicks: ex.clicks,
              purchases: ex.purchases,
              purchase_value: ex.purchase_value,
              permalink: ex.permalink,
              campaign_name: ex.campaign_name,
            });
          }
        }

        const top3 = Array.from(merged.values())
          .sort((a, b) => b.spend - a.spend)
          .slice(0, 3);

        for (let i = 0; i < top3.length; i++) {
          const a = top3[i];
          await supabase.from("ecommerce_meta_top_ads").upsert(
            {
              account_id: accountId,
              ad_id: a.ad_id,
              ad_name: a.ad_name,
              spend: a.spend,
              impressions: a.impressions,
              clicks: a.clicks,
              purchases: a.purchases,
              purchase_value: Math.round(a.purchase_value * 100) / 100,
              permalink: a.permalink,
              campaign_name: a.campaign_name || null,
              rank: i + 1,
            },
            { onConflict: "account_id,rank" }
          );
        }
        result.meta_top_ads += top3.length;
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
