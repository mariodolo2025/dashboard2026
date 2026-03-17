import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const SYNC_DAYS = 30;

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

    const { data: shopifyCreds } = await supabase
      .from("api_credentials")
      .select("store_url, access_token")
      .eq("provider", "shopify")
      .maybeSingle();

    if (shopifyCreds?.store_url && shopifyCreds?.access_token) {
      let storeUrl = String(shopifyCreds.store_url || "").trim();
      if (!storeUrl.includes(".")) storeUrl += ".myshopify.com";
      if (storeUrl.startsWith("http")) storeUrl = storeUrl.replace(/^https?:\/\//, "").split("/")[0];

      const until = new Date().toISOString().slice(0, 10);
      let since: string;

      const { data: lastRow } = await supabase
        .from("ecommerce_shopify_daily")
        .select("date")
        .eq("store_url", storeUrl)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastRow?.date) {
        const lastDate = new Date(String(lastRow.date));
        lastDate.setDate(lastDate.getDate() + 1);
        since = lastDate.toISOString().slice(0, 10);
      } else {
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - SYNC_DAYS);
        since = fromDate.toISOString().slice(0, 10);
      }

      const createdMin = `${since}T00:00:00.000Z`;
      const createdMax = `${until}T23:59:59.999Z`;

      let nextUrl: string | null = since <= until
        ? `https://${storeUrl}/admin/api/2024-01/orders.json?limit=250&status=any&created_at_min=${createdMin}&created_at_max=${createdMax}`
        : null;

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
        const dailyByMarket: Record<string, Record<string, { order_count: number; total_revenue: number }>> = {};
        for (const o of orders) {
          const price = parseFloat(String(o.total_price || o.current_total_price || 0));
          const created = String(o.created_at || "").slice(0, 10);
          if (!created || isNaN(price) || price <= 0) continue;
          const country = (o.shipping_address?.country_code || o.billing_address?.country_code || "").toUpperCase();
          const market = country === "US" || country === "USA" ? "usa" : country === "AU" || country === "AUS" ? "australia" : "other";
          if (!dailyByMarket[market]) dailyByMarket[market] = {};
          if (!dailyByMarket[market][created]) dailyByMarket[market][created] = { order_count: 0, total_revenue: 0 };
          dailyByMarket[market][created].order_count++;
          dailyByMarket[market][created].total_revenue += price;
        }
        const linkHeader = res.headers.get("Link");
        nextUrl = null;
        const match = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
        if (match) nextUrl = match[1];
      }

      const shopifyRows: Array<{ date: string; store_url: string; market: string; order_count: number; total_revenue: number; currency: string }> = [];
      for (const [market, daily] of Object.entries(dailyByMarket)) {
        for (const [date, d] of Object.entries(daily)) {
          shopifyRows.push({
            date,
            store_url: storeUrl,
            market,
            order_count: d.order_count,
            total_revenue: Math.round(d.total_revenue * 100) / 100,
            currency: "USD",
          });
        }
      }

      if (shopifyRows.length > 0) {
        const { error } = await supabase.from("ecommerce_shopify_daily").upsert(shopifyRows, {
          onConflict: "date,store_url,market",
        });
        if (error) errors.push(`Shopify upsert: ${error.message}`);
        else recordsSynced.shopify_days = shopifyRows.length;
      }
    }

    const durationMs = Date.now() - startMs;
    const status = errors.length === 0 ? "success" : recordsSynced.shopify_days > 0 ? "partial" : "failed";

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
    console.error("ecommerce-sync-shopify:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error", success: false },
      500
    );
  }
});
