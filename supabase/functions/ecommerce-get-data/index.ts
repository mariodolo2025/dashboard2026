import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

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

    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const daysParam = parseInt(url.searchParams.get("days") || "30", 10);
    const days = Math.min(90, Math.max(1, daysParam));
    const marketParam = url.searchParams.get("market") || "all";

    let since: string;
    let until: string;

    if (fromParam && toParam) {
      since = fromParam;
      until = toParam;
    } else {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      since = fromDate.toISOString().slice(0, 10);
      until = toDate.toISOString().slice(0, 10);
    }

    // ─── Shopify from cache (filter by market: all, usa, australia) ───────
    let shopifyRows: Array<{ date: string; store_url: string; market: string; order_count: number; total_revenue: number; currency: string }> | null = null;
    if (marketParam === "usa") {
      const { data } = await supabase
        .from("ecommerce_shopify_daily")
        .select("date, store_url, market, order_count, total_revenue, currency")
        .gte("date", since)
        .lte("date", until)
        .eq("market", "usa");
      shopifyRows = data;
    } else if (marketParam === "australia") {
      const { data } = await supabase
        .from("ecommerce_shopify_daily")
        .select("date, store_url, market, order_count, total_revenue, currency")
        .gte("date", since)
        .lte("date", until)
        .eq("market", "australia");
      shopifyRows = data;
    } else {
      const { data: perMarket } = await supabase
        .from("ecommerce_shopify_daily")
        .select("date, store_url, market, order_count, total_revenue, currency")
        .gte("date", since)
        .lte("date", until)
        .in("market", ["usa", "australia", "other"]);
      if (perMarket && perMarket.length > 0) {
        shopifyRows = perMarket;
      } else {
        const { data: legacy } = await supabase
          .from("ecommerce_shopify_daily")
          .select("date, store_url, market, order_count, total_revenue, currency")
          .gte("date", since)
          .lte("date", until)
          .eq("market", "all");
        shopifyRows = legacy;
      }
    }

    let shopify: { success: boolean; store_url?: string; period?: { from: string; to: string; days: number }; orders?: number; total_revenue?: number; aov?: number; currency?: string; from_cache?: boolean } = { success: false };

    if (shopifyRows && shopifyRows.length > 0) {
      const totalOrders = shopifyRows.reduce((s, r) => s + (r.order_count || 0), 0);
      const totalRevenue = shopifyRows.reduce((s, r) => s + Number(r.total_revenue || 0), 0);
      const storeUrl = shopifyRows[0]?.store_url || "";
      const currency = shopifyRows[0]?.currency || "USD";

      shopify = {
        success: true,
        store_url: storeUrl,
        period: { from: since, to: until, days },
        orders: totalOrders,
        total_revenue: Math.round(totalRevenue * 100) / 100,
        aov: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
        currency,
        from_cache: true,
      };
    }

    // ─── Meta from cache ─────────────────────────────────────────────────
    const { data: metaRows } = await supabase
      .from("ecommerce_meta_daily")
      .select("date, account_id, spend, impressions, clicks")
      .gte("date", since)
      .lte("date", until);

    const { data: topAdsRows } = await supabase
      .from("ecommerce_meta_top_ads")
      .select("account_id, ad_id, ad_name, spend, impressions, clicks, purchases, purchase_value, permalink, campaign_name, rank")
      .order("account_id")
      .order("rank");

    const { data: dailyAdsRows } = await supabase
      .from("ecommerce_meta_daily_ads")
      .select("date, account_id, ad_id, ad_name, campaign_name, spend, impressions, clicks, purchases, purchase_value")
      .gte("date", since)
      .lte("date", until);

    let meta: {
      success: boolean;
      period?: { from: string; to: string; days: number };
      total_spend?: number;
      total_impressions?: number;
      total_clicks?: number;
      accounts?: Array<{
        account_id: string;
        spend: number;
        impressions: number;
        clicks: number;
        top_ads_historical: Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases?: number; purchase_value?: number; permalink?: string; campaign_name?: string }>;
        top_ads_range: Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases?: number; purchase_value?: number; permalink?: string; campaign_name?: string }>;
      }>;
      from_cache?: boolean;
    } = { success: false };

    if (metaRows && metaRows.length > 0) {
      const totalSpend = metaRows.reduce((s, r) => s + Number(r.spend || 0), 0);
      const totalImpressions = metaRows.reduce((s, r) => s + (r.impressions || 0), 0);
      const totalClicks = metaRows.reduce((s, r) => s + (r.clicks || 0), 0);

      const byAccount = new Map<string, { spend: number; impressions: number; clicks: number }>();
      for (const r of metaRows) {
        const acc = r.account_id || "";
        if (!byAccount.has(acc)) byAccount.set(acc, { spend: 0, impressions: 0, clicks: 0 });
        const v = byAccount.get(acc)!;
        v.spend += Number(r.spend || 0);
        v.impressions += r.impressions || 0;
        v.clicks += r.clicks || 0;
      }

      const topHistoricalByAccount = new Map<string, Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases?: number; purchase_value?: number; permalink?: string; campaign_name?: string }>>();
      for (const r of topAdsRows || []) {
        const acc = r.account_id || "";
        if (!topHistoricalByAccount.has(acc)) topHistoricalByAccount.set(acc, []);
        topHistoricalByAccount.get(acc)!.push({
          ad_id: String(r.ad_id || ""),
          ad_name: String(r.ad_name || "Unnamed"),
          spend: Number(r.spend || 0),
          impressions: r.impressions || 0,
          clicks: r.clicks || 0,
          purchases: r.purchases ?? undefined,
          purchase_value: r.purchase_value != null ? Number(r.purchase_value) : undefined,
          permalink: r.permalink || undefined,
          campaign_name: r.campaign_name || undefined,
        });
      }

      const rangeByAccountAd = new Map<string, Map<string, { ad_id: string; ad_name: string; campaign_name: string; spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number }>>();
      for (const r of dailyAdsRows || []) {
        const acc = r.account_id || "";
        const key = String(r.ad_id || "") + "|" + String(r.ad_name || "Unnamed");
        if (!rangeByAccountAd.has(acc)) rangeByAccountAd.set(acc, new Map());
        const adMap = rangeByAccountAd.get(acc)!;
        if (!adMap.has(key)) {
          adMap.set(key, {
            ad_id: String(r.ad_id || ""),
            ad_name: String(r.ad_name || "Unnamed"),
            campaign_name: r.campaign_name || "",
            spend: 0,
            impressions: 0,
            clicks: 0,
            purchases: 0,
            purchase_value: 0,
          });
        }
        const agg = adMap.get(key)!;
        agg.spend += Number(r.spend || 0);
        agg.impressions += r.impressions || 0;
        agg.clicks += r.clicks || 0;
        agg.purchases += r.purchases || 0;
        agg.purchase_value += Number(r.purchase_value || 0);
      }

      const topRangeByAccount = new Map<string, Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases?: number; purchase_value?: number; permalink?: string; campaign_name?: string }>>();
      for (const [acc, adMap] of rangeByAccountAd) {
        const sorted = Array.from(adMap.values())
          .filter((a) => a.spend > 0)
          .sort((a, b) => b.spend - a.spend)
          .slice(0, 3)
          .map((a) => ({
            ad_id: a.ad_id,
            ad_name: a.ad_name,
            spend: Math.round(a.spend * 100) / 100,
            impressions: a.impressions,
            clicks: a.clicks,
            purchases: a.purchases > 0 ? a.purchases : undefined,
            purchase_value: a.purchase_value > 0 ? Math.round(a.purchase_value * 100) / 100 : undefined,
            permalink: undefined as string | undefined,
            campaign_name: a.campaign_name || undefined,
          }));
        topRangeByAccount.set(acc, sorted);
      }

      const accounts = Array.from(byAccount.entries()).map(([account_id, v]) => ({
        account_id,
        spend: Math.round(v.spend * 100) / 100,
        impressions: v.impressions,
        clicks: v.clicks,
        top_ads_historical: topHistoricalByAccount.get(account_id) || [],
        top_ads_range: topRangeByAccount.get(account_id) || [],
      }));

      meta = {
        success: true,
        period: { from: since, to: until, days },
        total_spend: Math.round(totalSpend * 100) / 100,
        total_impressions: totalImpressions,
        total_clicks: totalClicks,
        accounts,
        from_cache: true,
      };
    }

    return jsonResponse({
      shopify,
      meta,
      from_cache: shopify.success || meta.success,
    });
  } catch (err) {
    console.error("ecommerce-get-data:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error" },
      500
    );
  }
});
