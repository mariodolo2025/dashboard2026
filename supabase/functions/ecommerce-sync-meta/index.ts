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
  const recordsSynced: Record<string, number> = { shopify_days: 0, meta_days: 0, meta_top_ads: 0, meta_daily_ads: 0 };

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

    const until = new Date().toISOString().slice(0, 10);
    let since: string;

    const { data: lastRow } = await supabase
      .from("ecommerce_meta_daily")
      .select("date")
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

    if (since > until) {
      return jsonResponse({
        success: true,
        status: "success",
        records_synced: { shopify_days: 0, meta_days: 0, meta_top_ads: 0, meta_daily_ads: 0 },
        message: "Meta ya está al día",
        duration_ms: Date.now() - startMs,
      });
    }

    const timeRange = JSON.stringify({ since, until });

    const { data: metaCreds } = await supabase
      .from("api_credentials")
      .select("ad_account_ids, access_token")
      .eq("provider", "meta")
      .maybeSingle();

    if (!metaCreds?.ad_account_ids?.trim() || !metaCreds?.access_token) {
      errors.push("Meta credentials not configured. Add ad_account_ids and access_token in Config.");
    } else {
      const rawIds = metaCreds.ad_account_ids.split(",").map((s) => s.trim()).filter(Boolean);
      const accountIds = rawIds
        .map((s) => (/^\d+$/.test(s.replace(/^act_/, "")) ? `act_${s.replace(/^act_/, "")}` : null))
        .filter((s): s is string => s !== null);

      for (const accountId of accountIds) {
        const insightsUrl = `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?` +
          new URLSearchParams({
            access_token: metaCreds.access_token,
            fields: "spend,impressions,clicks",
            time_range: timeRange,
            time_increment: "1",
          });

        const insightsRes = await fetch(insightsUrl, { signal: AbortSignal.timeout(20000) });
        if (!insightsRes.ok) {
          const errBody = await insightsRes.text();
          try {
            const errJson = JSON.parse(errBody);
            const msg = errJson?.error?.message || errJson?.error?.error_user_msg || errBody?.slice(0, 200);
            errors.push(`Meta insights ${accountId}: ${insightsRes.status} - ${msg}`);
          } catch {
            errors.push(`Meta insights ${accountId}: ${insightsRes.status} - ${errBody?.slice(0, 150)}`);
          }
        } else {
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

        const purchaseTypes = ["purchase", "offsite_conversion.fb_pixel_purchases", "onsite_conversion.purchase", "commerce_event.purchase"];
        const dailyAdsRows: Array<{ date: string; account_id: string; ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number }> = [];
        const adTotals = new Map<string, { ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number; permalink: string | null }>();

        let adsNextUrl: string | null = `https://graph.facebook.com/${META_API_VERSION}/${accountId}/insights?` +
          new URLSearchParams({
            access_token: metaCreds.access_token,
            level: "ad",
            fields: "ad_id,ad_name,spend,impressions,clicks,actions,action_values",
            time_range: timeRange,
            time_increment: "1",
            limit: "100",
          });

        while (adsNextUrl) {
          const adsRes = await fetch(adsNextUrl, { signal: AbortSignal.timeout(30000) });
          if (!adsRes.ok) {
            const errBody = await adsRes.text();
            try {
              const errJson = JSON.parse(errBody);
              const msg = errJson?.error?.message || errJson?.error?.error_user_msg || errBody?.slice(0, 200);
              if (!errors.some((e) => e.includes(accountId))) {
                errors.push(`Meta ads ${accountId}: ${adsRes.status} - ${msg}`);
              }
            } catch {
              if (!errors.some((e) => e.includes(accountId))) {
                errors.push(`Meta ads ${accountId}: ${adsRes.status} - ${errBody?.slice(0, 150)}`);
              }
            }
            break;
          }

          const adsData = await adsRes.json();
          for (const a of adsData.data || []) {
            const spend = parseFloat(String(a.spend || 0)) || 0;
            if (spend <= 0) continue;
            let purchases = 0;
            let purchaseValue = 0;
            for (const act of a.actions || []) {
              const t = String(act.action_type || "");
              if (purchaseTypes.some((pt) => t.includes("purchase") || t === pt)) {
                purchases += parseInt(String(act.value || 0), 10) || 0;
              }
            }
            for (const av of a.action_values || []) {
              const t = String(av.action_type || "");
              if (purchaseTypes.some((pt) => t.includes("purchase") || t === pt)) {
                purchaseValue += parseFloat(String(av.value || 0)) || 0;
              }
            }
            const adId = String(a.ad_id || "").replace(/^act_/, "");
            const dateStart = a.date_start;
            const adName = String(a.ad_name || "Unnamed");
            if (dateStart) {
              dailyAdsRows.push({
                date: String(dateStart).slice(0, 10),
                account_id: accountId,
                ad_id: String(a.ad_id || ""),
                ad_name: adName,
                spend: Math.round(spend * 100) / 100,
                impressions: parseInt(String(a.impressions || 0), 10) || 0,
                clicks: parseInt(String(a.clicks || 0), 10) || 0,
                purchases,
                purchase_value: Math.round(purchaseValue * 100) / 100,
              });
            }
            const key = adName;
            if (!adTotals.has(key)) {
              adTotals.set(key, {
                ad_id: String(a.ad_id || ""),
                ad_name: adName,
                spend: 0,
                impressions: 0,
                clicks: 0,
                purchases: 0,
                purchase_value: 0,
                permalink: adId ? `https://business.facebook.com/adsmanager/manage/ads?act=${accountId}&selected_ad_ids=${adId}` : null,
              });
            }
            const tot = adTotals.get(key)!;
            tot.spend += spend;
            tot.impressions += parseInt(String(a.impressions || 0), 10) || 0;
            tot.clicks += parseInt(String(a.clicks || 0), 10) || 0;
            tot.purchases += purchases;
            tot.purchase_value += purchaseValue;
          }

          adsNextUrl = adsData.paging?.next || null;
        }

        if (dailyAdsRows.length > 0) {
          const { error: dailyErr } = await supabase.from("ecommerce_meta_daily_ads").upsert(dailyAdsRows, {
            onConflict: "date,account_id,ad_id",
          });
          if (!dailyErr) recordsSynced.meta_daily_ads += dailyAdsRows.length;
        }

        const apiAds = Array.from(adTotals.values()).map((t) => ({
          ad_id: t.ad_id,
          ad_name: t.ad_name,
          spend: Math.round(t.spend * 100) / 100,
          impressions: t.impressions,
          clicks: t.clicks,
          purchases: t.purchases,
          purchase_value: Math.round(t.purchase_value * 100) / 100,
          permalink: t.permalink,
        }));

        if (apiAds.length > 0) {
          const { data: existingRows } = await supabase
            .from("ecommerce_meta_top_ads")
            .select("ad_id, ad_name, spend, impressions, clicks, purchases, purchase_value, permalink")
            .eq("account_id", accountId)
            .order("rank");

          const merged = new Map<string, { ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; purchases: number; purchase_value: number; permalink: string | null }>();

          for (const ex of existingRows || []) {
            const key = String(ex.ad_name || "Unnamed");
            merged.set(key, {
              ad_id: String(ex.ad_id || ""),
              ad_name: key,
              spend: Number(ex.spend || 0),
              impressions: ex.impressions || 0,
              clicks: ex.clicks || 0,
              purchases: ex.purchases ?? 0,
              purchase_value: Number(ex.purchase_value || 0),
              permalink: ex.permalink || null,
            });
          }

          for (const api of apiAds) {
            const key = api.ad_name;
            if (merged.has(key)) {
              const m = merged.get(key)!;
              m.spend += api.spend;
              m.impressions += api.impressions;
              m.clicks += api.clicks;
              m.purchases = api.purchases > 0 ? api.purchases : m.purchases;
              m.purchase_value = api.purchase_value > 0 ? api.purchase_value : m.purchase_value;
              if (api.permalink) m.permalink = api.permalink;
              if (api.ad_id && !api.ad_id.startsWith("csv-")) m.ad_id = api.ad_id;
            } else {
              merged.set(key, {
                ad_id: api.ad_id,
                ad_name: api.ad_name,
                spend: api.spend,
                impressions: api.impressions,
                clicks: api.clicks,
                purchases: api.purchases,
                purchase_value: api.purchase_value,
                permalink: api.permalink,
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
                purchase_value: a.purchase_value,
                permalink: a.permalink,
                rank: i + 1,
              },
              { onConflict: "account_id,rank" }
            );
          }
          recordsSynced.meta_top_ads += top3.length;
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const status = errors.length === 0 ? "success" : recordsSynced.meta_days + recordsSynced.meta_top_ads + recordsSynced.meta_daily_ads > 0 ? "partial" : "failed";

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
    console.error("ecommerce-sync-meta:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Error", success: false },
      500
    );
  }
});
