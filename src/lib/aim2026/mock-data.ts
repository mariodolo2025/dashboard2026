import type { SKURow, KPISummary, StockValuationTotals, StockValuationHistoryRecord } from './types';

// ─── Mock SKU Data ───────────────────────────────────────────────────────────

const PRODUCTS: Partial<SKURow>[] = [
  { sku: 'PSD-puck', product: 'Pesado Puck Screen 58mm', productGroup: 'PESADO', sohMainWH: 12, sohChina: 450, projectedDemand: 280, marginPercent: 42.1, daysOfCover: 1.3, status: 'CRITICAL' },
  { sku: 'PSD-puck-54', product: 'Pesado Puck Screen 53.5mm', productGroup: 'PESADO', sohMainWH: 8, sohChina: 200, projectedDemand: 95, marginPercent: 41.8, daysOfCover: 2.5, status: 'CRITICAL' },
  { sku: 'AB3070-ClickTamper', product: 'Artisan Barista Lotus Click Tamper 58.3mm', productGroup: 'The Artisan Barista', sohMainWH: 62, sohChina: 0, projectedDemand: 110, marginPercent: 55.2, daysOfCover: 16.9, status: 'LOW STOCK' },
  { sku: 'PSD-HD-MV', product: 'High Diffusion Shower Screen E61', productGroup: 'PESADO', sohMainWH: 1881, sohChina: 0, projectedDemand: 320, marginPercent: 62.5, daysOfCover: 176.3, status: 'OK' },
  { sku: 'AB3070CD', product: 'Artisan Barista Distributor 58.3mm', productGroup: 'The Artisan Barista', sohMainWH: 39, sohChina: 506, projectedDemand: 85, marginPercent: 48.3, daysOfCover: 13.8, status: 'LOW STOCK' },
  { sku: 'EP-20g', product: 'IMS E61 Precision Basket 20g', productGroup: 'PESADO', sohMainWH: 340, sohChina: 120, projectedDemand: 150, marginPercent: 38.5, daysOfCover: 68.0, status: 'OK' },
  { sku: 'PSD-distributor', product: 'Pesado Distributor 58mm', productGroup: 'PESADO', sohMainWH: 215, sohChina: 300, projectedDemand: 70, marginPercent: 58.7, daysOfCover: 92.1, status: 'OK' },
  { sku: 'CA3070KT', product: 'Coffee Accessories Knock Tube', productGroup: 'Coffee Accessories', sohMainWH: 22, sohChina: 0, projectedDemand: 40, marginPercent: 35.2, daysOfCover: 16.5, status: 'LOW STOCK' },
  { sku: 'AB3070EK-BK', product: 'Artisan Barista 1lt Electric Kettle Black', productGroup: 'The Artisan Barista', sohMainWH: 0, sohChina: 62, projectedDemand: 25, marginPercent: 44.6, daysOfCover: 0, status: 'CRITICAL' },
  { sku: 'HG6333', product: 'Tiamo Cold Drip HG6333', productGroup: 'Tiamo Cold Drip', sohMainWH: 7, sohChina: 0, projectedDemand: 12, marginPercent: 32.1, daysOfCover: 17.5, status: 'LOW STOCK' },
  { sku: 'PSD-TampingStation', product: 'Pesado Tamping Station', productGroup: 'PESADO', sohMainWH: 180, sohChina: 50, projectedDemand: 45, marginPercent: 61.3, daysOfCover: 120, status: 'OK' },
  { sku: 'AB3070JRL-SS', product: 'Artisan Barista Milk Jug 600ml Stainless', productGroup: 'The Artisan Barista', sohMainWH: 95, sohChina: 200, projectedDemand: 55, marginPercent: 52.4, daysOfCover: 51.8, status: 'WARNING' },
  { sku: 'PSD-CeramicSet', product: 'Pesado Ceramic Cup Set', productGroup: 'PESADO', sohMainWH: 350, sohChina: 100, projectedDemand: 18, marginPercent: 65.0, daysOfCover: 583.3, status: 'OVERSTOCK' },
  { sku: 'EP-18g', product: 'IMS E61 Precision Basket 18g', productGroup: 'PESADO', sohMainWH: 280, sohChina: 100, projectedDemand: 120, marginPercent: 37.8, daysOfCover: 70.0, status: 'OK' },
  { sku: 'CA3070-grinderbrush', product: 'Coffee Accessories Grinder Brush', productGroup: 'Coffee Accessories', sohMainWH: 410, sohChina: 0, projectedDemand: 60, marginPercent: 72.1, daysOfCover: 205, status: 'OVERSTOCK' },
  { sku: 'AB3070MJ350TBK', product: 'Artisan Barista Milk Jug 350ml Black', productGroup: 'The Artisan Barista', sohMainWH: 45, sohChina: 150, projectedDemand: 35, marginPercent: 49.8, daysOfCover: 38.6, status: 'WARNING' },
  { sku: 'PSD-AD-SpringTamper', product: 'Pesado Adjustable Spring Tamper', productGroup: 'PESADO', sohMainWH: 120, sohChina: 80, projectedDemand: 42, marginPercent: 57.3, daysOfCover: 85.7, status: 'OK' },
  { sku: 'BWT-MG2PLUS', product: 'BWT Magnesium Mineralizer Filter', productGroup: 'BWT', sohMainWH: 55, sohChina: 0, projectedDemand: 30, marginPercent: 28.5, daysOfCover: 55.0, status: 'WARNING' },
  { sku: 'HG2713', product: 'Tiamo Cold Drip HG2713 Silver', productGroup: 'Tiamo Cold Drip', sohMainWH: 3, sohChina: 0, projectedDemand: 8, marginPercent: 40.2, daysOfCover: 11.3, status: 'LOW STOCK' },
  { sku: 'AB3070CD-53.5', product: 'Artisan Barista Distributor 53.5mm', productGroup: 'The Artisan Barista', sohMainWH: 278, sohChina: 0, projectedDemand: 50, marginPercent: 47.9, daysOfCover: 166.8, status: 'OK' },
];

function randomBetween(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateMockSKURows(): SKURow[] {
  return PRODUCTS.map((p) => {
    const projectedDemand = p.projectedDemand ?? randomBetween(5, 300);
    const sohMainWH = p.sohMainWH ?? Math.round(randomBetween(0, 500));
    const leadTimeDays = Math.round(randomBetween(30, 65));
    const avgDailyDemand = projectedDemand / 30;
    const safetyStock = Math.round(1.65 * (projectedDemand * 0.3) * Math.sqrt(leadTimeDays / 30));
    const reorderPoint = Math.round(avgDailyDemand * leadTimeDays + safetyStock);
    const suggestedQty = Math.max(0, Math.round(reorderPoint - sohMainWH));
    const productCostChina = randomBetween(2, 35);
    const landedCostAUD = Math.round(productCostChina * 1.21 * 1.54 * 100) / 100;
    const turnover = randomBetween(0.5, 12);
    const marginPercent = p.marginPercent ?? randomBetween(15, 70);
    const avgSellingPrice = Math.round((landedCostAUD / (1 - marginPercent / 100)) * 100) / 100;
    const gmroi = randomBetween(0.5, 8);
    const sohChinaVal = p.sohChina ?? Math.round(randomBetween(0, 200));
    const container = Math.round(randomBetween(0, 150));
    const dhl = Math.round(randomBetween(0, 50));
    const onProduction = Math.round(randomBetween(0, 300));
    const allocatedMainWHVal = Math.round(randomBetween(0, Math.min(sohMainWH, 100)));
    const availableMainWHVal = Math.max(0, sohMainWH - Math.round(randomBetween(0, Math.min(sohMainWH, 100))));
    const allocatedChinaVal = Math.round(randomBetween(0, Math.min(sohChinaVal, 100)));
    const availableChinaVal = Math.max(0, sohChinaVal - allocatedChinaVal);
    const targetStockLevel = reorderPoint + Math.round(safetyStock * 0.5);
    const pipeline = container + dhl + onProduction;

    return {
      sku: p.sku!,
      product: p.product!,
      productGroup: p.productGroup ?? 'Other',
      supplier: pickRandom(['Pesado Factory', 'Artisan Barista Co', 'Tiamo', 'BWT', 'IMS']),
      abcClass: projectedDemand > 100 ? 'A' : projectedDemand > 30 ? 'B' : 'C',
      sohMainWH,
      sohChina: sohChinaVal,
      container,
      dhl,
      onProduction,
      allocatedMainWH: allocatedMainWHVal,
      availableMainWH: availableMainWHVal,
      allocatedChina: allocatedChinaVal,
      availableChina: availableChinaVal,
      allocatedTotal: allocatedMainWHVal + allocatedChinaVal,
      projectedDemand,
      demandTrend: pickRandom(['up', 'down', 'stable'] as const),
      demandTrendPercent: randomBetween(-25, 40),
      reorderPoint,
      safetyStock,
      targetStockLevel,
      pipeline,
      suggestedQty,
      softSuggestedQty: suggestedQty,
      daysOfCover: p.daysOfCover ?? randomBetween(0, 200),
      turnover,
      turnoverTrend: pickRandom(['up', 'down', 'stable'] as const),
      marginPercent,
      gmroi,
      productCostChina,
      landedCostAUD,
      avgSellingPrice,
      status: p.status as SKURow['status'],
      stockoutRisk: p.status === 'CRITICAL' ? 'critical' : p.status === 'LOW STOCK' ? 'high' : p.status === 'WARNING' ? 'medium' : 'low',
      leadTimeDays,
      serviceLevelZ: 1.65,
      packSize: 1,
    };
  });
}

// ─── Mock KPI Summary ────────────────────────────────────────────────────────

export function generateMockKPISummary(): KPISummary {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10),
    value: 180000 + Math.random() * 40000,
  }));

  return {
    totalInventoryValueAUD: 218450,
    totalInventoryValueUSD: 141850,
    itemsAtRisk: 5,
    avgTurnover: 4.2,
    avgTurnoverTrend: 'up',
    avgGMROI: 3.8,
    avgMarginPercent: 47.3,
    avgMarginTrend: 'stable',
    avgDaysOfCover: 72,
    totalProducts: 20,
    lastSyncAt: new Date(Date.now() - 7200000).toISOString(),
    inventoryValueHistory: history,
  };
}

// ─── Mock Stock Valuation ────────────────────────────────────────────────────

export function generateMockValuation(): StockValuationTotals {
  return {
    mainWarehouse: 125400,
    china: 42300,
    container: 18700,
    dhl: 5200,
    onProduction: 22100,
    pesadoKorea: 4750,
    totalInventory: 218450,
  };
}

export function generateMockValuationHistory(): StockValuationHistoryRecord[] {
  return Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    snapshotDate: new Date(Date.now() - i * 7 * 86400000).toISOString().slice(0, 10),
    mainWarehouse: 120000 + Math.random() * 15000,
    china: 38000 + Math.random() * 10000,
    container: 15000 + Math.random() * 8000,
    dhl: 3000 + Math.random() * 5000,
    onProduction: 18000 + Math.random() * 8000,
    pesadoKorea: 3000 + Math.random() * 4000,
    totalInventory: 200000 + Math.random() * 40000,
  }));
}
