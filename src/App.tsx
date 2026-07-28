import { useState, useEffect, useMemo } from 'react';
import { format, parseISO, isValid, startOfWeek, isWithinInterval, parse, addDays, differenceInDays } from 'date-fns';
import { Calendar as CalendarIcon, Download, RefreshCw, ChevronDown, ChevronUp, Link2, Eye, EyeOff, CheckCircle2, XCircle, Loader2, Search, X, AlertTriangle, PanelLeftClose, PanelLeft, Settings, LogOut, UserPlus, ShoppingBag } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell, LabelList } from 'recharts';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Tooltip as TooltipComponent, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn, downloadCSV, CSVColumn } from '@/lib/utils';
import { signOut } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { XeroData, computeCostsSnapshot, loadCostsConfigFromSupabase, saveCostsConfig, loadCostsConfig, saveCostsConfigToSupabase } from '@/lib/costsCalculator';
import { CostsSnapshot } from '@/lib/utils';
import SalesEvolutionContent from '@/components/SalesEvolutionContent';
import InventoryReorderDashboard from '@/components/InventoryReorderDashboard';
import MarioDashboard from '@/components/MarioDashboard';
import CostsCanvas from '@/components/CostsCanvas';
import { AIM2026Overlay } from '@/components/AIM2026Overlay';
import { B2CSalesExplorer } from '@/components/B2CSalesExplorer';
import { ReportsOverlay } from '@/components/ReportsOverlay';
import { ConnectionsPanel } from '@/components/ConnectionsPanel';
import EcommerceTab from '@/components/EcommerceTab';
import WebUpgradeTab from '@/components/WebUpgradeTab';
import { fetchDashboardData, recalcKPIsForDateRange } from '@/lib/aim2026/api';
import type { SKURow } from '@/lib/aim2026/types';
import { TrendIndicator } from '@/components/aim2026/TrendIndicator';
import ModalDateRangePicker from '@/components/ModalDateRangePicker';
import { DateRangePresets } from '@/components/DateRangePresets';

// Utility function to validate dates
const isValidDate = (date: any): date is Date => {
  return date instanceof Date && !isNaN(date.getTime());
};

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

interface CostRow {
  sku: string;
  cost: number;
}

interface WeeklyROAS {
  week: string;
  weekStart: Date;
  sales: number;
  spend: number;
  roas: number | null;
  purchaseRoas: number | null;
}

interface DateRange {
  from?: Date;
  to?: Date;
}

function App() {
  // State
  const [unleashedData, setUnleashedData] = useState<UnleashedRow[]>([]);
  const [shopifyData, setShopifyData] = useState<ShopifyRow[]>([]);
  const [oldShopifyData, setOldShopifyData] = useState<OldShopifyRow[]>([]);
  const [metaData, setMetaData] = useState<MetaRow[]>([]);
  const [costsData, setCostsData] = useState<Map<string, number>>(new Map());
  const [xeroData, setXeroData] = useState<XeroData | null>(null);

  const [dateRange, setDateRange] = useState<DateRange>({
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    to: new Date()
  });
  
  const [fxRate, setFxRate] = useState<number>(1.54);
  const [fxSource, setFxSource] = useState<string>('fallback 1.54');
  const [manualFxRate, setManualFxRate] = useState<string>('');
  const [blendedRoasTarget, setBlendedRoasTarget] = useState<number>(2.1);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [syncRunning, setSyncRunning] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<string[]>(['Shopify', 'B2B', 'Korea']);
  const [sortBy, setSortBy] = useState<string>('revenue');
  
  // New states for Top 20 SKUs and warehouse filter
  const [skuSortBy, setSkuSortBy] = useState<string>('revenue');
  const [activeWarehouse, setActiveWarehouse] = useState<string>('ALL');
  const [selectedSkuChannels, setSelectedSkuChannels] = useState<string[]>(['Shopify', 'B2B', 'Korea', 'Web']);
  const [skuSearchTerm, setSkuSearchTerm] = useState<string>('');
  const [downloadingSkus, setDownloadingSkus] = useState<Set<string>>(new Set());

  // Calendar state
  const [isCalendarOpen, setIsCalendarOpen] = useState<boolean>(false);

  // Configuration dialog state
  const [isConfigOpen, setIsConfigOpen] = useState<boolean>(false);

  // Costs modal state
  const [isCostsModalOpen, setIsCostsModalOpen] = useState<boolean>(false);

  // Sidebar collapsed state - minimized by default
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);

  // Modal for each nav pill - pills open modals instead of inline content
  // 'aim' is the archived Inventory Reorder view: no tab points at it any more,
  // but the modal is still mounted so it can be restored without a rebuild.
  const [activeModal, setActiveModal] = useState<'channel' | 'brand' | 'top-skus' | 'sales-evolution' | 'aim' | 'aim-2026' | 'ecommerce' | 'web-upgrade' | 'b2c-explorer' | 'fy-report' | null>(null);
  
  // Configurable financial parameters
  const [shippingCostPercent, setShippingCostPercent] = useState<number>(0.157);
  const [fixedCostDaily, setFixedCostDaily] = useState<number>(2200);
  const [otherVariableCostPercent, setOtherVariableCostPercent] = useState<number>(0.0318);
  
  // B2B configurable financial parameters
  const [fixedCostB2BDaily, setFixedCostB2BDaily] = useState<number>(950);
  const [otherVariableCostB2BPercent, setOtherVariableCostB2BPercent] = useState<number>(0.027);

  // Andrea's extra costs toggle
  const [andreaExtraCosts, setAndreaExtraCosts] = useState<boolean>(false);

  // Post-Marketing Contribution visibility toggle
  const [showPostMarketingContribution, setShowPostMarketingContribution] = useState<boolean>(false);

  // B2C Standard Model visibility toggle
  const [showB2CStandardModel, setShowB2CStandardModel] = useState<boolean>(false);

  // Costs source selection
  const [costsSource, setCostsSource] = useState<string>(() => {
    return localStorage.getItem('bychannel-costs-source') || 'estimations';
  });
  const [costsSnapshot, setCostsSnapshot] = useState<CostsSnapshot | null>(null);

  // Pesado critical stock (from AIM 2026)
  const [pesadoCriticalStock, setPesadoCriticalStock] = useState<SKURow[]>([]);
  const [pesadoCriticalLoading, setPesadoCriticalLoading] = useState(false);

  // Cost "Other" detail dialog (for grouped slices)
  const [costOtherDetail, setCostOtherDetail] = useState<{ title: string; items: { name: string; value: number }[] } | null>(null);

  // Expandable cost lines states
  const [expandedB2CVariableCost, setExpandedB2CVariableCost] = useState<boolean>(false);
  const [expandedB2CFixedCost, setExpandedB2CFixedCost] = useState<boolean>(false);
  const [expandedB2CAndreaCost, setExpandedB2CAndreaCost] = useState<boolean>(false);
  const [expandedB2BVariableCost, setExpandedB2BVariableCost] = useState<boolean>(false);
  const [expandedB2BFixedCost, setExpandedB2BFixedCost] = useState<boolean>(false);
  const [expandedB2BAndreaCost, setExpandedB2BAndreaCost] = useState<boolean>(false);

  // Helper function to get B2C standard model percentages
  const getB2CStandardModelPercent = (metric: string): string => {
    const standardModel: Record<string, string> = {
      'Total Shopify COGS': '25-60%',
      'Total Meta Spend': '25%',
      'Shipping cost': '10%',
      'Fixed cost': '5-25%',
      'Estimated Revenue': '5-15%'
    };
    return standardModel[metric] || '';
  };

  // Mario Dashboard states
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [showMarioDashboard, setShowMarioDashboard] = useState(false);

  // Unleashed Integration states
  const [unleashedApiId, setUnleashedApiId] = useState<string>('');
  const [unleashedApiKey, setUnleashedApiKey] = useState<string>('');
  const [showUnleashedApiKey, setShowUnleashedApiKey] = useState<boolean>(false);
  const [unleashedConnectionStatus, setUnleashedConnectionStatus] = useState<{
    success: boolean;
    message: string;
    orderCount?: number;
    itemCount?: number;
  } | null>(null);
  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false);
  const [isSavingCredentials, setIsSavingCredentials] = useState<boolean>(false);
  const [inviteEmail, setInviteEmail] = useState<string>('');
  const [invitePassword, setInvitePassword] = useState<string>('');
  const [inviteStatus, setInviteStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isInviting, setIsInviting] = useState<boolean>(false);
  const [shopifyStoreUrl, setShopifyStoreUrl] = useState<string>('');
  const [shopifyAccessToken, setShopifyAccessToken] = useState<string>('');
  const [metaAdAccountIds, setMetaAdAccountIds] = useState<string>('');
  const [metaAccessToken, setMetaAccessToken] = useState<string>('');
  const [ecommerceCredsStatus, setEcommerceCredsStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isSavingEcommerceCreds, setIsSavingEcommerceCreds] = useState<boolean>(false);
  const [csvLoadStatus, setCsvLoadStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isLoadingCsv, setIsLoadingCsv] = useState<boolean>(false);

  // Load data from Supabase Edge Function
  const loadDataFromSupabase = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-csv-data`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: dateRange.from?.toISOString(),
          endDate: dateRange.to?.toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(data.details || data.error);
      }

      // Helper function to convert date strings to Date objects
      const ensureDate = (dateValue: any): Date | null => {
        if (!dateValue) return null;
        if (dateValue instanceof Date) return dateValue;
        const parsed = parseDate(dateValue);
        return parsed;
      };

      // Convert date strings to Date objects for all data arrays
      const processedUnleashed = (data.unleashed || []).map((row: any) => ({
        ...row,
        orderDate: ensureDate(row.orderDate)
      }));

      const processedShopify = (data.shopify || []).map((row: any) => ({
        ...row,
        date: ensureDate(row.date)
      }));

      const processedOldShopify = (data.oldShopify || []).map((row: any) => ({
        ...row,
        date: ensureDate(row.date)
      }));

      const processedMeta = (data.meta || []).map((row: any) => ({
        ...row,
        date: ensureDate(row.date),
        conversionValue: row.conversionValue
      }));

      // Update all data states
      setUnleashedData(processedUnleashed);
      setShopifyData(processedShopify);
      setOldShopifyData(processedOldShopify);
      setMetaData(processedMeta);

      // Convert costs object to Map
      const costsMap = new Map<string, number>();
      Object.entries(data.costs || {}).forEach(([sku, cost]) => {
        costsMap.set(sku, cost as number);
      });
      setCostsData(costsMap);

      // Update FX rate display - now using dynamic rates by month
      if (data.fxRate) {
        setFxRate(data.fxRate);
        if (data.fxRates && Object.keys(data.fxRates).length > 0) {
          const ratesList = Object.entries(data.fxRates)
            .map(([month, rate]) => `${month}: ${(rate as number).toFixed(4)}`)
            .join(', ');
          setFxSource(`Dynamic by month (${ratesList})`);
        } else {
          setFxSource('exchangerate.host (server)');
        }
      }

      // Set last updated date to the most recent order date from data
      if (data.lastOrderDate) {
        const lastOrderDate = ensureDate(data.lastOrderDate);
        setLastUpdated(lastOrderDate || new Date());
      } else {
        setLastUpdated(new Date());
      }

    } catch (error) {
      console.error('Error loading data from Supabase:', error);
      alert(`Failed to load data: ${(error as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Full refresh — same as the auto-sync cron: pull every source from its API and
  // rebuild what the dashboard reads. The refresh advances step-by-step in the
  // background (~minutes, driven by the every-minute driver), so we kick it off,
  // show whatever is already in the DB, then poll until the run finishes and
  // reload the fresh data. Progress/errors per step are visible in Config →
  // Connections.
  const handleFullRefresh = async () => {
    const base = import.meta.env.VITE_SUPABASE_URL;
    const headers = {
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    };
    setSyncRunning(true);

    // Kick off a run and capture WHICH run to wait for. If the kickoff itself
    // fails, surface it and stop — never leave the spinner up or report success
    // on stale data.
    let runId: number | null = null;
    try {
      const res = await fetch(`${base}/functions/v1/sync-orchestrate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kickoff: true, trigger: 'button' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) throw new Error(body?.message ?? `HTTP ${res.status}`);
      runId = typeof body?.runId === 'number' ? body.runId : null;
    } catch (e) {
      setSyncRunning(false);
      alert(`No se pudo iniciar la actualización: ${(e as Error).message}`);
      return;
    }

    // Show whatever is already in the DB (fire-and-forget so a slow reload can't
    // hang the button).
    loadDataFromSupabase().catch(() => {});

    // Poll until THAT run finishes (not just the newest run), then reload. Always
    // clear the spinner before the final reload so it can never stick on.
    const startedAt = Date.now();
    const finish = () => { setSyncRunning(false); loadDataFromSupabase().catch(() => {}); };
    const poll = async () => {
      if (Date.now() - startedAt > 15 * 60_000) { finish(); return; } // safety cap
      try {
        // Abort a hung request so the cap is always re-evaluated on the next tick.
        const ctrl = new AbortController();
        const t = window.setTimeout(() => ctrl.abort(), 10_000);
        let body: any;
        try {
          const res = await fetch(`${base}/functions/v1/connection-status`, { headers, signal: ctrl.signal });
          body = await res.json();
        } finally {
          window.clearTimeout(t);
        }
        const master = (body?.connections ?? []).find((c: any) => c.master);
        const runs = master?.runs ?? [];
        const run = runId != null ? runs.find((r: any) => r.id === runId) : runs[0];
        if (run && run.status !== 'running') { finish(); return; }
      } catch {
        /* transient; keep polling */
      }
      window.setTimeout(poll, 15_000);
    };
    window.setTimeout(poll, 15_000);
  };

  // Utility functions
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
    
    // Try ISO format first
    const isoDate = parseISO(String(dateStr));
    if (isValid(isoDate)) return isoDate;
    
    // Try dd/mm/yyyy format
    const ddmmyyyy = parse(String(dateStr), 'dd/MM/yyyy', new Date());
    if (isValid(ddmmyyyy)) return ddmmyyyy;
    
    return null;
  };

  // Legacy file parsing functions (kept for manual upload fallback)
  const parseUnleashedFile = async (file: File) => {
    // Implementation moved to Edge Function, but kept for fallback
    console.log('Manual file upload - consider using Update button instead');
  };

  const parseShopifyFile = (file: File) => {
    console.log('Manual file upload - consider using Update button instead');
  };

  const parseOldShopifyFile = (file: File) => {
    console.log('Manual file upload - consider using Update button instead');
  };

  const parseMetaFile = (file: File) => {
    console.log('Manual file upload - consider using Update button instead');
  };

  const parseCostsFile = (file: File) => {
    console.log('Manual file upload - consider using Update button instead');
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

  // Warehouse filtering utility
  const matchesWarehouse = (rowWarehouse: string, active: string): boolean => {
    if (active === 'ALL') return true;
    return String(rowWarehouse || '').trim() === active;
  };

  // FX Rate functions
  const updateFxRate = async () => {
    // Use Supabase Edge Function to get updated FX rate
    await loadDataFromSupabase();
  };

  const handleManualFxChange = (value: string) => {
    setManualFxRate(value);
    const num = parseFloat(value);
    if (!isNaN(num) && num > 0) {
      setFxRate(num);
      setFxSource('manual override');
    }
  };

  // Mario Dashboard functions
  const handlePasswordSubmit = () => {
    if (passwordInput === 'Dolo123') {
      setShowPasswordDialog(false);
      setPasswordInput('');
      setPasswordError('');
      setShowMarioDashboard(true);
    } else {
      setPasswordError('Contraseña incorrecta');
    }
  };

  const handlePasswordDialogClose = () => {
    setShowPasswordDialog(false);
    setPasswordInput('');
    setPasswordError('');
  };

  const handleCloseMarioDashboard = () => {
    setShowMarioDashboard(false);
  };

  // Unleashed Integration functions
  const loadUnleashedCredentials = async () => {
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-unleashed-credentials`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success && result.data) {
        setUnleashedApiId(result.data.api_id || '');
        setUnleashedApiKey(result.data.api_key || '');
      }
    } catch (error) {
      console.error('Error loading Unleashed credentials:', error);
    }
  };

  const handleSaveUnleashedCredentials = async () => {
    if (!unleashedApiId.trim() || !unleashedApiKey.trim()) {
      alert('Por favor ingresa API ID y API Key');
      return;
    }

    setIsSavingCredentials(true);
    setUnleashedConnectionStatus(null);

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-unleashed-credentials`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiId: unleashedApiId,
          apiKey: unleashedApiKey,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        alert('Credenciales guardadas exitosamente');
      } else {
        alert(`Error: ${result.message}`);
      }
    } catch (error) {
      console.error('Error saving Unleashed credentials:', error);
      alert(`Error al guardar credenciales: ${(error as Error).message}`);
    } finally {
      setIsSavingCredentials(false);
    }
  };

  const handleTestUnleashedConnection = async () => {
    if (!unleashedApiId.trim() || !unleashedApiKey.trim()) {
      alert('Por favor ingresa API ID y API Key antes de probar la conexión');
      return;
    }

    setIsTestingConnection(true);
    setUnleashedConnectionStatus(null);

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/test-unleashed-connection`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiId: unleashedApiId,
          apiKey: unleashedApiKey,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      setUnleashedConnectionStatus({
        success: result.success,
        message: result.message,
        orderCount: result.orderCount,
        itemCount: result.itemCount,
      });
    } catch (error) {
      console.error('Error testing Unleashed connection:', error);
      setUnleashedConnectionStatus({
        success: false,
        message: `Error al probar la conexión: ${(error as Error).message}`,
      });
    } finally {
      setIsTestingConnection(false);
    }
  };

  const loadEcommerceCredentials = async () => {
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-ecommerce-credentials`, {
        headers: { 'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
      });
      const data = await res.json();
      if (data.shopify?.store_url) setShopifyStoreUrl(data.shopify.store_url);
      if (data.meta?.ad_account_ids) setMetaAdAccountIds(data.meta.ad_account_ids);
    } catch {
      // ignore
    }
  };

  const handleSaveEcommerceCredentials = async () => {
    setIsSavingEcommerceCreds(true);
    setEcommerceCredsStatus(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setEcommerceCredsStatus({ type: 'error', message: 'Sesión expirada' });
        return;
      }
      const body: Record<string, unknown> = {};
      if (shopifyStoreUrl.trim() && shopifyAccessToken.trim()) {
        body.shopify = { store_url: shopifyStoreUrl.trim(), access_token: shopifyAccessToken.trim() };
      }
      if (metaAdAccountIds.trim() && metaAccessToken.trim()) {
        body.meta = { ad_account_ids: metaAdAccountIds.trim(), access_token: metaAccessToken.trim() };
      }
      if (Object.keys(body).length === 0) {
        setEcommerceCredsStatus({ type: 'error', message: 'Completa al menos Shopify o Meta' });
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-ecommerce-credentials`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) {
        setEcommerceCredsStatus({ type: 'error', message: result.error || 'Error al guardar' });
        return;
      }
      const savedList = result.saved?.length ? result.saved.join(', ') : '';
      setEcommerceCredsStatus({
        type: 'success',
        message: savedList ? `Credenciales guardadas: ${savedList}` : 'Credenciales guardadas',
      });
      setShopifyAccessToken('');
      setMetaAccessToken('');
      loadEcommerceCredentials();
    } catch (err) {
      setEcommerceCredsStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setIsSavingEcommerceCreds(false);
    }
  };

  const handleLoadFromCsv = async () => {
    setIsLoadingCsv(true);
    setCsvLoadStatus(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setCsvLoadStatus({ type: 'error', message: 'Sesión expirada' });
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ecommerce-load-csv`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      const result = await res.json();
      if (!res.ok) {
        const errMsg = result.error || result.errors?.join('; ') || 'Error al cargar CSV';
        setCsvLoadStatus({ type: 'error', message: errMsg });
        return;
      }
      const parts: string[] = [];
      if (result.shopify_days) parts.push(`${result.shopify_days} días Shopify`);
      if (result.meta_days) parts.push(`${result.meta_days} días Meta`);
      if (result.meta_top_ads) parts.push(`${result.meta_top_ads} ads top`);
      const msg = parts.length ? `Cargado: ${parts.join(', ')}` : 'Sin datos nuevos';
      if (result.errors?.length) {
        setCsvLoadStatus({ type: 'error', message: `${msg}. Errores: ${result.errors.join('; ')}` });
      } else {
        setCsvLoadStatus({ type: 'success', message: msg });
      }
    } catch (err) {
      setCsvLoadStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setIsLoadingCsv(false);
    }
  };

  const handleInviteUser = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.endsWith('@dolo.com.au')) {
      setInviteStatus({ type: 'error', message: 'Ingresa un email @dolo.com.au' });
      return;
    }
    if (!invitePassword || invitePassword.length < 6) {
      setInviteStatus({ type: 'error', message: 'Contraseña requerida (mín. 6 caracteres)' });
      return;
    }
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    if (!supabaseUrl) {
      setInviteStatus({ type: 'error', message: 'VITE_SUPABASE_URL no configurada en .env' });
      return;
    }
    setIsInviting(true);
    setInviteStatus(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setInviteStatus({ type: 'error', message: 'Sesión expirada. Vuelve a iniciar sesión.' });
        return;
      }
      const response = await fetch(`${supabaseUrl}/functions/v1/invite-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ email, password: invitePassword }),
      });
      const result = await response.json();
      if (!response.ok) {
        setInviteStatus({ type: 'error', message: result.error || 'Error al crear usuario' });
        return;
      }
      setInviteStatus({ type: 'success', message: result.message || 'Usuario creado' });
      setInviteEmail('');
      setInvitePassword('');
    } catch (err) {
      const msg = (err as Error).message;
      const hint = msg.includes('Failed to fetch')
        ? ' — Despliega la función: supabase functions deploy invite-user'
        : '';
      setInviteStatus({ type: 'error', message: `${msg}${hint}` });
    } finally {
      setIsInviting(false);
    }
  };

  // Load data on component mount
  useEffect(() => {
    loadDataFromSupabase();
    loadUnleashedCredentials();
  }, []);

  useEffect(() => {
    if (isConfigOpen) {
      loadEcommerceCredentials();
      setCsvLoadStatus(null);
    }
  }, [isConfigOpen]);

  // Reload data when date range changes (to apply correct exchange rates)
  useEffect(() => {
    if (dateRange.from && dateRange.to) {
      loadDataFromSupabase();
    }
  }, [dateRange.from, dateRange.to]);

  // Load costs config from Supabase on startup
  useEffect(() => {
    const loadGlobalCostsConfig = async () => {
      const supabaseConfig = await loadCostsConfigFromSupabase();
      if (supabaseConfig) {
        saveCostsConfig(supabaseConfig);
      } else {
        const localConfig = loadCostsConfig();
        await saveCostsConfigToSupabase(localConfig);
      }
    };

    loadGlobalCostsConfig();
  }, []);

  // Calculate number of days in period
  const numberOfDaysInPeriod = useMemo(() => {
    if (!dateRange?.from || !dateRange?.to) return 0;
    return differenceInDays(addDays(dateRange.to, 1), dateRange.from);
  }, [dateRange]);

  // Filtered data based on date range
  const filteredData = useMemo(() => {
    if (!dateRange || !dateRange.from || !dateRange.to) return { unleashed: [], shopify: [], oldShopify: [], meta: [] };

    const unleashed = unleashedData.filter(row =>
      row.orderDate && isWithinInterval(row.orderDate, { start: dateRange.from!, end: addDays(dateRange.to!, 1) })
    );

    const shopify = shopifyData.filter(row =>
      row.date && isWithinInterval(row.date, { start: dateRange.from!, end: addDays(dateRange.to!, 1) })
    );

    const oldShopify = oldShopifyData.filter(row =>
      row.date && isWithinInterval(row.date, { start: dateRange.from!, end: addDays(dateRange.to!, 1) })
    );

    const meta = metaData.filter(row =>
      row.date && isWithinInterval(row.date, { start: dateRange.from!, end: addDays(dateRange.to!, 1) })
    );

    return { unleashed, shopify, oldShopify, meta };
  }, [unleashedData, shopifyData, oldShopifyData, metaData, dateRange]);


  // Fetch Xero costs data from edge function
  const fetchXeroCosts = async () => {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-xero-costs`,
        {
          headers: {
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch Xero costs data');
      }

      const data: XeroData = await response.json();
      console.log('XeroData keys:', Object.keys(data));
      console.log('periodEnd:', data.periodEnd);
      console.log('last month:', data.months?.[data.months.length - 1]);
      setXeroData(data);
    } catch (err) {
      console.error('Error fetching Xero costs:', err);
    }
  };

  // Fetch Xero data on mount
  useEffect(() => {
    fetchXeroCosts();
  }, []);

  // Listen for costs config changes
  useEffect(() => {
    const handleCostsUpdate = () => {
      if (costsSource === 'costs' && xeroData) {
        const newSnapshot = computeCostsSnapshot(xeroData, dateRange);
        setCostsSnapshot(newSnapshot);
      }
    };

    window.addEventListener('costs:updated', handleCostsUpdate);
    return () => {
      window.removeEventListener('costs:updated', handleCostsUpdate);
    };
  }, [costsSource, xeroData, dateRange]);

  // Save costs source to localStorage
  useEffect(() => {
    localStorage.setItem('bychannel-costs-source', costsSource);
  }, [costsSource]);

  // Compute costs snapshot on-demand when using costs source
  const computedCostsSnapshot = useMemo(() => {
    if (costsSource === 'costs' && xeroData && dateRange.from && dateRange.to) {
      return computeCostsSnapshot(xeroData, dateRange);
    }
    return null;
  }, [costsSource, xeroData, dateRange]);

  // Use computed snapshot or manual snapshot
  useEffect(() => {
    if (costsSource === 'costs') {
      setCostsSnapshot(computedCostsSnapshot);
    }
  }, [costsSource, computedCostsSnapshot]);

  // Fetch Pesado critical stock from AIM 2026 (same data source as AIM 2026 modal)
  const PESADO_CRITICAL_EXCLUDED_SKUS = ['FREE-PSD-CeramicSet', 'M10 Screw'];
  useEffect(() => {
    let cancelled = false;
    setPesadoCriticalLoading(true);

    const isPesado = (r: SKURow) => {
      const pg = (r.productGroup || '').toLowerCase();
      const prod = (r.product || '').toLowerCase();
      return pg.includes('pesado') || prod.includes('pesado');
    };

    const applyFilters = (rows: SKURow[], assembledProductSKUs: string[], bomComponents: { component_sku: string }[]) => {
      const componentSKUs = new Set(bomComponents.map((b) => b.component_sku));
      return rows
        .filter((r) => !assembledProductSKUs.includes(r.sku))
        .filter((r) => !componentSKUs.has(r.sku))
        .filter((r) => !PESADO_CRITICAL_EXCLUDED_SKUS.includes(r.sku))
        .filter((r) => r.status === 'CRITICAL' && isPesado(r))
        .sort((a, b) => b.projectedDemand - a.projectedDemand)
        .slice(0, 10);
    };

    if (dateRange?.from && dateRange?.to) {
      const from = dateRange.from;
      const to = dateRange.to;
      const rangeFrom = format(from, 'yyyy-MM-dd');
      const rangeTo = format(to, 'yyyy-MM-dd');
      const startDate = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-01`;
      const toMonthLast = new Date(to.getFullYear(), to.getMonth() + 1, 0);
      const endDate = `${toMonthLast.getFullYear()}-${String(toMonthLast.getMonth() + 1).padStart(2, '0')}-${String(toMonthLast.getDate()).padStart(2, '0')}`;

      const monthsDiff = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
      if (monthsDiff >= 11) {
        fetchDashboardData()
          .then((data) => {
            if (cancelled) return;
            setPesadoCriticalStock(applyFilters(data.rows, data.assembledProductSKUs ?? [], data.bomComponents ?? []));
          })
          .catch(() => { if (!cancelled) setPesadoCriticalStock([]); })
          .finally(() => { if (!cancelled) setPesadoCriticalLoading(false); });
      } else {
        Promise.all([
          fetchDashboardData(),
          recalcKPIsForDateRange(startDate, endDate, rangeFrom, rangeTo, 'realDemand'),
        ])
          .then(([cacheData, recalcResult]) => {
            if (cancelled) return;
            setPesadoCriticalStock(applyFilters(recalcResult.rows, cacheData.assembledProductSKUs ?? [], cacheData.bomComponents ?? []));
          })
          .catch(() => { if (!cancelled) setPesadoCriticalStock([]); })
          .finally(() => { if (!cancelled) setPesadoCriticalLoading(false); });
      }
    } else {
      fetchDashboardData()
        .then((data) => {
          if (cancelled) return;
          setPesadoCriticalStock(applyFilters(data.rows, data.assembledProductSKUs ?? [], data.bomComponents ?? []));
        })
        .catch(() => { if (!cancelled) setPesadoCriticalStock([]); })
        .finally(() => { if (!cancelled) setPesadoCriticalLoading(false); });
    }

    return () => { cancelled = true; };
  }, [dateRange?.from?.getTime(), dateRange?.to?.getTime()]);

  // Generate warehouse options
  const warehouseOptions = useMemo(() => {
    const warehouseSet = new Set<string>();
    unleashedData.forEach(row => {
      if (row.warehouse) {
        warehouseSet.add(row.warehouse.trim());
      }
    });
    return ['ALL', ...Array.from(warehouseSet).sort()];
  }, [unleashedData]);

  // Net Total Shopify Sales memo (was Total Shopify Sales)
  const totalShopifySalesMemo = useMemo(() => {
    const currentShopifySales = filteredData.shopify.reduce((sum, row) => sum + row.netSales, 0);
    const oldShopifySales = filteredData.oldShopify.reduce((sum, row) => sum + row.netSales, 0);
    const total = currentShopifySales + oldShopifySales;
    console.log('totalShopifySalesMemo:', total, 'currentShopify:', currentShopifySales, 'oldShopify:', oldShopifySales);
    return total;
  }, [filteredData.shopify, filteredData.oldShopify]);

  // Taxes Received (from Shopify column L, converted to AUD)
  const taxesReceived = useMemo(() => {
    const currentTaxes = filteredData.shopify.reduce((sum, row) => sum + (row.taxes || 0), 0);
    return currentTaxes;
  }, [filteredData.shopify]);

  // Shipping Charges Received (from Shopify column N, converted to AUD)
  const shippingChargesReceived = useMemo(() => {
    const currentShipping = filteredData.shopify.reduce((sum, row) => sum + (row.shipping || 0), 0);
    return currentShipping;
  }, [filteredData.shopify]);

  // Total Shopify Sales (Net + Taxes + Shipping)
  const totalShopifySalesGross = useMemo(() => {
    return totalShopifySalesMemo + taxesReceived + shippingChargesReceived;
  }, [totalShopifySalesMemo, taxesReceived, shippingChargesReceived]);

  // Calculate total overall sales (AUD) for brand share calculation
  const totalOverallSalesAUDMemo = useMemo(() => {
    const unleashedTotal = filteredData.unleashed.reduce((sum, row) => sum + row.subTotal, 0);
    return totalShopifySalesGross + unleashedTotal;
  }, [filteredData.unleashed, totalShopifySalesGross]);

  // Total Shopify COGS memo
  const totalShopifyCOGS = useMemo(() => {
    let totalCOGS = 0;

    // Calculate COGS for current Shopify data
    filteredData.shopify.forEach(row => {
      const unitCost = costsData.get(row.sku);
      if (unitCost && unitCost > 0) {
        totalCOGS += unitCost * row.quantity;
      }
    });

    console.log('totalShopifyCOGS:', totalCOGS, 'costsData size:', costsData.size, 'shopify rows:', filteredData.shopify.length);
    return totalCOGS;
  }, [filteredData.shopify, costsData]);

  // Meta ads spend
  const metaSpend = useMemo(() => {
    // The Edge Function already handles USD to AUD conversion for Meta data.
    // So, we just sum the 'spend' field directly.
    const totalSpend = filteredData.meta.reduce((sum, row) => sum + row.spend, 0);
    const result = [{ brand: 'Total Meta Ads', spend: totalSpend }];
    console.log('metaSpend:', result, 'meta rows:', filteredData.meta.length);
    return result;
  }, [filteredData.meta]);

  // Calculate shipping cost (8.4% of Shopify sales actualizado el 11/9 para reflejar el costo de tax duty USA)
  const shippingCost = useMemo(() => {
    return totalShopifySalesMemo * shippingCostPercent;
  }, [totalShopifySalesMemo, shippingCostPercent]);

  // Calculate fixed cost (dynamic based on Andrea's checkbox)
  const fixedCost = useMemo(() => {
    const dailyCost = andreaExtraCosts ? 3956 : fixedCostDaily;
    return dailyCost * numberOfDaysInPeriod;
  }, [andreaExtraCosts, fixedCostDaily, numberOfDaysInPeriod]);

  // Calculate other variable costs (6% of Shopify sales)
  const otherVariableCosts = useMemo(() => {
    return totalShopifySalesMemo * otherVariableCostPercent;
  }, [totalShopifySalesMemo, otherVariableCostPercent]);

  // Calculate B2B sales
  const totalB2BSalesMemo = useMemo(() => {
    const b2bSales = filteredData.unleashed
      .filter(row => row.channel === 'B2B')
      .reduce((sum, row) => sum + row.subTotal, 0);
    console.log('totalB2BSalesMemo:', b2bSales, 'B2B rows:', filteredData.unleashed.filter(row => row.channel === 'B2B').length);
    return b2bSales;
  }, [filteredData.unleashed]);

  // Calculate B2B COGS
  const totalB2BCOGS = useMemo(() => {
    let totalCOGS = 0;

    // Calculate COGS for B2B data from Unleashed
    filteredData.unleashed
      .filter(row => row.channel === 'B2B')
      .forEach(row => {
        const unitCost = costsData.get(row.product);
        if (unitCost && unitCost > 0) {
          totalCOGS += unitCost * row.quantity;
        }
      });

    console.log('totalB2BCOGS:', totalCOGS, 'costsData size:', costsData.size, 'B2B rows:', filteredData.unleashed.filter(row => row.channel === 'B2B').length);
    return totalCOGS;
  }, [filteredData.unleashed, costsData]);

  // Calculate B2B fixed cost (dynamic based on Andrea's checkbox)
  const fixedCostB2B = useMemo(() => {
    const dailyCost = andreaExtraCosts ? 1320 : fixedCostB2BDaily;
    return dailyCost * numberOfDaysInPeriod;
  }, [andreaExtraCosts, fixedCostB2BDaily, numberOfDaysInPeriod]);

  // Calculate B2B Freight & Courier (1.1% of B2B sales)
  const freightCourierB2B = useMemo(() => {
    return totalB2BSalesMemo * 0.011;
  }, [totalB2BSalesMemo]);

  // Calculate B2B other variable costs
  const otherVariableCostsB2B = useMemo(() => {
    return totalB2BSalesMemo * otherVariableCostB2BPercent;
  }, [totalB2BSalesMemo, otherVariableCostB2BPercent]);

  // Calculate B2B estimated revenue
  const estimatedRevenueB2B = useMemo(() => {
    if (costsSource === 'costs' && costsSnapshot) {
      let revenue = totalB2BSalesMemo - totalB2BCOGS;
      revenue -= costsSnapshot.totals.variable.b2b;
      revenue -= costsSnapshot.totals.fixed.b2b;
      if (andreaExtraCosts) {
        revenue -= costsSnapshot.totals.andrea.b2b;
      }
      return revenue;
    } else {
      return totalB2BSalesMemo - totalB2BCOGS - fixedCostB2B - freightCourierB2B - otherVariableCostsB2B;
    }
  }, [totalB2BSalesMemo, totalB2BCOGS, fixedCostB2B, freightCourierB2B, otherVariableCostsB2B, costsSource, costsSnapshot, andreaExtraCosts]);

  // Calculate estimated revenue
  const estimatedRevenue = useMemo(() => {
    if (costsSource === 'costs' && costsSnapshot) {
      let revenue = totalShopifySalesGross - totalShopifyCOGS;
      revenue -= costsSnapshot.totals.variable.b2c;
      revenue -= costsSnapshot.totals.fixed.b2c;
      if (andreaExtraCosts) {
        revenue -= costsSnapshot.totals.andrea.b2c;
      }
      return revenue;
    } else {
      const totalMetaSpend = metaSpend.length > 0 ? metaSpend[0].spend : 0;
      return totalShopifySalesGross - totalShopifyCOGS - totalMetaSpend - shippingCost - fixedCost - otherVariableCosts;
    }
  }, [totalShopifySalesGross, totalShopifyCOGS, metaSpend, shippingCost, fixedCost, otherVariableCosts, costsSource, costsSnapshot, andreaExtraCosts]);

  // Date Range ROAS calculation
  const dateRangeROAS = useMemo(() => {
    const totalMetaSpend = metaSpend.length > 0 ? metaSpend[0].spend : 0;

    if (totalMetaSpend === 0) {
      return null; // Avoid division by zero
    }
    return totalShopifySalesMemo / totalMetaSpend;
  }, [totalShopifySalesMemo, metaSpend]);

  // Post-Marketing Contribution memo
  const postMarketingContribution = useMemo(() => {
    const totalMetaSpend = metaSpend.length > 0 ? metaSpend[0].spend : 0;
    const result = totalShopifySalesMemo - totalShopifyCOGS - totalMetaSpend;
    console.log('postMarketingContribution:', result, 'sales:', totalShopifySalesMemo, 'cogs:', totalShopifyCOGS, 'metaSpend:', totalMetaSpend);
    return result;
  }, [totalShopifySalesMemo, totalShopifyCOGS, metaSpend]);

  // Total Meta Conversions memo
  const totalMetaConversions = useMemo(() => {
    const totalConversions = filteredData.meta.reduce((sum, row) => {
      return sum + (row.conversionValue || 0);
    }, 0);
    console.log('totalMetaConversions:', totalConversions, 'meta rows:', filteredData.meta.length);
    return totalConversions;
  }, [filteredData.meta]);

  // Meta to Shopify Ratio memo
  const metaShopifyRatio = useMemo(() => {
    if (totalShopifySalesMemo === 0) {
      return null; // Avoid division by zero
    }
    const ratio = totalMetaConversions / totalShopifySalesMemo;
    console.log('metaShopifyRatio:', ratio, 'conversions:', totalMetaConversions, 'sales:', totalShopifySalesMemo);
    return ratio;
  }, [totalMetaConversions, totalShopifySalesMemo]);

  // Purchase ROAS calculation
  const purchaseROAS = useMemo(() => {
    const totalMetaSpend = metaSpend.length > 0 ? metaSpend[0].spend : 0;

    if (totalMetaSpend === 0) {
      return null; // Avoid division by zero
    }
    return totalMetaConversions / totalMetaSpend;
  }, [totalMetaConversions, metaSpend]);

  // Prepare detailed Shopify COGS data for CSV download
  const detailedShopifyCOGSData = useMemo(() => {
    if (!filteredData.shopify || !costsData) return [];

    return filteredData.shopify.map(sale => {
      const unitCost = costsData.get(sale.sku) || 0;
      const totalCost = unitCost * sale.quantity;
      
      return {
        date: format(sale.date, 'yyyy-MM-dd'),
        sku: sale.sku,
        quantity: sale.quantity,
        unitCost: unitCost,
        totalCost: totalCost
      };
    }).filter(item => item.totalCost > 0); // Only include items with valid costs
  }, [filteredData.shopify, costsData]);

  // Prepare detailed B2B COGS data for CSV download
  const detailedB2BCOGSData = useMemo(() => {
    if (!filteredData.unleashed || !costsData) return [];

    return filteredData.unleashed
      .filter(row => row.channel === 'B2B') // Only B2B sales
      .map(sale => {
        const unitCost = costsData.get(sale.product) || 0;
        const totalCost = unitCost * sale.quantity;

        return {
          date: sale.orderDate ? format(sale.orderDate, 'yyyy-MM-dd') : '',
          sku: sale.product,
          customer: sale.customer,
          quantity: sale.quantity,
          unitCost: unitCost,
          totalCost: totalCost
        };
      }); // Include all B2B sales, even those without cost data
  }, [filteredData.unleashed, costsData]);

  // Handle CSV download for Shopify COGS
  const handleDownloadShopifyCOGS = () => {
    const columns: CSVColumn[] = [
      { header: 'Date', key: 'date' },
      { header: 'SKU', key: 'sku' },
      { header: 'Quantity', key: 'quantity' },
      { header: 'Unit Cost (AUD)', key: 'unitCost', formatter: (value) => value.toFixed(2) },
      { header: 'Total Cost (AUD)', key: 'totalCost', formatter: (value) => value.toFixed(2) }
    ];

    downloadCSV(detailedShopifyCOGSData, 'shopify_cogs_details.csv', columns);
  };

  // Handle CSV download for B2B COGS
  const handleDownloadB2BCOGS = () => {
    const columns: CSVColumn[] = [
      { header: 'Date', key: 'date' },
      { header: 'SKU', key: 'sku' },
      { header: 'Customer', key: 'customer' },
      { header: 'Quantity', key: 'quantity' },
      { header: 'Unit Cost (AUD)', key: 'unitCost', formatter: (value) => value.toFixed(2) },
      { header: 'Total Cost (AUD)', key: 'totalCost', formatter: (value) => value.toFixed(2) }
    ];

    downloadCSV(detailedB2BCOGSData, 'b2b_cogs_details.csv', columns);
  };

  // Channel analysis
  const channelAnalysis = useMemo(() => {
    const channelMap = new Map<string, number>();

    // Add Shopify sales (Total Shopify Sales includes net sales + taxes + shipping)
    const shopifySales = totalShopifySalesGross;
    if (shopifySales > 0) {
      channelMap.set('Shopify', shopifySales);
    }

    // Add Unleashed data (B2B and Korea channels)
    filteredData.unleashed.forEach(row => {
      if (!matchesWarehouse(row.warehouse, activeWarehouse)) return;
      
      const channel = row.channel;
      
      // Skip Shopify and Shop sale channels from Unleashed to avoid double counting
      if (channel === 'Shopify' || channel === 'Shop sale') return;
      
      const current = channelMap.get(channel) || 0;
      channelMap.set(channel, current + row.subTotal);
    });

    // Convert to array and calculate shares
    const total = Array.from(channelMap.values()).reduce((sum, value) => sum + value, 0);

    return Array.from(channelMap.entries())
      .map(([channel, sales]) => ({
        channel,
        sales,
        share: total > 0 ? (sales / total) * 100 : 0
      }))
      .sort((a, b) => b.sales - a.sales);
  }, [filteredData, totalShopifySalesGross, activeWarehouse]);

  // Calculate total sales
  const totalSales = useMemo(() => {
    return channelAnalysis.reduce((sum, channel) => sum + channel.sales, 0);
  }, [channelAnalysis]);

  // Data coverage warnings: detect when the selected date range extends beyond
  // the data actually available in each source. Used to surface gaps in the
  // Total Sales card so the user doesn't misread partial totals as complete.
  const dataCoverageWarnings = useMemo(() => {
    if (!dateRange?.from || !dateRange?.to) return [] as { source: string; minDate: Date | null; maxDate: Date | null }[];

    const rangeFrom = dateRange.from;
    const rangeTo = dateRange.to;
    const warnings: { source: string; minDate: Date | null; maxDate: Date | null }[] = [];

    const getBounds = (rows: any[] | null | undefined, field: string): [Date | null, Date | null] => {
      if (!rows || rows.length === 0) return [null, null];
      let min: Date | null = null;
      let max: Date | null = null;
      for (const row of rows) {
        const d = row?.[field];
        if (!(d instanceof Date) || isNaN(d.getTime())) continue;
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
      return [min, max];
    };

    // Compare at day granularity: backend dates arrive as UTC ISO timestamps
    // and end up with a time-of-day offset after parsing, so a raw Date
    // comparison flags gaps that don't exist at day level (picker gives
    // Jul 1 00:00 local while the data's first day parses as Jul 1 10:00).
    const dayNumber = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

    const check = (name: string, min: Date | null, max: Date | null) => {
      if (!min || !max) {
        warnings.push({ source: name, minDate: null, maxDate: null });
        return;
      }
      if (dayNumber(rangeFrom) < dayNumber(min) || dayNumber(rangeTo) > dayNumber(max)) {
        warnings.push({ source: name, minDate: min, maxDate: max });
      }
    };

    const [shopMin, shopMax] = getBounds([...shopifyData, ...oldShopifyData], 'date');
    check('Shopify', shopMin, shopMax);

    const [unMin, unMax] = getBounds(unleashedData, 'orderDate');
    check('Unleashed B2B', unMin, unMax);

    const [metaMin, metaMax] = getBounds(metaData, 'date');
    check('Meta Ads', metaMin, metaMax);

    // Xero: derive min/max from the months array (first day of first month → last day of last month)
    if (xeroData?.months && xeroData.months.length > 0) {
      const sorted = [...xeroData.months].sort((a, b) =>
        a.year !== b.year ? a.year - b.year : a.month - b.month
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const xeroMin = new Date(first.year, first.month - 1, 1);
      const xeroMax = new Date(last.year, last.month, 0);
      check('Xero Costs', xeroMin, xeroMax);
    }

    return warnings;
  }, [dateRange, shopifyData, oldShopifyData, unleashedData, metaData, xeroData]);

  // Weekly ROAS calculation
  const weeklyROAS = useMemo((): WeeklyROAS[] => {
    if (!dateRange?.from || !dateRange?.to) return [];

    const weekMap = new Map<string, { sales: number; spend: number; conversions: number }>();

    // Sales: from current Shopify file data (already converted to AUD)
    for (const row of filteredData.shopify) {
      const date = row.date;
      if (!date) continue;

      const monday = startOfWeek(date, { weekStartsOn: 1 });
      const key = format(monday, 'yyyy-MM-dd');
      const prev = weekMap.get(key) || { sales: 0, spend: 0, conversions: 0 };
      weekMap.set(key, { sales: prev.sales + row.netSales, spend: prev.spend, conversions: prev.conversions });
    }

    // Sales: from old Shopify file data (already in AUD)
    for (const row of filteredData.oldShopify) {
      const date = row.date;
      if (!date) continue;

      const monday = startOfWeek(date, { weekStartsOn: 1 });
      const key = format(monday, 'yyyy-MM-dd');
      const prev = weekMap.get(key) || { sales: 0, spend: 0, conversions: 0 };
      weekMap.set(key, { sales: prev.sales + row.netSales, spend: prev.spend, conversions: prev.conversions });
    }

    // Spend and Conversions: Meta
    for (const row of filteredData.meta) {
      const date = row.date;
      if (!date) continue;

      let spend = row.spend;
      let conversions = row.conversionValue || 0;

      const monday = startOfWeek(date, { weekStartsOn: 1 });
      const key = format(monday, 'yyyy-MM-dd');
      const prev = weekMap.get(key) || { sales: 0, spend: 0, conversions: 0 };
      weekMap.set(key, { sales: prev.sales, spend: prev.spend + spend, conversions: prev.conversions + conversions });
    }

    // Convert map to array and calculate ROAS
    return Array.from(weekMap.entries())
      .map(([week, data]) => {
        const weekStart = parseISO(week);

        // Skip invalid dates to prevent getTime() errors
        if (!isValid(weekStart)) {
          console.warn(`Invalid date in weeklyROAS: ${week}`);
          return null;
        }

        const roas = data.spend > 0 ? data.sales / data.spend : null;
        const purchaseRoas = data.spend > 0 ? data.conversions / data.spend : null;

        return {
          week,
          weekStart,
          sales: data.sales,
          spend: data.spend,
          roas,
          purchaseRoas
        };
      })
      .filter((item): item is WeeklyROAS => item !== null)
      .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
  }, [filteredData, dateRange]);

  // Brand analysis
  const brandAnalysis = useMemo(() => {
    if (!filteredData?.unleashed || !dateRange.from || !dateRange.to) return [];
    
    // Initialize brand accumulators
    const brandTotals: Record<string, number> = {
      'Pesado': 0,
      'The Artisan Barista': 0,
      'Coffee Accessories': 0,
      'Tiamo': 0,
      'Others': 0
    };
    
    // Categorize unleashed sales with precise order
    filteredData.unleashed.forEach(row => {
      const subTotal = row.subTotal || 0;
      const customer = (row.customer || '').toLowerCase();
      const product = (row.product || '').toLowerCase();
      const productGroup = (row.productGroup || '').toLowerCase();
      const brand = row.brand || '';

      // Check conditions in the specified order
      if (product.includes('artisan barista') || productGroup.includes('artisan barista')) {
        brandTotals['The Artisan Barista'] += subTotal;
      } else if (product.includes('coffee accessories') || productGroup.includes('coffee accessories')) {
        brandTotals['Coffee Accessories'] += subTotal;
      } else if (product.includes('tiamo') || productGroup.includes('tiamo')) {
        brandTotals['Tiamo'] += subTotal;
      } else if (brand === 'Pesado' || customer.includes('pesado') || product.includes('pesado') || productGroup.includes('pesado')) {
        brandTotals['Pesado'] += subTotal;
      } else {
        brandTotals['Others'] += subTotal;
      }
    });

    // Add Shopify sales to Pesado brand (Total Shopify Sales includes net sales + taxes + shipping)
    brandTotals['Pesado'] += totalShopifySalesGross;

    // Convert to array format for visualization
    return Object.entries(brandTotals)
      .map(([brand, totalSales]) => ({
        brand,
        totalSales,
        totalUnits: 0
      }))
      // Sort: Pesado first, then main brands by sales (desc), then Others last
      .sort((a, b) => {
        if (a.brand === 'Pesado') return -1;
        if (b.brand === 'Pesado') return 1;
        if (a.brand === 'Others') return 1;
        if (b.brand === 'Others') return -1;
        return b.totalSales - a.totalSales;
      });
  }, [filteredData?.unleashed, totalShopifySalesGross, dateRange.from, dateRange.to]);

  // Sales by Product Group (for bar chart)
  const salesByProductGroup = useMemo(() => {
    const groupMap = new Map<string, number>();
    for (const row of filteredData.unleashed) {
      if (!matchesWarehouse(row.warehouse, activeWarehouse)) continue;
      if (row.channel === 'Shopify' || row.channel === 'Shop sale') continue;
      const pg = (row.productGroup || 'Other').trim() || 'Other';
      groupMap.set(pg, (groupMap.get(pg) || 0) + row.subTotal);
    }
    const shopifyTotal = filteredData.shopify.reduce((s, r) => s + r.netSales, 0) +
      filteredData.oldShopify.reduce((s, r) => s + r.netSales, 0);
    if (shopifyTotal > 0) {
      groupMap.set('Shopify', (groupMap.get('Shopify') || 0) + shopifyTotal);
    }
    return Array.from(groupMap.entries())
      .map(([name, sales]) => ({ name, sales }))
      .filter((x) => x.sales > 0)
      .sort((a, b) => b.sales - a.sales);
  }, [filteredData.unleashed, filteredData.shopify, filteredData.oldShopify, activeWarehouse]);

  // Top SKUs analysis
  const topSKUs = useMemo(() => {
    const skuData = new Map<string, { sku: string; units: number; revenue: number }>();

    // Process Unleashed data (B2B and Korea only, with warehouse filter)
    for (const row of filteredData.unleashed) {
      if (!matchesWarehouse(row.warehouse, activeWarehouse)) continue;

      const channel = row.channel;

      // Exclude Shopify and Shop sale channels from Unleashed
      if (channel === 'Shopify' || channel === 'Shop sale') continue;

      // Only include if channel is selected
      if (!selectedSkuChannels.includes(channel)) continue;

      const sku = row.product;
      if (!sku) continue;

      const existing = skuData.get(sku) || { sku, units: 0, revenue: 0 };
      existing.units += row.quantity;
      existing.revenue += row.subTotal;
      skuData.set(sku, existing);
    }

    // Process Shopify data (if Shopify channel is selected)
    if (selectedSkuChannels.includes('Shopify')) {
      for (const row of filteredData.shopify) {
        const sku = row.sku;
        if (!sku) continue;

        const existing = skuData.get(sku) || { sku, units: 0, revenue: 0 };
        existing.units += row.quantity;
        existing.revenue += row.netSales;
        skuData.set(sku, existing);
      }
    }

    // Convert to array and add cost/margin calculations
    let skuList = Array.from(skuData.values()).map(item => {
      const unitCost = costsData.get(item.sku) || null;
      const margin = unitCost && item.revenue > 0
        ? ((item.revenue - (unitCost * item.units)) / item.revenue) * 100
        : null;

      return {
        ...item,
        unitCost,
        margin
      };
    }).filter(item => !item.sku.toLowerCase().includes('shipping cost'));

    // Filter by search term if present
    if (skuSearchTerm.trim()) {
      const searchLower = skuSearchTerm.toLowerCase();
      skuList = skuList.filter(item => item.sku.toLowerCase().includes(searchLower));
    }

    // Sort
    skuList.sort((a, b) =>
      skuSortBy === 'revenue' ? b.revenue - a.revenue : b.units - a.units
    );

    // Only limit to top 20 if no search term
    return skuSearchTerm.trim() ? skuList : skuList.slice(0, 20);
  }, [filteredData.unleashed, filteredData.shopify, selectedSkuChannels, costsData, skuSortBy, activeWarehouse, skuSearchTerm]);

  // Top 10 SKUs for dashboard (exclude misc, with productGroup)
  const top10SKUsDashboard = useMemo(() => {
    const skuToProductGroup = new Map<string, string>();
    for (const row of filteredData.unleashed) {
      if (row.product && row.productGroup) {
        skuToProductGroup.set(row.product, row.productGroup);
      }
    }
    const skuData = new Map<string, { sku: string; units: number; revenue: number; productGroup: string }>();
    for (const row of filteredData.unleashed) {
      if (!matchesWarehouse(row.warehouse, activeWarehouse)) continue;
      if (row.channel === 'Shopify' || row.channel === 'Shop sale') continue;
      if (!selectedSkuChannels.includes(row.channel)) continue;
      const sku = row.product;
      if (!sku) continue;
      const pg = skuToProductGroup.get(sku) || '';
      const existing = skuData.get(sku) || { sku, units: 0, revenue: 0, productGroup: pg };
      existing.units += row.quantity;
      existing.revenue += row.subTotal;
      if (pg) existing.productGroup = pg;
      skuData.set(sku, existing);
    }
    if (selectedSkuChannels.includes('Shopify')) {
      for (const row of filteredData.shopify) {
        const sku = row.sku;
        if (!sku) continue;
        const pg = skuToProductGroup.get(sku) || 'Shopify';
        const existing = skuData.get(sku) || { sku, units: 0, revenue: 0, productGroup: pg };
        existing.units += row.quantity;
        existing.revenue += row.netSales;
        skuData.set(sku, existing);
      }
    }
    return Array.from(skuData.values())
      .filter((item) => !item.sku.toLowerCase().includes('misc') && !(item.productGroup || '').toLowerCase().includes('misc'))
      .filter((item) => !item.sku.toLowerCase().includes('shipping cost'))
      .map((item) => {
        const unitCost = costsData.get(item.sku) || null;
        const margin = unitCost && item.revenue > 0 ? ((item.revenue - unitCost * item.units) / item.revenue) * 100 : null;
        return { ...item, unitCost, margin };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
  }, [filteredData.unleashed, filteredData.shopify, selectedSkuChannels, costsData, activeWarehouse]);

  // Function to download Top SKUs as CSV
  const handleDownloadTopSkusCsv = () => {
    const columns: CSVColumn[] = [
      { header: 'SKU', key: 'sku' },
      { header: 'Units', key: 'units', formatter: (value) => value?.toLocaleString() || '0' },
      { header: 'Revenue (AUD)', key: 'revenue', formatter: (value) => value?.toFixed(2) || '0.00' },
      { header: 'Unit Cost (AUD)', key: 'unitCost', formatter: (value) => value ? value.toFixed(2) : 'N/A' },
      { header: 'Margin %', key: 'margin', formatter: (value) => value !== null ? value.toFixed(2) : 'N/A' }
    ];

    const filename = `top_skus_analysis_${format(dateRange.from || new Date(), 'yyyy-MM-dd')}_to_${format(dateRange.to || new Date(), 'yyyy-MM-dd')}.csv`;

    downloadCSV(topSKUs, filename, columns);
  };

  // Function to download detailed transactions for a specific SKU
  const handleDownloadSkuDetails = async (sku: string) => {
    setDownloadingSkus(prev => new Set(prev).add(sku));

    try {
      const transactions: any[] = [];

      // Process Unleashed transactions
      for (const row of filteredData.unleashed) {
        if (row.product !== sku) continue;
        if (!matchesWarehouse(row.warehouse, activeWarehouse)) continue;

        const channel = row.channel;
        if (channel === 'Shopify' || channel === 'Shop sale') continue;
        if (!selectedSkuChannels.includes(channel)) continue;

        transactions.push({
          date: row.orderDate ? format(row.orderDate, 'yyyy-MM-dd') : '',
          channel: row.channel,
          customerRegion: row.customer,
          quantity: row.quantity,
          unitPrice: row.quantity !== 0 ? (row.subTotal / row.quantity) : 0,
          subtotalNetSales: row.subTotal,
          warehouse: row.warehouse,
          status: row.status || ''
        });
      }

      // Process Shopify transactions
      if (selectedSkuChannels.includes('Shopify')) {
        for (const row of filteredData.shopify) {
          if (row.sku !== sku) continue;

          transactions.push({
            date: format(row.date, 'yyyy-MM-dd'),
            channel: 'Shopify',
            customerRegion: row.region,
            quantity: row.quantity,
            unitPrice: row.quantity !== 0 ? (row.netSales / row.quantity) : 0,
            subtotalNetSales: row.netSales,
            warehouse: 'Shopify',
            status: 'Completed'
          });
        }
      }

      if (transactions.length === 0) {
        console.warn('No transactions found for SKU:', sku);
        return;
      }

      // Sort by date
      transactions.sort((a, b) => a.date.localeCompare(b.date));

      // Add summary row
      const totalQuantity = transactions.reduce((sum, t) => sum + t.quantity, 0);
      const totalRevenue = transactions.reduce((sum, t) => sum + t.subtotalNetSales, 0);
      const unitCost = costsData.get(sku) || null;

      transactions.push({
        date: 'TOTAL',
        channel: '',
        customerRegion: '',
        quantity: totalQuantity,
        unitPrice: totalQuantity !== 0 ? (totalRevenue / totalQuantity) : 0,
        subtotalNetSales: totalRevenue,
        warehouse: unitCost ? `Unit Cost: $${unitCost.toFixed(2)}` : '',
        status: unitCost && totalRevenue > 0
          ? `Margin: ${(((totalRevenue - (unitCost * totalQuantity)) / totalRevenue) * 100).toFixed(2)}%`
          : ''
      });

      const columns: CSVColumn[] = [
        { header: 'Date', key: 'date' },
        { header: 'Channel', key: 'channel' },
        { header: 'Customer/Region', key: 'customerRegion' },
        { header: 'Quantity', key: 'quantity', formatter: (value) => value?.toLocaleString() || '0' },
        { header: 'Unit Price (AUD)', key: 'unitPrice', formatter: (value) => value?.toFixed(2) || '0.00' },
        { header: 'Subtotal/NetSales (AUD)', key: 'subtotalNetSales', formatter: (value) => value?.toFixed(2) || '0.00' },
        { header: 'Warehouse', key: 'warehouse' },
        { header: 'Status', key: 'status' }
      ];

      const filename = `sku_details_${sku}_${format(dateRange.from || new Date(), 'yyyy-MM-dd')}_to_${format(dateRange.to || new Date(), 'yyyy-MM-dd')}.csv`;

      downloadCSV(transactions, filename, columns);
    } catch (error) {
      console.error('Error downloading SKU details:', error);
    } finally {
      setDownloadingSkus(prev => {
        const newSet = new Set(prev);
        newSet.delete(sku);
        return newSet;
      });
    }
  };

  // Legacy topSKUs for existing functionality (keeping for backward compatibility)
  const legacyTopSKUs = useMemo(() => {
    const filteredUnleashed = filteredData.unleashed.filter(row => 
      selectedChannels.includes(row.channel) &&
      row.channel !== 'Shop sale' &&
      matchesWarehouse(row.warehouse, activeWarehouse)
    );

    const skuData = filteredUnleashed.reduce((acc, row) => {
      const sku = row.product;
      if (!acc[sku]) {
        acc[sku] = { sku, units: 0, revenue: 0 };
      }
      acc[sku].units += row.quantity;
      acc[sku].revenue += row.subTotal;
      return acc;
    }, {} as Record<string, { sku: string; units: number; revenue: number }>);

    const skuList = Object.values(skuData).map(item => {
      console.log(`Looking for SKU: "${item.sku}"`);
      const unitCost = costsData.get(item.sku) || 0;
      console.log(`Found cost: ${unitCost} for SKU: "${item.sku}"`);
      const margin = unitCost && item.revenue > 0
        ? ((item.revenue - (unitCost * item.units)) / item.revenue) * 100
        : null;

      return {
        ...item,
        unitCost: unitCost || null,
        margin
      };
    }).filter(item => !item.sku.toLowerCase().includes('shipping cost'));

    skuList.sort((a, b) =>
      sortBy === 'revenue' ? b.revenue - a.revenue : b.units - a.units
    );

    return skuList.slice(0, 20);
  }, [filteredData.unleashed, selectedChannels, costsData, sortBy, activeWarehouse]);

  // Channel detailed operations memo
  const channelDetailedOperations = useMemo(() => {
    const operationsByChannel = new Map<string, any[]>();

    // Shopify channel operations
    const shopifyOps: any[] = [];

    // Current Shopify data
    filteredData.shopify.forEach(row => {
      shopifyOps.push({
        date: row.date,
        sku: row.sku,
        quantity: row.quantity,
        netSales: row.netSales,
        taxes: row.taxes,
        shipping: row.shipping,
        region: row.region,
        source: 'Current Shopify'
      });
    });

    // Old Shopify data
    filteredData.oldShopify.forEach(row => {
      shopifyOps.push({
        date: row.date,
        sku: 'N/A',
        quantity: 0,
        netSales: row.netSales,
        taxes: 0,
        shipping: 0,
        region: row.region,
        source: 'Old Shopify'
      });
    });

    if (shopifyOps.length > 0) {
      operationsByChannel.set('Shopify', shopifyOps);
    }

    // Unleashed data (B2B, Korea, etc.)
    filteredData.unleashed.forEach(row => {
      if (!matchesWarehouse(row.warehouse, activeWarehouse)) return;

      const channel = row.channel;

      // Skip Shopify and Shop sale channels to avoid double counting
      if (channel === 'Shopify' || channel === 'Shop sale') return;

      const operations = operationsByChannel.get(channel) || [];
      operations.push({
        date: row.orderDate,
        product: row.product,
        customer: row.customer,
        quantity: row.quantity,
        subTotal: row.subTotal,
        warehouse: row.warehouse,
        productGroup: row.productGroup
      });
      operationsByChannel.set(channel, operations);
    });

    return operationsByChannel;
  }, [filteredData, activeWarehouse]);

  // Export CSV function for channel summary
  const exportChannelCSV = () => {
    const csvContent = [
      ['Channel', 'Sales (AUD)', 'Share %'],
      ...channelAnalysis.map(row => [row.channel, row.sales.toFixed(2), row.share.toFixed(1)])
    ].map(row => row.join(',')).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'channel-analysis.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export detailed operations CSV for a specific channel
  const exportChannelOperationsCSV = (channelName: string) => {
    const operations = channelDetailedOperations.get(channelName);

    if (!operations || operations.length === 0) {
      alert(`No operations found for channel: ${channelName}`);
      return;
    }

    let columns: CSVColumn[] = [];
    let data: any[] = [];

    if (channelName === 'Shopify') {
      columns = [
        { header: 'Date', key: 'date', formatter: (value) => value ? format(value, 'yyyy-MM-dd') : '' },
        { header: 'SKU', key: 'sku' },
        { header: 'Quantity', key: 'quantity' },
        { header: 'Net Sales (AUD)', key: 'netSales', formatter: (value) => value.toFixed(2) },
        { header: 'Taxes (AUD)', key: 'taxes', formatter: (value) => value.toFixed(2) },
        { header: 'Shipping (AUD)', key: 'shipping', formatter: (value) => value.toFixed(2) },
        { header: 'Region', key: 'region' },
        { header: 'Source', key: 'source' }
      ];
      data = operations;
    } else {
      columns = [
        { header: 'Date', key: 'date', formatter: (value) => value ? format(value, 'yyyy-MM-dd') : '' },
        { header: 'Product', key: 'product' },
        { header: 'Customer', key: 'customer' },
        { header: 'Quantity', key: 'quantity' },
        { header: 'Sub Total (AUD)', key: 'subTotal', formatter: (value) => value.toFixed(2) },
        { header: 'Warehouse', key: 'warehouse' },
        { header: 'Product Group', key: 'productGroup' }
      ];
      data = operations;
    }

    const dateFrom = dateRange.from ? format(dateRange.from, 'yyyy-MM-dd') : 'start';
    const dateTo = dateRange.to ? format(dateRange.to, 'yyyy-MM-dd') : 'end';
    const fileName = `${channelName.toLowerCase().replace(/\s+/g, '_')}_operations_${dateFrom}_${dateTo}.csv`;

    downloadCSV(data, fileName, columns);
  };

  // If Mario Dashboard is open, render it instead of the main content
  if (showMarioDashboard) {
    return <MarioDashboard onClose={handleCloseMarioDashboard} />;
  }

  return (
    <>
    <div className="min-h-screen flex flex-col">
      {/* Top Bar - Navigation pills + toolbar */}
      <header className="shrink-0 px-4 py-3 border-b border-border/60 bg-card/80 backdrop-blur-sm">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Logo / Title */}
          <div className="flex items-center gap-2 shrink-0">
            <h1 className="text-base font-semibold text-foreground tracking-tight">Dashboard 2026</h1>
          </div>

          {/* Nav Pills - each opens a modal */}
          <div className="overflow-x-auto flex-1 min-w-0">
          <div className="h-9 rounded-2xl bg-muted/60 p-1 gap-0.5 shrink-0 inline-flex">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'channel' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'channel' ? null : 'channel')}
              >
                By Channel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setIsCostsModalOpen(true)}
              >
                Costs
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'brand' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'brand' ? null : 'brand')}
              >
                Brand
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'top-skus' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'top-skus' ? null : 'top-skus')}
              >
                Top SKUs
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'sales-evolution' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'sales-evolution' ? null : 'sales-evolution')}
              >
                Sales Evolution
              </Button>
              {/* The old "AIM" tab (InventoryReorderDashboard) is archived: AIM 2026
                  superseded it. The modal below is still mounted and reachable by
                  setting activeModal to 'aim', so bringing it back is one line. */}
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "relative h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'aim-2026' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'aim-2026' ? null : 'aim-2026')}
              >
                AIM 2026
                <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                </span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'ecommerce' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'ecommerce' ? null : 'ecommerce')}
              >
                <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
                E-commerce
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'b2c-explorer' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'b2c-explorer' ? null : 'b2c-explorer')}
              >
                <Search className="h-3.5 w-3.5 mr-1.5" />
                B2C Sales Explorer
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'web-upgrade' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'web-upgrade' ? null : 'web-upgrade')}
              >
                Web Upgrade
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium",
                  activeModal === 'fy-report' ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setActiveModal(activeModal === 'fy-report' ? null : 'fy-report')}
              >
                Reports
              </Button>
            </div>
          </div>

          {/* Toolbar: Date, Update, Config, Sidebar toggle */}
          <div className="flex items-center gap-2 ml-auto shrink-0">
            <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 gap-1.5 text-xs font-normal",
                    !dateRange?.from && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateRange?.from ? (
                    dateRange.to ? (
                      `${format(dateRange.from, "MMM d")} – ${format(dateRange.to, "MMM d")}`
                    ) : (
                      format(dateRange.from, "MMM d")
                    )
                  ) : (
                    "Date range"
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end" side="bottom">
                <div className="flex">
                  <DateRangePresets onSelect={(r) => { setDateRange(r); setIsCalendarOpen(false); }} />
                  <div>
                    <Calendar
                      initialFocus
                      mode="range"
                      defaultMonth={dateRange?.from}
                      selected={dateRange as any}
                      onSelect={(range) => setDateRange(range || {})}
                      numberOfMonths={2}
                      weekStartsOn={1}
                    />
                    <div className="p-2 border-t flex justify-end">
                      <Button size="sm" onClick={() => setIsCalendarOpen(false)}>
                        Apply
                      </Button>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Button
              onClick={handleFullRefresh}
              disabled={isLoading || syncRunning}
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              title="Pull every source from its API and rebuild the dashboard (same as the auto-sync)"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${(isLoading || syncRunning) ? 'animate-spin' : ''}`} />
              {syncRunning ? 'Syncing…' : isLoading ? 'Updating...' : 'Update'}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setIsConfigOpen(true)}
              title="Config"
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => signOut()}
              title="Cerrar sesión"
            >
              <LogOut className="h-4 w-4 text-muted-foreground" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setSidebarOpen((o) => !o)}
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
              ) : (
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* Body: Sidebar + Main */}
      <div className="flex-1 flex min-h-0">
      {/* Sidebar - collapsible */}
      <aside
        className={cn(
          "shrink-0 bg-card border-r border-border/60 overflow-hidden transition-all duration-300 ease-in-out",
          sidebarOpen ? "w-80" : "w-0"
        )}
      >
        <div className={cn("w-80 p-6 space-y-6", !sidebarOpen && "opacity-0 pointer-events-none")}>
        {/* File Inputs - no Update button here anymore */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Data Sources</h2>
          </div>
          
          {lastUpdated && (
            <p className="text-sm text-muted-foreground">
              Last updated: {format(lastUpdated, 'MMM dd, yyyy HH:mm')}
            </p>
          )}
          
          <div className="text-sm text-muted-foreground space-y-1">
            <p>• Unleashed Sales: {unleashedData.length} records</p>
            <p>• Shopify Sales: {shopifyData.length} records</p>
            <p>• Old Shopify: {oldShopifyData.length} records</p>
            <p>• Meta Ads: {metaData.length} records</p>
            <p>• Cost Data: {costsData.size} SKUs</p>
          </div>
          
          {/* Data Source Links */}
          <div className="space-y-2">
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full text-xs"
              onClick={() => window.open('https://au.unleashedsoftware.com/v2/Enquiry/SalesEnquiry#transactionDateType=OrderDate,salesOrderStatuses=Parked%2CPlaced%2CBackordered%2CCompleted%2CB2B%2Cpls+print+send,warehouseIds=4%2C7%2C9%2C1%2C6%2C8%2C3%2C5,start=01%2F01%2F2025,end=30%2F06%2F2026', '_blank')}
            >
              Open Unleashed Sales
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={() => window.open('https://admin.shopify.com/store/pesado585/analytics/reports/147751219?ql=FROM+sales%0A++SHOW+net_items_sold%2C+gross_sales%2C+discounts%2C+returns%2C+net_sales%2C+taxes%2C%0A++++total_sales%2C+shipping_charges%0A++WHERE+line_type+%3D+%27product%27%0A++++OR+line_type+%3D+%27shipping%27%0A++GROUP+BY+product_title%2C+product_variant_title%2C+product_variant_sku%2C+month%2C%0A++++shipping_country%2C+day+WITH+TOTALS%2C+CURRENCY+%27USD%27%0A++SINCE+2025-07-01+UNTIL+2026-06-02%0A++ORDER+BY+month+ASC%0A++LIMIT+1000%0AVISUALIZE+total_sales+TYPE+horizontal_bar', '_blank')}
            >
              Open Shopify Sales
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={() => window.open('https://adsmanager.facebook.com/adsmanager/reporting/business_view?act=1619162111994178&ads_manager_write_regions=true&business_id=204916233498200&event_source=CLICK_CREATE_REPORT&selected_report_id=1893156248007515', '_blank')}
            >
              Open Meta Ads
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={() => window.open('https://reporting.xero.com/!-Dc4k/v1/Run/15118890?isCustom=True', '_blank')}
            >
              <Link2 className="mr-2 h-4 w-4" />
              Open Xero expenses
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs"
              onClick={() => window.open('https://supabase.com/dashboard/project/teewkafclgpfpczftvah/storage/buckets/csv-files', '_blank')}
            >
              Upload files to Supabase
            </Button>
          </div>
          
          {/* Legacy file inputs - kept for fallback */}
          <details className="mt-4">
            <summary className="text-sm text-muted-foreground cursor-pointer">Manual File Upload (Fallback)</summary>
            <div className="mt-2 space-y-2">
              <div>
                <Label>Unleashed Sales</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) => e.target.files?.[0] && parseUnleashedFile(e.target.files[0])}
                />
              </div>
              
              <div>
                <Label>Shopify Sales</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) => e.target.files?.[0] && parseShopifyFile(e.target.files[0])}
                />
              </div>
              
              <div>
                <Label>Old Shopify Sales (2025)</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) => e.target.files?.[0] && parseOldShopifyFile(e.target.files[0])}
                />
              </div>
              
              <div>
                <Label>Meta Ads</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) => e.target.files?.[0] && parseMetaFile(e.target.files[0])}
                />
              </div>
              
              <div>
                <Label>Costs</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={(e) => e.target.files?.[0] && parseCostsFile(e.target.files[0])}
                />
              </div>
            </div>
          </details>
        </div>

        {/* Warehouse Filter */}
        <div>
          <Label>Filter by Warehouse</Label>
          <Select value={activeWarehouse} onValueChange={setActiveWarehouse}>
            <SelectTrigger className="text-foreground">
              <SelectValue placeholder="Select warehouse" />
            </SelectTrigger>
            <SelectContent>
              {warehouseOptions.map((warehouse) => (
                <SelectItem key={warehouse} value={warehouse}>
                  {warehouse === 'ALL' ? 'All warehouses' : warehouse}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* FX Controls */}
        <div className="space-y-3">
          <Label>Currency Exchange</Label>
          <Button onClick={updateFxRate} className="w-full">
            Update FX
          </Button>
          <TooltipProvider>
            <TooltipComponent>
              <TooltipTrigger asChild>
                <p className="text-sm text-muted-foreground cursor-help">
                  Source: {fxSource.includes('Dynamic') ? 'Dynamic rates by month' : fxSource}
                </p>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs">
                <p className="text-xs">{fxSource}</p>
              </TooltipContent>
            </TooltipComponent>
          </TooltipProvider>
          <Input
            placeholder="Manual override"
            value={manualFxRate}
            onChange={(e) => handleManualFxChange(e.target.value)}
            type="number"
            step="0.0001"
          />
          <p className="text-sm font-medium">
            Fallback FX: {fxRate.toFixed(4)} USD→AUD
          </p>
          
          <div className="space-y-2">
            <Label>Blended ROAS Target</Label>
            <Input
              placeholder="e.g. 2.56"
              value={blendedRoasTarget.toString()}
              onChange={(e) => {
                const value = e.target.value;
                const numValue = parseFloat(value);
                if (!isNaN(numValue) && numValue > 0) {
                  setBlendedRoasTarget(numValue);
                } else if (value === '') {
                  setBlendedRoasTarget(0);
                }
              }}
              type="number"
              step="0.01"
            />
            <Button 
              variant="outline" 
              size="sm" 
              className="w-full text-xs"
              onClick={() => window.open('https://docs.google.com/spreadsheets/d/1GbEeuBb9QUfinJI3lsF20SaAq9qNm7sdh_WiiSkf95A/edit?usp=sharing', '_blank')}
            >
              How is the Blended ROAS Target calculated?
            </Button>
            <Button 
              variant="outline" 
              onClick={() => setShowPasswordDialog(true)}
            >
              Internal Functions (Mario)
            </Button>
          </div>
        </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-auto">
        <main className="flex-1 p-6 space-y-6 overflow-auto">
        {/* KPI Cards Row */}
        <div className="flex gap-6 mb-6">
          {/* Total Sales KPI */}
          <Card className="flex-1">
            <CardHeader>
              <CardTitle>Total Sales (AUD)</CardTitle>
              {dateRange?.from && dateRange?.to && (
                <CardDescription>
                  {format(dateRange.from, "MMM d, yyyy")} – {format(dateRange.to, "MMM d, yyyy")}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center text-center">
              <div className="text-5xl font-bold tabular-nums">
                ${totalSales.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
              </div>
              {lastUpdated && (
                <div className="text-xs text-muted-foreground mt-2">
                  Last updated: {format(lastUpdated, 'MMM d, yyyy h:mm a')}
                </div>
              )}
              {dataCoverageWarnings.length > 0 && (
                <div className="mt-4 w-full rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-left">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                    <div className="text-xs space-y-1">
                      <div className="font-semibold text-amber-900 dark:text-amber-200">
                        Data incompleta para el rango seleccionado
                      </div>
                      <ul className="space-y-0.5 text-amber-800 dark:text-amber-300">
                        {dataCoverageWarnings.map((w) => (
                          <li key={w.source}>
                            <span className="font-medium">{w.source}:</span>{' '}
                            {!w.minDate || !w.maxDate
                              ? 'sin datos en el sistema'
                              : `datos disponibles ${format(w.minDate, 'MMM d, yyyy')} – ${format(w.maxDate, 'MMM d, yyyy')}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* FY YTD by Channel */}
          <Card className="flex-1">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>FY YTD by Channel</CardTitle>
              <Button onClick={exportChannelCSV} size="sm">
                <Download className="h-4 w-4 mr-2" />
                Download CSV
              </Button>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead className="text-right">Sales (AUD)</TableHead>
                    <TableHead className="text-right">Share %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {channelAnalysis.map((row) => (
                    <TableRow
                      key={row.channel}
                      className="cursor-pointer hover:bg-muted/60 transition-colors"
                      onClick={() => exportChannelOperationsCSV(row.channel)}
                    >
                      <TableCell className="font-medium">{row.channel}</TableCell>
                      <TableCell className="text-right">
                        ${row.sales.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.share.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Shopify vs Meta Attribution */}
          <Card className="flex-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Shopify vs Meta Attribution</CardTitle>
              <CardDescription>
                Attribution analysis for selected date range
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Top Section: Meta Ads and Date Range ROAS */}
              <div className="grid grid-cols-2 gap-4 text-center mb-4 pb-4 border-b">
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Total Meta Ads</div>
                  <div className="text-lg font-semibold">
                    ${(metaSpend.length > 0 ? metaSpend[0].spend : 0).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Date Range ROAS</div>
                  <div className="text-lg font-semibold">
                    {dateRangeROAS !== null ? dateRangeROAS.toFixed(2) : 'N/A'}
                  </div>
                </div>
              </div>
              
              {/* Bottom Section: Attribution Details */}
              <div className="grid grid-cols-4 gap-4 text-center">
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Shopify Sales</div>
                  <div className="text-lg font-semibold">
                    ${totalShopifySalesMemo.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Meta Conversions</div>
                  <div className="text-lg font-semibold">
                    ${totalMetaConversions.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Purchase ROAS</div>
                  <div className="text-lg font-semibold">
                    {purchaseROAS !== null ? purchaseROAS.toFixed(2) : 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Ratio Meta / Shopify</div>
                  <div className="text-lg font-semibold">
                    {metaShopifyRatio !== null ? `${(metaShopifyRatio * 100).toFixed(1)}%` : 'N/A'}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ROAS + Cost distribution */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Weekly ROAS</CardTitle>
              <CardDescription>Shopify Net Sales / Meta Ads Spend</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyROAS}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="week" tickFormatter={(v) => format(parseISO(v), 'MMM dd')} />
                    <YAxis />
                    <Tooltip
                      labelFormatter={(v) => `Week of ${format(parseISO(v), 'MMM dd, yyyy')}`}
                      formatter={(value: any, name: string) => [
                        value?.toFixed(2) || 'N/A',
                        name === 'roas' ? 'Blended ROAS' : 'META Purchase ROAS',
                      ]}
                    />
                    <Line type="monotone" dataKey="roas" stroke="#3b82f6" strokeWidth={2} connectNulls={false} />
                    <Line type="monotone" dataKey="purchaseRoas" stroke="#16a34a" strokeWidth={2} connectNulls={false} />
                    {blendedRoasTarget && blendedRoasTarget > 0 && (
                      <ReferenceLine
                        y={blendedRoasTarget}
                        stroke="red"
                        strokeDasharray="3 3"
                        label={{ value: `Target: ${blendedRoasTarget.toFixed(2)}`, position: 'top' as const }}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Cost distribution</CardTitle>
              <CardDescription>
                {costsSource === 'costs' && costsSnapshot
                  ? 'Fixed and Variable costs from Costs tab. Hover for details, click Other to expand.'
                  : 'Use Costs tab to see distribution'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {costsSnapshot && costsSource === 'costs' ? (
                  <>
                    {(() => {
                      const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
                      const buildChartData = (board: 'fixed' | 'variable') => {
                        const items = costsSnapshot!.items
                          .filter((i) => i.board === board)
                          .map((i) => ({ name: i.name, value: i.b2cAmount + i.b2bAmount }))
                          .filter((d) => d.value > 0)
                          .sort((a, b) => b.value - a.value);
                        if (items.length === 0) return { displayData: [] as { name: string; value: number; _otherItems?: { name: string; value: number }[] }[], otherItems: [] as { name: string; value: number }[] };
                        const top6 = items.slice(0, 6);
                        const rest = items.slice(6);
                        const otherSum = rest.reduce((s, x) => s + x.value, 0);
                        const displayData = top6.map((x) => ({ ...x, _otherItems: undefined as { name: string; value: number }[] | undefined }));
                        if (otherSum > 0) {
                          displayData.push({ name: 'Other', value: otherSum, _otherItems: rest });
                        }
                        return { displayData, otherItems: rest };
                      };
                      const fixed = buildChartData('fixed');
                      const variable = buildChartData('variable');
                      const renderBarChart = (
                        data: { name: string; value: number; _otherItems?: { name: string; value: number }[] }[],
                        title: string,
                        colorOffset: number
                      ) => {
                        if (data.length === 0) return <div className="text-muted-foreground text-sm">No {title.toLowerCase()} in range</div>;
                        const total = data.reduce((s, d) => s + d.value, 0);
                        const dataWithPct = data.map((d) => ({ ...d, pct: total > 0 ? (d.value / total) * 100 : 0 }));
                        const hasClickableOther = data.some((d) => d.name === 'Other' && d._otherItems?.length);
                        return (
                          <div className="h-64">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={dataWithPct} layout="vertical" margin={{ left: 100, right: 60 }}>
                                <CartesianGrid strokeDasharray="3 3" />
                                <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                                <YAxis type="category" dataKey="name" width={95} tick={{ fontSize: 11 }} />
                                <Tooltip
                                  formatter={(v: number, _n: string, item: unknown) => {
                                    const p = (item as { payload?: { name?: string; _otherItems?: unknown[] } })?.payload;
                                    const label = p?.name === 'Other' && (p?._otherItems?.length ?? 0) > 0
                                      ? `Other (${p._otherItems!.length} items) – click to expand`
                                      : (p?.name ?? '');
                                    return [`$${Number(v).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`, label];
                                  }}
                                />
                                <Bar
                                  dataKey="value"
                                  radius={[0, 4, 4, 0]}
                                  onClick={(payload: { name: string; _otherItems?: { name: string; value: number }[] }) => {
                                    if (payload?.name === 'Other' && payload?._otherItems?.length) {
                                      setCostOtherDetail({ title: `${title} – Other`, items: payload._otherItems });
                                    }
                                  }}
                                  style={{ cursor: hasClickableOther ? 'pointer' : 'default' }}
                                >
                                  {dataWithPct.map((d, i) => (
                                    <Cell key={d.name} fill={COLORS[(colorOffset + i) % COLORS.length]} />
                                  ))}
                                  <LabelList dataKey="pct" position="right" formatter={(v: number) => `${v.toFixed(1)}%`} />
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        );
                      };
                      return (
                        <>
                          <div>
                            <div className="text-sm font-medium mb-2">Fixed Costs</div>
                            {renderBarChart(fixed.displayData, 'Fixed Costs', 0)}
                          </div>
                          <div>
                            <div className="text-sm font-medium mb-2">Variable Costs</div>
                            {renderBarChart(variable.displayData, 'Variable Costs', 2)}
                          </div>
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <div className="md:col-span-2 h-64 flex items-center justify-center text-muted-foreground text-sm">Select Costs source in By Channel</div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Dialog open={!!costOtherDetail} onOpenChange={(o) => !o && setCostOtherDetail(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{costOtherDetail?.title ?? 'Other'}</DialogTitle>
              <DialogDescription>Breakdown of grouped items</DialogDescription>
            </DialogHeader>
            {costOtherDetail && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Amount (AUD)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costOtherDetail.items.map((item) => (
                    <TableRow key={item.name}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell className="text-right">${item.value.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </DialogContent>
        </Dialog>

        {/* Sales by Product Group */}
        <Card>
          <CardHeader>
            <CardTitle>Sales by Product Group</CardTitle>
            <CardDescription>Revenue by brand (Pesado, The Artisan Barista, Coffee Accessories, Tiamo, Others) – same as Brand modal</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              {(() => {
                const chartData = brandAnalysis.filter((b) => b.totalSales > 0).map((b) => ({ name: b.brand, sales: b.totalSales }));
                const total = chartData.reduce((s, x) => s + x.sales, 0);
                const dataWithPct = chartData.map((d) => ({ ...d, pct: total > 0 ? (d.sales / total) * 100 : 0 }));
                return dataWithPct.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dataWithPct} layout="vertical" margin={{ left: 80, right: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="name" width={75} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: number) => [`$${v.toLocaleString('en-AU', { minimumFractionDigits: 2 })}`, 'Sales']} />
                    <Bar dataKey="sales" fill="#3b82f6" radius={[0, 4, 4, 0]}>
                      <LabelList dataKey="pct" position="right" formatter={(v: number) => `${v.toFixed(1)}%`} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground">No sales data in range</div>
              );
              })()}
            </div>
          </CardContent>
        </Card>

        {/* Top 10 SKUs + Pesado critical stock */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Top 10 SKUs by Revenue</CardTitle>
              <CardDescription>Excluding misc products</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Revenue (AUD)</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Margin %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {top10SKUsDashboard.map((row, i) => (
                    <TableRow key={row.sku}>
                      <TableCell className="font-medium">{i + 1}</TableCell>
                      <TableCell className="font-medium">{row.sku}</TableCell>
                      <TableCell className="text-right">${row.revenue.toLocaleString('en-AU', { minimumFractionDigits: 2 })}</TableCell>
                      <TableCell className="text-right">{row.units.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{row.margin != null ? `${row.margin.toFixed(1)}%` : 'N/A'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {top10SKUsDashboard.length === 0 && (
                <div className="py-6 text-center text-muted-foreground text-sm">No SKU data in range</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>10 Pesado products – Critical stock</CardTitle>
              <CardDescription>Stock, demand and days of coverage</CardDescription>
            </CardHeader>
            <CardContent>
              {pesadoCriticalLoading ? (
                <div className="py-6 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead className="text-right">Demand</TableHead>
                      <TableHead className="text-right">Trend</TableHead>
                      <TableHead className="text-right">Days cover</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pesadoCriticalStock.map((r) => (
                      <TableRow key={r.sku}>
                        <TableCell className="font-medium">{r.sku}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.sohMainWH}
                          {r.sohChina > 0 && (
                            <span className="ml-1 text-[10px] text-muted-foreground">+{r.sohChina} CN</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{r.projectedDemand.toFixed(1)}</TableCell>
                        <TableCell className="text-right">
                          <TrendIndicator direction={r.demandTrend} percent={r.demandTrendPercent} showPercent />
                        </TableCell>
                        <TableCell className="text-right text-red-600 font-medium">{r.daysOfCover}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {!pesadoCriticalLoading && pesadoCriticalStock.length === 0 && (
                <div className="py-6 text-center text-muted-foreground text-sm">No Pesado products in critical stock</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* By Channel modal */}
        <Dialog open={activeModal === 'channel'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>By Channel</DialogTitle>
              <DialogDescription>Detailed financials for B2C and B2B channels</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 mt-4">
            <div className="flex items-center gap-4 mb-4 flex-wrap">
              <ModalDateRangePicker dateRange={dateRange} setDateRange={setDateRange} />
              <Label htmlFor="costs-source" className="whitespace-nowrap">Costs source:</Label>
              <Select value={costsSource} onValueChange={setCostsSource}>
                <SelectTrigger id="costs-source" className="w-[250px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="estimations">Use estimations</SelectItem>
                  <SelectItem value="costs">Use info from Costs tab</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-4">
              <Card className="flex-1">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Detailed Financials for B2C channel</CardTitle>
                      <CardDescription>Key financial metrics and costs for B2C (Shopify)</CardDescription>
                    </div>
                    <TooltipProvider>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="andrea-costs"
                          checked={andreaExtraCosts}
                          onCheckedChange={(checked) => setAndreaExtraCosts(checked as boolean)}
                        />
                        <TooltipComponent>
                          <TooltipTrigger asChild>
                            <Label htmlFor="andrea-costs" className="cursor-help">
                              Andrea's extra costs
                            </Label>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p>Includes cleaning, insurance, total motor vehicle expenses, non-deductible expenses, Andrea's taxes, light, gas and power (Andrea), and travel.</p>
                          </TooltipContent>
                        </TooltipComponent>
                      </div>
                    </TooltipProvider>
                  </div>
                </CardHeader>
                <CardContent>
                  <TooltipProvider>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Metric</TableHead>
                          <TableHead className="text-right">Amount (AUD)</TableHead>
                          <TableHead className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <span>Share %</span>
                              <button
                                onClick={() => setShowB2CStandardModel(!showB2CStandardModel)}
                                className="text-gray-500 hover:text-gray-700"
                                title={showB2CStandardModel ? 'Hide B2C standard model %' : 'Show B2C standard model %'}
                              >
                                {showB2CStandardModel ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </button>
                            </div>
                          </TableHead>
                          {showB2CStandardModel && (
                            <TableHead className="text-right">B2C standard model %</TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">
                            <TooltipComponent>
                              <TooltipTrigger asChild>
                                <span className="cursor-help underline decoration-dotted">Net Total Shopify Sales</span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>This is Gross sales - discounts - returns</p>
                              </TooltipContent>
                            </TooltipComponent>
                          </TableCell>
                          <TableCell className="text-right">
                            ${totalShopifySalesMemo.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {(totalShopifySalesGross === 0 ? 0 : (totalShopifySalesMemo / totalShopifySalesGross) * 100).toFixed(2)}%
                          </TableCell>
                          {showB2CStandardModel && (
                            <TableCell className="text-right text-gray-500">
                              {getB2CStandardModelPercent('Net Total Shopify Sales')}
                            </TableCell>
                          )}
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Taxes received</TableCell>
                          <TableCell className="text-right">
                            ${taxesReceived.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {(totalShopifySalesGross === 0 ? 0 : (taxesReceived / totalShopifySalesGross) * 100).toFixed(2)}%
                          </TableCell>
                          {showB2CStandardModel && (
                            <TableCell className="text-right text-gray-500">
                              {getB2CStandardModelPercent('Taxes received')}
                            </TableCell>
                          )}
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Shipping charges received</TableCell>
                          <TableCell className="text-right">
                            ${shippingChargesReceived.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {(totalShopifySalesGross === 0 ? 0 : (shippingChargesReceived / totalShopifySalesGross) * 100).toFixed(2)}%
                          </TableCell>
                          {showB2CStandardModel && (
                            <TableCell className="text-right text-gray-500">
                              {getB2CStandardModelPercent('Shipping charges received')}
                            </TableCell>
                          )}
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium">Total Shopify Sales</TableCell>
                          <TableCell className="text-right">
                            ${totalShopifySalesGross.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            100.00%
                          </TableCell>
                          {showB2CStandardModel && (
                            <TableCell className="text-right text-gray-500">
                              {getB2CStandardModelPercent('Total Shopify Sales')}
                            </TableCell>
                          )}
                        </TableRow>
                        <TableRow className="border-b-2 border-gray-300">
                          <TableCell colSpan={showB2CStandardModel ? 4 : 3}></TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell
                            className="font-medium cursor-pointer hover:underline text-blue-600"
                            onClick={handleDownloadShopifyCOGS}
                            title="Click to download detailed COGS breakdown"
                          >
                            Total Shopify COGS
                          </TableCell>
                          <TableCell className="text-right">
                            -${totalShopifyCOGS.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {(totalShopifySalesGross === 0 ? 0 : (totalShopifyCOGS / totalShopifySalesGross) * 100).toFixed(2)}%
                          </TableCell>
                          {showB2CStandardModel && (
                            <TableCell className="text-right text-gray-500">
                              {getB2CStandardModelPercent('Total Shopify COGS')}
                            </TableCell>
                          )}
                        </TableRow>
                        {costsSource === 'estimations' && (
                          <TableRow>
                            <TableCell className="font-medium">Total Meta Spend</TableCell>
                            <TableCell className="text-right">
                              -${(metaSpend.length > 0 ? metaSpend[0].spend : 0).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className="text-right">
                              {(totalShopifySalesGross === 0 ? 0 : ((metaSpend.length > 0 ? metaSpend[0].spend : 0) / totalShopifySalesGross) * 100).toFixed(2)}%
                            </TableCell>
                            {showB2CStandardModel && (
                              <TableCell className="text-right text-gray-500">
                                {getB2CStandardModelPercent('Total Meta Spend')}
                              </TableCell>
                            )}
                          </TableRow>
                        )}
                        {showPostMarketingContribution && (
                          <TableRow>
                            <TableCell className="font-medium font-bold">Post-Marketing Contribution</TableCell>
                            <TableCell className="text-right">
                              ${postMarketingContribution.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                            </TableCell>
                            <TableCell className="text-right">
                              {(totalShopifySalesGross === 0 ? 0 : (postMarketingContribution / totalShopifySalesGross) * 100).toFixed(2)}%
                            </TableCell>
                            {showB2CStandardModel && (
                              <TableCell className="text-right text-gray-500">
                                {getB2CStandardModelPercent('Post-Marketing Contribution')}
                              </TableCell>
                            )}
                          </TableRow>
                        )}
                        <TableRow>
                          <TableCell colSpan={showB2CStandardModel ? 4 : 3} className="py-1">
                            <button
                              onClick={() => setShowPostMarketingContribution(!showPostMarketingContribution)}
                              className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-800"
                            >
                              {showPostMarketingContribution ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              <span>{showPostMarketingContribution ? 'Hide' : 'Show'} Post-Marketing Contribution</span>
                            </button>
                          </TableCell>
                        </TableRow>
                        {costsSource === 'estimations' && (
                          <>
                            <TableRow>
                              <TableCell className="font-medium">
                                <TooltipComponent>
                                  <TooltipTrigger asChild>
                                    <span className="cursor-help underline decoration-dotted">Shipping cost</span>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-xs">
                                    <p>From the analysis of the last 3 months</p>
                                    <a
                                      href="https://docs.google.com/spreadsheets/d/1sIox4oJn6L7uNPWwBIJFTnJKgzIx7Ll6vwbQsVTHRl4/edit?gid=483965303#gid=483965303"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:text-blue-800 underline block mt-2"
                                    >
                                      View Details
                                    </a>
                                  </TooltipContent>
                                </TooltipComponent>
                              </TableCell>
                              <TableCell className="text-right">
                                -${shippingCost.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalShopifySalesGross === 0 ? 0 : (shippingCost / totalShopifySalesGross) * 100).toFixed(2)}%
                              </TableCell>
                              {showB2CStandardModel && (
                                <TableCell className="text-right text-gray-500">
                                  {getB2CStandardModelPercent('Shipping cost')}
                                </TableCell>
                              )}
                            </TableRow>
                            <TableRow>
                              <TableCell className="font-medium">
                                <TooltipComponent>
                                  <TooltipTrigger asChild>
                                    <span className="cursor-help underline decoration-dotted">Fixed cost</span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>The daily fixed cost is AUD 2654 (oct 2025). Fixed cost is composed by the sum of B2B and B2C fixed costs</p>
                                    <a
                                      href="https://docs.google.com/spreadsheets/d/1sIox4oJn6L7uNPWwBIJFTnJKgzIx7Ll6vwbQsVTHRl4/edit?gid=483965303#gid=483965303"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:text-blue-800 underline block mt-2"
                                    >
                                      View Details
                                    </a>
                                  </TooltipContent>
                                </TooltipComponent>
                              </TableCell>
                              <TableCell className="text-right">
                                -${fixedCost.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalShopifySalesGross === 0 ? 0 : (fixedCost / totalShopifySalesGross) * 100).toFixed(2)}%
                              </TableCell>
                              {showB2CStandardModel && (
                                <TableCell className="text-right text-gray-500">
                                  {getB2CStandardModelPercent('Fixed cost')}
                                </TableCell>
                              )}
                            </TableRow>
                            <TableRow>
                              <TableCell className="font-medium">
                                <TooltipComponent>
                                  <TooltipTrigger asChild>
                                    <span className="cursor-help underline decoration-dotted">Other variable costs</span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <a
                                      href="https://docs.google.com/spreadsheets/d/1sIox4oJn6L7uNPWwBIJFTnJKgzIx7Ll6vwbQsVTHRl4/edit?gid=483965303#gid=483965303"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:text-blue-800 underline"
                                    >
                                      View Details
                                    </a>
                                  </TooltipContent>
                                </TooltipComponent>
                              </TableCell>
                              <TableCell className="text-right">
                                -${otherVariableCosts.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalShopifySalesGross === 0 ? 0 : (otherVariableCosts / totalShopifySalesGross) * 100).toFixed(2)}%
                              </TableCell>
                              {showB2CStandardModel && (
                                <TableCell className="text-right text-gray-500">
                                  {getB2CStandardModelPercent('Other variable costs')}
                                </TableCell>
                              )}
                            </TableRow>
                          </>
                        )}
                        {costsSource === 'costs' && costsSnapshot && (
                          <>
                            <TableRow
                              className="cursor-pointer hover:bg-gray-50"
                              onClick={() => setExpandedB2CVariableCost(!expandedB2CVariableCost)}
                            >
                              <TableCell className="font-medium">
                                <div className="flex items-center gap-2">
                                  {expandedB2CVariableCost ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                  <span>Variable Cost</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                -${costsSnapshot.totals.variable.b2c.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalShopifySalesGross === 0 ? 0 : (costsSnapshot.totals.variable.b2c / totalShopifySalesGross) * 100).toFixed(2)}%
                              </TableCell>
                              {showB2CStandardModel && <TableCell></TableCell>}
                            </TableRow>
                            {expandedB2CVariableCost && costsSnapshot.items.filter(item => item.board === 'variable').map((item, idx) => (
                              <TableRow key={idx} className="bg-gray-50">
                                <TableCell className="pl-12 text-sm text-gray-600">{item.name}</TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  -${item.b2cAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                </TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  {(totalShopifySalesGross === 0 ? 0 : (item.b2cAmount / totalShopifySalesGross) * 100).toFixed(2)}%
                                </TableCell>
                                {showB2CStandardModel && <TableCell></TableCell>}
                              </TableRow>
                            ))}
                            <TableRow
                              className="cursor-pointer hover:bg-gray-50"
                              onClick={() => setExpandedB2CFixedCost(!expandedB2CFixedCost)}
                            >
                              <TableCell className="font-medium">
                                <div className="flex items-center gap-2">
                                  {expandedB2CFixedCost ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                  <span>Fixed Cost</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                -${costsSnapshot.totals.fixed.b2c.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalShopifySalesGross === 0 ? 0 : (costsSnapshot.totals.fixed.b2c / totalShopifySalesGross) * 100).toFixed(2)}%
                              </TableCell>
                              {showB2CStandardModel && <TableCell></TableCell>}
                            </TableRow>
                            {expandedB2CFixedCost && costsSnapshot.items.filter(item => item.board === 'fixed').map((item, idx) => (
                              <TableRow key={idx} className="bg-gray-50">
                                <TableCell className="pl-12 text-sm text-gray-600">{item.name}</TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  -${item.b2cAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                </TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  {(totalShopifySalesGross === 0 ? 0 : (item.b2cAmount / totalShopifySalesGross) * 100).toFixed(2)}%
                                </TableCell>
                                {showB2CStandardModel && <TableCell></TableCell>}
                              </TableRow>
                            ))}
                            {andreaExtraCosts && (
                              <>
                                <TableRow
                                  className="cursor-pointer hover:bg-gray-50"
                                  onClick={() => setExpandedB2CAndreaCost(!expandedB2CAndreaCost)}
                                >
                                  <TableCell className="font-medium">
                                    <div className="flex items-center gap-2">
                                      {expandedB2CAndreaCost ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                      <span>Andrea's costs</span>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right">
                                    -${costsSnapshot.totals.andrea.b2c.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {(totalShopifySalesGross === 0 ? 0 : (costsSnapshot.totals.andrea.b2c / totalShopifySalesGross) * 100).toFixed(2)}%
                                  </TableCell>
                                  {showB2CStandardModel && <TableCell></TableCell>}
                                </TableRow>
                                {expandedB2CAndreaCost && costsSnapshot.items.filter(item => item.board === 'andrea').map((item, idx) => (
                                  <TableRow key={idx} className="bg-gray-50">
                                    <TableCell className="pl-12 text-sm text-gray-600">{item.name}</TableCell>
                                    <TableCell className="text-right text-sm text-gray-600">
                                      -${item.b2cAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                    </TableCell>
                                    <TableCell className="text-right text-sm text-gray-600">
                                      {(totalShopifySalesGross === 0 ? 0 : (item.b2cAmount / totalShopifySalesGross) * 100).toFixed(2)}%
                                    </TableCell>
                                    {showB2CStandardModel && <TableCell></TableCell>}
                                  </TableRow>
                                ))}
                              </>
                            )}
                          </>
                        )}
                        <TableRow className="border-t-2 border-gray-300">
                          <TableCell colSpan={showB2CStandardModel ? 4 : 3}></TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="font-medium font-bold text-base">Estimated Revenue</TableCell>
                          <TableCell className="text-right font-bold text-base">
                            ${estimatedRevenue.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right font-bold text-base">
                            {(totalShopifySalesGross === 0 ? 0 : (estimatedRevenue / totalShopifySalesGross) * 100).toFixed(2)}%
                          </TableCell>
                          {showB2CStandardModel && (
                            <TableCell className="text-right font-bold text-base text-gray-500">
                              {getB2CStandardModelPercent('Estimated Revenue')}
                            </TableCell>
                          )}
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TooltipProvider>
                </CardContent>
              </Card>
              
              <Card className="flex-1">
                <CardHeader>
                  <CardTitle>Detailed Financials for B2B channel</CardTitle>
                  <CardDescription>Key financial metrics and costs for B2B</CardDescription>
                </CardHeader>
                <CardContent>
                  <TooltipProvider>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Metric</TableHead>
                          <TableHead className="text-right">Amount (AUD)</TableHead>
                          <TableHead className="text-right">Share %</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="font-medium">Total B2B Sales</TableCell>
                          <TableCell className="text-right">
                            ${totalB2BSalesMemo.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            100.00%
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell 
                            className="cursor-pointer hover:underline text-blue-600"
                            onClick={handleDownloadB2BCOGS}
                            title="Click to download detailed B2B COGS breakdown"
                          >
                            Total B2B COGS
                          </TableCell>
                          <TableCell className="text-right">
                            -${totalB2BCOGS.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {(totalB2BSalesMemo === 0 ? 0 : (totalB2BCOGS / totalB2BSalesMemo) * 100).toFixed(2)}%
                          </TableCell>
                        </TableRow>
                        {costsSource === 'estimations' && (
                          <>
                            <TableRow>
                              <TableCell className="font-medium">
                                <TooltipComponent>
                                  <TooltipTrigger asChild>
                                    <span className="cursor-help underline decoration-dotted">Fixed cost</span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>The daily fixed cost for B2B is 25% of total and is AUD 900</p>
                                    <a
                                      href="https://docs.google.com/spreadsheets/d/1sIox4oJn6L7uNPWwBIJFTnJKgzIx7Ll6vwbQsVTHRl4/edit?gid=483965303#gid=483965303"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 hover:text-blue-800 underline block mt-2"
                                    >
                                      View Details
                                    </a>
                                  </TooltipContent>
                                </TooltipComponent>
                              </TableCell>
                              <TableCell className="text-right">
                                -${fixedCostB2B.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalB2BSalesMemo === 0 ? 0 : (fixedCostB2B / totalB2BSalesMemo) * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell className="font-medium">Freight & Courier (B2B)</TableCell>
                              <TableCell className="text-right">
                                -${freightCourierB2B.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalB2BSalesMemo === 0 ? 0 : (freightCourierB2B / totalB2BSalesMemo) * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell className="font-medium">
                                <TooltipComponent>
                                  <TooltipTrigger asChild>
                                    <span className="cursor-help underline decoration-dotted">Other variable costs</span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Other variable costs for B2B channel including transaction fees and operational expenses.</p>
                                  </TooltipContent>
                                </TooltipComponent>
                              </TableCell>
                              <TableCell className="text-right">
                                -${otherVariableCostsB2B.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalB2BSalesMemo === 0 ? 0 : (otherVariableCostsB2B / totalB2BSalesMemo) * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                          </>
                        )}
                        {costsSource === 'costs' && costsSnapshot && (
                          <>
                            <TableRow
                              className="cursor-pointer hover:bg-gray-50"
                              onClick={() => setExpandedB2BVariableCost(!expandedB2BVariableCost)}
                            >
                              <TableCell className="font-medium">
                                <div className="flex items-center gap-2">
                                  {expandedB2BVariableCost ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                  <span>Variable Cost</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                -${costsSnapshot.totals.variable.b2b.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalB2BSalesMemo === 0 ? 0 : (costsSnapshot.totals.variable.b2b / totalB2BSalesMemo) * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                            {expandedB2BVariableCost && costsSnapshot.items.filter(item => item.board === 'variable').map((item, idx) => (
                              <TableRow key={idx} className="bg-gray-50">
                                <TableCell className="pl-12 text-sm text-gray-600">{item.name}</TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  -${item.b2bAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                </TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  {(totalB2BSalesMemo === 0 ? 0 : (item.b2bAmount / totalB2BSalesMemo) * 100).toFixed(2)}%
                                </TableCell>
                              </TableRow>
                            ))}
                            <TableRow
                              className="cursor-pointer hover:bg-gray-50"
                              onClick={() => setExpandedB2BFixedCost(!expandedB2BFixedCost)}
                            >
                              <TableCell className="font-medium">
                                <div className="flex items-center gap-2">
                                  {expandedB2BFixedCost ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                  <span>Fixed Cost</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                -${costsSnapshot.totals.fixed.b2b.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right">
                                {(totalB2BSalesMemo === 0 ? 0 : (costsSnapshot.totals.fixed.b2b / totalB2BSalesMemo) * 100).toFixed(2)}%
                              </TableCell>
                            </TableRow>
                            {expandedB2BFixedCost && costsSnapshot.items.filter(item => item.board === 'fixed').map((item, idx) => (
                              <TableRow key={idx} className="bg-gray-50">
                                <TableCell className="pl-12 text-sm text-gray-600">{item.name}</TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  -${item.b2bAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                </TableCell>
                                <TableCell className="text-right text-sm text-gray-600">
                                  {(totalB2BSalesMemo === 0 ? 0 : (item.b2bAmount / totalB2BSalesMemo) * 100).toFixed(2)}%
                                </TableCell>
                              </TableRow>
                            ))}
                            {andreaExtraCosts && (
                              <>
                                <TableRow
                                  className="cursor-pointer hover:bg-gray-50"
                                  onClick={() => setExpandedB2BAndreaCost(!expandedB2BAndreaCost)}
                                >
                                  <TableCell className="font-medium">
                                    <div className="flex items-center gap-2">
                                      {expandedB2BAndreaCost ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                      <span>Andrea's Cost</span>
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right">
                                    -${costsSnapshot.totals.andrea.b2b.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    {(totalB2BSalesMemo === 0 ? 0 : (costsSnapshot.totals.andrea.b2b / totalB2BSalesMemo) * 100).toFixed(2)}%
                                  </TableCell>
                                </TableRow>
                                {expandedB2BAndreaCost && costsSnapshot.items.filter(item => item.board === 'andrea').map((item, idx) => (
                                  <TableRow key={idx} className="bg-gray-50">
                                    <TableCell className="pl-12 text-sm text-gray-600">{item.name}</TableCell>
                                    <TableCell className="text-right text-sm text-gray-600">
                                      -${item.b2bAmount.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                                    </TableCell>
                                    <TableCell className="text-right text-sm text-gray-600">
                                      {(totalB2BSalesMemo === 0 ? 0 : (item.b2bAmount / totalB2BSalesMemo) * 100).toFixed(2)}%
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </>
                            )}
                          </>
                        )}
                        <TableRow>
                          <TableCell className="font-medium font-bold">Estimated Revenue</TableCell>
                          <TableCell className="text-right">
                            ${estimatedRevenueB2B.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {(totalB2BSalesMemo === 0 ? 0 : (estimatedRevenueB2B / totalB2BSalesMemo) * 100).toFixed(2)}%
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TooltipProvider>
                </CardContent>
              </Card>
            </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Sales Evolution modal */}
        <Dialog open={activeModal === 'sales-evolution'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Sales Evolution</DialogTitle>
            </DialogHeader>
            <div className="mt-4 space-y-4">
            <div className="flex items-center">
              <ModalDateRangePicker dateRange={dateRange} setDateRange={setDateRange} />
            </div>
            <SalesEvolutionContent
              unleashedData={unleashedData}
              shopifyData={shopifyData}
              oldShopifyData={oldShopifyData}
              startDate={dateRange.from ?? new Date('2025-01-01')}
              endDate={dateRange.to ?? new Date()}
            />
            </div>
          </DialogContent>
        </Dialog>

        {/* AIM modal */}
        <Dialog open={activeModal === 'aim'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>AIM - Inventory Reorder</DialogTitle>
            </DialogHeader>
            <div className="mt-4 space-y-4">
            <div className="flex items-center">
              <ModalDateRangePicker dateRange={dateRange} setDateRange={setDateRange} />
            </div>
            <InventoryReorderDashboard 
              startDate={dateRange.from ?? new Date()}
              endDate={dateRange.to ?? new Date()}
            />
            </div>
          </DialogContent>
        </Dialog>

        {/* AIM 2026 modal — overlay propio (no Radix Dialog).
            El dashboard abre sub-modales (Complete Projection, POBuilder)
            portaleados a document.body. Radix Dialog modal=true aplicaría
            body{pointer-events:none} + FocusScope + RemoveScroll que romperían
            esos sub-modales; modal=false alternativa dejaba click-outside-
            closes el dialog y artifacts al cerrar. Overlay propio = full
            screen, cierra solo con X / Escape, sin side-effects globales. */}
        <AIM2026Overlay
          open={activeModal === 'aim-2026'}
          onClose={() => setActiveModal(null)}
          dateRange={dateRange}
          setDateRange={setDateRange}
        />

        {/* B2C Sales Explorer — one SKU's Shopify sales over a chosen window.
            Same full-screen overlay shape as AIM 2026 rather than a Radix
            Dialog, so the date inputs and the search dropdown are not fighting
            a focus scope. */}
        {activeModal === 'b2c-explorer' && (
          <div className="fixed inset-0 z-50 bg-background overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 backdrop-blur px-6 py-3">
              <h1 className="text-base font-semibold tracking-tight">B2C Sales Explorer</h1>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveModal(null)}
                aria-label="Close"
                className="h-8 w-8 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-6">
              <B2CSalesExplorer />
            </div>
          </div>
        )}

        {/* Reports — op-manager reports container (FY Report, Freight, …) */}
        <ReportsOverlay
          open={activeModal === 'fy-report'}
          onClose={() => setActiveModal(null)}
        />

        {/* E-commerce modal (Shopify + Meta) */}
        <Dialog open={activeModal === 'ecommerce'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>E-commerce (Shopify + Meta)</DialogTitle>
              <DialogDescription>Orders, AOV and Meta Ads metrics</DialogDescription>
            </DialogHeader>
            <div className="mt-4">
              <EcommerceTab dateRange={dateRange} setDateRange={setDateRange} fxRate={fxRate} />
            </div>
          </DialogContent>
        </Dialog>

        {/* Web Upgrade performance modal */}
        <Dialog open={activeModal === 'web-upgrade'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader className="sr-only">
              <DialogTitle>Web Upgrade performance</DialogTitle>
            </DialogHeader>
            <WebUpgradeTab dateRange={dateRange} setDateRange={setDateRange} />
          </DialogContent>
        </Dialog>

        {/* Brand modal */}
        <Dialog open={activeModal === 'brand'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Sales by Product Group</DialogTitle>
            </DialogHeader>
            <div className="mt-4 space-y-4">
            <div className="flex items-center">
              <ModalDateRangePicker dateRange={dateRange} setDateRange={setDateRange} />
            </div>
            <Card>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Brand</TableHead>
                      <TableHead className="text-right">Total Sales (AUD)</TableHead>
                      <TableHead className="text-right">Share %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {brandAnalysis.map((brand) => (
                      <TableRow key={brand.brand}>
                        <TableCell className="font-medium">{brand.brand}</TableCell>
                        <TableCell className="text-right">${brand.totalSales.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</TableCell>
                        <TableCell className="text-right">
                          {totalOverallSalesAUDMemo > 0 
                            ? `${((brand.totalSales / totalOverallSalesAUDMemo) * 100).toFixed(2)}%`
                            : '0.00%'
                          }
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            </div>
          </DialogContent>
        </Dialog>

        {/* Top SKUs modal */}
        <Dialog open={activeModal === 'top-skus'} onOpenChange={(o) => !o && setActiveModal(null)}>
          <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Top SKUs Analysis</DialogTitle>
              <DialogDescription>Combined data from Unleashed (B2B/Korea/Web) and Shopify with cost analysis</DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
            <div className="flex items-center">
              <ModalDateRangePicker dateRange={dateRange} setDateRange={setDateRange} />
            </div>
                {/* Filters */}
                <div className="space-y-4">
                <div className="flex gap-4 items-center flex-wrap">
                  <div className="flex items-center space-x-4">
                    <Label>Channels:</Label>
                    {['Shopify', 'B2B', 'Korea', 'Web'].map((channel) => (
                      <div key={channel} className="flex items-center space-x-2">
                        <Checkbox
                          id={`sku-${channel}`}
                          checked={selectedSkuChannels.includes(channel)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedSkuChannels(prev => [...prev, channel]);
                            } else {
                              setSelectedSkuChannels(prev => prev.filter(c => c !== channel));
                            }
                          }}
                        />
                        <Label htmlFor={`sku-${channel}`}>{channel}</Label>
                      </div>
                    ))}
                  </div>
                  
                  <div className="flex items-center space-x-2">
                    <Label>Sort by:</Label>
                    <Select value={skuSortBy} onValueChange={setSkuSortBy}>
                      <SelectTrigger className="w-40 text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="revenue">Revenue (AUD)</SelectItem>
                        <SelectItem value="units">Units</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center space-x-2 flex-1 max-w-md">
                    <Label>Search:</Label>
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input
                        type="text"
                        placeholder="Search SKU..."
                        value={skuSearchTerm}
                        onChange={(e) => setSkuSearchTerm(e.target.value)}
                        className="pl-9 pr-9"
                      />
                      {skuSearchTerm && (
                        <button
                          onClick={() => setSkuSearchTerm('')}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  <Button
                    onClick={handleDownloadTopSkusCsv}
                    disabled={topSKUs.length === 0}
                    className="shrink-0"
                    title="Download Top SKUs as CSV"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download CSV
                  </Button>
                </div>

                {/* Search Results Info */}
                {skuSearchTerm.trim() && (
                  <div className="text-sm text-muted-foreground">
                    {topSKUs.length > 0 ? (
                      <span>Showing {topSKUs.length} result{topSKUs.length !== 1 ? 's' : ''} for "{skuSearchTerm}"</span>
                    ) : (
                      <span>No results found for "{skuSearchTerm}"</span>
                    )}
                  </div>
                )}

                {/* Results Table */}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                      <TableHead className="text-right">Revenue (AUD)</TableHead>
                      <TableHead className="text-right">Unit Cost (AUD)</TableHead>
                      <TableHead className="text-right">Margin %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topSKUs.map((row, index) => {
                      const isDownloading = downloadingSkus.has(row.sku);
                      return (
                        <TableRow key={`${row.sku}-${index}`}>
                          <TableCell className="font-medium">
                            <button
                              onClick={() => handleDownloadSkuDetails(row.sku)}
                              className={`text-blue-600 hover:text-blue-800 hover:underline cursor-pointer text-left ${isDownloading ? 'opacity-50' : ''}`}
                              title="Click to download detailed transactions"
                              disabled={isDownloading}
                            >
                              {isDownloading ? `${row.sku} (downloading...)` : row.sku}
                            </button>
                          </TableCell>
                          <TableCell className="text-right">{row.units.toLocaleString()}</TableCell>
                          <TableCell className="text-right">
                            ${row.revenue.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.unitCost ? `$${row.unitCost.toFixed(2)}` : 'N/A'}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.margin !== null ? `${row.margin.toFixed(2)}%` : 'N/A'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                
                {topSKUs.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No data available for the selected filters and date range.
                  </div>
                )}
                </div>
            </div>
          </DialogContent>
        </Dialog>
        </main>
      </div>
      </div>
    </div>
      
      {/* Configuration Dialog */}
      <Dialog open={isConfigOpen} onOpenChange={setIsConfigOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Financial Configuration</DialogTitle>
            <DialogDescription>
              Configure the financial parameters used in calculations
            </DialogDescription>
          </DialogHeader>
          <div className="border-b pb-4">
            <ConnectionsPanel />
          </div>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="shipping-cost" className="text-right">
                Shipping Cost %
              </Label>
              <Input
                id="shipping-cost"
                type="number"
                step="0.001"
                min="0"
                value={shippingCostPercent}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  if (!isNaN(value) && value >= 0) {
                    setShippingCostPercent(value);
                  }
                }}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="fixed-cost" className="text-right">
                B2C Fixed Cost Daily
              </Label>
              <Input
                id="fixed-cost"
                type="number"
                min="0"
                value={fixedCostDaily}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  if (!isNaN(value) && value >= 0) {
                    setFixedCostDaily(value);
                  }
                }}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="other-variable" className="text-right">
                B2C Other Variable %
              </Label>
              <Input
                id="other-variable"
                type="number"
                step="0.001"
                min="0"
                value={otherVariableCostPercent}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  if (!isNaN(value) && value >= 0) {
                    setOtherVariableCostPercent(value);
                  }
                }}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="b2b-fixed-cost" className="text-right">
                B2B Fixed Cost Daily
              </Label>
              <Input
                id="b2b-fixed-cost"
                type="number"
                min="0"
                value={fixedCostB2BDaily}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  if (!isNaN(value) && value >= 0) {
                    setFixedCostB2BDaily(value);
                  }
                }}
                className="col-span-3"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="b2b-other-variable" className="text-right">
                B2B Other Variable %
              </Label>
              <Input
                id="b2b-other-variable"
                type="number"
                step="0.001"
                min="0"
                value={otherVariableCostB2BPercent}
                onChange={(e) => {
                  const value = parseFloat(e.target.value);
                  if (!isNaN(value) && value >= 0) {
                    setOtherVariableCostB2BPercent(value);
                  }
                }}
                className="col-span-3"
              />
            </div>

            {/* Unleashed Integration Section */}
            <div className="pt-6 border-t border-gray-200">
              <div className="flex items-center gap-2 mb-4">
                <Link2 className="w-5 h-5 text-gray-700" />
                <h3 className="text-lg font-semibold text-gray-900">Unleashed Integration</h3>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Configure Unleashed API credentials
              </p>

              {/* Connection Status Banner */}
              {unleashedConnectionStatus && (
                <div className={cn(
                  "mb-4 p-3 rounded-lg flex items-start gap-2",
                  unleashedConnectionStatus.success
                    ? "bg-green-50 border border-green-200"
                    : "bg-red-50 border border-red-200"
                )}>
                  {unleashedConnectionStatus.success ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1">
                    <p className={cn(
                      "font-medium text-sm",
                      unleashedConnectionStatus.success ? "text-green-900" : "text-red-900"
                    )}>
                      {unleashedConnectionStatus.success ? "Connection Successful" : "Connection Failed"}
                    </p>
                    <p className={cn(
                      "text-sm mt-1",
                      unleashedConnectionStatus.success ? "text-green-700" : "text-red-700"
                    )}>
                      {unleashedConnectionStatus.message}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-4">
                {/* API ID Field */}
                <div className="space-y-2">
                  <Label htmlFor="unleashed-api-id" className="text-sm font-medium">
                    API ID
                  </Label>
                  <p className="text-xs text-gray-500">
                    (Found in Unleashed: Settings → Integration → API Access)
                  </p>
                  <Input
                    id="unleashed-api-id"
                    type="text"
                    placeholder="33e97171-1817-4655-b743-188e2e6ee9cb"
                    value={unleashedApiId}
                    onChange={(e) => setUnleashedApiId(e.target.value)}
                    className="w-full font-mono text-sm"
                  />
                </div>

                {/* API Key Field */}
                <div className="space-y-2">
                  <Label htmlFor="unleashed-api-key" className="text-sm font-medium">
                    API Key
                  </Label>
                  <p className="text-xs text-gray-500">
                    (Found in Unleashed: Settings → Integration → API Access)
                  </p>
                  <div className="relative">
                    <Input
                      id="unleashed-api-key"
                      type={showUnleashedApiKey ? "text" : "password"}
                      placeholder="Enter your API Key"
                      value={unleashedApiKey}
                      onChange={(e) => setUnleashedApiKey(e.target.value)}
                      className="w-full font-mono text-sm pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                      onClick={() => setShowUnleashedApiKey(!showUnleashedApiKey)}
                    >
                      {showUnleashedApiKey ? (
                        <EyeOff className="w-4 h-4 text-gray-500" />
                      ) : (
                        <Eye className="w-4 h-4 text-gray-500" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    onClick={handleSaveUnleashedCredentials}
                    disabled={isSavingCredentials || !unleashedApiId.trim() || !unleashedApiKey.trim()}
                    className="flex-1"
                  >
                    {isSavingCredentials ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save Credentials"
                    )}
                  </Button>
                  <Button
                    onClick={handleTestUnleashedConnection}
                    disabled={isTestingConnection || !unleashedApiId.trim() || !unleashedApiKey.trim()}
                    className="flex-1 bg-blue-600 hover:bg-blue-700"
                  >
                    {isTestingConnection ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Testing...
                      </>
                    ) : (
                      "Test Connection"
                    )}
                  </Button>
                </div>
              </div>
            </div>

            {/* E-commerce (Shopify + Meta) */}
            <div className="pt-6 border-t border-gray-200">
              <div className="flex items-center gap-2 mb-4">
                <ShoppingBag className="w-5 h-5 text-gray-700" />
                <h3 className="text-lg font-semibold text-gray-900">E-commerce (Shopify + Meta)</h3>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Credenciales para el tab E-commerce. Solo administradores pueden configurarlas.
              </p>
              {ecommerceCredsStatus && (
                <div className={cn(
                  "mb-4 p-3 rounded-lg flex items-start gap-2",
                  ecommerceCredsStatus.type === 'success' ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"
                )}>
                  {ecommerceCredsStatus.type === 'success' ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  )}
                  <p className={cn("text-sm", ecommerceCredsStatus.type === 'success' ? "text-green-800" : "text-red-800")}>
                    {ecommerceCredsStatus.message}
                  </p>
                </div>
              )}
              <div className="space-y-4">
                <div>
                  <Label className="text-sm font-medium">Shopify</Label>
                  <p className="text-xs text-gray-500 mb-1">Store URL (ej. mi-tienda.myshopify.com) · Admin API Access Token</p>
                  <div className="space-y-2 mt-1">
                    <Input
                      placeholder="mi-tienda.myshopify.com"
                      value={shopifyStoreUrl}
                      onChange={(e) => setShopifyStoreUrl(e.target.value)}
                    />
                    <Input
                      type="password"
                      placeholder="Admin API token"
                      value={shopifyAccessToken}
                      onChange={(e) => setShopifyAccessToken(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Meta Ads</Label>
                  <p className="text-xs text-gray-500 mb-1">Ad Account IDs (act_123,act_456) · Marketing API token</p>
                  <p className="text-xs text-amber-600 mb-1">
                    Para evitar bloqueos: usa un <strong>System User token</strong> (no expira). Business Manager → System Users → Generate token con ads_read. Orden de IDs: 1º = USA Market, 2º = Australia Market.
                  </p>
                  <div className="space-y-2 mt-1">
                    <Input
                      placeholder="act_123456789,act_987654321"
                      value={metaAdAccountIds}
                      onChange={(e) => setMetaAdAccountIds(e.target.value)}
                    />
                    <Input
                      type="password"
                      placeholder="Marketing API token"
                      value={metaAccessToken}
                      onChange={(e) => setMetaAccessToken(e.target.value)}
                    />
                  </div>
                </div>
                <Button
                  onClick={handleSaveEcommerceCredentials}
                  disabled={isSavingEcommerceCreds}
                >
                  {isSavingEcommerceCreds ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Guardar credenciales
                </Button>
                <div className="flex items-center gap-2 pt-2">
                  <Button
                    variant="outline"
                    onClick={handleLoadFromCsv}
                    disabled={isLoadingCsv}
                  >
                    {isLoadingCsv ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Load from CSV
                  </Button>
                  <span className="text-xs text-gray-500">Carga datos históricos desde bucket ecom</span>
                </div>
                {csvLoadStatus && (
                  <div className={cn(
                    "mt-2 p-3 rounded-lg flex items-start gap-2",
                    csvLoadStatus.type === 'success' ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"
                  )}>
                    {csvLoadStatus.type === 'success' ? (
                      <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    )}
                    <p className={cn("text-sm", csvLoadStatus.type === 'success' ? "text-green-800" : "text-red-800")}>
                      {csvLoadStatus.message}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Crear usuario (solo admin) */}
            <div className="pt-6 border-t border-gray-200">
              <div className="flex items-center gap-2 mb-4">
                <UserPlus className="w-5 h-5 text-gray-700" />
                <h3 className="text-lg font-semibold text-gray-900">Crear usuario</h3>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Solo administradores. Crea un usuario con email y contraseña. Podrá iniciar sesión de inmediato en dashboard2026.dolo.au
              </p>
              {inviteStatus && (
                <div className={cn(
                  "mb-4 p-3 rounded-lg flex items-start gap-2",
                  inviteStatus.type === 'success' ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"
                )}>
                  {inviteStatus.type === 'success' ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  )}
                  <p className={cn(
                    "text-sm",
                    inviteStatus.type === 'success' ? "text-green-800" : "text-red-800"
                  )}>
                    {inviteStatus.message}
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Input
                  type="email"
                  placeholder="nuevo@dolo.com.au"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full"
                />
                <Input
                  type="password"
                  placeholder="Contraseña (mín. 6 caracteres)"
                  value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  className="w-full"
                />
                <Button
                  onClick={handleInviteUser}
                  disabled={isInviting || !inviteEmail.trim() || !invitePassword || invitePassword.length < 6}
                >
                  {isInviting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Crear usuario'}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setIsConfigOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={handlePasswordDialogClose}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Acceso a Funciones Internas</DialogTitle>
            <DialogDescription>
              Ingresa la contraseña para acceder al dashboard de funciones internas de Mario.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="password" className="text-right">
                Contraseña
              </Label>
              <Input
                id="password"
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handlePasswordSubmit()}
                className="col-span-3"
              />
            </div>
            {passwordError && (
              <div className="text-red-600 text-sm text-center">
                {passwordError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handlePasswordDialogClose}>
              Cancelar
            </Button>
            <Button onClick={handlePasswordSubmit}>Acceder</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isCostsModalOpen} onOpenChange={setIsCostsModalOpen}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] h-[95vh] overflow-auto p-6">
          <DialogHeader>
            <DialogTitle className="text-2xl">Costs Analysis</DialogTitle>
            <Button
              variant="outline"
              size="sm"
              className="absolute right-4 top-4"
              onClick={() => setIsCostsModalOpen(false)}
            >
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </DialogHeader>
          <div className="mt-4">
            <CostsCanvas dateRange={dateRange} setDateRange={setDateRange} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default App;