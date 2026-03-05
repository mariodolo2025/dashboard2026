import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface TestConnectionRequest {
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
    const { apiId, apiKey }: TestConnectionRequest = await req.json();

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

    // Preparar la solicitud a Unleashed
    const unleashedUrl = "https://api.unleashedsoftware.com/SalesOrders?pageSize=1";
    
    // Crear la firma HMAC-SHA256 según documentación de Unleashed
    // La firma se crea con: apiKey como clave, y el query string como mensaje
    const queryString = "pageSize=1";
    
    const encoder = new TextEncoder();
    const keyData = encoder.encode(apiKey);
    const messageData = encoder.encode(queryString);
    
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      messageData
    );
    
    // Convertir la firma a base64
    const signatureArray = Array.from(new Uint8Array(signature));
    const signatureBase64 = btoa(String.fromCharCode(...signatureArray));

    // Hacer la solicitud a Unleashed con los headers de autenticación
    const response = await fetch(unleashedUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "api-auth-id": apiId,
        "api-auth-signature": signatureBase64,
      },
      signal: AbortSignal.timeout(10000), // 10 segundos timeout
    });

    if (response.status === 401 || response.status === 403) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Credenciales inválidas. Verifica tu API ID y API Key.",
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

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `Error al conectar con Unleashed: ${response.status} ${response.statusText}`,
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

    // Parsear la respuesta de Unleashed
    const data = await response.json();
    
    // Extraer información relevante de la respuesta
    const pagination = data.Pagination || {};
    const items = data.Items || [];
    const numberOfOrders = pagination.NumberOfItems || 0;
    const numberOfItems = items.length;

    return new Response(
      JSON.stringify({
        success: true,
        message: `Connection successful! Found ${numberOfOrders} orders with ${numberOfItems} items`,
        orderCount: numberOfOrders,
        itemCount: numberOfItems,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );

  } catch (error) {
    console.error("Error testing Unleashed connection:", error);
    
    return new Response(
      JSON.stringify({
        success: false,
        message: `Error: ${error instanceof Error ? error.message : "Error desconocido"}`,
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
});