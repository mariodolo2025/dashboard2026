import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const META_API_VERSION = "v25.0";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface MetaAdInsight {
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
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
      .select("ad_account_ids, access_token")
      .eq("provider", "meta")
      .maybeSingle();

    if (credsError || !creds?.ad_account_ids?.trim() || !creds?.access_token) {
      return jsonResponse({
        error: "Meta credentials not configured",
        configured: false,
      }, 400);
    }

    const rawIds = creds.ad_account_ids.split(",").map((s) => s.trim()).filter(Boolean);
    const accountIds = rawIds
      .map((s) => {
        const num = s.replace(/^act_/, "");
        return /^\d+$/.test(num) ? `act_${num}` : null;
      })
      .filter((s): s is string => s !== null);

    if (accountIds.length === 0) {
      return jsonResponse({
        error: "No valid ad account IDs. Usa formato act_123456 o 123456 separados por coma.",
        configured: false,
      }, 400);
    }

    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const daysParam = parseInt(url.searchParams.get("days") || "30", 10);
    const days = Math.min(90, Math.max(1, daysParam));

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

    const accessToken = creds.access_token;
    const baseUrl = `https://graph.facebook.com/${META_API_VERSION}`;

    const accounts: Array<{
      account_id: string;
      spend: number;
      impressions: number;
      clicks: number;
      top_ads: Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; permalink?: string }>;
    }> = [];

    let totalSpend = 0;
    let totalImpressions = 0;
    let totalClicks = 0;

    for (const accountId of accountIds) {
      const timeRange = JSON.stringify({ since, until });

      const insightsUrl = `${baseUrl}/${accountId}/insights?` + new URLSearchParams({
        access_token: accessToken,
        fields: "spend,impressions,clicks",
        time_range: timeRange,
      });

      const insightsRes = await fetch(insightsUrl, { signal: AbortSignal.timeout(15000) });
      if (!insightsRes.ok) {
        const errText = await insightsRes.text();
        console.error(`Meta insights ${accountId}:`, insightsRes.status, errText);
        accounts.push({
          account_id: accountId,
          spend: 0,
          impressions: 0,
          clicks: 0,
          top_ads: [],
        });
        continue;
      }

      const insightsData = await insightsRes.json();
      let spend = 0;
      let impressions = 0;
      let clicks = 0;

      const insightRows = insightsData.data || [];
      if (Array.isArray(insightRows) && insightRows.length > 0) {
        for (const row of insightRows) {
          spend += parseFloat(String(row.spend || 0)) || 0;
          impressions += parseInt(String(row.impressions || 0), 10) || 0;
          clicks += parseInt(String(row.clicks || 0), 10) || 0;
        }
      }

      totalSpend += spend;
      totalImpressions += impressions;
      totalClicks += clicks;

      const adsInsightsUrl = `${baseUrl}/${accountId}/insights?` + new URLSearchParams({
        access_token: accessToken,
        level: "ad",
        fields: "ad_id,ad_name,spend,impressions,clicks",
        time_range: timeRange,
        limit: "100",
      });

      const adsRes = await fetch(adsInsightsUrl, { signal: AbortSignal.timeout(20000) });
      let topAds: Array<{ ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; permalink?: string }> = [];

      if (adsRes.ok) {
        const adsData = await adsRes.json();
        const adRows = (adsData.data || []) as MetaAdInsight[];
        const sorted = adRows
          .filter((a) => parseFloat(String(a.spend || 0)) > 0)
          .sort((a, b) => parseFloat(String(b.spend || 0)) - parseFloat(String(a.spend || 0)))
          .slice(0, 3);

        for (const a of sorted) {
          const adId = String(a.ad_id || "").replace(/^act_/, "");
          topAds.push({
            ad_id: String(a.ad_id || ""),
            ad_name: String(a.ad_name || "Unnamed"),
            spend: parseFloat(String(a.spend || 0)) || 0,
            impressions: parseInt(String(a.impressions || 0), 10) || 0,
            clicks: parseInt(String(a.clicks || 0), 10) || 0,
            permalink: adId ? `https://business.facebook.com/adsmanager/manage/ads?act=${accountId}&selected_ad_ids=${adId}` : undefined,
          });
        }
      }

      accounts.push({
        account_id: accountId,
        spend,
        impressions,
        clicks,
        top_ads: topAds,
      });
    }

    const periodDays = Math.ceil((new Date(until).getTime() - new Date(since).getTime()) / (24 * 60 * 60 * 1000)) + 1;

    return jsonResponse({
      success: true,
      period: { from: since, to: until, days: periodDays },
      total_spend: Math.round(totalSpend * 100) / 100,
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      accounts,
    });
  } catch (err) {
    console.error("meta-ads-insights:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error interno" },
      500
    );
  }
});
