import { createClient } from 'npm:@supabase/supabase-js@2';
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";
import { format } from 'npm:date-fns@3.6.0';

interface UnleashedRow {
  orderDate: Date;
  product: string;
  customer: string;
  quantity: number;
  subTotal: number;
  productGroup: string;
  channel: string;
  brand: string;
  warehouse: string;
  status: string;
}

interface ShopifyRow {
  date: Date;
  netSales: number;
  sku: string;
  quantity: number;
  region: string;
  taxes: number;
  shipping: number;
}

interface MetaRow {
  date: Date;
  spend: number;
  spendUSD?: number;
  currency: string;
  conversionValue?: number;
}

interface OldShopifyRow {
  date: Date;
  netSales: number;
  region: string;
}

interface DataResponse {
  unleashed: UnleashedRow[];
  shopify: ShopifyRow[];
  oldShopify: OldShopifyRow[];
  meta: MetaRow[];
  costs: Record<string, number>;
  fxRate: number;
  fxRates?: Record<string, number>;
  lastOrderDate: string | null;
}

interface RequestBody {
  startDate?: string;
  endDate?: string;
  // Optional storage folder to read the source files from, e.g. "fy2025-26".
  // Empty/absent = live files at the bucket root (default behavior).
  prefix?: string;
  // Snapshot folders are immutable, so their parsed result is cached as
  // <prefix>/parsed-snapshot.json. Set materialize=true to (re)build that cache
  // — the only path that re-parses the CSVs. See SNAPSHOT_CACHE below.
  materialize?: boolean;
}

// Re-parsing a snapshot on every request means reading ~23MB of CSV and
// serialising ~9MB of JSON inside one worker — that intermittently trips
// Supabase's WORKER_RESOURCE_LIMIT (HTTP 546), which is what broke the FY
// Report. A fiscal-year snapshot never changes, so parse it once and serve the
// stored JSON afterwards (streamed straight through, near-zero CPU).
//
// Note: the cached payload freezes fxRates for the range it was built with.
// That's correct for a closed FY, and the FY Report always asks for the same
// range. The live path (no prefix) is untouched.
const SNAPSHOT_CACHE = 'parsed-snapshot.json';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Utility functions (copied from frontend)
const cleanNumber = (value: any): number => {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  
  let s = String(value);
  
  // Handle parentheses negatives: "(1,234.50)" -> "-1,234.50"
  const isParenNegative = /^\s*\(.*\)\s*$/.test(s);
  if (isParenNegative) s = '-' + s.replace(/[()]/g, '');
  
  // Normalize decimal/comma: remove all non [0-9 . -]
  // Then collapse multiple dots to the last one if needed
  s = s.replace(/[^0-9.-]/g, '');
  
  // If there are multiple dots, keep the last as decimal point
  const parts = s.split('.');
  if (parts.length > 2) {
    const decimal = parts.pop();
    s = parts.join('') + '.' + decimal;
  }
  
  const num = parseFloat(s);
  return isNaN(num) ? 0 : num;
};

const parseDate = (dateStr: any): Date | null => {
  if (!dateStr) return null;
  
  const s = String(dateStr).split(' ')[0]; // Obtener solo la parte de la fecha

  // Intentar parsear como DD/MM/YYYY primero
  const parts = s.split('/');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // El mes es de 0 a 11
    const year = parseInt(parts[2], 10);

    // Validar las partes para evitar fechas inválidas que JavaScript podría "corregir" (ej. 31/02)
    if (!isNaN(day) && !isNaN(month) && !isNaN(year) && month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const date = new Date(Date.UTC(year, month, day));
      // Verificar que los componentes de la fecha coincidan después del parseo
      // Esto asegura que no se haya producido una coerción de fecha (ej. 31/02 -> 2 de marzo)
      if (date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day) {
        return date;
      }
    }
  }
  
  // Si el parseo DD/MM/YYYY falló o no fue aplicable, intentar el formato ISO (que es más fiable)
  const isoDate = new Date(s);
  if (!isNaN(isoDate.getTime())) {
    // Asegurarse de que se trate como UTC para la consistencia
    return new Date(Date.UTC(isoDate.getFullYear(), isoDate.getMonth(), isoDate.getDate()));
  }

  return null;
};

const getChannelAndBrand = (customer: string): { channel: string; brand: string } => {
  // Handle empty or whitespace-only customer names
  if (!customer || customer.trim() === '') {
    return { channel: 'Unclassified', brand: 'Unknown' };
  }

  const customerLower = customer.trim().toLowerCase();

  // Shop sale
  if (customerLower.includes('shop sale')) {
    return { channel: 'Shop sale', brand: 'Pesado' };
  }

  // Web sales (online sales customers)
  if (customerLower.endsWith('-onlinesale')) {
    if (customerLower.startsWith('dolo-')) {
      return { channel: 'Web', brand: 'Dolo' };
    } else if (customerLower.startsWith('artisanbarista-')) {
      return { channel: 'Web', brand: 'The Artisan Barista' };
    } else if (customerLower.startsWith('pesado-')) {
      return { channel: 'Web', brand: 'Pesado' };
    }
  }

  // All other customers from Unleashed (that passed the Customer Type != Web filter) are B2B
  return { channel: 'B2B', brand: 'B2B' };
};

const findHeaderRow = (rows: string[][]): { headerIndex: number; headers: string[] } => {
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    const values = row.map(v => String(v || '').toLowerCase());
    
    // Skip rows that are clearly not headers
    if (values.some(v => v.includes('sales enquiry as of') || v.includes('enquiry'))) {
      continue;
    }
    
    // Skip rows with mostly empty or generic values
    const meaningfulValues = values.filter(v => v && v.trim() !== '');
    if (meaningfulValues.length < 3) {
      continue;
    }
    
    // Check if this row contains typical header keywords
    const hasOrderDate = values.some(v => 
      v.includes('order date') || v.includes('orderdate') || 
      v === 'order date' || v === 'date'
    );
    const hasProduct = values.some(v => 
      (v.includes('product') && !v.includes('group')) || 
      v.includes('sku') || v === 'product'
    );
    const hasCustomer = values.some(v => 
      v.includes('customer') || v === 'customer'
    );
    const hasQuantity = values.some(v => 
      v.includes('quantity') || v.includes('qty') || v === 'quantity'
    );
    const hasSubTotal = values.some(v => 
      v.includes('sub total') || v.includes('subtotal') || 
      v.includes('total') || v === 'total'
    );
    
    // Need at least 3 of these key columns to consider it a header row
    const headerScore = [hasOrderDate, hasProduct, hasCustomer, hasQuantity, hasSubTotal].filter(Boolean).length;
    
    if (headerScore >= 3) {
      return { headerIndex: i, headers: row };
    }
  }
  
  console.warn('No suitable header row found, using first row as fallback');
  return { headerIndex: 0, headers: rows[0] || [] };
};

const getFxRate = async (): Promise<number> => {
  try {
    const response = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=AUD');
    const data = await response.json();

    if (data.success && data.rates?.AUD) {
      return data.rates.AUD;
    } else {
      throw new Error('Invalid response');
    }
  } catch (error) {
    console.warn('Failed to fetch FX rate, using fallback:', error);
    return 1.44; // Fallback rate
  }
};

const getExchangeRatesForDateRange = async (
  supabase: any,
  startDate: Date,
  endDate: Date
): Promise<Record<string, number>> => {
  try {
    const monthsInRange: Array<{ year: number; month: number }> = [];
    const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const endMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

    while (current <= endMonth) {
      monthsInRange.push({
        year: current.getFullYear(),
        month: current.getMonth() + 1,
      });
      current.setMonth(current.getMonth() + 1);
    }

    const { data: rates, error } = await supabase
      .from('currency_exchange_rates')
      .select('year, month, rate')
      .in('year', [...new Set(monthsInRange.map((m) => m.year))]);

    if (error) {
      console.error('Error fetching exchange rates from DB:', error);
      throw error;
    }

    const rateMap: Record<string, number> = {};
    const fallbackRate = 1.54;

    for (const monthInfo of monthsInRange) {
      const key = `${monthInfo.year}-${monthInfo.month}`;
      const rateData = rates?.find(
        (r: any) => r.year === monthInfo.year && r.month === monthInfo.month
      );

      if (rateData) {
        rateMap[key] = parseFloat(rateData.rate.toString());
        console.log(`Loaded rate for ${key}: ${rateMap[key]}`);
      } else {
        console.warn(
          `No rate found for ${key}, using fallback: ${fallbackRate}`
        );
        rateMap[key] = fallbackRate;
      }
    }

    return rateMap;
  } catch (error) {
    console.error('Failed to fetch exchange rates, using fallback', error);
    return {};
  }
};

const getRateForDate = (date: Date | null, rateMap: Record<string, number>): number => {
  if (!date) return 1.54;

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const key = `${year}-${month}`;

  return rateMap[key] || 1.54;
};

const parseUnleashedData = (csvText: string): UnleashedRow[] => {
  try {
    // Use Deno.std/csv for robust CSV parsing
    const rawData: string[][] = parse(csvText, { skipFirstRow: false });
    
    console.log(`=== CSV PARSING DEBUG ===`);
    console.log(`Raw CSV text length: ${csvText.length} characters`);
    console.log(`Parsed rows count: ${rawData.length}`);
    console.log(`First few rows:`, rawData.slice(0, 3));
  
    const { headerIndex, headers } = findHeaderRow(rawData);
    console.log(`Header found at index: ${headerIndex}`);
    console.log(`Headers:`, headers);
    
    const dataRows = rawData.slice(headerIndex + 1);
    console.log(`Data rows after header: ${dataRows.length}`);
  
    // Convert to objects using detected headers
    const processedData = dataRows.map((row: string[]) => {
      const obj: any = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });
    console.log(`Processed data objects: ${processedData.length}`);
  
    // Filter out rows where Customer Type = "Web" (case insensitive)
    // EXCEPT for online sales customers (Dolo-OnlineSale, ArtisanBarista-OnlineSale, Pesado-OnlineSale)
    const filteredData = processedData.filter((row: any) => {
      const customerType = String(row['Customer Type'] || '').trim().toLowerCase();
      const customerName = String(row['Customer'] || '').trim().toLowerCase();

      // Allow Web customer type if it's one of the online sales customers
      if (customerType === 'web') {
        const isOnlineSale = customerName.endsWith('-onlinesale') &&
                            (customerName.startsWith('dolo-') ||
                             customerName.startsWith('artisanbarista-') ||
                             customerName.startsWith('pesado-'));
        return isOnlineSale;
      }

      return true;
    });
    console.log(`Filtered data (excluding Customer Type = Web except online sales): ${filteredData.length}`);
    console.log(`Records lost to Customer Type = Web filter: ${processedData.length - filteredData.length}`);

    // Note: Status = "Parked" is now INCLUDED (no longer filtered out)

    // Convert to UnleashedRow objects
    const mappedData = filteredData.map((row: any) => {
      const orderDate = parseDate(row['Order Date'] || row['Date']);
      const customer = row['Customer'] || '';
      const warehouse = row['Warehouse'] || row['warehouse'] || '';
      const status = String(row['Status'] || '').trim();
      const { channel, brand } = getChannelAndBrand(customer);
      const subTotal = cleanNumber(row['Sub Total'] || row['Total']);

      return {
        orderDate: orderDate, // Don't use fallback to new Date()
        product: row['Product Code'] || row['Product'] || Object.values(row)[1] || '',
        customer,
        quantity: cleanNumber(row['Quantity']),
        subTotal,
        productGroup: row['Product Group'] || '',
        channel,
        brand,
        warehouse,
        status
      };
    });
    console.log(`Mapped data objects: ${mappedData.length}`);
  
    // Count invalid dates for logging (but don't filter them out)
    let invalidDateCount = 0;
    let zeroSubTotalCount = 0;
    
    mappedData.forEach(row => {
      if (!row.orderDate) {
        invalidDateCount++;
      }
      if (row.subTotal <= 0) {
        zeroSubTotalCount++;
      }
    });
    
    console.log(`Records with invalid dates: ${invalidDateCount}`);
    console.log(`Records with subTotal <= 0: ${zeroSubTotalCount}`);
    console.log(`Final result (no additional filtering applied): ${mappedData.length}`);
    console.log(`=== SUMMARY ===`);
    console.log(`Original rows: ${rawData.length}`);
    console.log(`After header removal: ${dataRows.length}`);
    console.log(`After Customer Type filter (Status = Parked now INCLUDED): ${filteredData.length}`);
    console.log(`Final result: ${mappedData.length}`);
    console.log(`=== END CSV PARSING DEBUG ===`);
  
    return mappedData;
    
  } catch (error) {
    console.error('Error in parseUnleashedData:', error);
    console.log('CSV text sample:', csvText.substring(0, 1000));
    throw error;
  }
};

const parseShopifyData = (csvText: string, rateMap: Record<string, number>): ShopifyRow[] => {
  try {
    const rawData: string[][] = parse(csvText, { skipFirstRow: false });
    console.log(`Shopify CSV: ${rawData.length} rows parsed`);
    const dataRows = rawData.slice(1); // Skip header

    const result = dataRows.map((row: string[]) => {
      const sku = row[2]; // Column C
      const quantity = cleanNumber(row[6]); // Column G
      const dateStr = row[5]; // Column F
      const netSalesStr = row[10]; // Column K
      const taxesStr = row[11]; // Column L - Taxes
      const shippingStr = row[13]; // Column N - Shipping charges
      const shippingCountry = row[4]; // Column E - Shipping country

      const date = parseDate(dateStr);

      // The Shopify CSV is now regenerated from the DB in AUD (native amounts,
      // US/other converted at market FX), so read these columns directly — no
      // USD→AUD conversion here (that double-converted foreign sales).
      const netSales = cleanNumber(netSalesStr);
      const taxes = cleanNumber(taxesStr);
      const shipping = cleanNumber(shippingStr);

      // Determine region based on shipping country
      let region = 'Other';
      if (shippingCountry) {
        const country = shippingCountry.toLowerCase().trim();
        if (country === 'us' || country === 'united states' || country === 'usa') {
          region = 'USA';
        } else if (country === 'au' || country === 'australia') {
          region = 'Australia';
        }
      }

      return {
        date: date || new Date(),
        netSales,
        sku: sku || '',
        quantity,
        region,
        taxes,
        shipping
      };
    }).filter(row => row.date && (row.netSales > 0 || row.taxes > 0 || row.shipping > 0));

    console.log(`Shopify final result: ${result.length} records`);
    return result;

  } catch (error) {
    console.error('Error in parseShopifyData:', error);
    return [];
  }
};

const parseOldShopifyData = (csvText: string): OldShopifyRow[] => {
  try {
    const rawData: string[][] = parse(csvText, { skipFirstRow: false });
    console.log(`Old Shopify CSV: ${rawData.length} rows parsed`);
    const dataRows = rawData.slice(1); // Skip header
  
    const result = dataRows.map((row: string[]) => {
      const dateStr = row[3]; // Column D
      const netSalesStr = row[8]; // Column I
      const shippingCountry = row[4]; // Column E - Shipping country
    
      const date = parseDate(dateStr);
      const netSales = cleanNumber(netSalesStr); // Already in AUD
      
      // Determine region based on shipping country
      let region = 'Other';
      if (shippingCountry) {
        const country = shippingCountry.toLowerCase().trim();
        if (country === 'us' || country === 'united states' || country === 'usa') {
          region = 'USA';
        } else if (country === 'au' || country === 'australia') {
          region = 'Australia';
        }
      }
    
      return {
        date: date || new Date(),
        netSales,
        region
      };
    }).filter(row => row.date && row.netSales > 0);
    
    console.log(`Old Shopify final result: ${result.length} records`);
    return result;
    
  } catch (error) {
    console.error('Error in parseOldShopifyData:', error);
    return [];
  }
};

const parseMetaData = (csvText: string, rateMap: Record<string, number>): MetaRow[] => {
  try {
    const rawData: string[][] = parse(csvText, { skipFirstRow: false });
    console.log(`Meta CSV: ${rawData.length} rows parsed`);
    const headers = rawData[0];
    console.log(`Meta CSV Headers detected:`, headers);
    const dataRows = rawData.slice(1);

    const result = dataRows.map((row: string[]) => {
      const obj: any = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || '';
      });

      const date = parseDate(
        obj['Date'] || obj['Reporting Starts'] || obj['Day'] || row[2]
      );

      const fxRate = getRateForDate(date, rateMap);

      let spend = cleanNumber(
        obj['Amount Spent (AUD)'] || obj['Amount Spent'] || obj['Spend'] ||
        obj['Cost'] || row[7]
      );

      const currency = obj['Currency'] || obj['Account Currency'] || 'AUD';

      let spendUSD = 0;
      if (currency === 'USD') {
        spendUSD = spend;
        spend = spend * fxRate; // Use month-specific rate
      }

      // Parse conversion value from new column
      let conversionValue = cleanNumber(
        obj['Purchases conversion value'] || obj['purchases conversion values'] ||
        obj['Purchases Conversion Values'] || obj['Purchase Conversion Value'] ||
        obj['Conversion Value'] || row[9] || 0
      );

      // Debug log for conversion value detection
      if (conversionValue > 0) {
        console.log(`Found conversion value: ${conversionValue} for date: ${date}`);
      }
      // Convert conversion value from USD to AUD if needed
      if (currency === 'USD' && conversionValue > 0) {
        conversionValue = conversionValue * fxRate; // Use month-specific rate
        console.log(`Converted conversion value to AUD: ${conversionValue}`);
      }

      return {
        date: date || new Date(),
        spend,
        spendUSD: spendUSD || undefined,
        currency,
        conversionValue: conversionValue > 0 ? conversionValue : undefined
      };
    }).filter(row => row.date && row.spend > 0);

    console.log(`Meta final result: ${result.length} records`);
    const totalConversions = result.reduce((sum, row) => sum + (row.conversionValue || 0), 0);
    console.log(`Total conversion values found: ${totalConversions}`);
    return result;

  } catch (error) {
    console.error('Error in parseMetaData:', error);
    return [];
  }
};

const parseCostsData = (csvText: string): Record<string, number> => {
  try {
    const rawData: string[][] = parse(csvText, { skipFirstRow: false });
    console.log(`Costs CSV: ${rawData.length} rows parsed`);
    const dataRows = rawData.slice(1); // Skip header
    const costMap: Record<string, number> = {};
  
    dataRows.forEach((row: string[]) => {
      const sku = String(row[0] || '').trim();
      const costValue = row[1];
      const cost = parseFloat(String(costValue));
    
      if (sku && !isNaN(cost) && cost > 0) {
        costMap[sku] = cost;
      }
    });
  
    console.log(`Costs final result: ${Object.keys(costMap).length} SKUs`);
    return costMap;
    
  } catch (error) {
    console.error('Error in parseCostsData:', error);
    return {};
  }
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request body to get date range
    let requestBody: RequestBody = {};
    if (req.method === 'POST') {
      try {
        requestBody = await req.json();
      } catch (e) {
        console.warn('Failed to parse request body, using defaults');
      }
    }

    // Get dates from request or use defaults
    const startDate = requestBody.startDate ? new Date(requestBody.startDate) : new Date(new Date().getFullYear(), 0, 1);
    const endDate = requestBody.endDate ? new Date(requestBody.endDate) : new Date();

    // Optional snapshot folder (e.g. "fy2025-26"). Only fiscal-year folders
    // are accepted; anything else falls back to the live bucket root.
    const folder = /^fy\d{4}-\d{2}$/.test(requestBody.prefix ?? '') ? requestBody.prefix as string : '';
    const pathPrefix = folder ? `${folder}/` : '';
    const materialize = requestBody.materialize === true;

    // Snapshot fast path: serve the pre-parsed JSON without touching the CSVs.
    // Streaming the Blob straight into the Response keeps the worker well under
    // its resource limit (the 546 this replaces). Applies to BOTH the frozen
    // fiscal-year folders AND the live root: the auto-sync re-materialises the
    // root snapshot at the end of every run, so the dashboard never re-parses the
    // ~23 MB of CSVs on load.
    if (!materialize) {
      const { data: cached } = await supabase.storage
        .from('csv-files')
        .download(`${pathPrefix}${SNAPSHOT_CACHE}`);
      if (cached) {
        console.log(`Snapshot cache hit: ${pathPrefix}${SNAPSHOT_CACHE}`);
        return new Response(cached, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Snapshot-Cache': 'hit' },
        });
      }
      console.log(`Snapshot cache miss for ${pathPrefix || 'root'} — parsing CSVs`);
    }

    // Get dynamic exchange rates for the date range
    const fxRates = await getExchangeRatesForDateRange(supabase, startDate, endDate);

    // Get current FX rate as fallback
    const fxRate = await getFxRate();

    // Find Shopify file by pattern
    let shopifySalesFileName = '';
    try {
      const { data: fileList, error: listError } = await supabase.storage
        .from('csv-files')
        .list(folder || undefined);

      if (listError) {
        console.error('Error listing files:', listError);
      } else {
        // Prefer the DB-regenerated canonical file; fall back to the manual dated
        // export (kept as a backup) so nothing breaks during the switch.
        const CANON = 'MARIO Total sales by product variant.csv';
        const shopifyFile = fileList?.find(file => file.name === CANON)
          ?? fileList?.find(file => file.name.startsWith('MARIO Total sales by product variant'));

        if (shopifyFile) {
          shopifySalesFileName = shopifyFile.name;
          console.log(`Found Shopify file: ${shopifySalesFileName}`);
        } else {
          console.warn('No Shopify file found matching pattern "MARIO Total sales by product variant"');
        }
      }
    } catch (error) {
      console.error('Error searching for Shopify file:', error);
    }

    // File names in storage (optionally inside the snapshot folder)
    const fileNames = [
      'SalesEnquiryList.csv',
      shopifySalesFileName,
      'old-shopify-sales.csv',
      '2-Mario-for-Danshboard.csv',
      'costs.csv'
    ]
      .filter(name => name !== '') // Remove empty shopify filename if not found
      .map(name => `${pathPrefix}${name}`);

    console.log('Using filenames:', fileNames);

    // Download and parse all files
    const fileContents = await Promise.all(
      fileNames.map(async (fileName, index) => {
        const { data, error } = await supabase.storage
          .from('csv-files')
          .download(fileName);

        if (error) {
          console.error(`Error downloading ${fileName}:`, error);
          return '';
        }

        return await data.text();
      })
    );

    // Map file contents to variables, handling the case where shopify file might be missing
    const unleashedText = fileContents[0] || '';
    const shopifyText = shopifySalesFileName ? fileContents[1] || '' : '';
    const oldShopifyText = shopifySalesFileName ? fileContents[2] || '' : fileContents[1] || '';
    const metaText = shopifySalesFileName ? fileContents[3] || '' : fileContents[2] || '';
    const costsText = shopifySalesFileName ? fileContents[4] || '' : fileContents[3] || '';

    // Parse all data using dynamic exchange rates
    const unleashed = unleashedText ? parseUnleashedData(unleashedText) : [];
    const shopify = shopifyText ? parseShopifyData(shopifyText, fxRates) : [];
    const oldShopify = oldShopifyText ? parseOldShopifyData(oldShopifyText) : [];
    const meta = metaText ? parseMetaData(metaText, fxRates) : [];
    const costs = costsText ? parseCostsData(costsText) : {};

    // Calculate the most recent order date from all data sources
    let lastOrderDate: Date | null = null;

    // Find max date from Unleashed data
    if (unleashed.length > 0) {
      const maxUnleashedDate = unleashed.reduce((max, row) => {
        if (!row.orderDate) return max;
        if (!max) return row.orderDate;
        return row.orderDate > max ? row.orderDate : max;
      }, null as Date | null);

      if (maxUnleashedDate && (!lastOrderDate || maxUnleashedDate > lastOrderDate)) {
        lastOrderDate = maxUnleashedDate;
      }
    }

    // Find max date from Shopify data
    if (shopify.length > 0) {
      const maxShopifyDate = shopify.reduce((max, row) => {
        if (!row.date) return max;
        if (!max) return row.date;
        return row.date > max ? row.date : max;
      }, null as Date | null);

      if (maxShopifyDate && (!lastOrderDate || maxShopifyDate > lastOrderDate)) {
        lastOrderDate = maxShopifyDate;
      }
    }

    // Find max date from Old Shopify data
    if (oldShopify.length > 0) {
      const maxOldShopifyDate = oldShopify.reduce((max, row) => {
        if (!row.date) return max;
        if (!max) return row.date;
        return row.date > max ? row.date : max;
      }, null as Date | null);

      if (maxOldShopifyDate && (!lastOrderDate || maxOldShopifyDate > lastOrderDate)) {
        lastOrderDate = maxOldShopifyDate;
      }
    }

    console.log(`Most recent order date found: ${lastOrderDate}`);

    const response: DataResponse = {
      unleashed,
      shopify,
      oldShopify,
      meta,
      costs,
      fxRate,
      fxRates,
      lastOrderDate: lastOrderDate ? lastOrderDate.toISOString() : null
    };

    const body = JSON.stringify(response);

    // Materialise the snapshot cache (root or folder) so every later read skips
    // the parse. For the live root this is called at the end of each auto-sync run.
    if (materialize) {
      const { error: upErr } = await supabase.storage
        .from('csv-files')
        .upload(`${pathPrefix}${SNAPSHOT_CACHE}`, new Blob([body], { type: 'application/json' }), {
          upsert: true,
          contentType: 'application/json',
        });
      if (upErr) console.error(`Failed to write snapshot cache: ${upErr.message}`);
      else console.log(`Snapshot cache written: ${pathPrefix}${SNAPSHOT_CACHE} (${body.length} bytes)`);
    }

    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
        'X-Snapshot-Cache': materialize ? 'written' : 'miss',
      },
    });

  } catch (error) {
    console.error('Error processing CSV data:', error);
    
    return new Response(
      JSON.stringify({ 
        error: 'Failed to process CSV data',
        details: error.message 
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