import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const META_API_VERSION = "v25.0";
const SYNC_DAYS = 90;

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

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const startMs = Date.now();
  const errors: string[] = [];
  const recordsSynced: Record<string, number> = { shopify_days: 0, meta_days: 0, meta_top_ads: 0 };

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

    const adminEmails = ["mario@dolo.com.au"];
    if (!adminEmails.includes(user.email.toLowerCase())) {
      return jsonResponse({ error: "Admin only" }, 403);
    }

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - SYNC_DAYS);
    const since = fromDate.toISOString().slice(0, 10);
    const until = toDate.toISOString().slice(0, 10);
    const createdMin = `${since}T00:00:00.000Z`;
    const createdMax = `${until}T23:59:59.999Z`;

    // ─── Shopify ─────────────────────────────────────────────────────────
    const { data: shopifyCreds } = await supabase
      .from("api_credentials")
      .select("store_url, access_token")
      .eq("provider", "shopify")
      .maybeSingle();

    if (shopifyCreds?.store_url && shopifyCreds?.access_token) {
      let storeUrl = String(shopifyCreds.store_url || "").trim();
      if (!storeUrl.includes(".")) storeUrl += ".myshopify.com";
      if (storeUrl.startsWith("http")) storeUrl = storeUrl.replace(/^https?:\/\//, "").split("/")[0];

      const dailyTotals: Record<string, { order_count: number; total_revenue: number }> = {};
      let nextUrl: string | null = `https://${storeUrl}/admin/api/2024-01/orders.json?limit=250&status=any&created_at_min=${createdMin}&created_at_max=${createdMax}`;

      while (nextUrl) {
        const res = await fetch(nextUrl, {
          headers: {
            "X-Shopify-Access-Token": shopifyCreds.access_token,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          errors.push(`Shopify API: ${res.status}`);
          break;
        }
        const data = await res.json();
        const orders = data.orders || [];
        for (const o of orders) {
          const price = parseFloat(String(o.total_price || o.current_total_price || 0));
          const created = String(o.created_at || "").slice(0, 10);
          if (created && !isNaN(price) && price > 0) {
            if (!dailyTotals[created]) dailyTotals[created] = { order_count: 0, total_revenue: 0 };
            dailyTotals[created].order_count++;
            dailyTotals[created].total_revenue += price;
          }
        }
        const linkHeader = res.headers.get("Link");
        nextUrl = null;
        const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
        if (match) nextUrl = match[1];
      }

      const shopifyRows = Object.entries(dailyTotals).map(([date, d]) => ({
        date,
        store_url: storeUrl,
        order_count: d.order_count,
        total_revenue: Math.round(d.total_revenue * 100) / 100,
        currency: "USD",
      }));

      if (shopifyRows.length > 0) {
        const { error } = await supabase.from("ecommerce_shopify_daily").upsert(shopifyRows, {
          onConflict: "date,store_url",
        });
        if (error) errors.push(`Shopify upsert: ${error.message}`);
        else recordsSynced.shopify_days = shopifyRows.length;
      }
    }

    // ─── Meta ───────────────────────────────────────────────────────────
    const { data: metaCreds } = await supabase
      .from("api_credentials")
      .select("ad_account_ids, access_token")
      .eq("provider", "meta")
      .maybeSingle();

    if (metaCreds?.ad_account_ids?.trim() && metaCreds?.access_token) {
      const rawIds = metaCreds.ad_account_ids.split(",").map((s) => s.trim()).filter(Boolean);
      const accountIds = rawIds
        .map((s) => (/^\d+$/.test(s.replace(/^act_/, "")) ? `act_${s.replace(/^act_/, "")}` : null))
        .filter((s): s is string => s !== null);

      for (const accountId of accountIds) {
        const timeRange = JSON.stringify({ since, until });
        const insightsUrl = `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?` +
          new URLSearchParams({
            access_token: metaCreds.access_token,
            fields: "spend,impressions,clicks",
            time_range: timeRange,
            time_increment: "1",
          });

        const insightsRes = await fetch(insightsUrl, { signal: AbortSignal.timeout(20000) });
        if (insightsRes.ok) {
          const insightsData = await insightsRes.json();
          const rows = (insightsData.data || []).map((r: { date_start?: string; spend?: string; impressions?: string; clicks?: string }) => ({
            date: r.date_start,
            account_id: accountId,
            spend: parseFloat(String(r.spend || 0)) || 0,
            impressions: parseInt(String(r.impressions || 0), 10) || 0,
            clicks: parseInt(String(r.clicks || 0), 10) || 0,
          })).filter((r: { date?: string }) => r.date);

          if (rows.length > 0) {
            const { error } = await supabase.from("ecommerce_meta_daily").upsert(rows, {
              onConflict: "date,account_id",
            });
            if (!error) recordsSynced.meta_days += rows.length;
          }
        }

        const adsUrl = `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?` +
          new URLSearchParams({
            access_token: metaCreds.access_token,
            level: "ad",
            fields: "ad_id,ad_name,spend,impressions,clicks",
            time_range: timeRange,
            limit: "100",
          });
        const adsRes = await fetch(adsUrl, { signal: AbortSignal.timeout(20000) });
        if (adsRes.ok) {
          const adsData = await adsRes.json();
          const adRows = (adsData.data || [])
            .filter((a: { spend?: string }) => parseFloat(String(a.spend || 0)) > 0)
            .sort((a: { spend?: string }, b: { spend?: string }) =>
              parseFloat(String(b.spend || 0)) - parseFloat(String(a.spend || 0))
            )
            .slice(0, 3);

          await supabase.from("ecommerce_meta_top_ads").delete().eq("account_id", accountId);
          for (let i = 0; i < adRows.length; i++) {
            const a = adRows[i];
            const adId = String(a.ad_id || "").replace(/^act_/, "");
            await supabase.from("ecommerce_meta_top_ads").insert({
              account_id: accountId,
              ad_id: String(a.ad_id || ""),
              ad_name: String(a.ad_name || "Unnamed"),
              spend: parseFloat(String(a.spend || 0)) || 0,
              impressions: parseInt(String(a.impressions || 0), 10) || 0,
              clicks: parseInt(String(a.clicks || 0), 10) || 0,
              permalink: adId ? `https://business.facebook.com/adsmanager/manage/ads?act=${accountId}&selected_ad_ids=${adId}` : null,
              rank: i + 1,
            });
          }
          recordsSynced.meta_top_ads += adRows.length;
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const status = errors.length === 0 ? "success" : recordsSynced.shopify_days + recordsSynced.meta_days > 0 ? "partial" : "failed";

    await supabase.from("ecommerce_sync_log").insert({
      status,
      records_synced: recordsSynced,
      errors: errors.length > 0 ? errors : [],
      duration_ms: durationMs,
    });

    return jsonResponse({
      success: errors.length === 0,
      status,
      records_synced: recordsSynced,
      errors: errors.length > 0 ? errors : undefined,
      duration_ms: durationMs,
    });
  } catch (err) {
    console.error("ecommerce-sync:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error", success: false },
      500
    );
  }
});
