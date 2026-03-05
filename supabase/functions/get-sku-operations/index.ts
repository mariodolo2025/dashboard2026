import { createClient } from 'npm:@supabase/supabase-js@2';
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

interface SkuOperationsRequest {
  sku: string;
  startDate: string;
  endDate: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Required columns for each file type
const REQUIRED_COLUMNS = {
  sales: ["Product Code", "Product", "Quantity", "Warehouse"],
  prod: ["Product Code", "Assembly Number", "Quantity", "Assemble By"],
};

// Header detection keywords for each file type
const HEADER_KEYWORDS = {
  sales: {
    "Product Code": ["product code", "productcode", "sku"],
    "Product": ["product", "product description", "description"],
    "Quantity": ["quantity", "qty"],
    "Warehouse": ["warehouse", "location"],
    "Order Date": ["order date", "orderdate", "date"],
    "Customer": ["customer", "client"]
  },
  prod: {
    "Product Code": ["product code", "productcode", "sku"],
    "Assembly Number": ["assembly number", "assembly no", "assembly", "assemblynumber"],
    "Quantity": ["quantity", "qty"],
    "Assemble By": ["assemble by", "assembleby", "assembly date", "date", "assemble date"],
    "Order Date": ["order date", "orderdate", "date"]
  }
};

// Utility functions (copied from process-aim-data)
function findHeaderRow(rows: string[][], fileType: 'sales' | 'prod'): { headerIndex: number; headers: string[]; headerMap: Record<string, number> } {
  const keywords = HEADER_KEYWORDS[fileType];
  const requiredCols = REQUIRED_COLUMNS[fileType];

  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    const values = row.map(v => String(v || '').toLowerCase().trim());

    // Skip rows that are clearly not headers
    if (values.some(v => v.includes('sales enquiry as of') || v.includes('enquiry') || v.includes('report'))) {
      continue;
    }

    // Skip rows with mostly empty or generic values
    const meaningfulValues = values.filter(v => v && v.trim() !== '');
    if (meaningfulValues.length < 3) {
      continue;
    }

    // Check if this row contains required columns based on keywords
    let matchedColumns = 0;
    const headerMapping: Record<string, number> = {};

    for (const [standardName, keywordList] of Object.entries(keywords)) {
      for (let colIndex = 0; colIndex < values.length; colIndex++) {
        const cellValue = values[colIndex];
        if (keywordList.some(keyword => cellValue.includes(keyword))) {
          headerMapping[standardName] = colIndex;
          matchedColumns++;
          break;
        }
      }
    }

    // Need at least 70% of required columns to consider it a header row
    const requiredMatchThreshold = Math.ceil(requiredCols.length * 0.7);

    if (matchedColumns >= requiredMatchThreshold) {
      console.log(`Header found at row ${i} for ${fileType} with ${matchedColumns}/${requiredCols.length} columns matched`);
      return { headerIndex: i, headers: row, headerMap: headerMapping };
    }
  }

  console.warn(`No suitable header row found for ${fileType}, using first row as fallback`);
  const fallbackMapping: Record<string, number> = {};
  const fallbackHeaders = rows[0] || [];
  fallbackHeaders.forEach((header, index) => {
    fallbackMapping[String(header || "").trim()] = index;
  });
  return { headerIndex: 0, headers: fallbackHeaders, headerMap: fallbackMapping };
}

function parseCsvTextWithDynamicHeader(text: string, fileType: 'sales' | 'prod'): Promise<{ header: string[]; rows: any[] }> {
  return new Promise((resolve, reject) => {
    try {
      const rawData: string[][] = parse(text, { skipFirstRow: false });
      
      if (!rawData || rawData.length < 1) {
        resolve({ header: [], rows: [] });
        return;
      }
      
      const { headerIndex, headers, headerMap } = findHeaderRow(rawData, fileType);
      const dataRows = rawData.slice(headerIndex + 1);
      
      console.log(`${fileType.toUpperCase()} CSV: Found header at row ${headerIndex}, processing ${dataRows.length} data rows`);
      
      const objects = dataRows.map((r) => {
        const obj: any = {};
        // Use headerMap to create objects with standardized keys
        for (const [standardName, colIndex] of Object.entries(headerMap)) {
          obj[standardName] = r[colIndex];
        }
        // Also include original headers for backward compatibility
        headers.forEach((h, i) => {
          const headerName = String(h || "").trim();
          if (headerName && !obj[headerName]) {
            obj[headerName] = r[i];
          }
        });
        return obj;
      });
      
      resolve({ header: headers, rows: objects });
    } catch (e) {
      console.error(`Error parsing ${fileType} CSV:`, e);
      reject(e);
    }
  });
}

const toNumber = (v: any): number => {
  const n = parseFloat(String(v ?? "").toString().replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

function parseDateSmart(value: any): Date | null {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  
  // dd/mm/yyyy or d/m/yy(y)
  const m1 = s.match(/^([0-3]?\d)[/.-]([0-1]?\d)[/.-](\d{2,4})$/);
  if (m1) {
    const d = parseInt(m1[1], 10);
    const mo = parseInt(m1[2], 10) - 1;
    let y = parseInt(m1[3], 10);
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, mo, d));
    return isNaN(dt.getTime()) ? null : dt;
  }
  
  const dt2 = new Date(s);
  return isNaN(dt2.getTime()) ? null : dt2;
}

function filterDataByDateRange(rows: any[], startDate: Date, endDate: Date): any[] {
  return rows.filter(row => {
    // Find date columns
    const keys = Object.keys(row);
    const dateKeys = keys.filter((k) => /date/i.test(k));
    
    for (const dateKey of dateKeys) {
      const date = parseDateSmart(row[dateKey]);
      if (date) {
        return date >= startDate && date <= endDate;
      }
    }
    
    return false; // If no valid date found, exclude the row
  });
}

function generateCsvString(operations: any[]): string {
  if (operations.length === 0) {
    return 'No operations found for this SKU in the specified date range';
  }

  // Get all unique keys from all operations
  const allKeys = Array.from(new Set(operations.flatMap(op => Object.keys(op))));
  
  // Create header row
  const headers = allKeys.join(',');
  
  // Create data rows
  const rows = operations.map(operation => {
    return allKeys.map(key => {
      const value = operation[key] ?? '';
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      if (String(value).includes(',') || String(value).includes('"') || String(value).includes('\n')) {
        return `"${String(value).replace(/"/g, '""')}"`;
      }
      return String(value);
    }).join(',');
  });
  
  return [headers, ...rows].join('\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Parse query parameters
    const url = new URL(req.url);
    const sku = url.searchParams.get('sku');
    const startDateStr = url.searchParams.get('startDate');
    const endDateStr = url.searchParams.get('endDate');

    if (!sku || !startDateStr || !endDateStr) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters: sku, startDate, endDate' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);

    console.log(`Getting operations for SKU: ${sku} from ${startDate.toISOString()} to ${endDate.toISOString()}`);

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Download files from aim-csv-files bucket
    const [salesText, prodText] = await Promise.all([
      'SalesEnquiryList.csv',
      'ProductionEnquiryList.csv'
    ].map(async (fileName) => {
      const { data, error } = await supabase.storage
        .from('aim-csv-files')
        .download(fileName);

      if (error) {
        console.error(`Error downloading ${fileName}:`, error);
        return '';
      }

      return await data.text();
    }));

    console.log('Files downloaded successfully');

    // Parse CSV files
    const [{ rows: sales }, { rows: prod }] = await Promise.all([
      parseCsvTextWithDynamicHeader(salesText, 'sales'),
      parseCsvTextWithDynamicHeader(prodText, 'prod'),
    ]);

    console.log(`Parsed data - Sales: ${sales.length}, Production: ${prod.length}`);

    // Filter data by date range
    const filteredSales = filterDataByDateRange(sales, startDate, endDate);
    const filteredProd = filterDataByDateRange(prod, startDate, endDate);

    console.log(`Filtered data by date range - Sales: ${filteredSales.length}, Production: ${filteredProd.length}`);

    // Filter by SKU and combine operations
    const operations: any[] = [];

    // Add sales operations for the specific SKU
    filteredSales
      .filter(row => String(row["Product Code"]).trim() === sku)
      .forEach(row => {
        operations.push({
          ...row,
          Type: 'Sales',
          Source: 'SalesEnquiryList.csv'
        });
      });

    // Add production operations for the specific SKU
    filteredProd
      .filter(row => String(row["Product Code"]).trim() === sku)
      .forEach(row => {
        operations.push({
          ...row,
          Type: 'Production',
          Source: 'ProductionEnquiryList.csv'
        });
      });

    console.log(`Found ${operations.length} operations for SKU ${sku}`);

    // Generate CSV string
    const csvContent = generateCsvString(operations);

    // Return CSV file
    return new Response(csvContent, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="operations_${sku}_${startDateStr}_to_${endDateStr}.csv"`,
        ...corsHeaders,
      },
    });

  } catch (error) {
    console.error('Error getting SKU operations:', error);
    
    return new Response(
      JSON.stringify({ 
        error: 'Failed to get SKU operations',
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