import { createClient } from 'npm:@supabase/supabase-js@2';
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

interface AimDataRequest {
  startDate: string;
  endDate: string;
  includeAllProducts?: boolean;
}

interface AimDataResponse {
  finalRows: any[];
  inventorySummaryRows: any[];
  assembledProductSKUs: string[];
  periodInfo: string;
  totalProductCount: number;
  stockValuationTotals: {
    mainWarehouse: number;
    china: number;
    container: number;
    dhl: number;
    onProduction: number;
    pesadoKorea: number;
    totalInventory: number;
  };
  stockValuationDetails: {
    mainWarehouseDetails: ValuationDetail[];
    chinaDetails: ValuationDetail[];
    containerDetails: ValuationDetail[];
    dhlDetails: ValuationDetail[];
    onProductionDetails: ValuationDetail[];
    pesadoKoreaDetails: ValuationDetail[];
  };
}

interface ValuationDetail {
  sku: string;
  product: string;
  quantity: number;
  unitCost: number;
  totalValue: number;
  productGroup?: string;
  purchaseOrders?: Array<{orderNumber: string; orderDate: string; quantity: number}>;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TABLE_HEADERS = [
  "SKU","Product","SoH Main WH","On Purchase Order","Allocated Main WH","SoH China W","Monthly Avg Sales","ROD","Days of Cover","Status","Suggested Reorder Qty",
];

const TABLE_HEADERS_SUMMARY = [
  "SKU","ROD","SoH Main WH","Allocated Main WH","Available Main WH","CONTAINER","DHL","SOH China","ON PRODUCTION China",
];

const BANNED_PATTERNS = [
  /\bmisc\.?\s*product\b/i,
  /\bcourier\s*fee\b/i,
  /\bb2b\s*pickup\s*\/?\s*dropship\b/i,
];

const REQUIRED_COLUMNS = {
  sales: ["Product Code", "Product", "Quantity", "Warehouse", "Status"],
  soh: ["Product Code", "Product Description", "Warehouse", "Qty On Hand", "Allocated", "Available Qty"],
  prod: ["Product Code", "Assembly Number", "Quantity", "Assemble By"],
  purchase: ["Product Code", "Quantity", "Order Status", "Base Unit Qty"],
  bom: ["Product Code"],
};

const HEADER_KEYWORDS = {
  sales: {
    "Product Code": ["product code", "productcode", "sku"],
    "Product": ["product", "product description", "description"],
    "Quantity": ["quantity", "qty"],
    "Warehouse": ["warehouse", "location"],
    "Status": ["status", "order status", "estado", "sales order status"]
  },
  soh: {
    "Product Code": ["product code", "productcode", "sku"],
    "Product Description": ["product description", "description", "product"],
    "Warehouse": ["warehouse", "location"],
    "Qty On Hand": ["qty on hand", "on hand", "stock", "quantity"],
    "Allocated": ["allocated", "allocation"],
    "Available Qty": ["available qty", "available quantity", "available"],
    "Product Group": ["product group", "productgroup", "group"]
  },
  prod: {
    "Product Code": ["product code", "productcode", "sku"],
    "Assembly Number": ["assembly number", "assembly no", "assembly", "assemblynumber"],
    "Quantity": ["quantity", "qty"],
    "Assemble By": ["assemble by", "assembleby", "assembly date", "date", "assemble date"]
  },
  purchase: {
    "Order Number": ["order number", "order no", "purchase order", "po number", "order code", "purchase order number"],
    "Order Date": ["order date", "date", "purchase date"],
    "Product Code": ["product code", "productcode", "sku"],
    "Quantity": ["quantity", "qty"],
    "Order Status": ["order status", "status", "purchase order status"],
    "Base Unit Qty": ["base unit qty", "base unit quantity", "base qty"],
    "Warehouse": ["warehouse", "location"],
    "Landed Cost": ["landed cost", "landedcost", "landed cost (aud)"]
  },
  bom: {
    "Product Code": ["product code", "productcode", "sku"]
  }
};

function findHeaderRow(rows: string[][], fileType: 'sales' | 'soh' | 'prod' | 'purchase' | 'bom'): { headerIndex: number; headers: string[]; headerMap: Record<string, number> } {
  const keywords = HEADER_KEYWORDS[fileType];
  const requiredCols = REQUIRED_COLUMNS[fileType];
  
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    const values = row.map(v => String(v || '').toLowerCase().trim());
    
    if (values.some(v => v.includes('sales enquiry as of') || v.includes('enquiry') || v.includes('report'))) {
      continue;
    }
    
    const meaningfulValues = values.filter(v => v && v.trim() !== '');
    if (meaningfulValues.length < 3) {
      continue;
    }
    
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

function parseCsvTextWithDynamicHeader(text: string, fileType: 'sales' | 'soh' | 'prod' | 'purchase' | 'bom'): Promise<{ header: string[]; rows: any[] }> {
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
        for (const [standardName, colIndex] of Object.entries(headerMap)) {
          obj[standardName] = r[colIndex];
        }
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

  const m1 = s.match(/^([0-3]?\d)[\/.-]([0-1]?\d)[\/.-](\d{2,4})$/);
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

function calculateDataSourceDate(soh: any[], purchase: any[]): Date | null {
  let maxDate: Date | null = null;

  // Find the most recent date from Stock on Hand data
  // SOH data typically doesn't have explicit dates, but we'll check for any date fields
  soh.forEach(row => {
    const dateKeys = Object.keys(row).filter(k => /date/i.test(k));
    dateKeys.forEach(key => {
      const date = parseDateSmart(row[key]);
      if (date && (!maxDate || date > maxDate)) {
        maxDate = date;
      }
    });
  });

  // Find the most recent date from Purchase Order data (Order Date)
  purchase.forEach(row => {
    const orderDate = parseDateSmart(row["Order Date"]);
    if (orderDate && (!maxDate || orderDate > maxDate)) {
      maxDate = orderDate;
    }
  });

  console.log(`Data source date calculated: ${maxDate ? maxDate.toISOString() : 'null'}`);
  return maxDate;
}

function calculatePeriodFromSelectedDates(startDate: Date, endDate: Date): { monthsFactor: number; minDate: Date; maxDate: Date } {
  const days = Math.max(1, (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const monthsFactor = days / 30.0;

  console.log(`Calculating period from selected dates: ${startDate.toISOString().slice(0,10)} to ${endDate.toISOString().slice(0,10)}`);
  console.log(`Days in period: ${days.toFixed(2)}, monthsFactor: ${monthsFactor.toFixed(2)}`);

  return { monthsFactor, minDate: startDate, maxDate: endDate };
}

function daysOfCover(sohMain: number, monthlyRod: number): string {
  const m = toNumber(monthlyRod);
  if (m <= 0) return "";
  return (toNumber(sohMain) / (m / 30)).toFixed(1);
}

function filterDataByDateRange(rows: any[], startDate: Date, endDate: Date, fileType?: 'sales' | 'prod' | 'purchase'): any[] {
  return rows.filter(row => {
    const keys = Object.keys(row);
    let dateKeys: string[];

    if (fileType === 'prod') {
      dateKeys = keys.filter((k) => k === 'Assemble By' || /assemble by|assembly date/i.test(k));
    } else {
      dateKeys = keys.filter((k) => /date/i.test(k));
    }

    for (const dateKey of dateKeys) {
      const date = parseDateSmart(row[dateKey]);
      if (date) {
        return date >= startDate && date <= endDate;
      }
    }

    return false;
  });
}

const cleanNumber = (value: any): number => {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  
  let s = String(value);
  
  const isParenNegative = /^\s*\(.*\)\s*$/.test(s);
  if (isParenNegative) s = '-' + s.replace(/[()]/g, '');
  
  s = s.replace(/[^0-9.-]/g, '');
  
  const parts = s.split('.');
  if (parts.length > 2) {
    const decimal = parts.pop();
    s = parts.join('') + '.' + decimal;
  }
  
  const num = parseFloat(s);
  return isNaN(num) ? 0 : num;
};

const parseCostsData = (csvText: string): Record<string, number> => {
  try {
    const rawData: string[][] = parse(csvText, { skipFirstRow: false });
    console.log(`Costs CSV: ${rawData.length} rows parsed`);
    const dataRows = rawData.slice(1);
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { startDate: startDateStr, endDate: endDateStr, includeAllProducts = false }: AimDataRequest = await req.json();
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);

    console.log(`Processing AIM data for period: ${startDate.toISOString()} to ${endDate.toISOString()}, includeAllProducts: ${includeAllProducts}`);

    const fileNames = [
      'SalesEnquiryList.csv',
      'SOHList.csv',
      'ProductionEnquiryList.csv',
      'PurchaseEnquiryList.csv',
      'BillOfMaterialsList.csv',
      'costs.csv'
    ];

    const [salesText, sohText, prodText, purchText, bomText, costsText] = await Promise.all(
      fileNames.map(async (fileName) => {
        const { data, error } = await supabase.storage
          .from('aim-csv-files')
          .download(fileName);

        if (error) {
          console.error(`Error downloading ${fileName}:`, error);
          return '';
        }

        return await data.text();
      })
    );

    console.log('Files downloaded successfully');

    console.log(`costsText length: ${costsText.length > 0 ? costsText.length : 'empty'}`);
    if (costsText.length > 0) {
      console.log('First 200 chars of costsText:', costsText.substring(0, 200));
    }

    const costs = costsText ? parseCostsData(costsText) : {};
    console.log(`Parsed costs map contains ${Object.keys(costs).length} SKUs`);
    if (Object.keys(costs).length > 0) {
      console.log('Sample costs:', Object.fromEntries(Object.entries(costs).slice(0, 5)));
    } else {
      console.log('WARNING: No costs were parsed from the costs file');
    }

    const [{ rows: sales }, { rows: soh }, { rows: prod }, { rows: purchase }, { rows: bom }] = await Promise.all([
      parseCsvTextWithDynamicHeader(salesText, 'sales'),
      parseCsvTextWithDynamicHeader(sohText, 'soh'),
      parseCsvTextWithDynamicHeader(prodText, 'prod'),
      parseCsvTextWithDynamicHeader(purchText, 'purchase'),
      parseCsvTextWithDynamicHeader(bomText, 'bom'),
    ]);

    console.log(`Parsed data - Sales: ${sales.length}, SOH: ${soh.length}, Production: ${prod.length}, Purchase: ${purchase.length}, BOM: ${bom.length}`);

    const assembledProductSKUs = new Set<string>();
    bom.forEach(row => {
      const sku = String(row["Product Code"]).trim();
      if (sku) {
        assembledProductSKUs.add(sku);
      }
    });

    console.log(`Found ${assembledProductSKUs.size} assembled product SKUs`);

    const purchMap: Record<string, number> = {};
    const containerMap: Record<string, number> = {};
    const dhlMap: Record<string, number> = {};
    const onProductionChinaMap: Record<string, number> = {};

    // Maps to store purchase order info: { [sku]: Array<{orderNumber, orderDate, quantity, status}> }
    const containerPurchaseInfo: Record<string, Array<{orderNumber: string; orderDate: string; quantity: number}>> = {};
    const dhlPurchaseInfo: Record<string, Array<{orderNumber: string; orderDate: string; quantity: number}>> = {};
    const onProductionPurchaseInfo: Record<string, Array<{orderNumber: string; orderDate: string; quantity: number}>> = {};

    const validPurchaseStatuses = ['placed', 'container', 'dhl', 'dhl inbounds', 'dhl-inbounds', 'production'];

    let purchaseOrderDebugCount = 0;
    purchase
      .filter(row => {
        const status = String(row["Order Status"] || "").trim().toLowerCase();
        return validPurchaseStatuses.includes(status);
      })
      .forEach(row => {
        const sku = String(row["Product Code"]).trim();
        const qty = cleanNumber(row["Quantity"]);
        const baseUnitQty = cleanNumber(row["Base Unit Qty"]);
        const status = String(row["Order Status"] || "").trim().toLowerCase();
        const warehouse = String(row["Warehouse"] || "").trim();

        // Extract Order Number (Column A) and Order Date (Column B)
        const orderNumber = String(row["Order Number"] || row["Purchase Order Number"] || "").trim();
        const orderDate = String(row["Order Date"] || "").trim();

        // Debug logging for first few purchase orders
        if (purchaseOrderDebugCount < 5) {
          console.log(`\n=== Purchase Order Debug #${purchaseOrderDebugCount + 1} ===`);
          console.log(`SKU: ${sku}`);
          console.log(`Order Number mapped: "${orderNumber}"`);
          console.log(`Order Date mapped: "${orderDate}"`);
          console.log(`Status: ${status}`);
          console.log(`Base Unit Qty: ${baseUnitQty}`);
          console.log(`Available keys in row:`, Object.keys(row).slice(0, 10));
          purchaseOrderDebugCount++;
        }

        if (status === 'container') {
          containerMap[sku] = (containerMap[sku] || 0) + Math.abs(baseUnitQty);
          if (!containerPurchaseInfo[sku]) containerPurchaseInfo[sku] = [];
          containerPurchaseInfo[sku].push({
            orderNumber,
            orderDate,
            quantity: Math.abs(baseUnitQty)
          });
        }

        if (status === 'dhl' || status === 'dhl inbounds' || status === 'dhl-inbounds') {
          dhlMap[sku] = (dhlMap[sku] || 0) + Math.abs(baseUnitQty);
          if (!dhlPurchaseInfo[sku]) dhlPurchaseInfo[sku] = [];
          dhlPurchaseInfo[sku].push({
            orderNumber,
            orderDate,
            quantity: Math.abs(baseUnitQty)
          });
        }

        if (status === 'production' && warehouse.toLowerCase() === 'china-w') {
          onProductionChinaMap[sku] = (onProductionChinaMap[sku] || 0) + Math.abs(baseUnitQty);
          if (!onProductionPurchaseInfo[sku]) onProductionPurchaseInfo[sku] = [];
          onProductionPurchaseInfo[sku].push({
            orderNumber,
            orderDate,
            quantity: Math.abs(baseUnitQty)
          });
        }

        if (sku) {
          purchMap[sku] = (purchMap[sku] || 0) + Math.abs(qty);
        }
      });
    
    console.log(`Processed purchase orders: ${Object.keys(purchMap).length} SKUs with valid status (Placed, CONTAINER, DHL)`);
    console.log(`Processed China-W Production orders: ${Object.keys(onProductionChinaMap).length} SKUs`);
    console.log(`Container purchase info: ${Object.keys(containerPurchaseInfo).length} SKUs`);
    console.log(`DHL purchase info: ${Object.keys(dhlPurchaseInfo).length} SKUs`);
    console.log(`Production purchase info: ${Object.keys(onProductionPurchaseInfo).length} SKUs`);

    // Sample purchase order info for debugging
    const sampleContainerSku = Object.keys(containerPurchaseInfo)[0];
    if (sampleContainerSku) {
      console.log(`Sample container purchase info for ${sampleContainerSku}:`, containerPurchaseInfo[sampleContainerSku]);
    }

    const productNameMap: Record<string, string> = {};
    const productGroupMap: Record<string, string> = {};
    soh.forEach((r) => {
      const sku = String(r["Product Code"]).trim();
      const productName = String(r["Product Description"] || "").trim();
      const productGroup = String(r["Product Group"] || "").trim();
      if (sku && productName) {
        productNameMap[sku] = productName;
      }
      if (sku && productGroup) {
        productGroupMap[sku] = productGroup;
      }
    });

    console.log(`Created product name map with ${Object.keys(productNameMap).length} SKUs`);
    console.log(`Created product group map with ${Object.keys(productGroupMap).length} SKUs`);

    const hasCols = (arr: any[], needed: string[]) => {
      if (!arr.length) return false;
      const availableKeys = Object.keys(arr[0]);
      const missingCols = needed.filter(col => !availableKeys.includes(col));
      if (missingCols.length > 0) {
        console.warn(`Missing columns: ${missingCols.join(', ')}. Available: ${availableKeys.join(', ')}`);
      }
      return missingCols.length === 0;
    };
    
    if (!hasCols(sales, REQUIRED_COLUMNS.sales)) {
      throw new Error("SalesEnquiryList.csv: required columns missing.");
    }
    if (!hasCols(soh, REQUIRED_COLUMNS.soh)) {
      throw new Error("SOHList.csv: required columns missing.");
    }
    if (!hasCols(prod, REQUIRED_COLUMNS.prod)) {
      throw new Error("ProductionEnquiryList.csv: required columns missing.");
    }
    if (!hasCols(purchase, REQUIRED_COLUMNS.purchase)) {
      throw new Error("PurchaseEnquiryList.csv: required columns missing.");
    }

    const filteredSales = filterDataByDateRange(sales, startDate, endDate, 'sales');
    const filteredProd = filterDataByDateRange(prod, startDate, endDate, 'prod');

    console.log(`Filtered data by date range - Sales: ${filteredSales.length}, Production: ${filteredProd.length}`);
    console.log(`Original data counts - Sales: ${sales.length}, Production: ${prod.length}`);
    console.log(`Filtering efficiency - Sales: ${((filteredSales.length / sales.length) * 100).toFixed(1)}%, Production: ${((filteredProd.length / prod.length) * 100).toFixed(1)}%`);

    const { monthsFactor, minDate, maxDate } = calculatePeriodFromSelectedDates(startDate, endDate);
    const periodStr = `Period selected: ${minDate.toISOString().slice(0,10)} → ${maxDate.toISOString().slice(0,10)} • monthsFactor=${monthsFactor.toFixed(2)} • Filtered records: ${filteredSales.length} sales, ${filteredProd.length} production`;

    console.log(`Period info: ${periodStr}`);

    const salesMain = filteredSales
      .filter((r) => String(r["Warehouse"]).trim() === "Main Warehouse")
      .filter((r) => {
        const status = String(r["Status"] || "").trim().toLowerCase();
        return status !== "parked";
      })
      .reduce((acc: any, r) => {
        const sku = String(r["Product Code"]).trim();
        const qty = cleanNumber(r["Quantity"]);
        const productName = String(r["Product"] ?? "");
        if (!acc[sku]) acc[sku] = { salesQty: 0, product: productName };
        acc[sku].salesQty += qty;
        if (!acc[sku].product && productName) acc[sku].product = productName;
        return acc;
      }, {});

    console.log(`Processed sales for ${Object.keys(salesMain).length} unique SKUs from Main Warehouse`);

    const compUsage = filteredProd.reduce((acc: any, r) => {
      const assemblyNumber = String(r["Assembly Number"] || "").trim();
      const sku = String(r["Product Code"]).trim();
      const rawQty = r["Quantity"];
      const cleanQty = cleanNumber(rawQty);
      const qty = Math.abs(cleanQty);

      // Only count as component usage when used in OTHER assemblies (ASM-XXXXX)
      // Exclude disassembly records (DSM-XXXXX) where the product itself is being assembled/disassembled
      const isComponentUsage = assemblyNumber && !assemblyNumber.toUpperCase().startsWith('DSM');

      // Only count negative quantities (components used in production)
      // Positive quantities are the assembled products themselves
      // Also exclude DSM records where the product is being assembled (not used as component)
      if (sku && cleanQty < 0 && isComponentUsage) {
        acc[sku] = (acc[sku] || 0) + qty;
      }

      return acc;
    }, {});

    console.log(`Processed component usage for ${Object.keys(compUsage).length} unique SKUs from production records`);

    // Debug: Show top 10 components by usage
    const topComponents = Object.entries(compUsage)
      .sort((a: any, b: any) => b[1] - a[1])
      .slice(0, 10);
    console.log('Top 10 components by usage:');
    topComponents.forEach(([sku, qty]) => {
      console.log(`  ${sku}: ${qty}`);
    });

    const sohMain: Record<string, number> = {};
    const sohAllocated: Record<string, number> = {};
    const sohChina: Record<string, number> = {};
    const sohPesadoKorea: Record<string, number> = {};
    const availableMainWH: Record<string, number> = {};
    const availableChinaWH: Record<string, number> = {};
    const availablePesadoKoreaWH: Record<string, number> = {};

    soh.forEach((r) => {
      const sku = String(r["Product Code"]).trim();
      const wh = String(r["Warehouse"]).trim();
      const qoh = toNumber(r["Qty On Hand"]);
      const alloc = toNumber(r["Allocated"]);
      const available = toNumber(r["Available Qty"]);

      if (wh === "Main Warehouse") {
        sohMain[sku] = (sohMain[sku] || 0) + qoh;
        sohAllocated[sku] = (sohAllocated[sku] || 0) + alloc;
        availableMainWH[sku] = (availableMainWH[sku] || 0) + available;
      }
      if (wh === "China-W") {
        sohChina[sku] = (sohChina[sku] || 0) + qoh;
        availableChinaWH[sku] = (availableChinaWH[sku] || 0) + available;
      }
      if (wh === "Pesado Korea") {
        sohPesadoKorea[sku] = (sohPesadoKorea[sku] || 0) + qoh;
        availablePesadoKoreaWH[sku] = (availablePesadoKoreaWH[sku] || 0) + available;
      }
    });

    const mf = monthsFactor || 1.0;

    let allSkus: string[];
    if (includeAllProducts) {
      const skusWithStock = new Set<string>();
      Object.keys(sohMain).forEach(sku => {
        if (sohMain[sku] > 0) skusWithStock.add(sku);
      });
      Object.keys(sohChina).forEach(sku => {
        if (sohChina[sku] > 0) skusWithStock.add(sku);
      });
      Object.keys(sohPesadoKorea).forEach(sku => {
        if (sohPesadoKorea[sku] > 0) skusWithStock.add(sku);
      });

      allSkus = Array.from(new Set([
        ...Object.keys(salesMain),
        ...Object.keys(compUsage),
        ...Array.from(skusWithStock)
      ]));

      console.log(`Include All Products mode: ${allSkus.length} total SKUs (${skusWithStock.size} with stock, ${Object.keys(salesMain).length} with sales, ${Object.keys(compUsage).length} with component usage)`);
    } else {
      allSkus = Array.from(new Set([...Object.keys(salesMain), ...Object.keys(compUsage)]));
      console.log(`Top 400 mode: ${allSkus.length} SKUs with sales or component usage`);
    }

    const rodMap = allSkus.reduce((acc: any, sku) => {
      const salesQty = salesMain[sku]?.salesQty || 0;
      const compQty = compUsage[sku] || 0;
      const isAssembledProduct = assembledProductSKUs.has(sku);

      const total = isAssembledProduct ? salesQty : (salesQty + compQty);

      const productName = salesMain[sku]?.product || productNameMap[sku] || "";

      const monthlyAvgSales = salesQty / mf;
      const rod = total / mf;

      acc[sku] = {
        product: productName,
        monthlyAvgSales,
        rod,
      };

      return acc;
    }, {});

    let topSkus: string[];
    if (includeAllProducts) {
      topSkus = Object.entries(rodMap)
        .filter(([sku, v]: [string, any]) => String(sku).trim().length > 0 && !BANNED_PATTERNS.some((rx) => rx.test(String(v.product || ""))))
        .sort((a: any, b: any) => {
          const aRod = a[1].rod || 0;
          const bRod = b[1].rod || 0;
          if (aRod === 0 && bRod === 0) {
            const aSoh = (sohMain[a[0]] || 0) + (sohChina[a[0]] || 0);
            const bSoh = (sohMain[b[0]] || 0) + (sohChina[b[0]] || 0);
            return bSoh - aSoh;
          }
          return bRod - aRod;
        })
        .map(([sku]) => sku);

      console.log(`Include All Products: ${topSkus.length} products to display`);
    } else {
      topSkus = Object.entries(rodMap)
        .filter(([sku, v]: [string, any]) => String(sku).trim().length > 0 && !BANNED_PATTERNS.some((rx) => rx.test(String(v.product || ""))))
        .sort((a: any, b: any) => b[1].rod - a[1].rod)
        .slice(0, 400)
        .map(([sku]) => sku);

      console.log(`Top 400 mode: ${topSkus.length} products selected`);
    }

    const LEAD_TIME_MONTHS = 2;
    const finalRows = topSkus.map((sku) => {
      const meta = rodMap[sku] || { product: "", monthlyAvgSales: 0, rod: 0 };
      const sohM = sohMain[sku] || 0;
      const allocM = sohAllocated[sku] || 0;
      const sohC = sohChina[sku] || 0;
      const monthly = meta.monthlyAvgSales || 0;
      const doc = daysOfCover(sohM, meta.rod);
      const sugg = monthly * LEAD_TIME_MONTHS - sohM;
      const status = doc !== "" && parseFloat(doc) < 30 ? "LOW STOCK" : "OK";
      
      return {
        SKU: sku,
        Product: meta.product,
        "SoH Main WH": sohM,
        "On Purchase Order": purchMap[sku] || 0,
        "Allocated Main WH": allocM,
        "SoH China W": sohC,
        "Monthly Avg Sales": Math.round(monthly * 100) / 100,
        ROD: Math.round(meta.rod * 100) / 100,
        "Days of Cover": doc,
        Status: status,
        "Suggested Reorder Qty": Math.round(sugg),
      };
    });

    finalRows.sort((a, b) => {
      if (a.Status !== b.Status) return a.Status === "LOW STOCK" ? -1 : 1;
      return b.ROD - a.ROD;
    });

    const inventorySummaryRows = topSkus.map((sku) => {
      const meta = rodMap[sku] || { product: "", monthlyAvgSales: 0, rod: 0 };
      const sohM = sohMain[sku] || 0;
      const allocM = sohAllocated[sku] || 0;
      const availM = availableMainWH[sku] || 0;
      const containerQty = containerMap[sku] || 0;
      const dhlQty = dhlMap[sku] || 0;
      const sohC = sohChina[sku] || 0;
      const onProductionChina = onProductionChinaMap[sku] || 0;
      
      return {
        SKU: sku,
        ROD: Math.round(meta.rod * 100) / 100,
        "SoH Main WH": sohM,
        "Allocated Main WH": allocM,
        "Available Main WH": availM,
        "CONTAINER": containerQty,
        "DHL": dhlQty,
        "SOH China": sohC,
        "ON PRODUCTION China": onProductionChina,
      };
    });

    const allValuationSkus = new Set<string>();

    Object.keys(sohMain).forEach(sku => allValuationSkus.add(sku));
    Object.keys(sohChina).forEach(sku => allValuationSkus.add(sku));
    Object.keys(sohPesadoKorea).forEach(sku => allValuationSkus.add(sku));
    Object.keys(costs).forEach(sku => allValuationSkus.add(sku));

    console.log(`All valuation SKUs for Main/China/Pesado Korea: ${allValuationSkus.size} SKUs`);

    let mainWarehouseValue = 0;
    let chinaValue = 0;
    let pesadoKoreaValue = 0;
    let containerValue = 0;
    let dhlValue = 0;
    let onProductionValue = 0;

    const mainWarehouseDetails: ValuationDetail[] = [];
    const chinaDetails: ValuationDetail[] = [];
    const pesadoKoreaDetails: ValuationDetail[] = [];
    const containerDetails: ValuationDetail[] = [];
    const dhlDetails: ValuationDetail[] = [];
    const onProductionDetails: ValuationDetail[] = [];

    console.log(`Starting stock valuation calculation`);
    console.log(`Main/China/Pesado Korea: ${allValuationSkus.size} SKUs, Container/DHL/Production: ${topSkus.length} top SKUs`);
    let skusWithCosts = 0;
    let skusWithoutCosts = 0;

    Array.from(allValuationSkus).forEach((sku) => {
      const unitCost = costs[sku] || 0;

      const productName = productNameMap[sku] ||
                         (rodMap[sku] && rodMap[sku].product) ||
                         "";

      const productGroup = productGroupMap[sku] || "";

      if (unitCost > 0) {
        skusWithCosts++;
      } else {
        skusWithoutCosts++;
      }

      const sohMainQty = Math.max(0, sohMain[sku] || 0);
      const sohChinaQty = Math.max(0, sohChina[sku] || 0);
      const sohPesadoKoreaQty = Math.max(0, sohPesadoKorea[sku] || 0);

      const mainWarehouseItemValue = sohMainQty * unitCost;
      const chinaItemValue = sohChinaQty * unitCost;
      const pesadoKoreaItemValue = sohPesadoKoreaQty * unitCost;

      mainWarehouseValue += mainWarehouseItemValue;
      chinaValue += chinaItemValue;
      pesadoKoreaValue += pesadoKoreaItemValue;

      if (sohMainQty > 0) {
        mainWarehouseDetails.push({
          sku,
          product: productName,
          quantity: sohMainQty,
          unitCost,
          totalValue: mainWarehouseItemValue,
          productGroup
        });
      }

      if (sohChinaQty > 0) {
        chinaDetails.push({
          sku,
          product: productName,
          quantity: sohChinaQty,
          unitCost,
          totalValue: chinaItemValue,
          productGroup
        });
      }

      if (sohPesadoKoreaQty > 0) {
        pesadoKoreaDetails.push({
          sku,
          product: productName,
          quantity: sohPesadoKoreaQty,
          unitCost,
          totalValue: pesadoKoreaItemValue,
          productGroup
        });
      }
    });

    topSkus.forEach((sku) => {
      const unitCost = costs[sku] || 0;
      const meta = rodMap[sku] || { product: "", monthlyAvgSales: 0, rod: 0 };
      const productGroup = productGroupMap[sku] || "";

      const containerQty = Math.max(0, containerMap[sku] || 0);
      const dhlQty = Math.max(0, dhlMap[sku] || 0);
      const onProductionQty = Math.max(0, onProductionChinaMap[sku] || 0);

      const containerItemValue = containerQty * unitCost;
      const dhlItemValue = dhlQty * unitCost;
      const onProductionItemValue = onProductionQty * unitCost;

      containerValue += containerItemValue;
      dhlValue += dhlItemValue;
      onProductionValue += onProductionItemValue;

      if (containerQty > 0) {
        containerDetails.push({
          sku,
          product: meta.product,
          quantity: containerQty,
          unitCost,
          totalValue: containerItemValue,
          productGroup,
          purchaseOrders: containerPurchaseInfo[sku] || []
        });
      }

      if (dhlQty > 0) {
        dhlDetails.push({
          sku,
          product: meta.product,
          quantity: dhlQty,
          unitCost,
          totalValue: dhlItemValue,
          productGroup,
          purchaseOrders: dhlPurchaseInfo[sku] || []
        });
      }

      if (onProductionQty > 0) {
        onProductionDetails.push({
          sku,
          product: meta.product,
          quantity: onProductionQty,
          unitCost,
          totalValue: onProductionItemValue,
          productGroup,
          purchaseOrders: onProductionPurchaseInfo[sku] || []
        });
      }
    });

    console.log(`Stock valuation summary:`);
    console.log(`Main/China/Pesado Korea: ${skusWithCosts} SKUs with costs, ${skusWithoutCosts} SKUs without costs`);
    console.log(`Container details: ${containerDetails.length} SKUs`);
    console.log(`DHL details: ${dhlDetails.length} SKUs`);
    console.log(`Production details: ${onProductionDetails.length} SKUs`);
    console.log(`Main Warehouse details: ${mainWarehouseDetails.length} SKUs`);
    console.log(`China details: ${chinaDetails.length} SKUs`);
    console.log(`Pesado Korea details: ${pesadoKoreaDetails.length} SKUs`);

    console.log(`Cost source: costs.csv with ${Object.keys(costs).length} SKUs`);

    console.log(`=== FINAL STOCK VALUATION DETAILS ===`);
    console.log(`Main Warehouse details array length: ${mainWarehouseDetails.length}`);
    console.log(`China details array length: ${chinaDetails.length}`);
    console.log(`Pesado Korea details array length: ${pesadoKoreaDetails.length}`);
    console.log(`Container details array length: ${containerDetails.length}`);
    console.log(`DHL details array length: ${dhlDetails.length}`);
    console.log(`Production details array length: ${onProductionDetails.length}`);

    if (mainWarehouseDetails.length > 0) {
      console.log(`Sample Main Warehouse detail:`, mainWarehouseDetails[0]);
    }
    if (chinaDetails.length > 0) {
      console.log(`Sample China detail:`, chinaDetails[0]);
    }
    if (pesadoKoreaDetails.length > 0) {
      console.log(`Sample Pesado Korea detail:`, pesadoKoreaDetails[0]);
    }
    console.log(`=== END FINAL STOCK VALUATION DETAILS ===`);
    const totalInventoryValue = mainWarehouseValue + chinaValue + pesadoKoreaValue + containerValue + dhlValue + onProductionValue;

    const stockValuationTotals = {
      mainWarehouse: Math.round(mainWarehouseValue * 100) / 100,
      china: Math.round(chinaValue * 100) / 100,
      container: Math.round(containerValue * 100) / 100,
      dhl: Math.round(dhlValue * 100) / 100,
      onProduction: Math.round(onProductionValue * 100) / 100,
      pesadoKorea: Math.round(pesadoKoreaValue * 100) / 100,
      totalInventory: Math.round(totalInventoryValue * 100) / 100,
    };

    console.log(`Final stock valuation totals:`, stockValuationTotals);

    // Calculate data source date (most recent date from the source data)
    const dataSourceDate = calculateDataSourceDate(soh, purchase);

    // Save stock valuation history to database with deduplication logic
    try {
      // Optimize: Get only the last 5 records instead of all from today
      // This significantly reduces query time and memory usage
      const { data: recentRecords, error: queryError } = await supabase
        .from('stock_valuation_history')
        .select('id, data_source_date, main_warehouse, china, container, dhl, on_production, pesado_korea, total_inventory')
        .order('created_at', { ascending: false })
        .limit(5);

      if (queryError) {
        console.error('Error querying recent stock valuation records:', queryError);
      }

      let shouldInsert = true;
      let skipReason = '';

      const newSourceDateStr = dataSourceDate ? dataSourceDate.toISOString().split('T')[0] : null;

      // Check if we already have an identical record in the last 5 entries
      if (recentRecords && recentRecords.length > 0) {
        console.log(`Found ${recentRecords.length} recent records to check`);

        for (const record of recentRecords) {
          const recordSourceDateStr = record.data_source_date
            ? new Date(record.data_source_date).toISOString().split('T')[0]
            : null;

          // Check if both date AND values match
          const datesMatch = recordSourceDateStr === newSourceDateStr;

          const valuesMatch =
            Math.abs(record.main_warehouse - stockValuationTotals.mainWarehouse) < 0.01 &&
            Math.abs(record.china - stockValuationTotals.china) < 0.01 &&
            Math.abs(record.container - stockValuationTotals.container) < 0.01 &&
            Math.abs(record.dhl - stockValuationTotals.dhl) < 0.01 &&
            Math.abs(record.on_production - stockValuationTotals.onProduction) < 0.01 &&
            Math.abs((record.pesado_korea || 0) - stockValuationTotals.pesadoKorea) < 0.01 &&
            Math.abs(record.total_inventory - stockValuationTotals.totalInventory) < 0.01;

          if (datesMatch && valuesMatch) {
            shouldInsert = false;
            skipReason = `Duplicate record found (ID: ${record.id}) - same data_source_date (${recordSourceDateStr}) and identical values`;
            console.log(skipReason);
            break;
          }
        }

        if (shouldInsert && newSourceDateStr) {
          console.log(`New or updated data for date ${newSourceDateStr} - will insert record`);
        }
      } else {
        console.log('No recent records found, will insert first record');
      }

      if (shouldInsert) {
        const recordToInsert = {
          recorded_at: dataSourceDate ? dataSourceDate.toISOString() : new Date().toISOString(),
          data_source_date: dataSourceDate ? dataSourceDate.toISOString() : null,
          main_warehouse: stockValuationTotals.mainWarehouse,
          china: stockValuationTotals.china,
          container: stockValuationTotals.container,
          dhl: stockValuationTotals.dhl,
          on_production: stockValuationTotals.onProduction,
          pesado_korea: stockValuationTotals.pesadoKorea,
          total_inventory: stockValuationTotals.totalInventory
        };

        console.log('Inserting new stock valuation record:', recordToInsert);

        const { error: insertError } = await supabase
          .from('stock_valuation_history')
          .insert(recordToInsert);

        if (insertError) {
          console.error('Error saving stock valuation history:', insertError);
        } else {
          console.log('Stock valuation history saved successfully');
        }
      } else {
        console.log(`Skipping stock valuation history insert: ${skipReason}`);
      }
    } catch (historyError) {
      console.error('Exception while saving stock valuation history:', historyError);
    }

    const response: AimDataResponse = {
      finalRows,
      inventorySummaryRows,
      assembledProductSKUs: Array.from(assembledProductSKUs),
      periodInfo: periodStr,
      totalProductCount: topSkus.length,
      stockValuationTotals,
      stockValuationDetails: {
        mainWarehouseDetails,
        chinaDetails,
        containerDetails,
        dhlDetails,
        onProductionDetails,
        pesadoKoreaDetails
      }
    };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });

  } catch (error) {
    console.error('Error processing AIM data:', error);
    
    return new Response(
      JSON.stringify({ 
        error: 'Failed to process AIM data',
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