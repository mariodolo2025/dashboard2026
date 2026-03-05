import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const STORAGE_BUCKET = "csv-files";
const STORAGE_PATH = "dashboard-settings/costs-config-v1.json";

interface CostsConfig {
  schemaVersion: number;
  boards: Record<string, 'fixed' | 'variable' | 'andrea' | 'pool'>;
  sliders: Record<string, number>;
  adjustments: Record<string, { percent: number; note: string }>;
  excluded: Record<string, boolean>;
  updatedAt: string;
}

interface SaveConfigRequest {
  settings_json: CostsConfig;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    if (req.method === "GET") {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(STORAGE_PATH);

      if (error) {
        if (error.message.includes("not found") || error.message.includes("Object not found")) {
          return new Response(
            JSON.stringify({
              success: true,
              settings_json: null,
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

        console.error("Error downloading costs config:", error);
        return new Response(
          JSON.stringify({
            success: false,
            message: "Error loading costs configuration",
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

      const text = await data.text();
      const config = JSON.parse(text);

      return new Response(
        JSON.stringify({
          success: true,
          settings_json: config,
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

    if (req.method === "POST") {
      const { settings_json }: SaveConfigRequest = await req.json();

      if (!settings_json || typeof settings_json !== 'object') {
        return new Response(
          JSON.stringify({
            success: false,
            message: "Valid settings_json is required",
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

      if (settings_json.schemaVersion !== 1) {
        return new Response(
          JSON.stringify({
            success: false,
            message: "Invalid schemaVersion",
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

      const updatedConfig = {
        ...settings_json,
        updatedAt: new Date().toISOString(),
      };

      const jsonBlob = new Blob([JSON.stringify(updatedConfig, null, 2)], {
        type: "application/json",
      });

      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(STORAGE_PATH, jsonBlob, {
          upsert: true,
          contentType: "application/json",
        });

      if (uploadError) {
        console.error("Error saving costs config:", uploadError);
        return new Response(
          JSON.stringify({
            success: false,
            message: "Error saving costs configuration",
            error: uploadError.message,
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
          ok: true,
          message: "Costs configuration saved successfully",
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

    return new Response(
      JSON.stringify({
        success: false,
        message: "Method not allowed",
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
    console.error("Error in costs-config:", error);

    return new Response(
      JSON.stringify({
        success: false,
        message: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
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