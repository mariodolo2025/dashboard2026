import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ExchangeRate {
  year: number;
  month: number;
  rate: number;
}

interface ExchangeRateMap {
  [key: string]: number;
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

    const { startDate, endDate } = await req.json();

    if (!startDate || !endDate) {
      return new Response(
        JSON.stringify({ error: "startDate and endDate are required" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const monthsInRange: Array<{ year: number; month: number }> = [];
    const current = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);

    while (current <= endMonth) {
      monthsInRange.push({
        year: current.getFullYear(),
        month: current.getMonth() + 1,
      });
      current.setMonth(current.getMonth() + 1);
    }

    const { data: rates, error } = await supabase
      .from("currency_exchange_rates")
      .select("year, month, rate")
      .in(
        "year",
        [...new Set(monthsInRange.map((m) => m.year))]
      );

    if (error) {
      console.error("Error fetching exchange rates:", error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch exchange rates" }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const rateMap: ExchangeRateMap = {};
    const fallbackRate = 1.54;

    for (const monthInfo of monthsInRange) {
      const key = `${monthInfo.year}-${monthInfo.month}`;
      const rateData = rates?.find(
        (r: ExchangeRate) =>
          r.year === monthInfo.year && r.month === monthInfo.month
      );

      if (rateData) {
        rateMap[key] = parseFloat(rateData.rate.toString());
      } else {
        console.warn(
          `No rate found for ${monthInfo.year}-${monthInfo.month}, using fallback: ${fallbackRate}`
        );
        rateMap[key] = fallbackRate;
      }
    }

    return new Response(
      JSON.stringify({
        rates: rateMap,
        fallbackRate,
        monthsIncluded: monthsInRange,
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
    console.error("Error in get-exchange-rates function:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
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
