// =============================================================================
// AIM 2026 — AI Insights (Claude API)
// Receives KPI summary data, sends to Claude for analysis, returns insight cards
// =============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Claude API ────────────────────────────────────────────────────────────

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";

interface InsightCard {
  category: "inventory" | "demand" | "financial" | "action";
  severity: "critical" | "warning" | "info" | "positive";
  title: string;
  description: string;
  confidence: number;
  actionLabel?: string;
  relatedSKUs?: string[];
}

// ─── Build Analysis Prompt ─────────────────────────────────────────────────

function buildPrompt(data: any): string {
  const { skus, kpiSummary } = data;

  // Prepare compact SKU data for the prompt
  const skuLines = skus
    .map(
      (s: any) =>
        `${s.sku}|${s.abcClass}|SOH:${s.sohMainWH}|Demand:${s.projectedDemand}/mo|Cover:${s.daysOfCover}d|ROP:${s.reorderPoint}|SugQty:${s.suggestedQty}|Pipeline:${s.pipeline}|Status:${s.status}|Margin:${s.marginPercent}%|GMROI:${s.gmroi}|Turnover:${s.turnover}|Trend:${s.demandTrend}(${s.demandTrendPercent}%)|LT:${s.leadTimeDays}d|Cost:$${s.productCostChina}|Landed:$${s.landedCostAUD}|ASP:$${s.avgSellingPrice}`
    )
    .join("\n");

  return `You are an expert inventory analyst for a consumer products company (Pesado Coffee accessories). Analyze the following inventory KPI data and provide 3-5 actionable insights.

PORTFOLIO SUMMARY:
- Total Products: ${kpiSummary.totalProducts}
- Total Inventory Value: AUD ${Math.round(kpiSummary.totalInventoryValueAUD).toLocaleString()}
- Items at Risk: ${kpiSummary.itemsAtRisk}
- Avg Turnover: ${kpiSummary.avgTurnover}x
- Avg GMROI: ${kpiSummary.avgGMROI}
- Avg Margin: ${kpiSummary.avgMarginPercent}%
- Avg Days of Cover: ${Math.round(kpiSummary.avgDaysOfCover)} days

SKU DATA (format: SKU|ABC|SOH|Demand|Cover|ROP|SugQty|Pipeline|Status|Margin|GMROI|Turnover|Trend|LeadTime|Cost|LandedCost|AvgSellingPrice):
${skuLines}

Respond ONLY with a valid JSON array of insight objects. Each insight must have:
- "category": one of "inventory", "demand", "financial", "action"
- "severity": one of "critical", "warning", "info", "positive"
- "title": short headline (max 8 words)
- "description": 2-3 sentences with specific SKU codes, numbers, and recommended actions. Be specific and data-driven.
- "confidence": number 75-99 representing how confident you are
- "actionLabel": short button label for the recommended action (e.g. "Restock Now", "Review Pricing", "Reduce Stock")
- "relatedSKUs": array of up to 3 most relevant SKU codes

Focus on:
1. Urgent stockout risks (CRITICAL/LOW STOCK items, especially ABC class A)
2. Overstock situations tying up capital
3. Margin or GMROI anomalies
4. Demand trend changes that need attention
5. Specific reorder recommendations

Be concise, specific with numbers, and prioritize by business impact. Output ONLY the JSON array, no other text.`;
}

// ─── Main Handler ──────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return jsonResponse(null, 200);
  }

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        {
          success: false,
          message:
            "ANTHROPIC_API_KEY not configured. Add it as a Supabase Secret.",
        },
        400
      );
    }

    const body = await req.json();
    const { skus, kpiSummary } = body;

    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return jsonResponse(
        { success: false, message: "No SKU data provided" },
        400
      );
    }

    // Limit to most relevant SKUs to keep token count reasonable
    // Prioritize: critical/low stock first, then A class, then by suggested qty
    const prioritized = [...skus].sort((a: any, b: any) => {
      const statusOrder: Record<string, number> = {
        CRITICAL: 0,
        "LOW STOCK": 1,
        WARNING: 2,
        OK: 3,
        OVERSTOCK: 4,
      };
      const abcOrder: Record<string, number> = { A: 0, B: 1, C: 2 };
      const sa = statusOrder[a.status] ?? 3;
      const sb = statusOrder[b.status] ?? 3;
      if (sa !== sb) return sa - sb;
      const aa = abcOrder[a.abcClass] ?? 2;
      const ab = abcOrder[b.abcClass] ?? 2;
      if (aa !== ab) return aa - ab;
      return (b.suggestedQty ?? 0) - (a.suggestedQty ?? 0);
    });

    const topSKUs = prioritized.slice(0, 60);

    const prompt = buildPrompt({ skus: topSKUs, kpiSummary });

    console.log(
      `AI Insights: sending ${topSKUs.length} SKUs to Claude (${prompt.length} chars)`
    );

    // Call Claude API
    const claudeRes = await fetch(CLAUDE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: AbortSignal.timeout(55000),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("Claude API error:", claudeRes.status, errText);
      return jsonResponse(
        {
          success: false,
          message: `Claude API error: ${claudeRes.status} — ${errText.slice(0, 200)}`,
        },
        500
      );
    }

    const claudeData = await claudeRes.json();
    const rawContent = claudeData.content?.[0]?.text ?? "";

    console.log(`AI Insights: received ${rawContent.length} chars from Claude`);

    // Parse JSON from Claude's response
    let insights: InsightCard[] = [];
    try {
      // Try to extract JSON array from the response
      const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        insights = JSON.parse(jsonMatch[0]);
      } else {
        insights = JSON.parse(rawContent);
      }
    } catch (parseErr) {
      console.error("Failed to parse Claude response:", parseErr);
      console.error("Raw response:", rawContent.slice(0, 500));
      return jsonResponse(
        {
          success: false,
          message: "Failed to parse AI response. Please try again.",
        },
        500
      );
    }

    // Validate and sanitize insights
    insights = insights
      .filter(
        (i: any) => i.title && i.description && i.category && i.severity
      )
      .slice(0, 5)
      .map((i: any) => ({
        category: i.category,
        severity: i.severity,
        title: String(i.title).slice(0, 60),
        description: String(i.description).slice(0, 500),
        confidence: Math.min(99, Math.max(50, Number(i.confidence) || 85)),
        actionLabel: i.actionLabel ? String(i.actionLabel).slice(0, 25) : undefined,
        relatedSKUs: Array.isArray(i.relatedSKUs)
          ? i.relatedSKUs.slice(0, 3).map(String)
          : [],
      }));

    console.log(`AI Insights: returning ${insights.length} insight cards`);

    return jsonResponse({
      success: true,
      insights,
      generatedAt: new Date().toISOString(),
      model: CLAUDE_MODEL,
      skuCount: topSKUs.length,
    });
  } catch (error) {
    console.error("AI Insights error:", error);
    return jsonResponse(
      {
        success: false,
        message: `AI analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
      500
    );
  }
});
