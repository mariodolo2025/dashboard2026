import { useState, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Table as TableIcon, Trash2, Info, Loader as Loader2, Download, Menu, ChevronDown, ChevronUp } from "lucide-react";

interface InventoryReorderDashboardProps {
  startDate: Date;
  endDate: Date;
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

// Fixed column order for table
const TABLE_HEADERS = [
  "SKU","Product","SoH Main WH","On Purchase Order","Allocated Main WH","SoH China W","Monthly Avg Sales","ROD","Days of Cover","Status","Suggested Reorder Qty",
];

// Fixed column order for inventory summary table
const TABLE_HEADERS_SUMMARY = [
  "SKU","ROD","SoH Main WH","Allocated Main WH","Available Main WH","CONTAINER","DHL","SOH China","ON PRODUCTION China",
];

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

export default function InventoryReorderDashboard({ startDate, endDate }: InventoryReorderDashboardProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [downloadingSkus, setDownloadingSkus] = useState<Set<string>>(new Set());
  const [resultsTableExpanded, setResultsTableExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [stockHistory, setStockHistory] = useState<StockValuationHistoryRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // State
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [output, setOutput] = useState<any[]>([]);
  const [inventorySummary, setInventorySummary] = useState<any[]>([]);
  const [assembledProductSKUs, setAssembledProductSKUs] = useState<Set<string>>(new Set());
  const [csvUrl, setCsvUrl] = useState("");
  const [periodInfo, setPeriodInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [stockValuationTotals, setStockValuationTotals] = useState({
    mainWarehouse: 0,
    china: 0,
    container: 0,
    dhl: 0,
    onProduction: 0,
    pesadoKorea: 0,
    totalInventory: 0,
  });
  const [stockValuationDetails, setStockValuationDetails] = useState<{
    mainWarehouseDetails: ValuationDetail[];
    chinaDetails: ValuationDetail[];
    containerDetails: ValuationDetail[];
    dhlDetails: ValuationDetail[];
    onProductionDetails: ValuationDetail[];
    pesadoKoreaDetails: ValuationDetail[];
  }>({
    mainWarehouseDetails: [],
    chinaDetails: [],
    containerDetails: [],
    dhlDetails: [],
    onProductionDetails: [],
    pesadoKoreaDetails: [],
  });

  // New state variables for filtering
  const [showAssembledProducts, setShowAssembledProducts] = useState(false);
  const [includeAllProducts, setIncludeAllProducts] = useState(false);
  const [skuSearchTerm, setSkuSearchTerm] = useState("");
  const [totalProductCount, setTotalProductCount] = useState(0);

  const fetchAimData = async () => {
    setError("");
    setOutput([]);
    setInventorySummary([]);
    setAssembledProductSKUs(new Set());
    setStatus("");
    setLoading(true);

    try {
      setStatus("Processing AIM data...");
      
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-aim-data`;
      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      };

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          includeAllProducts: includeAllProducts
        })
      });

      if (!response.ok) {
        throw new Error(`Error ${response.status}: ${response.statusText}`);
      }

      const data: AimDataResponse = await response.json();

      setOutput(data.finalRows || []);
      setInventorySummary(data.inventorySummaryRows || []);
      setAssembledProductSKUs(new Set(data.assembledProductSKUs || []));
      setPeriodInfo(data.periodInfo || "");
      setTotalProductCount(data.totalProductCount || 0);
      setStockValuationTotals(data.stockValuationTotals || {
        mainWarehouse: 0,
        china: 0,
        container: 0,
        dhl: 0,
        onProduction: 0,
        pesadoKorea: 0,
        totalInventory: 0,
      });
      setStockValuationDetails(data.stockValuationDetails || {
        mainWarehouseDetails: [],
        chinaDetails: [],
        containerDetails: [],
        dhlDetails: [],
        onProductionDetails: [],
        pesadoKoreaDetails: [],
      });

      console.log('Stock Valuation Details loaded:', {
        mainWarehouse: data.stockValuationDetails?.mainWarehouseDetails?.length || 0,
        china: data.stockValuationDetails?.chinaDetails?.length || 0,
        container: data.stockValuationDetails?.containerDetails?.length || 0,
        dhl: data.stockValuationDetails?.dhlDetails?.length || 0,
        onProduction: data.stockValuationDetails?.onProductionDetails?.length || 0,
        pesadoKorea: data.stockValuationDetails?.pesadoKoreaDetails?.length || 0,
      });

      setStatus("");
    } catch (e) {
      console.error('Error fetching AIM data:', e);
      setStatus("");
      setError(`Could not process AIM data: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const fetchStockHistory = async () => {
    setLoadingHistory(true);
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-stock-valuation-history`;
      const params = new URLSearchParams({ limit: '50' });

      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      };

      const response = await fetch(`${apiUrl}?${params}`, { headers });

      if (!response.ok) {
        throw new Error(`Error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const records = data.records || [];

      // Client-side deduplication: keep only unique records based on data_source_date and values
      const uniqueRecords: StockValuationHistoryRecord[] = [];
      const seen = new Set<string>();

      for (const record of records) {
        const dateStr = record.data_source_date
          ? new Date(record.data_source_date).toISOString().split('T')[0]
          : new Date(record.recorded_at).toISOString().split('T')[0];

        // Create a unique key combining date and all values
        const key = `${dateStr}-${record.main_warehouse}-${record.china}-${record.container}-${record.dhl}-${record.on_production}-${record.total_inventory}`;

        if (!seen.has(key)) {
          seen.add(key);
          uniqueRecords.push(record);
        }
      }

      console.log(`Stock history: ${records.length} total records, ${uniqueRecords.length} unique records after deduplication`);
      setStockHistory(uniqueRecords);
    } catch (error) {
      console.error('Error fetching stock history:', error);
      setError(`Error loading stock history: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoadingHistory(false);
    }
  };

  const downloadSkuOperations = async (sku: string) => {
    setDownloadingSkus(prev => new Set(prev).add(sku));
    
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-sku-operations`;
      const params = new URLSearchParams({
        sku: sku,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      });
      
      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      };

      const response = await fetch(`${apiUrl}?${params}`, { headers });

      if (!response.ok) {
        throw new Error(`Error ${response.status}: ${response.statusText}`);
      }

      // Get the CSV content as blob
      const blob = await response.blob();
      
      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `operations_${sku}_${startDate.toISOString().split('T')[0]}_to_${endDate.toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
    } catch (error) {
      console.error('Error downloading SKU operations:', error);
      setError(`Error downloading operations for ${sku}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDownloadingSkus(prev => {
        const newSet = new Set(prev);
        newSet.delete(sku);
        return newSet;
      });
    }
  };

  const downloadValuationCsv = (categoryName: string, details: ValuationDetail[]) => {
    if (details.length === 0) {
      setError(`No data available for ${categoryName}`);
      return;
    }

    try {
      // Determine if we need purchase order columns (for Container, DHL, On Production)
      const includePurchaseOrders = ['Container', 'DHL', 'On Production'].includes(categoryName);

      // CSV headers
      const headers = includePurchaseOrders
        ? ['SKU', 'Product', 'Product Group', 'Quantity', 'Unit Cost (AUD)', 'Total Value (AUD)', 'Order Code', 'Order Date']
        : ['SKU', 'Product', 'Product Group', 'Quantity', 'Unit Cost (AUD)', 'Total Value (AUD)'];

      // CSV rows
      const rows: string[][] = [];

      details.forEach(detail => {
        if (includePurchaseOrders && detail.purchaseOrders && detail.purchaseOrders.length > 0) {
          // Create a row for each purchase order
          detail.purchaseOrders.forEach(po => {
            rows.push([
              detail.sku,
              detail.product,
              detail.productGroup || '',
              po.quantity.toString(),
              detail.unitCost.toFixed(2),
              (po.quantity * detail.unitCost).toFixed(2),
              po.orderNumber || '',
              po.orderDate || ''
            ]);
          });
        } else if (includePurchaseOrders) {
          // No purchase orders, but include empty columns
          rows.push([
            detail.sku,
            detail.product,
            detail.productGroup || '',
            detail.quantity.toString(),
            detail.unitCost.toFixed(2),
            detail.totalValue.toFixed(2),
            '',
            ''
          ]);
        } else {
          // Standard row without purchase orders
          rows.push([
            detail.sku,
            detail.product,
            detail.productGroup || '',
            detail.quantity.toString(),
            detail.unitCost.toFixed(2),
            detail.totalValue.toFixed(2)
          ]);
        }
      });

      // Generate CSV content
      const csvContent = [headers, ...rows]
        .map(row => row.map(field => {
          // Escape quotes and wrap in quotes if contains comma, quote, or newline
          if (field.includes(',') || field.includes('"') || field.includes('\n')) {
            return `"${field.replace(/"/g, '""')}"`;
          }
          return field;
        }).join(','))
        .join('\n');

      // Create and trigger download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_valuation_${categoryName.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Error downloading ${categoryName} CSV: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Effect to load data when dates or includeAllProducts change
  useEffect(() => {
    if (startDate && endDate) {
      fetchAimData();
    }
  }, [startDate, endDate, includeAllProducts]);

  // Filtering logic
  const filteredOutput = useMemo(() => {
    let filtered = [...output];

    // SKU search filter
    if (skuSearchTerm.trim()) {
      filtered = filtered.filter(row => 
        String(row.SKU || '').toLowerCase().includes(skuSearchTerm.toLowerCase().trim())
      );
    }

    // Assembled products filter
    if (!showAssembledProducts) {
      filtered = filtered.filter(row => 
        !assembledProductSKUs.has(String(row.SKU || ''))
      );
    }

    return filtered;
  }, [output, skuSearchTerm, showAssembledProducts, assembledProductSKUs]);

  const filteredInventorySummary = useMemo(() => {
    let filtered = [...inventorySummary];

    // SKU search filter
    if (skuSearchTerm.trim()) {
      filtered = filtered.filter(row => 
        String(row.SKU || '').toLowerCase().includes(skuSearchTerm.toLowerCase().trim())
      );
    }

    // Assembled products filter
    if (!showAssembledProducts) {
      filtered = filtered.filter(row => 
        !assembledProductSKUs.has(String(row.SKU || ''))
      );
    }

    return filtered;
  }, [inventorySummary, skuSearchTerm, showAssembledProducts, assembledProductSKUs]);

  function downloadCsv() {
    if (!filteredOutput.length) return;
    try {
      // Simple CSV generation without Papa
      const headers = TABLE_HEADERS.join(',');
      const rows = filteredOutput.map(row => 
        TABLE_HEADERS.map(header => {
          const value = row[header] ?? '';
          // Escape quotes and wrap in quotes if contains comma, quote, or newline
          if (String(value).includes(',') || String(value).includes('"') || String(value).includes('\n')) {
            return `"${String(value).replace(/"/g, '""')}"`;
          }
          return String(value);
        }).join(',')
      );
      
      const csv = [headers, ...rows].join('\n');
      const href = 'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFF' + csv);
      setCsvUrl(href);
      
      const a = document.createElement('a');
      a.href = href;
      a.download = 'inventory_reorder_top400.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error('CSV download failed', e);
      setError('Could not generate CSV.');
    }
  }

  function resetAll() {
    setOutput([]);
    setInventorySummary([]);
    setAssembledProductSKUs(new Set());
    setError("");
    setStatus("");
    setPeriodInfo("");
    setCsvUrl("");
    setSkuSearchTerm("");
    setShowAssembledProducts(false);
    setIncludeAllProducts(false);
    setTotalProductCount(0);
    setStockValuationTotals({
      mainWarehouse: 0,
      china: 0,
      container: 0,
      dhl: 0,
      onProduction: 0,
      pesadoKorea: 0,
      totalInventory: 0,
    });
    setStockValuationDetails({
      mainWarehouseDetails: [],
      chinaDetails: [],
      containerDetails: [],
      dhlDetails: [],
      onProductionDetails: [],
      pesadoKoreaDetails: [],
    });
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="max-w-7xl mx-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-neutral-700">Inventory Reorder Dashboard</div>
          <Button variant="secondary" onClick={() => setSidebarOpen((v) => !v)} className="rounded-2xl">
            <Menu className="w-4 h-4 mr-1" /> {sidebarOpen ? 'Hide Menu' : 'Show Menu'}
          </Button>
        </div>
        <div className="grid grid-cols-12 gap-4">
          <aside className={`col-span-12 ${sidebarOpen ? 'md:col-span-3' : 'hidden'}`}>
            <Card className="shadow-sm">
              <CardContent className="p-4 grid gap-2">
                <div className="text-sm font-medium mb-1">Menu</div>
                <Button 
                  variant="default" 
                  className="rounded-2xl" 
                  onClick={fetchAimData}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      Processing...
                    </>
                  ) : (
                    'Update Data'
                  )}
                </Button>
                <Button 
                  variant="secondary" 
                  className="rounded-2xl" 
                  onClick={resetAll}
                  disabled={loading}
                >
                  <Trash2 className="w-4 h-4 mr-1" /> Clear
                </Button>
                
                <div className="border-t pt-2 mt-2">
                  <div className="text-xs font-medium mb-2 text-neutral-600">Unleashed Links</div>
                  <Button 
                    variant="secondary" 
                    className="rounded-2xl w-full text-xs" 
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/Enquiry/SalesEnquiry#transactionDateType=OrderDate,salesOrderStatuses=Parked%2CPlaced%2CBackordered%2CCompleted%2CB2B%2Cpls+print+send,warehouseIds=4%2C7%2C9%2C1%2C6%2C8%2C3%2C5,start=01%2F01%2F2025,end=30%2F06%2F2026', '_blank')}
                  >
                    Sales Enquiry
                  </Button>
                  <Button 
                    variant="secondary" 
                    className="rounded-2xl w-full text-xs" 
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/Production/ProductionEnquiry#type=All,autoAssembly=All,warehouseIds=1,assemblyStatus=Parked%2CCompleted,start=01%2F01%2F2025,end=30%2F06%2F2026', '_blank')}
                  >
                    Production Enquiry
                  </Button>
                  <Button 
                    variant="secondary" 
                    className="rounded-2xl w-full text-xs" 
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/Enquiry/StockOnHandEnquiry#warehouseId=-1,queryType=All,end=30%2F06%2F2026', '_blank')}
                  >
                    Stock On Hand Enquiry
                  </Button>
                  <Button 
                    variant="secondary" 
                    className="rounded-2xl w-full text-xs" 
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/Enquiry/PurchaseEnquiry#transactionDateType=OrderDate,orderStatus=Placed%2CCONTAINER%2CDHL-INBOUNDS%2CPRODUCTION,warehouseIds=4%2C1,start=01%2F01%2F2025,end=30%2F06%2F2026,quantityPricingOnly=false', '_blank')}
                  >
                    Purchase Inquiry
                  </Button>
                  <Button 
                    variant="secondary" 
                    className="rounded-2xl w-full text-xs" 
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/Production/ImportExport/?tabSelector=tabsBOM', '_blank')}
                  >
                    Bill Of Materials Enquiry
                  </Button>
                </div>
              </CardContent>
            </Card>
          </aside>

          <main className={`col-span-12 ${sidebarOpen ? 'md:col-span-9' : ''} grid gap-4`}>
            <Card className="shadow-sm">
              <CardContent className="p-4">
                <div className="text-sm text-neutral-600 flex items-start gap-2 mb-4">
                  <Info className="w-4 h-4 mt-0.5" />
                  <div>
                    {`ROD is calculated using ONLY data within the selected date range. The date range determines the monthsFactor used for calculations.
                    Rules: sales from "Main Warehouse" only (excluding Parked orders); components in absolute value; monthly ROD = (sales + components)/months selected;
                    Lead Time = 2 months; LOW STOCK if Days of Cover < 30.`}
                  </div>
                </div>

                {(status || error) && (
                  <div className="text-sm mb-4">
                    {status && <div className="text-neutral-700 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {status}</div>}
                    {error && <div className="text-red-700">{error}</div>}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Stock Valuation Card */}
            <Card className="shadow-sm">
              <CardContent className="p-4">
                <div className="text-base font-medium text-neutral-700 mb-4">Stock Valuation</div>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
                  <div 
                    className="text-center cursor-pointer hover:bg-neutral-100 p-2 rounded-lg transition-colors"
                    onClick={() => downloadValuationCsv('Main Warehouse', stockValuationDetails.mainWarehouseDetails)}
                    title="Click to download detailed CSV"
                  >
                    <div className="text-sm text-neutral-600">Main Warehouse</div>
                    <div className="text-base font-medium">AUD {stockValuationTotals.mainWarehouse.toLocaleString()}</div>
                    <div className="text-xs text-neutral-500">USD {(stockValuationTotals.mainWarehouse / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div 
                    className="text-center cursor-pointer hover:bg-neutral-100 p-2 rounded-lg transition-colors"
                    onClick={() => downloadValuationCsv('China', stockValuationDetails.chinaDetails)}
                    title="Click to download detailed CSV"
                  >
                    <div className="text-sm text-neutral-600">China</div>
                    <div className="text-base font-medium">AUD {stockValuationTotals.china.toLocaleString()}</div>
                    <div className="text-xs text-neutral-500">USD {(stockValuationTotals.china / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div 
                    className="text-center cursor-pointer hover:bg-neutral-100 p-2 rounded-lg transition-colors"
                    onClick={() => downloadValuationCsv('Container', stockValuationDetails.containerDetails)}
                    title="Click to download detailed CSV"
                  >
                    <div className="text-sm text-neutral-600">Container</div>
                    <div className="text-base font-medium">AUD {stockValuationTotals.container.toLocaleString()}</div>
                    <div className="text-xs text-neutral-500">USD {(stockValuationTotals.container / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div 
                    className="text-center cursor-pointer hover:bg-neutral-100 p-2 rounded-lg transition-colors"
                    onClick={() => downloadValuationCsv('DHL', stockValuationDetails.dhlDetails)}
                    title="Click to download detailed CSV"
                  >
                    <div className="text-sm text-neutral-600">DHL</div>
                    <div className="text-base font-medium">AUD {stockValuationTotals.dhl.toLocaleString()}</div>
                    <div className="text-xs text-neutral-500">USD {(stockValuationTotals.dhl / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div
                    className="text-center cursor-pointer hover:bg-neutral-100 p-2 rounded-lg transition-colors"
                    onClick={() => downloadValuationCsv('On Production', stockValuationDetails.onProductionDetails)}
                    title="Click to download detailed CSV"
                  >
                    <div className="text-sm text-neutral-600">On Production (to pay)</div>
                    <div className="text-base font-medium text-red-600">AUD {stockValuationTotals.onProduction.toLocaleString()}</div>
                    <div className="text-xs text-red-400">USD {(stockValuationTotals.onProduction / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div
                    className="text-center cursor-pointer hover:bg-neutral-100 p-2 rounded-lg transition-colors"
                    onClick={() => downloadValuationCsv('Pesado Korea', stockValuationDetails.pesadoKoreaDetails)}
                    title="Click to download detailed CSV"
                  >
                    <div className="text-sm text-neutral-600">Pesado Korea</div>
                    <div className="text-base font-medium">AUD {stockValuationTotals.pesadoKorea.toLocaleString()}</div>
                    <div className="text-xs text-neutral-500">USD {(stockValuationTotals.pesadoKorea / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                  </div>
                </div>
                <div className="border-t pt-4 text-center">
                  <div className="text-base text-neutral-600">Total Inventory Value</div>
                  <div className="text-lg font-bold">AUD {stockValuationTotals.totalInventory.toLocaleString()}</div>
                  <div className="text-sm text-neutral-500">USD {(stockValuationTotals.totalInventory / 1.54).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                </div>
              </CardContent>
            </Card>

            {/* Stock Valuation History */}
            <Card className="shadow-sm">
              <CardContent className="p-4">
                <div
                  className="flex items-center justify-between cursor-pointer hover:bg-neutral-50 p-2 -m-2 rounded-lg transition-colors"
                  onClick={() => {
                    setHistoryExpanded(!historyExpanded);
                    if (!historyExpanded && stockHistory.length === 0) {
                      fetchStockHistory();
                    }
                  }}
                >
                  <div className="flex items-center gap-2 text-base font-medium text-neutral-700">
                    Stock Valuation History
                    {historyExpanded ? (
                      <ChevronUp className="w-4 h-4 text-neutral-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-neutral-500" />
                    )}
                  </div>
                  {stockHistory.length > 0 && (
                    <div className="text-xs text-neutral-500">
                      {stockHistory.length} snapshots
                    </div>
                  )}
                </div>

                {historyExpanded && (
                  <div className="mt-4 space-y-4">
                    {loadingHistory ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-neutral-500" />
                        <span className="ml-2 text-sm text-neutral-600">Loading history...</span>
                      </div>
                    ) : stockHistory.length === 0 ? (
                      <div className="text-center py-8 text-sm text-neutral-500">
                        No historical data available yet. Data will be saved automatically when you update the dashboard.
                      </div>
                    ) : (
                      <>
                        <div className="overflow-x-auto rounded-lg border">
                          <table className="w-full text-sm">
                            <thead className="bg-neutral-100">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium">Data Date</th>
                                <th className="px-3 py-2 text-right font-medium">Main WH</th>
                                <th className="px-3 py-2 text-right font-medium">China</th>
                                <th className="px-3 py-2 text-right font-medium">Container</th>
                                <th className="px-3 py-2 text-right font-medium">DHL</th>
                                <th className="px-3 py-2 text-right font-medium">On Prod</th>
                                <th className="px-3 py-2 text-right font-medium">Pesado KR</th>
                                <th className="px-3 py-2 text-right font-medium">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {stockHistory.map((record, idx) => {
                                const displayDate = record.data_source_date || record.recorded_at;
                                const processedDate = record.created_at;
                                const isDataSourceDate = !!record.data_source_date;

                                return (
                                  <tr key={record.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-neutral-50'}>
                                    <td className="px-3 py-2 whitespace-nowrap">
                                      <div className="flex flex-col">
                                        <span className="font-medium">
                                          {new Date(displayDate).toLocaleDateString('en-AU', {
                                            year: 'numeric',
                                            month: 'short',
                                            day: 'numeric'
                                          })}
                                        </span>
                                        <span className="text-xs text-neutral-500" title={`Processed on ${new Date(processedDate).toLocaleString('en-AU')}`}>
                                          {isDataSourceDate ? 'Last Updated' : 'Recorded'}
                                        </span>
                                      </div>
                                    </td>
                                    <td className="px-3 py-2 text-right">${record.main_warehouse.toLocaleString()}</td>
                                    <td className="px-3 py-2 text-right">${record.china.toLocaleString()}</td>
                                    <td className="px-3 py-2 text-right">${record.container.toLocaleString()}</td>
                                    <td className="px-3 py-2 text-right">${record.dhl.toLocaleString()}</td>
                                    <td className="px-3 py-2 text-right text-red-600">${record.on_production.toLocaleString()}</td>
                                    <td className="px-3 py-2 text-right">${(record.pesado_korea || 0).toLocaleString()}</td>
                                    <td className="px-3 py-2 text-right font-medium">${record.total_inventory.toLocaleString()}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Filter Controls */}
            <Card className="shadow-sm">
              <CardContent className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label htmlFor="sku-search" className="text-sm font-medium text-neutral-700">
                      Search by SKU
                    </label>
                    <Input
                      id="sku-search"
                      type="text"
                      placeholder="Enter SKU to search..."
                      value={skuSearchTerm}
                      onChange={(e) => setSkuSearchTerm(e.target.value)}
                    />
                  </div>
                  <div className="flex items-end gap-4">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="include-all"
                        checked={includeAllProducts}
                        onCheckedChange={(checked) => setIncludeAllProducts(checked as boolean)}
                      />
                      <label htmlFor="include-all" className="text-sm font-medium text-neutral-700" title="Show all products with stock, not just top 400 by ROD">
                        Include All Products
                      </label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="show-assembled"
                        checked={showAssembledProducts}
                        onCheckedChange={(checked) => setShowAssembledProducts(checked as boolean)}
                      />
                      <label htmlFor="show-assembled" className="text-sm font-medium text-neutral-700">
                        Show Assembled Products
                      </label>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {filteredInventorySummary.length > 0 && (
              <>
                <Card className="shadow-sm">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-base font-medium mb-4">
                      <TableIcon className="w-5 h-5" />
                      Inventory Summary {includeAllProducts ? '(All Products)' : '(Top 400 by ROD)'}
                    </div>
                    {periodInfo && <div className="text-[11px] text-neutral-600 mb-3">{periodInfo}</div>}
                    <div className="text-xs text-neutral-500 mb-3">
                      Showing {filteredInventorySummary.length} of {totalProductCount} products
                      {!showAssembledProducts && assembledProductSKUs.size > 0 && (
                        <span> (excluding {assembledProductSKUs.size} assembled products)</span>
                      )}
                    </div>

                    <div className="rounded-xl border max-h-[70vh] overflow-auto">
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-neutral-100 sticky top-0 z-10">
                          <tr>
                            {TABLE_HEADERS_SUMMARY.map((h) => (
                              <th key={h} className="px-3 py-2 text-left font-medium text-base whitespace-normal break-words">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredInventorySummary.map((row, idx) => (
                            <tr key={idx} className={`${idx % 2 !== 0 ? 'bg-neutral-50' : 'bg-white'} hover:bg-neutral-100`}>
                              {TABLE_HEADERS_SUMMARY.map((h) => (
                                <td key={h} className="px-3 py-2 text-base whitespace-normal break-words border-t">{row[h] ?? ""}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

              </>
            )}

            {filteredOutput.length > 0 && (
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <div
                    className="flex items-center justify-between mb-1 cursor-pointer hover:bg-neutral-50 p-2 -m-2 rounded-lg transition-colors"
                    onClick={() => setResultsTableExpanded(!resultsTableExpanded)}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <TableIcon className="w-4 h-4" />
                      Results {includeAllProducts ? '(All Products, sorted by Status and ROD)' : '(Top 400 by ROD, sorted by Status)'}
                      {resultsTableExpanded ? (
                        <ChevronUp className="w-4 h-4 text-neutral-500" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-neutral-500" />
                      )}
                    </div>
                    <div className="flex flex-col md:flex-row md:items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button onClick={downloadCsv} className="rounded-2xl"><Download className="w-4 h-4 mr-1" /> Download CSV</Button>
                      {csvUrl && (
                        <a href={csvUrl} download="inventory_reorder_top400.csv" target="_blank" rel="noopener" className="text-blue-600 underline text-sm">If not downloading, click here</a>
                      )}
                    </div>
                  </div>
                  {periodInfo && <div className="text-[11px] text-neutral-600 mb-3">{periodInfo}</div>}
                  <div className="text-xs text-neutral-500 mb-3">
                    Showing {filteredOutput.length} of {totalProductCount} products
                    {!showAssembledProducts && assembledProductSKUs.size > 0 && (
                      <span> (excluding {assembledProductSKUs.size} assembled products)</span>
                    )}
                  </div>

                  {resultsTableExpanded && (
                    <div className="rounded-xl border max-h-[70vh] overflow-auto">
                    <table className="w-full table-fixed text-xs">
                      <thead className="bg-neutral-100 sticky top-0 z-10">
                        <tr>
                          {TABLE_HEADERS.map((h) => (
                            <th key={h} className="px-2 py-1 text-left whitespace-normal break-words">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredOutput.map((row, idx) => (
                          <tr key={idx} className={row.Status === "LOW STOCK" ? "bg-red-50" : "bg-white"}>
                            {TABLE_HEADERS.map((h) => {
                              // Make SKU column clickable for all SKUs
                              if (h === "SKU") {
                                const isDownloading = downloadingSkus.has(row[h]);
                                return (
                                  <td key={h} className="px-2 py-1 whitespace-normal break-words border-t">
                                    <span 
                                      onClick={() => downloadSkuOperations(row[h])}
                                      className={`text-blue-600 hover:text-blue-800 underline cursor-pointer ${isDownloading ? 'opacity-50' : ''}`}
                                      title="Download operations for this SKU"
                                    >
                                      {isDownloading ? `${row[h]} (downloading...)` : (row[h] ?? "")}
                                    </span>
                                  </td>
                                );
                              }
                              return (
                                <td key={h} className="px-2 py-1 whitespace-normal break-words border-t">{row[h] ?? ""}</td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  )}
                </CardContent>
              </Card>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}