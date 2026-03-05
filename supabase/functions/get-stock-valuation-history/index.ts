import { createClient } from 'npm:@supabase/supabase-js@2';

interface StockValuationHistoryRecord {
  id: number;
  recorded_at: string;
  data_source_date: string | null;
  main_warehouse: number;
  china: number;
  container: number;
  dhl: number;
  on_production: number;
  pesado_korea: number;
  total_inventory: number;
  created_at: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse query parameters for optional date filtering
    const url = new URL(req.url);
    const startDate = url.searchParams.get('startDate');
    const endDate = url.searchParams.get('endDate');
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    console.log(`Fetching stock valuation history - startDate: ${startDate}, endDate: ${endDate}, limit: ${limit}`);

    // Build query
    let query = supabase
      .from('stock_valuation_history')
      .select('*')
      .order('recorded_at', { ascending: false })
      .limit(limit);

    // Apply date filters if provided
    if (startDate) {
      query = query.gte('recorded_at', startDate);
    }
    if (endDate) {
      query = query.lte('recorded_at', endDate);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching stock valuation history:', error);
      throw error;
    }

    console.log(`Successfully fetched ${data?.length || 0} stock valuation history records`);

    return new Response(
      JSON.stringify({
        records: data || [],
        count: data?.length || 0
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );

  } catch (error) {
    console.error('Error in get-stock-valuation-history function:', error);

    return new Response(
      JSON.stringify({
        error: 'Failed to fetch stock valuation history',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
  }
});
