// =============================================================================
// FY Report — data loading and metric computation
//
// Reads the frozen fiscal-year snapshot (csv-files/fy2025-26/) through the
// same edge functions the live dashboard uses (parse-csv-data /
// parse-xero-costs with the optional `prefix` param), then computes the
// aggregates for the report views. Metric semantics mirror App.tsx so the
// report matches what the live dashboard shows for the same range:
//   - Shopify gross = net sales + taxes received + shipping received
//   - Unleashed channels exclude 'Shopify' / 'Shop sale' (double-count guard)
//   - COGS = unit cost (costs.csv) × quantity, per SKU
// =============================================================================

import { parseISO, isValid, format } from 'date-fns';
import {
  XeroData,
  CostsConfig,
  CostsSnapshot,
  computeCostsSnapshot,
} from '@/lib/costsCalculator';

export const FY_PREFIX = 'fy2025-26';
export const FY_LABEL = 'FY 2025–26';
export const FY_FROM = new Date(2025, 6, 1);   // Jul 1, 2025
export const FY_TO = new Date(2026, 5, 30);    // Jun 30, 2026
export const PRIOR_FY_FROM = new Date(2024, 6, 1);
export const PRIOR_FY_TO = new Date(2025, 5, 30);

// --- Raw row shapes (as returned by parse-csv-data, dates revived) -----------

export interface FYUnleashedRow {
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

export interface FYShopifyRow {
  date: Date;
  netSales: number;
  sku: string;
  quantity: number;
  region: string;
  taxes: number;
  shipping: number;
}

export interface FYOldShopifyRow {
  date: Date;
  netSales: number;
  region: string;
}

export interface FYMetaRow {
  date: Date;
  spend: number;
  conversionValue?: number;
}

export interface FYSnapshotData {
  unleashed: FYUnleashedRow[];
  shopify: FYShopifyRow[];
  oldShopify: FYOldShopifyRow[];
  meta: FYMetaRow[];
  costs: Map<string, number>;
  xero: XeroData | null;
  costsConfig: CostsConfig | null;
  // Inbound freight to AU (Container + DHL International + B2B related) summed
  // over the FY. Unleashed costs are China FOB, so landed COGS = COGS + this.
  inboundFreight: number;
}

// --- Loading ------------------------------------------------------------------

const reviveDate = (value: any): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = parseISO(String(value));
  return isValid(parsed) ? parsed : null;
};

export async function loadFYSnapshotData(): Promise<FYSnapshotData> {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const authHeaders = {
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
  };

  const [csvRes, xeroRes, configRes, freightRes] = await Promise.all([
    fetch(`${baseUrl}/functions/v1/parse-csv-data`, {
      method: 'POST',
      headers: authHeaders,
      // Ask from prior-FY start so YoY has FX coverage; rows are filtered
      // per-view on the client anyway.
      body: JSON.stringify({
        prefix: FY_PREFIX,
        startDate: format(PRIOR_FY_FROM, 'yyyy-MM-dd'),
        endDate: format(FY_TO, 'yyyy-MM-dd'),
      }),
    }),
    fetch(`${baseUrl}/functions/v1/parse-xero-costs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ prefix: FY_PREFIX }),
    }),
    // The frozen costs canvas config (fixed/variable/andrea boards) — the
    // bucket allows public read, so plain storage URL works.
    fetch(`${baseUrl}/storage/v1/object/public/csv-files/${FY_PREFIX}/costs-config-v1.json`),
    // Live freight split (the frozen path only has aggregate "Freight &
    // Courier"). We sum the FY months of the inbound buckets for landed COGS.
    // Best-effort: landed COGS just falls back to plain COGS if this fails.
    fetch(`${baseUrl}/functions/v1/parse-xero-costs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    }),
  ]);

  if (!csvRes.ok) throw new Error(`parse-csv-data failed: ${csvRes.status}`);
  const csv = await csvRes.json();
  if (csv.error) throw new Error(csv.details || csv.error);

  const unleashed: FYUnleashedRow[] = (csv.unleashed || [])
    .map((r: any) => ({ ...r, orderDate: reviveDate(r.orderDate) }))
    .filter((r: any) => r.orderDate);
  const shopify: FYShopifyRow[] = (csv.shopify || [])
    .map((r: any) => ({ ...r, date: reviveDate(r.date) }))
    .filter((r: any) => r.date);
  const oldShopify: FYOldShopifyRow[] = (csv.oldShopify || [])
    .map((r: any) => ({ ...r, date: reviveDate(r.date) }))
    .filter((r: any) => r.date);
  const meta: FYMetaRow[] = (csv.meta || [])
    .map((r: any) => ({ ...r, date: reviveDate(r.date) }))
    .filter((r: any) => r.date);

  const costs = new Map<string, number>();
  Object.entries(csv.costs || {}).forEach(([sku, cost]) => {
    costs.set(sku, cost as number);
  });

  let xero: XeroData | null = null;
  if (xeroRes.ok) {
    const parsed = await xeroRes.json();
    if (!parsed.error) xero = parsed as XeroData;
  }

  let costsConfig: CostsConfig | null = null;
  if (configRes.ok) {
    try {
      const raw = await configRes.json();
      // The stored file may be the config itself or wrapped in settings_json.
      costsConfig = (raw?.settings_json ?? raw) as CostsConfig;
    } catch {
      costsConfig = null;
    }
  }

  // Inbound freight (to AU) for the FY — sum the FY months of the inbound
  // freight buckets from the live split. Rolling window currently spans the FY;
  // if a future rolling window drops an FY month, that month's inbound is
  // omitted (a minor, closed-FY edge case).
  let inboundFreight = 0;
  if (freightRes.ok) {
    try {
      const fr = await freightRes.json();
      const months: { year: number; month: number }[] = fr.months ?? [];
      const fyIdx = months
        .map((m, i) => ({ i, ym: m.year * 100 + m.month }))
        .filter(({ ym }) => ym >= 202507 && ym <= 202606)
        .map(({ i }) => i);
      for (const it of fr.items ?? []) {
        if (typeof it.name === 'string' && it.name.startsWith('Freight & Courier') && it.name.includes('Inbound')) {
          for (const i of fyIdx) inboundFreight += Number(it.monthly?.[i]) || 0;
        }
      }
    } catch {
      inboundFreight = 0;
    }
  }

  return { unleashed, shopify, oldShopify, meta, costs, xero, costsConfig, inboundFreight };
}

// --- Metric computation --------------------------------------------------------

const dayNumber = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

const inRange = (d: Date, from: Date, to: Date) =>
  dayNumber(d) >= dayNumber(from) && dayNumber(d) <= dayNumber(to);

export interface FYChannelRow {
  channel: string;
  sales: number;
  share: number;
  priorSales: number | null;
  yoyPct: number | null;
}

export interface FYMonthPoint {
  key: string;       // "2025-07"
  label: string;     // "Jul 25"
  sales: number;
  b2cSales: number;  // B2C = Shopify net sales (to compare against Meta spend)
  metaSpend: number;
  roas: number | null;
  priorSales: number | null;
}

export interface FYSkuRow {
  sku: string;
  units: number;
  revenue: number;
  unitCost: number | null;
  marginPct: number | null;
}

export interface FYBrandRow {
  brand: string;
  sales: number;
  share: number;
}

export interface FYRegionRow {
  region: string;
  sales: number;
  share: number;
}

export interface FYMetrics {
  // CEO
  totalSales: number;
  priorTotalSales: number | null;
  priorCoverageNote: string | null;
  channels: FYChannelRow[];
  shopifyNet: number;
  shopifyGross: number;
  taxesReceived: number;
  shippingReceived: number;
  shopifyCOGS: number;
  b2bSales: number;
  b2bCOGS: number;
  grossMargin: number;          // totalSales − (shopifyCOGS + b2bCOGS)
  grossMarginPct: number | null;
  // Landed: Unleashed costs are China FOB, so landed COGS adds inbound freight.
  inboundFreight: number;
  landedCOGS: number;           // shopifyCOGS + b2bCOGS + inboundFreight
  landedGrossMargin: number;    // totalSales − landedCOGS
  landedGrossMarginPct: number | null;
  costsSnapshot: CostsSnapshot; // Xero fixed/variable/andrea for the FY
  operatingResult: number;      // grossMargin − xero(fixed+variable+andrea)
  metaSpend: number;
  metaConversionValue: number;
  blendedROAS: number | null;   // shopifyNet / metaSpend
  purchaseROAS: number | null;  // metaConversionValue / metaSpend
  months: FYMonthPoint[];
  brands: FYBrandRow[];
  topSkusByRevenue: FYSkuRow[];
  // Operations
  unitsByChannel: { channel: string; units: number }[];
  topSkusByUnits: FYSkuRow[];
  // Marketing
  regions: FYRegionRow[];
  metaShopifyRatio: number | null; // conversionValue / shopifyNet
}

const monthKeys = (from: Date, to: Date): { key: string; label: string }[] => {
  const out: { key: string; label: string }[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), 1);
  while (d <= to) {
    out.push({
      key: format(d, 'yyyy-MM'),
      label: format(d, 'MMM yy'),
    });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
};

export function computeFYMetrics(data: FYSnapshotData): FYMetrics {
  const from = FY_FROM;
  const to = FY_TO;

  const shopify = data.shopify.filter(r => inRange(r.date, from, to));
  const oldShopifyFY = data.oldShopify.filter(r => inRange(r.date, from, to));
  const unleashed = data.unleashed.filter(r => inRange(r.orderDate, from, to));
  const meta = data.meta.filter(r => inRange(r.date, from, to));

  // Prior FY (for YoY)
  const priorShopifyOld = data.oldShopify.filter(r => inRange(r.date, PRIOR_FY_FROM, PRIOR_FY_TO));
  const priorShopifyCur = data.shopify.filter(r => inRange(r.date, PRIOR_FY_FROM, PRIOR_FY_TO));
  const priorUnleashed = data.unleashed.filter(r => inRange(r.orderDate, PRIOR_FY_FROM, PRIOR_FY_TO));

  // --- Shopify financials (mirrors App.tsx) ---
  const shopifyNet =
    shopify.reduce((s, r) => s + r.netSales, 0) +
    oldShopifyFY.reduce((s, r) => s + r.netSales, 0);
  const taxesReceived = shopify.reduce((s, r) => s + (r.taxes || 0), 0);
  const shippingReceived = shopify.reduce((s, r) => s + (r.shipping || 0), 0);
  const shopifyGross = shopifyNet + taxesReceived + shippingReceived;

  const shopifyCOGS = shopify.reduce((s, r) => {
    const c = data.costs.get(r.sku);
    return c && c > 0 ? s + c * r.quantity : s;
  }, 0);

  // --- Channels (Unleashed minus Shopify/Shop sale/Web + Shopify gross) ---
  // "Web" (Unleashed online-sale customers) is online DTC and belongs to the
  // Shopify channel, so it's folded in rather than shown separately. Its value
  // is still counted — the total doesn't change, only the grouping.
  const webSales = unleashed.reduce((s, r) => r.channel === 'Web' ? s + r.subTotal : s, 0);
  const channelMap = new Map<string, number>();
  channelMap.set('Shopify', shopifyGross + webSales);
  unleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale' || r.channel === 'Web') return;
    channelMap.set(r.channel, (channelMap.get(r.channel) || 0) + r.subTotal);
  });
  const totalSales = Array.from(channelMap.values()).reduce((a, b) => a + b, 0);

  // Prior-FY channels
  const priorChannelMap = new Map<string, number>();
  const priorShopifyNet =
    priorShopifyOld.reduce((s, r) => s + r.netSales, 0) +
    priorShopifyCur.reduce((s, r) => s + r.netSales, 0) +
    priorShopifyCur.reduce((s, r) => s + (r.taxes || 0) + (r.shipping || 0), 0);
  const priorWebSales = priorUnleashed.reduce((s, r) => r.channel === 'Web' ? s + r.subTotal : s, 0);
  if (priorShopifyNet + priorWebSales > 0) priorChannelMap.set('Shopify', priorShopifyNet + priorWebSales);
  priorUnleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale' || r.channel === 'Web') return;
    priorChannelMap.set(r.channel, (priorChannelMap.get(r.channel) || 0) + r.subTotal);
  });
  const priorTotal = Array.from(priorChannelMap.values()).reduce((a, b) => a + b, 0);

  // Prior-FY data coverage note (sources may not span the whole prior year)
  let priorCoverageNote: string | null = null;
  const priorDates: Date[] = [
    ...priorShopifyOld.map(r => r.date),
    ...priorShopifyCur.map(r => r.date),
    ...priorUnleashed.map(r => r.orderDate),
  ];
  if (priorDates.length === 0) {
    priorCoverageNote = 'No prior-year data available';
  } else {
    let min = priorDates[0];
    let max = priorDates[0];
    priorDates.forEach(d => {
      if (d < min) min = d;
      if (d > max) max = d;
    });
    if (dayNumber(min) > dayNumber(PRIOR_FY_FROM) || dayNumber(max) < dayNumber(PRIOR_FY_TO)) {
      priorCoverageNote = `Prior-year data covers ${format(min, 'MMM d, yyyy')} – ${format(max, 'MMM d, yyyy')} (partial)`;
    }
  }

  const channels: FYChannelRow[] = Array.from(channelMap.entries())
    .map(([channel, sales]) => {
      const prior = priorChannelMap.get(channel) ?? null;
      return {
        channel,
        sales,
        share: totalSales > 0 ? (sales / totalSales) * 100 : 0,
        priorSales: prior,
        yoyPct: prior && prior > 0 ? ((sales - prior) / prior) * 100 : null,
      };
    })
    .sort((a, b) => b.sales - a.sales);

  // --- B2B ---
  const b2bRows = unleashed.filter(r => r.channel === 'B2B');
  const b2bSales = b2bRows.reduce((s, r) => s + r.subTotal, 0);
  const b2bCOGS = b2bRows.reduce((s, r) => {
    const c = data.costs.get(r.product);
    return c && c > 0 ? s + c * r.quantity : s;
  }, 0);

  const grossMargin = totalSales - shopifyCOGS - b2bCOGS;
  const grossMarginPct = totalSales > 0 ? (grossMargin / totalSales) * 100 : null;

  // Landed COGS: Unleashed unit costs are China FOB, so add inbound freight to
  // AU (Container + DHL International + B2B related) to get the true landed cost.
  const inboundFreight = data.inboundFreight || 0;
  const landedCOGS = shopifyCOGS + b2bCOGS + inboundFreight;
  const landedGrossMargin = totalSales - landedCOGS;
  const landedGrossMarginPct = totalSales > 0 ? (landedGrossMargin / totalSales) * 100 : null;

  // --- Xero costs for the FY (frozen canvas config) ---
  const costsSnapshot = computeCostsSnapshot(
    data.xero,
    { from, to },
    data.costsConfig ?? undefined
  );
  const xeroTotal =
    costsSnapshot.totals.fixed.b2c + costsSnapshot.totals.fixed.b2b +
    costsSnapshot.totals.variable.b2c + costsSnapshot.totals.variable.b2b +
    costsSnapshot.totals.andrea.b2c + costsSnapshot.totals.andrea.b2b;
  const operatingResult = grossMargin - xeroTotal;

  // --- Meta ---
  const metaSpend = meta.reduce((s, r) => s + r.spend, 0);
  const metaConversionValue = meta.reduce((s, r) => s + (r.conversionValue || 0), 0);
  const blendedROAS = metaSpend > 0 ? shopifyNet / metaSpend : null;
  const purchaseROAS = metaSpend > 0 ? metaConversionValue / metaSpend : null;

  // --- Monthly series ---
  const monthsBase = monthKeys(from, to);
  const salesByMonth = new Map<string, number>();
  const priorSalesByMonth = new Map<string, number>();
  const spendByMonth = new Map<string, number>();
  const netByMonth = new Map<string, number>();

  const addMonth = (map: Map<string, number>, d: Date, v: number) => {
    const k = format(d, 'yyyy-MM');
    map.set(k, (map.get(k) || 0) + v);
  };

  shopify.forEach(r => {
    addMonth(salesByMonth, r.date, r.netSales + (r.taxes || 0) + (r.shipping || 0));
    addMonth(netByMonth, r.date, r.netSales);
  });
  oldShopifyFY.forEach(r => {
    addMonth(salesByMonth, r.date, r.netSales);
    addMonth(netByMonth, r.date, r.netSales);
  });
  unleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale') return;
    addMonth(salesByMonth, r.orderDate, r.subTotal);
  });
  meta.forEach(r => addMonth(spendByMonth, r.date, r.spend));

  // Prior year, shifted forward 12 months so it aligns with the same FY month
  const shiftYear = (d: Date) => new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
  priorShopifyOld.forEach(r => addMonth(priorSalesByMonth, shiftYear(r.date), r.netSales));
  priorShopifyCur.forEach(r => addMonth(priorSalesByMonth, shiftYear(r.date), r.netSales + (r.taxes || 0) + (r.shipping || 0)));
  priorUnleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale') return;
    addMonth(priorSalesByMonth, shiftYear(r.orderDate), r.subTotal);
  });

  const months: FYMonthPoint[] = monthsBase.map(m => {
    const sales = salesByMonth.get(m.key) || 0;
    const spend = spendByMonth.get(m.key) || 0;
    const net = netByMonth.get(m.key) || 0;
    return {
      key: m.key,
      label: m.label,
      sales,
      b2cSales: net,
      metaSpend: spend,
      roas: spend > 0 ? net / spend : null,
      priorSales: priorSalesByMonth.has(m.key) ? priorSalesByMonth.get(m.key)! : null,
    };
  });

  // --- Brands (Unleashed brands + Shopify gross counted as Pesado, per App.tsx) ---
  const brandMap = new Map<string, number>();
  brandMap.set('Pesado', shopifyGross);
  unleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale') return;
    const brand = r.brand || 'Others';
    brandMap.set(brand, (brandMap.get(brand) || 0) + r.subTotal);
  });
  const brandTotal = Array.from(brandMap.values()).reduce((a, b) => a + b, 0);
  const brands: FYBrandRow[] = Array.from(brandMap.entries())
    .map(([brand, sales]) => ({
      brand,
      sales,
      share: brandTotal > 0 ? (sales / brandTotal) * 100 : 0,
    }))
    .sort((a, b) => b.sales - a.sales);

  // --- SKUs (Shopify + Unleashed non-Shopify channels) ---
  const skuMap = new Map<string, { units: number; revenue: number }>();
  const addSku = (sku: string, units: number, revenue: number) => {
    if (!sku) return;
    const cur = skuMap.get(sku) || { units: 0, revenue: 0 };
    skuMap.set(sku, { units: cur.units + units, revenue: cur.revenue + revenue });
  };
  shopify.forEach(r => addSku(r.sku, r.quantity, r.netSales));
  unleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale') return;
    addSku(r.product, r.quantity, r.subTotal);
  });

  const skuRows: FYSkuRow[] = Array.from(skuMap.entries()).map(([sku, v]) => {
    const unitCost = data.costs.get(sku) ?? null;
    const cogs = unitCost && unitCost > 0 ? unitCost * v.units : null;
    return {
      sku,
      units: v.units,
      revenue: v.revenue,
      unitCost,
      marginPct: cogs !== null && v.revenue > 0 ? ((v.revenue - cogs) / v.revenue) * 100 : null,
    };
  });

  const topSkusByRevenue = [...skuRows].sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  const topSkusByUnits = [...skuRows].sort((a, b) => b.units - a.units).slice(0, 15);

  // --- Units by channel ---
  const unitsMap = new Map<string, number>();
  const webUnits = unleashed.reduce((s, r) => r.channel === 'Web' ? s + r.quantity : s, 0);
  unitsMap.set('Shopify', shopify.reduce((s, r) => s + r.quantity, 0) + webUnits);
  unleashed.forEach(r => {
    if (r.channel === 'Shopify' || r.channel === 'Shop sale' || r.channel === 'Web') return;
    unitsMap.set(r.channel, (unitsMap.get(r.channel) || 0) + r.quantity);
  });
  const unitsByChannel = Array.from(unitsMap.entries())
    .map(([channel, units]) => ({ channel, units }))
    .sort((a, b) => b.units - a.units);

  // --- Shopify regions ---
  const regionMap = new Map<string, number>();
  shopify.forEach(r => {
    const region = r.region || 'Unknown';
    regionMap.set(region, (regionMap.get(region) || 0) + r.netSales);
  });
  const regionTotal = Array.from(regionMap.values()).reduce((a, b) => a + b, 0);
  const regions: FYRegionRow[] = Array.from(regionMap.entries())
    .map(([region, sales]) => ({
      region,
      sales,
      share: regionTotal > 0 ? (sales / regionTotal) * 100 : 0,
    }))
    .sort((a, b) => b.sales - a.sales);

  return {
    totalSales,
    priorTotalSales: priorTotal > 0 ? priorTotal : null,
    priorCoverageNote,
    channels,
    shopifyNet,
    shopifyGross,
    taxesReceived,
    shippingReceived,
    shopifyCOGS,
    b2bSales,
    b2bCOGS,
    grossMargin,
    grossMarginPct,
    inboundFreight,
    landedCOGS,
    landedGrossMargin,
    landedGrossMarginPct,
    costsSnapshot,
    operatingResult,
    metaSpend,
    metaConversionValue,
    blendedROAS,
    purchaseROAS,
    months,
    brands,
    topSkusByRevenue,
    unitsByChannel,
    topSkusByUnits,
    regions,
    metaShopifyRatio: shopifyNet > 0 ? (metaConversionValue / shopifyNet) * 100 : null,
  };
}

// --- Stock valuation (Operations view) -----------------------------------------

export interface FYStockValuation {
  opening: { date: string; total: number } | null;
  closing: { date: string; total: number } | null;
}

export async function loadFYStockValuation(): Promise<FYStockValuation> {
  try {
    const baseUrl = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const url = `${baseUrl}/functions/v1/get-stock-valuation-history?startDate=${format(FY_FROM, 'yyyy-MM-dd')}&endDate=${format(FY_TO, 'yyyy-MM-dd')}T23:59:59&limit=1000`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${anonKey}` },
    });
    if (!res.ok) return { opening: null, closing: null };
    const body = await res.json();
    const records: any[] = body.records || body.data || (Array.isArray(body) ? body : []);
    if (!records.length) return { opening: null, closing: null };

    const sorted = [...records].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    return {
      opening: { date: first.recorded_at, total: first.total_inventory },
      closing: { date: last.recorded_at, total: last.total_inventory },
    };
  } catch {
    return { opening: null, closing: null };
  }
}

// --- Operations extras (order volume + B2B payment + market split) -------------

export interface FYOpsExtras {
  shopifyOrders: {
    current: { orders: number; gross: number };
    prior: { orders: number; gross: number };
    ordersYoYPct: number | null;
    currentDaily: number;
    priorDaily: number;
    monthly: { label: string; orders: number }[];
  };
  b2bPayment: {
    invoices: number; customers: number; total: number;
    avg_days: number; median_days: number; dso_days: number;
    ontime_pct: number; late_pct: number;
  } | null;
  marketSplit: { au: number; international: number; us: number; other: number; total: number };
}

export async function loadFYOpsExtras(): Promise<FYOpsExtras | null> {
  try {
    const baseUrl = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const res = await fetch(`${baseUrl}/functions/v1/fy-ops-extras`, {
      headers: { Authorization: `Bearer ${anonKey}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.success ? (body as FYOpsExtras) : null;
  } catch {
    return null;
  }
}
