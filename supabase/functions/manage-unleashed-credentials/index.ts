import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface SaveCredentialsRequest {
  apiId: string;
  apiKey: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Crear cliente de Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // GET: Obtener credenciales activas
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("unleashed_credentials")
        .select("*")
        .eq("is_active", true)
        .maybeSingle();

      if (error) {
        console.error("Error fetching credentials:", error);
        return new Response(
          JSON.stringify({
            success: false,
            message: "Error al cargar credenciales",
            error: error.message,
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          data: data || null,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // POST: Guardar o actualizar credenciales
    if (req.method === "POST") {
      const { apiId, apiKey }: SaveCredentialsRequest = await req.json();

      if (!apiId || !apiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "API ID y API Key son requeridos",
          }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Verificar si ya existen credenciales activas
      const { data: existingCreds } = await supabase
        .from("unleashed_credentials")
        .select("*")
        .eq("is_active", true)
        .maybeSingle();

      let result;

      if (existingCreds) {
        // Actualizar credenciales existentes
        result = await supabase
          .from("unleashed_credentials")
          .update({
            api_id: apiId,
            api_key: apiKey,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingCreds.id)
          .select()
          .single();
      } else {
        // Insertar nuevas credenciales
        result = await supabase
          .from("unleashed_credentials")
          .insert({
            api_id: apiId,
            api_key: apiKey,
            is_active: true,
          })
          .select()
          .single();
      }

      if (result.error) {
        console.error("Error saving credentials:", result.error);
        return new Response(
          JSON.stringify({
            success: false,
            message: "Error al guardar credenciales",
            error: result.error.message,
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Credenciales guardadas exitosamente",
          data: result.data,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Método no permitido
    return new Response(
      JSON.stringify({
        success: false,
        message: "Método no permitido",
      }),
      {
        status: 405,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );

  } catch (error) {
    console.error("Error in manage-unleashed-credentials:", error);
    
    return new Response(
      JSON.stringify({
        success: false,
        message: `Error: ${error instanceof Error ? error.message : "Error desconocido"}`,
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});