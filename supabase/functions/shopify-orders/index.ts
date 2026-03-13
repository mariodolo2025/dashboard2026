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
    const supabaseService = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseService);

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user }, error: userError } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userError || !user?.email) {
      return jsonResponse({ error: "Invalid session" }, 401);
    }

    const { data: creds, error: credsError } = await supabase
      .from("api_credentials")
      .select("store_url, access_token")
      .eq("provider", "shopify")
      .maybeSingle();

    if (credsError || !creds?.store_url || !creds?.access_token) {
      return jsonResponse({
        error: "Shopify credentials not configured",
        configured: false,
      }, 400);
    }

    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const daysParam = parseInt(url.searchParams.get("days") || "30", 10);
    const days = Math.min(90, Math.max(1, daysParam));

    let createdMin: string;
    let createdMax: string;

    if (fromParam && toParam) {
      createdMin = `${fromParam}T00:00:00.000Z`;
      createdMax = `${toParam}T23:59:59.999Z`;
    } else {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      createdMin = fromDate.toISOString();
      createdMax = toDate.toISOString();
    }

    let storeUrl = String(creds.store_url || "").trim();
    if (!storeUrl.includes(".")) storeUrl += ".myshopify.com";
    if (storeUrl.startsWith("http")) storeUrl = storeUrl.replace(/^https?:\/\//, "").split("/")[0];

    const baseUrl = `https://${storeUrl}/admin/api/2024-01/orders.json`;
    const params = new URLSearchParams({
      limit: "250",
      status: "any",
      created_at_min: createdMin,
      created_at_max: createdMax,
    });

    let nextUrl: string | null = `${baseUrl}?${params}`;
    let totalRevenue = 0;
    let orderCount = 0;

    while (nextUrl) {
      const res = await fetch(nextUrl, {
        headers: {
          "X-Shopify-Access-Token": creds.access_token,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Shopify API error:", res.status, errText);
        return jsonResponse({
          error: `Shopify API: ${res.status} ${res.statusText}`,
          details: errText.slice(0, 200),
        }, 502);
      }

      const data = await res.json();
      const orders = data.orders || [];

      for (const o of orders) {
        const price = parseFloat(String(o.total_price || o.current_total_price || 0));
        if (!isNaN(price) && price > 0) {
          totalRevenue += price;
          orderCount++;
        }
      }

      const linkHeader = res.headers.get("Link");
      nextUrl = null;
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (match) nextUrl = match[1];
      }
    }

    const aov = orderCount > 0 ? totalRevenue / orderCount : 0;

    const periodFrom = createdMin.slice(0, 10);
    const periodTo = createdMax.slice(0, 10);

    return jsonResponse({
      success: true,
      store_url: storeUrl,
      period: { from: periodFrom, to: periodTo, days },
      orders: orderCount,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      aov: Math.round(aov * 100) / 100,
      currency: "USD",
    });
  } catch (err) {
    console.error("shopify-orders:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error interno" },
      500
    );
  }
});
