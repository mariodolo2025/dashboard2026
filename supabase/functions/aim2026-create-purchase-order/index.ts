// =============================================================================
// AIM 2026 — Create Purchase Order in Unleashed
// =============================================================================
// Creates a new Purchase Order via the Unleashed API.
// Expects JSON body with:
//   items: Array<{ productCode, orderQuantity, unitPrice }>
//   supplierCode: string (e.g. "Winkin")
//   warehouseCode: string (e.g. "China")
//   setProductionStatus: boolean (attempt to set CustomOrderStatus to "Production")
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ─── CORS ──────────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Unleashed API Helpers ─────────────────────────────────────────────────

const UNLEASHED_BASE = "https://api.unleashedsoftware.com";

interface UnleashedCreds {
  api_id: string;
  api_key: string;
}

async function hmacSign(apiKey: string, queryString: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(queryString));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function unleashedGet(
  endpoint: string,
  queryString: string,
  creds: UnleashedCreds
): Promise<any> {
  const url = `${UNLEASHED_BASE}/${endpoint}${queryString ? "?" + queryString : ""}`;
  const signature = await hmacSign(creds.api_key, queryString);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "api-auth-id": creds.api_id,
      "api-auth-signature": signature,
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Unleashed GET ${endpoint}: ${res.status} ${res.statusText} — ${text}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function unleashedPost(
  endpoint: string,
  queryString: string,
  body: any,
  creds: UnleashedCreds
): Promise<any> {
  const url = `${UNLEASHED_BASE}/${endpoint}${queryString ? "?" + queryString : ""}`;
  const signature = await hmacSign(creds.api_key, queryString);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-auth-id": creds.api_id,
      "api-auth-signature": signature,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Unleashed POST ${endpoint}: ${res.status} ${res.statusText} — ${text}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function unleashedPut(
  endpoint: string,
  queryString: string,
  body: any,
  creds: UnleashedCreds
): Promise<any> {
  const url = `${UNLEASHED_BASE}/${endpoint}${queryString ? "?" + queryString : ""}`;
  const signature = await hmacSign(creds.api_key, queryString);

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-auth-id": creds.api_id,
      "api-auth-signature": signature,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Unleashed PUT ${endpoint}: ${res.status} ${res.statusText} — ${text}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ─── Main Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  try {
    const body = await req.json();
    const {
      items,
      supplierCode,
      warehouseCode,
      customOrderStatus,
    } = body;

    // Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse(
        { success: false, message: "No items provided" },
        400
      );
    }
    if (!supplierCode) {
      return jsonResponse(
        { success: false, message: "Missing supplierCode" },
        400
      );
    }
    if (!warehouseCode) {
      return jsonResponse(
        { success: false, message: "Missing warehouseCode" },
        400
      );
    }

    // Connect to Supabase and get Unleashed credentials
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: credsRow, error: credsError } = await supabase
      .from("unleashed_credentials")
      .select("api_id, api_key")
      .eq("is_active", true)
      .maybeSingle();

    if (credsError || !credsRow) {
      return jsonResponse(
        {
          success: false,
          message:
            "No Unleashed credentials found. Save your API credentials in Settings first.",
        },
        400
      );
    }

    const creds: UnleashedCreds = {
      api_id: credsRow.api_id,
      api_key: credsRow.api_key,
    };

    // Validate products: filter out non-purchasable ones
    // Unleashed uses path pagination: /Products/1 for first page
    const uniqueCodes = [...new Set(items.map((i: any) => String(i.productCode ?? "").trim()).filter(Boolean))];
    const nonPurchasableCodes: string[] = [];

    for (const code of uniqueCodes) {
      try {
        let list: any[] = [];
        for (const filter of [`productCode=${encodeURIComponent(code)}`, `product=${encodeURIComponent(code)}`]) {
          const qs = `${filter}&pageSize=20`;
          const productsRes = await unleashedGet("Products/1", qs, creds);
          const productList = productsRes.Items ?? productsRes.Products ?? (Array.isArray(productsRes) ? productsRes : []);
          list = Array.isArray(productList) ? productList : [];
          if (list.length > 0) break;
        }
        const exact = list.find((p: any) => {
          const pc = (p.ProductCode ?? p.productCode ?? "").trim();
          return pc === code || pc.toLowerCase() === code.toLowerCase();
        });
        const product = exact ?? list[0];
        const isPurchasable = product != null
          ? (product.IsPurchasable ?? product.isPurchasable ?? true)
          : true;
        if (!isPurchasable) {
          nonPurchasableCodes.push(code);
        }
      } catch {
        // If we can't fetch the product, assume it's purchasable (let Unleashed handle it)
      }
    }

    const purchasableItems = items.filter(
      (i: any) => !nonPurchasableCodes.includes(String(i.productCode ?? "").trim())
    );

    if (purchasableItems.length === 0) {
      return jsonResponse(
        {
          success: false,
          message:
            nonPurchasableCodes.length > 0
              ? `All products are non-purchasable in Unleashed. Please enable "IsPurchasable" for: ${nonPurchasableCodes.join(", ")}`
              : "No valid items to create purchase order.",
        },
        400
      );
    }

    const excludedCount = items.length - purchasableItems.length;

    // Build PO lines (only purchasable items)
    const poLines = purchasableItems.map(
      (
        item: { productCode: string; orderQuantity: number; unitPrice: number },
        i: number
      ) => {
        const lineTotal =
          Math.round(item.orderQuantity * item.unitPrice * 100) / 100;
        return {
          LineNumber: i + 1,
          Product: { ProductCode: item.productCode },
          OrderQuantity: item.orderQuantity,
          UnitPrice: item.unitPrice,
          LineTotal: lineTotal,
          LineTax: 0,
          DiscountRate: 0,
        };
      }
    );

    // Calculate totals
    const subTotal =
      Math.round(
        poLines.reduce((s: number, l: any) => s + l.LineTotal, 0) * 100
      ) / 100;

    // Build the PO payload
    const poGuid = crypto.randomUUID();
    const now = new Date();
    // Default delivery date = order date + 45 days (standard lead time)
    const deliveryDate = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);

    const purchaseOrder: Record<string, any> = {
      Guid: poGuid,
      Supplier: { SupplierCode: supplierCode },
      Warehouse: { WarehouseCode: warehouseCode },
      OrderDate: now.toISOString(),
      DeliveryDate: deliveryDate.toISOString(),
      RequiredDate: deliveryDate.toISOString(),
      OrderStatus: "Placed",
      SubTotal: subTotal,
      TaxTotal: 0,
      Total: subTotal,
      PurchaseOrderLines: poLines,
      Comments: `Created by AIM 2026 Dashboard on ${now.toISOString().slice(0, 10)}`,
    };

    // Include CustomOrderStatus in the initial POST if provided
    if (customOrderStatus) {
      purchaseOrder.CustomOrderStatus = customOrderStatus;
      purchaseOrder.SupplierRef = `Please change status to ${customOrderStatus.toUpperCase()}`;
    }

    console.log(
      `Creating PO: ${purchasableItems.length} lines, supplier=${supplierCode}, warehouse=${warehouseCode}, total=${subTotal}${excludedCount > 0 ? ` (excluded ${excludedCount} non-purchasable: ${nonPurchasableCodes.join(", ")})` : ""}`
    );

    // POST to Unleashed — catch 400 "non-purchasable" to return helpful error
    let result: any;
    try {
      result = await unleashedPost(
        `PurchaseOrders/${poGuid}`,
        "",
        purchaseOrder,
        creds
      );
    } catch (postErr) {
      const errMsg = postErr instanceof Error ? postErr.message : String(postErr);
      if (errMsg.includes("400") && (errMsg.includes("non-purchasable") || errMsg.includes("Non-purchasable"))) {
        const allCodes = [...new Set(purchasableItems.map((i: any) => i.productCode))];
        return jsonResponse(
          {
            success: false,
            message: `Unleashed rejected the PO: one or more products are non-purchasable. Please enable "IsPurchasable" in Unleashed for each product. Products in this order: ${allCodes.join(", ")}`,
            productCodes: allCodes,
          },
          400
        );
      }
      throw postErr;
    }

    const orderNumber = result.OrderNumber ?? result.orderNumber ?? null;
    const returnedGuid = result.Guid ?? result.guid ?? poGuid;

    console.log(
      `PO created: OrderNumber=${orderNumber}, Guid=${returnedGuid}`
    );

    // Verify CustomOrderStatus was set; if not, try PUT as fallback
    const createdStatus = result.CustomOrderStatus ?? "";
    if (customOrderStatus && createdStatus !== customOrderStatus) {
      try {
        console.log(
          `CustomOrderStatus not set in POST (got "${createdStatus}"), attempting PUT fallback for ${returnedGuid}`
        );
        await unleashedPut(
          `PurchaseOrders/${returnedGuid}`,
          "",
          {
            ...result,
            CustomOrderStatus: customOrderStatus,
          },
          creds
        );
        console.log(`CustomOrderStatus set to ${customOrderStatus} via PUT`);
      } catch (e) {
        // Non-fatal: PO was created, custom status just couldn't be set
        console.warn("Failed to set CustomOrderStatus via PUT:", e);
      }
    }

    const successMessage =
      excludedCount > 0
        ? `Purchase Order ${orderNumber ?? "created"} with ${purchasableItems.length} items (${subTotal.toLocaleString()} AUD). Excluded ${excludedCount} non-purchasable product(s): ${nonPurchasableCodes.join(", ")}`
        : `Purchase Order ${orderNumber ?? "created"} with ${purchasableItems.length} items (${subTotal.toLocaleString()} AUD)`;

    return jsonResponse({
      success: true,
      orderNumber,
      orderGuid: returnedGuid,
      message: successMessage,
      excludedProductCodes: excludedCount > 0 ? nonPurchasableCodes : undefined,
    });
  } catch (error) {
    console.error("Error creating purchase order:", error);
    return jsonResponse(
      {
        success: false,
        message: `Failed to create PO: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      500
    );
  }
});
