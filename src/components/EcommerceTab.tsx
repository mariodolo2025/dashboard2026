import { useState, useEffect, useCallback, useMemo } from 'react';
import { format, differenceInDays } from 'date-fns';
import { RefreshCw, ShoppingBag, DollarSign, TrendingUp, ExternalLink, Loader2, AlertTriangle, MousePointerClick, Eye, Calendar as CalendarIcon, Database, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { DateRangePresets } from '@/components/DateRangePresets';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';

interface ShopifyData {
  success: boolean;
  store_url?: string;
  period?: { from: string; to: string; days: number };
  orders?: number;
  total_revenue?: number;
  aov?: number;
  currency?: string;
  error?: string;
  configured?: boolean;
}

interface MetaAd {
  ad_id: string;
  ad_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases?: number;
  purchase_value?: number;
  permalink?: string;
  campaign_name?: string;
}

interface MetaAccount {
  account_id: string;
  spend: number;
  impressions: number;
  clicks: number;
  top_ads?: MetaAd[];
  top_ads_historical?: MetaAd[];
  top_ads_range?: MetaAd[];
}

interface MetaData {
  success: boolean;
  period?: { from: string; to: string; days: number };
  total_spend?: number;
  total_impressions?: number;
  total_clicks?: number;
  accounts?: MetaAccount[];
  error?: string;
  configured?: boolean;
}

interface DateRange {
  from?: Date;
  to?: Date;
}

interface EcommerceTabProps {
  days?: number;
  dateRange?: DateRange;
  setDateRange?: (range: DateRange) => void;
  fxRate?: number;
}

function toYMD(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

const FX_RATE_DEFAULT = 1.54;

function formatAUDWithUSD(usdValue: number, fxRate: number) {
  const aud = usdValue * fxRate;
  return (
    <>
      <span>${aud.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} AUD</span>
      <span className="text-[10px] text-muted-foreground block mt-0.5">
        (${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD)
      </span>
    </>
  );
}

export default function EcommerceTab({ days: propDays, dateRange, setDateRange, fxRate = FX_RATE_DEFAULT }: EcommerceTabProps) {
  const [shopify, setShopify] = useState<ShopifyData | null>(null);
  const [meta, setMeta] = useState<MetaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ status: string; records_synced?: Record<string, number>; errors?: string[]; duration_ms?: number } | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<'all' | 'usa' | 'australia'>('all');

  const days = propDays ?? (dateRange?.from && dateRange?.to
    ? Math.max(1, differenceInDays(dateRange.to, dateRange.from))
    : 30);

  const fromStr = dateRange?.from ? toYMD(dateRange.from) : null;
  const toStr = dateRange?.to ? toYMD(dateRange.to) : null;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!SUPABASE_URL) {
        setError('VITE_SUPABASE_URL is not configured in .env');
        setLoading(false);
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Session expired. Please sign in again.');
        setLoading(false);
        return;
      }

      const headers = { Authorization: `Bearer ${session.access_token}` };
      const params = new URLSearchParams();
      if (fromStr && toStr) {
        params.set('from', fromStr);
        params.set('to', toStr);
      } else {
        params.set('days', String(days));
      }
      params.set('market', selectedMarket);
      const qs = params.toString();

      let shopifyJson: ShopifyData = { success: false };
      let metaJson: MetaData = { success: false };

      // Try cache first (ecommerce-get-data)
      try {
        const cacheRes = await fetch(`${SUPABASE_URL}/functions/v1/ecommerce-get-data?${qs}`, { headers });
        const cacheData = await cacheRes.json();
        if (cacheData?.from_cache && (cacheData?.shopify?.success || cacheData?.meta?.success)) {
          shopifyJson = { ...cacheData.shopify, configured: true };
          metaJson = { ...cacheData.meta, configured: true };
          setShopify(shopifyJson);
          setMeta(metaJson);
        } else {
          throw new Error('Cache empty');
        }
      } catch {
        // Fallback: direct API calls in parallel
        const [shopifyRes, metaRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/functions/v1/shopify-orders?${qs}`, { headers }).then((r) => r.json()).catch((e) => {
            console.error('shopify-orders fetch failed:', e);
            return { success: false, error: 'Could not connect. Deploy: supabase functions deploy shopify-orders' } as ShopifyData;
          }),
          fetch(`${SUPABASE_URL}/functions/v1/meta-ads-insights?${qs}`, { headers }).then((r) => r.json()).catch((e) => {
            console.error('meta-ads-insights fetch failed:', e);
            return { success: false, error: 'Could not connect. Deploy: supabase functions deploy meta-ads-insights' } as MetaData;
          }),
        ]);
        shopifyJson = shopifyRes as ShopifyData;
        metaJson = metaRes as MetaData;
        setShopify(shopifyJson);
        setMeta(metaJson);
      }

      const bothFailed = !shopifyJson?.success && !metaJson?.success;
      if (bothFailed && (shopifyJson?.error || metaJson?.error)) {
        setError((shopifyJson?.error || metaJson?.error) ?? null);
      } else if (bothFailed) {
        setError('Could not load data. Configure credentials and run Sync, or deploy Edge Functions.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error loading';
      setError(msg === 'Failed to fetch'
        ? 'Network error. Verify Edge Functions are deployed.'
        : msg);
    } finally {
      setLoading(false);
    }
  }, [days, fromStr, toStr, selectedMarket]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token || !SUPABASE_URL) return;
      const headers = { Authorization: `Bearer ${session.access_token}` };
      const [shopifyRes, metaRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/functions/v1/ecommerce-sync-shopify`, { method: 'POST', headers }).then((r) => r.json()),
        fetch(`${SUPABASE_URL}/functions/v1/ecommerce-sync-meta`, { method: 'POST', headers }).then((r) => r.json()),
      ]);
      const shopifyData = shopifyRes as { status?: string; success?: boolean; records_synced?: Record<string, number>; errors?: string[]; duration_ms?: number };
      const metaData = metaRes as { status?: string; success?: boolean; records_synced?: Record<string, number>; errors?: string[]; duration_ms?: number };
      const recordsSynced: Record<string, number> = {
        shopify_days: (shopifyData.records_synced?.shopify_days ?? 0) + (metaData.records_synced?.shopify_days ?? 0),
        meta_days: (shopifyData.records_synced?.meta_days ?? 0) + (metaData.records_synced?.meta_days ?? 0),
        meta_top_ads: (shopifyData.records_synced?.meta_top_ads ?? 0) + (metaData.records_synced?.meta_top_ads ?? 0),
      };
      const allErrors = [...(shopifyData.errors ?? []), ...(metaData.errors ?? [])];
      const shopifyOk = shopifyData.success || shopifyData.status === 'success' || shopifyData.status === 'partial';
      const metaOk = metaData.success || metaData.status === 'success' || metaData.status === 'partial';
      const status = shopifyOk && metaOk ? 'success' : shopifyOk || metaOk ? 'partial' : 'failed';
      const durationMs = Math.max(shopifyData.duration_ms ?? 0, metaData.duration_ms ?? 0);
      setSyncResult({
        status,
        records_synced: recordsSynced,
        errors: allErrors.length > 0 ? allErrors : undefined,
        duration_ms: durationMs,
      });
      if (status === 'success' || status === 'partial') {
        await fetchData();
      }
    } catch (e) {
      setSyncResult({ status: 'failed', errors: [e instanceof Error ? e.message : 'Sync failed'] });
    } finally {
      setSyncing(false);
    }
  }, [fetchData]);

  const ACCOUNT_LABELS = ['USA Market', 'Australia Market'];
  const getAccountDisplayName = (accountId: string, index: number) =>
    ACCOUNT_LABELS[index] ?? accountId;

  // Filter Meta by market: account index 0 = USA, 1 = Australia (must be before conditional returns - hooks rule)
  const filteredMeta = useMemo(() => {
    if (!meta?.accounts?.length) return meta;
    if (selectedMarket === 'all') return meta;
    const idx = selectedMarket === 'usa' ? 0 : 1;
    const acc = meta.accounts[idx];
    if (!acc) return { ...meta, accounts: [], total_spend: 0, total_impressions: 0, total_clicks: 0 };
    return {
      ...meta,
      accounts: [acc],
      total_spend: acc.spend,
      total_impressions: acc.impressions,
      total_clicks: acc.clicks,
    };
  }, [meta, selectedMarket]);

  if (loading && !shopify && !meta) {
    return (
      <div className="flex items-center justify-center min-h-[200px] gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Loading E-commerce...</span>
      </div>
    );
  }

  const hasShopify = shopify?.success && shopify.configured !== false;
  const hasMeta = meta?.success && meta.configured !== false;
  const noData = !hasShopify && !hasMeta;

  if (noData && (shopify?.error || meta?.error || error)) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span>{error || shopify?.error || meta?.error || 'Configure credentials in Config'}</span>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const totalSales = shopify?.total_revenue ?? 0;
  const orders = shopify?.orders ?? 0;
  const amountSpend = filteredMeta?.total_spend ?? 0;
  const impressions = filteredMeta?.total_impressions ?? 0;
  const clicks = filteredMeta?.total_clicks ?? 0;

  const roi = amountSpend > 0 ? totalSales / amountSpend : null;
  const costPerOrder = orders > 0 ? amountSpend / orders : null;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;

  return (
    <div className="space-y-6">
      {meta?.error && !meta?.success && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Meta Ads: {meta.error}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={selectedMarket} onValueChange={(v) => setSelectedMarket(v as 'all' | 'usa' | 'australia')}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <Globe className="h-3.5 w-3.5 mr-1.5" />
              <SelectValue placeholder="Market" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All (USA + Australia)</SelectItem>
              <SelectItem value="usa">USA only</SelectItem>
              <SelectItem value="australia">Australia only</SelectItem>
            </SelectContent>
          </Select>
          {setDateRange && dateRange ? (
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen} modal>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 gap-1.5 text-xs font-medium",
                    !dateRange?.from && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateRange?.from && dateRange?.to
                    ? `${format(dateRange.from, 'MMM d, yyyy')} – ${format(dateRange.to, 'MMM d, yyyy')}`
                    : 'Date range'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start" side="bottom">
                <div className="flex">
                  <DateRangePresets onSelect={(r) => { setDateRange(r); setDatePickerOpen(false); }} />
                  <div>
                    <Calendar
                      initialFocus
                      mode="range"
                      defaultMonth={dateRange?.from}
                      selected={dateRange as never}
                      onSelect={(range) => setDateRange(range || {})}
                      numberOfMonths={2}
                      weekStartsOn={1}
                    />
                    <div className="p-2 border-t flex justify-end">
                      <Button size="sm" onClick={() => setDatePickerOpen(false)}>
                        Apply
                      </Button>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <p className="text-sm text-muted-foreground">
              {fromStr && toStr
                ? `${format(new Date(fromStr), 'MMM d, yyyy')} – ${format(new Date(toStr), 'MMM d, yyyy')}`
                : `Last ${days} days`}
            </p>
          )}
          {shopify?.period && (
            <span className="text-xs text-muted-foreground">
              ({shopify.period.from} – {shopify.period.to})
            </span>
          )}
          {selectedMarket !== 'all' && (
            <span className="text-xs text-muted-foreground">
              · {selectedMarket === 'usa' ? 'USA' : 'Australia'} only (Shopify + Meta)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={runSync} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            <span className="ml-2">Sync</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={fetchData} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </div>

      {syncResult && (
        <div className={cn(
          "rounded-lg border px-3 py-2 text-sm",
          syncResult.status === 'success'
            ? "border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800 text-green-800 dark:text-green-200"
            : syncResult.status === 'partial'
              ? "border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-800 dark:text-amber-200"
              : "border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 text-red-800 dark:text-red-200"
        )}>
          <span className="font-medium">Sync {syncResult.status}</span>
          {syncResult.records_synced && (
            <span className="ml-2">
              Shopify: {syncResult.records_synced.shopify_days ?? 0} days · Meta: {syncResult.records_synced.meta_days ?? 0} days · Top ads: {syncResult.records_synced.meta_top_ads ?? 0}
            </span>
          )}
          {syncResult.duration_ms != null && <span className="ml-2">({(syncResult.duration_ms / 1000).toFixed(1)}s)</span>}
          {syncResult.errors && syncResult.errors.length > 0 && (
            <div className="mt-1 text-xs">{syncResult.errors.join('; ')}</div>
          )}
        </div>
      )}

      {/* KPI Cards - Reference style */}
      <div className={cn(
        "grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6 transition-opacity",
        loading && "opacity-70 animate-pulse"
      )}>
        {hasMeta && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Amount spend</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAUDWithUSD(amountSpend, fxRate)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Meta Ads</p>
            </CardContent>
          </Card>
        )}
        {hasShopify && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total sales</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAUDWithUSD(totalSales, fxRate)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{shopify?.store_url}</p>
            </CardContent>
          </Card>
        )}
        {hasMeta && roi !== null && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">ROI / ROAS</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{roi.toFixed(2)}x</div>
              <p className="text-xs text-muted-foreground">Return on ad spend</p>
            </CardContent>
          </Card>
        )}
        {hasShopify && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Orders</CardTitle>
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{orders.toLocaleString()}</div>
              <p className="text-xs text-muted-foreground">Shopify</p>
            </CardContent>
          </Card>
        )}
        {hasMeta && costPerOrder !== null && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Cost per order (CPP)</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAUDWithUSD(costPerOrder, fxRate)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">CPP · Spend / Orders</p>
            </CardContent>
          </Card>
        )}
        {hasShopify && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg order value</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAUDWithUSD(shopify?.aov ?? 0, fxRate)}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Impressions & Clicks */}
      {hasMeta && (impressions > 0 || clicks > 0) && (
        <div className={cn(
          "grid gap-4 grid-cols-2 md:grid-cols-4 transition-opacity",
          loading && "opacity-70 animate-pulse"
        )}>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Impressions</CardTitle>
              <Eye className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{impressions.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Clicks</CardTitle>
              <MousePointerClick className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{clicks.toLocaleString()}</div>
            </CardContent>
          </Card>
          {ctr !== null && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">CTR</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{ctr.toFixed(2)}%</div>
                <p className="text-xs text-muted-foreground">Click-through rate</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Meta Ads by account - Clean table layout */}
      {hasMeta && filteredMeta?.accounts && filteredMeta.accounts.length > 0 && (
        <Card className={cn(
          "transition-opacity",
          loading && "opacity-70 animate-pulse"
        )}>
          <CardHeader>
            <CardTitle>Meta Ads by account</CardTitle>
            <CardDescription>Spend, Purchases, CPP, ROAS and Impressions per account</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {filteredMeta.accounts.map((acc, accIndex) => {
                const historicalAds = acc.top_ads_historical ?? acc.top_ads ?? [];
                const rangeAds = acc.top_ads_range ?? [];
                const displayIndex = selectedMarket === 'all' ? accIndex : (selectedMarket === 'usa' ? 0 : 1);
                return (
                <div key={acc.account_id} className="space-y-4">
                  <div className="font-medium text-sm">{getAccountDisplayName(acc.account_id, displayIndex)}</div>
                  <div className="flex gap-4 text-sm text-muted-foreground mb-3">
                    <span>Spend: ${(acc.spend * fxRate).toLocaleString('en-AU', { minimumFractionDigits: 2 })} AUD <span className="text-[10px]">(${acc.spend.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD)</span></span>
                    <span>Impressions: {acc.impressions.toLocaleString()}</span>
                    <span>Clicks: {acc.clicks.toLocaleString()}</span>
                  </div>

                  {/* Top 3 histórico - siempre visible */}
                  <div>
                    <div className="text-sm font-medium mb-2">Top 3 histórico</div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-8">#</TableHead>
                          <TableHead>Ad name</TableHead>
                          <TableHead>Campaign</TableHead>
                          <TableHead className="text-right">Spend</TableHead>
                          <TableHead className="text-right">Purchases</TableHead>
                          <TableHead className="text-right">CPP</TableHead>
                          <TableHead className="text-right">ROAS</TableHead>
                          <TableHead className="text-right">Impressions</TableHead>
                          <TableHead className="w-10"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historicalAds.length > 0 ? historicalAds.map((ad, i) => {
                          const purchases = ad.purchases ?? 0;
                          const purchaseVal = ad.purchase_value ?? 0;
                          const adCpp = purchases > 0 ? ad.spend / purchases : null;
                          const adRoas = ad.spend > 0 && purchaseVal > 0 ? purchaseVal / ad.spend : null;
                          return (
                            <TableRow key={`hist-${ad.ad_id}-${i}`}>
                              <TableCell className="font-medium">{i + 1}</TableCell>
                              <TableCell className="max-w-[200px] truncate">{ad.ad_name || 'Unnamed'}</TableCell>
                              <TableCell className="max-w-[150px] truncate text-muted-foreground">{ad.campaign_name || '–'}</TableCell>
                              <TableCell className="text-right">
                                <span>${(ad.spend * fxRate).toLocaleString('en-AU', { minimumFractionDigits: 2 })} AUD</span>
                                <span className="text-[10px] text-muted-foreground block">${ad.spend.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD</span>
                              </TableCell>
                              <TableCell className="text-right">{purchases > 0 ? purchases : '–'}</TableCell>
                              <TableCell className="text-right">{adCpp != null ? formatAUDWithUSD(adCpp, fxRate) : '–'}</TableCell>
                              <TableCell className="text-right">{adRoas != null ? `${adRoas.toFixed(2)}x` : '–'}</TableCell>
                              <TableCell className="text-right">{ad.impressions.toLocaleString()}</TableCell>
                              <TableCell>
                                {ad.permalink && (
                                  <a href={ad.permalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" title="Open in Ads Manager">
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </a>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        }) : (
                          <TableRow>
                            <TableCell colSpan={9} className="text-center text-muted-foreground py-4">
                              Sin datos. Ejecuta Load from CSV para cargar datos históricos.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Top 3 del período seleccionado */}
                  <div>
                    <div className="text-sm font-medium mb-2">Top 3 del período seleccionado</div>
                    {rangeAds.length > 0 ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8">#</TableHead>
                            <TableHead>Ad name</TableHead>
                            <TableHead>Campaign</TableHead>
                            <TableHead className="text-right">Spend</TableHead>
                            <TableHead className="text-right">Purchases</TableHead>
                            <TableHead className="text-right">CPP</TableHead>
                            <TableHead className="text-right">ROAS</TableHead>
                            <TableHead className="text-right">Impressions</TableHead>
                            <TableHead className="w-10"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rangeAds.map((ad, i) => {
                            const purchases = ad.purchases ?? 0;
                            const purchaseVal = ad.purchase_value ?? 0;
                            const adCpp = purchases > 0 ? ad.spend / purchases : null;
                            const adRoas = ad.spend > 0 && purchaseVal > 0 ? purchaseVal / ad.spend : null;
                            return (
                              <TableRow key={`range-${ad.ad_id}-${i}`}>
                                <TableCell className="font-medium">{i + 1}</TableCell>
                                <TableCell className="max-w-[200px] truncate">{ad.ad_name || 'Unnamed'}</TableCell>
                                <TableCell className="max-w-[150px] truncate text-muted-foreground">{ad.campaign_name || '–'}</TableCell>
                                <TableCell className="text-right">
                                  <span>${(ad.spend * fxRate).toLocaleString('en-AU', { minimumFractionDigits: 2 })} AUD</span>
                                  <span className="text-[10px] text-muted-foreground block">${ad.spend.toLocaleString('en-US', { minimumFractionDigits: 2 })} USD</span>
                                </TableCell>
                                <TableCell className="text-right">{purchases > 0 ? purchases : '–'}</TableCell>
                                <TableCell className="text-right">{adCpp != null ? formatAUDWithUSD(adCpp, fxRate) : '–'}</TableCell>
                                <TableCell className="text-right">{adRoas != null ? `${adRoas.toFixed(2)}x` : '–'}</TableCell>
                                <TableCell className="text-right">{ad.impressions.toLocaleString()}</TableCell>
                                <TableCell>
                                  {ad.permalink && (
                                    <a href={ad.permalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" title="Open in Ads Manager">
                                      <ExternalLink className="h-3.5 w-3.5" />
                                    </a>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    ) : (
                      <div className="text-sm text-muted-foreground py-2 border rounded-md px-3 bg-muted/30">
                        Sin datos en el período seleccionado
                      </div>
                    )}
                  </div>
                </div>
              );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {noData && !error && (
        <div className="text-center py-8 text-muted-foreground">
          <ShoppingBag className="h-12 w-12 mx-auto mb-2 opacity-50" />
          <p>Configure Shopify and Meta credentials in Config to view data.</p>
        </div>
      )}
    </div>
  );
}
