import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

interface ShopifyCreds {
  store_url: string;
  access_token: string;
}

interface MetaCreds {
  ad_account_ids: string;
  access_token: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseService = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseService);

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("api_credentials")
        .select("provider, store_url, ad_account_ids, updated_at")
        .in("provider", ["shopify", "meta"]);

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const shopify = data?.find((r) => r.provider === "shopify");
      const meta = data?.find((r) => r.provider === "meta");

      return new Response(
        JSON.stringify({
          shopify: shopify
            ? { store_url: shopify.store_url || "", configured: !!(shopify.store_url) }
            : { store_url: "", configured: false },
          meta: meta
            ? { ad_account_ids: meta.ad_account_ids || "", configured: !!(meta.ad_account_ids) }
            : { ad_account_ids: "", configured: false },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (req.method === "POST") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({ error: "Authorization required" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const token = authHeader.replace("Bearer ", "");
      const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
      const { data: { user }, error: userError } = await anonClient.auth.getUser(token);

      if (userError || !user?.email) {
        return new Response(
          JSON.stringify({ error: "Invalid session" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const adminEmails = ["mario@dolo.com.au"];
      if (!adminEmails.includes(user.email.toLowerCase())) {
        return new Response(
          JSON.stringify({ error: "Solo administradores pueden configurar credenciales" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const body = await req.json();
      const rows: Array<Record<string, unknown>> = [];

      if (body.shopify) {
        const { store_url, access_token } = body.shopify as ShopifyCreds;
        if (!store_url?.trim() || !access_token?.trim()) {
          return new Response(
            JSON.stringify({ error: "Shopify: store_url y access_token requeridos" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        rows.push({
          provider: "shopify",
          store_url: store_url.trim(),
          access_token: access_token.trim(),
          updated_at: new Date().toISOString(),
        });
      }

      if (body.meta) {
        const { ad_account_ids, access_token } = body.meta as MetaCreds;
        if (!ad_account_ids?.trim() || !access_token?.trim()) {
          return new Response(
            JSON.stringify({ error: "Meta: ad_account_ids y access_token requeridos" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        rows.push({
          provider: "meta",
          ad_account_ids: ad_account_ids.trim(),
          access_token: access_token.trim(),
          updated_at: new Date().toISOString(),
        });
      }

      if (rows.length === 0) {
        return new Response(
          JSON.stringify({ error: "Completa al menos Shopify o Meta" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { error } = await supabase
        .from("api_credentials")
        .upsert(rows, { onConflict: "provider" });

      if (error) {
        console.error("manage-ecommerce-credentials upsert:", error);
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, saved: rows.map((r) => r.provider) }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("manage-ecommerce-credentials:", err);
    return new Response(
      JSON.stringify({ error: "Error interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
