import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ADMIN_EMAILS = ["mario@dolo.com.au"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseService = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const anonClient = createClient(supabaseUrl, supabaseAnon);
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);

    if (userError || !user?.email) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase());
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: "Solo administradores pueden invitar usuarios" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { email, password } = await req.json();
    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "Email requerido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return new Response(
        JSON.stringify({ error: "Contraseña requerida (mín. 6 caracteres)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailTrimmed = email.trim().toLowerCase();
    if (!emailTrimmed.endsWith("@dolo.com.au")) {
      return new Response(
        JSON.stringify({ error: "Solo se permiten correos @dolo.com.au" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adminClient = createClient(supabaseUrl, supabaseService);
    const { error: createError } = await adminClient.auth.admin.createUser({
      email: emailTrimmed,
      password: password.trim(),
      email_confirm: true,
    });

    if (createError) {
      const msg = createError.message.includes("already been registered")
        ? "Este usuario ya existe. Usa 'Reset password' en Supabase si olvidó la contraseña."
        : createError.message;
      return new Response(
        JSON.stringify({ error: msg }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Usuario creado. Puede iniciar sesión en https://dashboard2026.dolo.au/`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("invite-user error:", err);
    return new Response(
      JSON.stringify({ error: "Error interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
