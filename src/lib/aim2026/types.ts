// =============================================================================
// AIM 2026 — Type Definitions
// =============================================================================

// ─── Status & Classification ─────────────────────────────────────────────────

export type StockStatus = 'CRITICAL' | 'LOW STOCK' | 'WARNING' | 'OK' | 'OVERSTOCK';
export type ABCClass = 'A' | 'B' | 'C';
export type TrendDirection = 'up' | 'down' | 'stable';
export type StockoutRisk = 'critical' | 'high' | 'medium' | 'low';
export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

// ─── KPI Summary ─────────────────────────────────────────────────────────────

export interface KPISummary {
  totalInventoryValueAUD: number;
  totalInventoryValueUSD: number;
  itemsAtRisk: number;
  avgTurnover: number;
  avgTurnoverTrend: TrendDirection;
  avgGMROI: number;
  avgMarginPercent: number;
  avgMarginTrend: TrendDirection;
  avgDaysOfCover: number;
  totalProducts: number;
  lastSyncAt: string | null;
  inventoryValueHistory: { date: string; value: number }[];
}

// ─── SKU Row (main table) ────────────────────────────────────────────────────

export interface SKURow {
  sku: string;
  product: string;
  productGroup: string;
  supplier: string;
  abcClass: ABCClass;
  // Stock
  sohMainWH: number;
  sohChina: number;
  // In-transit (toggle)
  container: number;
  dhl: number;
  onProduction: number;
  // Allocation (toggle)
  allocatedMainWH: number;
  availableMainWH: number;
  allocatedChina: number;
  availableChina: number;
  allocatedTotal: number;
  // Demand
  projectedDemand: number;
  demandTrend: TrendDirection;
  demandTrendPercent: number;
  // Channel split (loaded lazily when B2B/B2C split is toggled)
  demandB2b?: number;
  demandB2c?: number;
  // Reorder
  reorderPoint: number;
  safetyStock: number;
  targetStockLevel: number;
  pipeline: number;
  suggestedQty: number;
  softSuggestedQty: number;
  // Coverage
  daysOfCover: number;
  // Performance
  turnover: number;
  turnoverTrend: TrendDirection;
  marginPercent: number;
  gmroi: number;
  // Cost
  productCostChina: number;
  landedCostAUD: number;
  avgSellingPrice: number;
  // Status
  status: StockStatus;
  stockoutRisk: StockoutRisk;
  // Meta
  leadTimeDays: number;
  serviceLevelZ: number;
  /** Units per master carton. Used by Complete Projection's PO Builder to
   *  round suggested qty to the nearest multiple. Loaded from ProductList.csv
   *  'Pack Size' column. Default 1 = no rounding. */
  packSize: number;
}

// ─── SKU Detail (popup) ─────────────────────────────────────────────────────

export interface SKUDetail extends SKURow {
  demandHistory: { period: string; quantity: number; revenue: number }[];
  sohHistory: { date: string; mainWH: number; china: number }[];
  recentOrders: {
    orderNumber: string;
    orderDate: string;
    quantity: number;
    status: string;
    type: 'purchase' | 'sales';
  }[];
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export type DemandMode = 'realDemand' | 'estimatedDemandParked';

export const DEMAND_MODE_OPTIONS: { value: DemandMode; label: string }[] = [
  { value: 'realDemand', label: 'real demand' },
  { value: 'estimatedDemandParked', label: 'estimated demand (Parked status included)' },
];

export interface AIM2026Filters {
  search: string;
  abcClass: ABCClass | 'all';
  status: StockStatus | 'all';
  productGroup: string | 'all';
  supplier: string | 'all';
  showInTransit: boolean;
  showAllocation: boolean;
  showReorderDetail: boolean;
  hiddenColumns: string[];
  demandMode: DemandMode;
}

export const DEFAULT_FILTERS: AIM2026Filters = {
  search: '',
  abcClass: 'all',
  status: 'all',
  productGroup: 'all',
  supplier: 'all',
  showInTransit: false,
  showAllocation: false,
  showReorderDetail: false,
  hiddenColumns: [],
  demandMode: 'realDemand',
};

/** Columns that can be individually toggled in the main table */
export const TOGGLEABLE_COLUMNS: { key: string; label: string }[] = [
  { key: 'abcClass', label: 'ABC' },
  { key: 'sohMainWH', label: 'SOH Main' },
  { key: 'sohChina', label: 'SOH China' },
  { key: 'projectedDemand', label: 'Demand' },
  { key: 'reorderPoint', label: 'ROP' },
  { key: 'suggestedQty', label: 'Sug. Qty' },
  { key: 'daysOfCover', label: 'Cover' },
  { key: 'turnover', label: 'Turnover' },
  { key: 'marginPercent', label: 'Margin' },
  { key: 'gmroi', label: 'GMROI' },
  { key: 'status', label: 'Status' },
];

// ─── Config ──────────────────────────────────────────────────────────────────

export interface LandedCostRates {
  freightRate: number;
  dutyRate: number;
  insuranceRate: number;
}

export interface LandedCostConfig {
  default: LandedCostRates;
  byGroup: Record<string, LandedCostRates>;
}

export interface HoldingCostConfig {
  warehouseItems: string[]; // item names from CostsCanvas tagged as warehouse
  capitalRatePercent: number; // default 10
  riskRatePercent: number; // default 4
}

export interface AIM2026Config {
  landedCost: LandedCostConfig;
  holdingCost: HoldingCostConfig;
  defaultLeadTimeDays: number;
  defaultServiceLevelZ: number;
  exchangeRateUSDToAUD: number;
  landedCostNotes: string;
  /** Custom prompt for AI Insights. Use {{SKU_DATA}}, {{PORTFOLIO_SUMMARY}}, {{ASSEMBLED_NOTE}}, {{EXCLUDED_NOTE}} as placeholders. Empty = use default. */
  aiInsightsPrompt?: string;
  /** SKUs or product names to exclude from AI analysis (e.g. "Courier Fee" - not a real product). Comma-separated. */
  aiInsightsExcludedSKUs?: string;
}

export const DEFAULT_LANDED_COST_NOTES = `FY 2025-26 (1 Jul 2025 to date):
• FOB Purchase Value: AUD 1,520,000 (from PESADO PAYMENT files, China supplier invoices)
• Freight Cost: AUD 90,000 (sea containers China→AU + DHL express restocking shipments)
• Insurance Cost: AUD 20,000 (cargo insurance)
• Duty Rate: 5% (disbursement costs from Xero invoices)

Calculated rates:
→ Freight Rate = 90,000 / 1,520,000 = 5.92%
→ Insurance Rate = 20,000 / 1,520,000 = 1.32%
→ Duty Rate = 5.00% (fixed)

Formula: Landed Cost AUD = Product Cost (China AUD) × (1 + Freight + Duty + Insurance)`;

/** Default AI Insights prompt. Shown in Settings when empty. Placeholders: {{SKU_DATA}}, {{PORTFOLIO_SUMMARY}}, {{ASSEMBLED_NOTE}}, {{EXCLUDED_NOTE}} */
export const DEFAULT_AI_INSIGHTS_PROMPT = `You are an expert inventory analyst for a consumer products company (Pesado Coffee accessories). Analyze the following inventory KPI data and provide 3-5 actionable insights.
{{ASSEMBLED_NOTE}}
{{EXCLUDED_NOTE}}

PORTFOLIO SUMMARY:
{{PORTFOLIO_SUMMARY}}

SKU DATA (format: SKU|ABC|SOH|Demand|Cover|ROP|SugQty|Pipeline|Status|Margin|GMROI|Turnover|Trend|LeadTime|Cost|LandedCost|AvgSellingPrice|Assembled):
{{SKU_DATA}}

Respond ONLY with a valid JSON array of insight objects. Each insight must have:
- "category": one of "inventory", "demand", "financial", "action"
- "severity": one of "critical", "warning", "info", "positive"
- "title": short headline (max 8 words)
- "description": 2-3 sentences with specific SKU codes, numbers, and recommended actions. Be specific and data-driven.
- "confidence": number 75-99 representing how confident you are
- "actionLabel": short button label for the recommended action (e.g. "Restock Now", "Review Pricing", "Reduce Stock")
- "relatedSKUs": array of up to 3 most relevant SKU codes (or more for missing-price / bundle lists)

Focus on:
1. Urgent stockout risks (CRITICAL/LOW STOCK items, especially ABC class A). CRITICAL: Do NOT flag assembled products (Assembled:Y) as stockout or restock based on SOH alone—they get stock from components. Never recommend "Emergency Restock" for assembled SKUs.
2. Overstock situations tying up capital
3. Margin or GMROI anomalies
4. Demand trend changes that need attention
5. Specific reorder recommendations
6. **MISSING SELLING PRICE**: Identify products with HIGH demand that have ASP:0 or no selling price. Include full list in relatedSKUs and description.
7. Premium bundles or products with zero revenue that need pricing/visibility checks

Be concise, specific with numbers, and prioritize by business impact. Output ONLY the JSON array, no other text.`;

export const DEFAULT_CONFIG: AIM2026Config = {
  landedCost: {
    default: { freightRate: 0.0592, dutyRate: 0.05, insuranceRate: 0.0132 },
    byGroup: {},
  },
  holdingCost: {
    warehouseItems: [],
    capitalRatePercent: 10,
    riskRatePercent: 4,
  },
  defaultLeadTimeDays: 45,
  defaultServiceLevelZ: 1.65,
  exchangeRateUSDToAUD: 1.54,
  landedCostNotes: DEFAULT_LANDED_COST_NOTES,
  aiInsightsPrompt: '',
  aiInsightsExcludedSKUs: 'Courier Fee',
};

// ─── Sync ────────────────────────────────────────────────────────────────────

export interface SyncProgress {
  status: SyncStatus;
  currentStep: string;
  progress: number; // 0-100
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SyncLogEntry {
  id: string;
  syncedAt: string;
  status: 'success' | 'partial' | 'failed';
  recordsSynced: {
    sales: number;
    soh: number;
    purchase: number;
    production: number;
    products: number;
  };
  errors: string[];
  durationMs: number;
}

// ─── Stock Valuation ─────────────────────────────────────────────────────────

export interface StockValuationTotals {
  mainWarehouse: number;
  china: number;
  container: number;
  dhl: number;
  onProduction: number;
  pesadoKorea: number;
  totalInventory: number;
}

export interface StockValuationHistoryRecord {
  id: number;
  snapshotDate: string;
  mainWarehouse: number;
  china: number;
  container: number;
  dhl: number;
  onProduction: number;
  pesadoKorea: number;
  totalInventory: number;
}

// ─── AI Insights ────────────────────────────────────────────────────────────

export type InsightCategory = 'inventory' | 'demand' | 'financial' | 'action';
export type InsightSeverity = 'critical' | 'warning' | 'info' | 'positive';

export interface InsightCard {
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;
  description: string;
  confidence: number;
  actionLabel?: string;
  relatedSKUs?: string[];
}

export interface AIInsightsResponse {
  success: boolean;
  insights: InsightCard[];
  generatedAt: string;
  model: string;
  skuCount: number;
  message?: string;
}

// ─── Purchase Order Builder ─────────────────────────────────────────────────

export type POType = 'Container' | 'Production';

export interface POBuilderItem {
  sku: string;
  product: string;
  quantity: number;
  suggestedQty: number;
  unitPrice: number;       // productCostChina
  /** Cart bucket. Same SKU can coexist as two items, one per poType. Key of
   *  identity for add/update/remove handlers is (sku, poType). */
  poType: POType;
  /** ISO date (yyyy-mm-dd). Container only: la projectionDate del modal al
   *  agregarse. Se usa al hacer Create PO para calcular DeliveryDate =
   *  projectionDate + 30d (transit). Si hay varios items con fechas distintas,
   *  se usa max() — un container = una fecha. */
  projectionDate?: string;
}

export interface CreatePORequest {
  items: Array<{
    productCode: string;
    orderQuantity: number;
    unitPrice: number;
  }>;
  supplierCode: string;
  warehouseCode: string;
  customOrderStatus: string;  // e.g. "Production", "Container", "DHL-Inbounds"
}

export interface CreatePOResponse {
  success: boolean;
  orderNumber?: string;
  orderGuid?: string;
  message: string;
}

// ─── KPI Tooltip Descriptions ────────────────────────────────────────────────

export const KPI_DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  sohMainWH: {
    title: 'SOH Main WH',
    description: 'Stock on Hand in the Main Warehouse (Australia). Physical units currently available on shelves.',
  },
  sohChina: {
    title: 'SOH China',
    description: 'Stock on Hand in the China Warehouse. Units produced and ready to ship to Australia.',
  },
  projectedDemand: {
    title: 'Projected Demand',
    description: 'Average monthly demand based on Completed + Placed + Backordered sales, plus component usage. Parked sales are included only when the Demand mode is set to "estimated demand (Parked status included)". Click for history chart.',
  },
  reorderPoint: {
    title: 'Reorder Point',
    description: 'Stock level that triggers a reorder. Formula: (Avg Daily Demand × Lead Time) + Safety Stock. When SOH drops below this, a purchase order should be placed.',
  },
  suggestedQty: {
    title: 'Suggested Qty',
    description: 'Order quantity to bring stock up to the Target Stock Level, accounting for pipeline inventory (Container + DHL + On Production). Formula: max(0, Target − SOH − Pipeline). Blue = SOH ≤ ROP (urgent). Yellow/Amber = SOH between ROP and 1.5× ROP (approaching reorder).',
  },
  daysOfCover: {
    title: 'Days of Cover',
    description: 'Number of days current Main WH stock will last at the current demand rate. Red < 30, Yellow < 60, Green ≥ 60.',
  },
  turnover: {
    title: 'Turnover',
    description: 'How many times per YEAR the current inventory is sold and replaced (annualized). Formula: (Avg Monthly Demand in units × 12 × Landed Cost per unit in AUD) ÷ (Current SOH Main WH in units × Landed Cost per unit in AUD). Example: if a SKU sells ~2200 units/month and you have 2800 in stock at AUD 11.22 each → Annual COGS = 2200×12×11.22 = AUD 296K, Inventory Value = 2800×11.22 = AUD 31.4K → Turnover = 296K/31.4K = 9.4× per year. Target: 4-8× is healthy.',
  },
  marginPercent: {
    title: 'Margin %',
    description: 'Gross profit margin: (Avg Selling Price − Landed Cost) ÷ Avg Selling Price × 100.',
  },
  gmroi: {
    title: 'GMROI',
    description: 'Gross Margin Return on Investment: annual gross profit per AUD invested in this SKU\'s inventory. Formula: (Avg Monthly Demand × 12 × (Avg Selling Price − Landed Cost)) ÷ (Current SOH Main WH × Landed Cost). Example: SKU sells 2200/month at AUD 70.90, landed cost AUD 11.22 → Annual Margin = 2200×12×(70.90−11.22) = AUD 1.57M, Inventory = 2800×11.22 = AUD 31.4K → GMROI = 50.1. Values >100 indicate extremely low stock relative to sales volume. Target: > 3.0.',
  },
  abcClass: {
    title: 'ABC Class',
    description: 'Revenue-based classification. A = top 80% of total revenue, B = next 15%, C = bottom 5%. Focus efforts on A items.',
  },
  status: {
    title: 'Status',
    description: 'Stock health: CRITICAL (< 7 days), LOW STOCK (< 30), WARNING (< 60), OK (≥ 60), OVERSTOCK (> 180 days of cover).',
  },
  container: {
    title: 'Container',
    description: 'Units in transit via sea freight to Australia. Typically 4-6 weeks delivery.',
  },
  dhl: {
    title: 'DHL',
    description: 'Units in transit via express courier (DHL) to Australia. Typically 5-7 business days.',
  },
  onProduction: {
    title: 'On Production',
    description: 'Units currently being manufactured in China. Not yet shipped.',
  },
  allocatedMainWH: {
    title: 'Allocated (All Warehouses)',
    description: 'Total units reserved for pending sales orders across ALL warehouses (Main WH, China, Korea, etc.).',
  },
  availableMainWH: {
    title: 'Available Main WH',
    description: 'Truly available units: SOH Main WH minus Allocated. This is what you can actually sell.',
  },
  stockoutRisk: {
    title: 'Stockout Risk',
    description: 'Risk assessment: Critical (below safety stock), High (below reorder point), Medium (cover < 1.5× lead time), Low.',
  },
  targetStockLevel: {
    title: 'Target Stock',
    description: 'Order-up-to level: the quantity we want AFTER receiving the order. Formula: ROP + (Avg Daily Demand × Lead Time). Covers two lead time cycles + safety stock.',
  },
  pipeline: {
    title: 'Pipeline',
    description: 'Total in-transit / on-order stock that will arrive: Container + DHL + On Production. Subtracted from the order quantity to avoid over-ordering.',
  },
  safetyStock: {
    title: 'Safety Stock',
    description: 'Buffer stock to protect against demand variability. Formula: Z × σ × √(Lead Time / 30), where Z is the service level factor.',
  },
  leadTimeDays: {
    title: 'Lead Time',
    description: 'Supplier lead time in days: production + shipping time. Loaded from ProductList.csv or Unleashed sync.',
  },
};

// ─── Future Projected Demand Report ─────────────────────────────────────────

/**
 * Risk levels for the coverage waterfall report.
 *   SAFE           → full chain covers the target date (no gap)
 *   ORDER_REQUIRED → gap exists but orderDeadline is today or later (can still act)
 *   CRITICAL       → gap exists and orderDeadline has already passed (too late)
 */
export type RiskLevel = 'SAFE' | 'ORDER_REQUIRED' | 'CRITICAL';

/** A single supply source in the coverage timeline. */
export interface CoverageSegment {
  source: 'MAIN' | 'CHINA' | 'DHL' | 'CONTAINER' | 'PRODUCTION';
  label: string;
  units: number;
  /** Estimated day (from today) when this supply physically arrives at Main WH */
  arrivalDay: number;
  /**
   * Day when actual draw-down of this source begins (previous tier exhausted).
   *   - Main: 0
   *   - DHL: mainStockoutDay  (arrives day 7, consumed from mainStockoutDay)
   *   - Container: mainAndDhlStockoutDay
   *   - China: tier1StockoutDay  (bar starts earlier at arrivalDay for visual overlap)
   *   - Production: combinedStockoutDay, or tier1StockoutDay if co-shipped with China
   */
  consumptionStartDay: number;
  /**
   * Day when the transit period begins on the shared timeline.
   *   - Main: 0 (no transit)
   *   - DHL/Container: 0 (already in transit from today, no action needed)
   *   - China: chinaOrderDeadlineDay (transit starts when you place the order)
   *   - Production: productionReadyDay (transit starts when production is complete in China)
   */
  transitStartDay: number;
  /** How many days this source alone would cover demand (units / dailyDemand) */
  coveragePotentialDays: number;
  /** = arrivalDay (start of coverage window on the timeline) */
  fromDay: number;
  /** = consumptionStartDay + coveragePotentialDays (end of coverage window) */
  toDay: number;
  fromDate: Date;
  toDate: Date;
  /** For CHINA / PRODUCTION: latest date to place the DHL order */
  orderDeadline?: Date;
  /** True for sources already in transit (DHL, Container) — no action needed */
  isAutomatic: boolean;
  /**
   * True when this PRODUCTION segment ships in the SAME DHL order as the China WH segment.
   * It arrives at the same arrivalDay as China, not as a separate later wave.
   */
  coShippedWithChina: boolean;
}

/** One point in the waterfall stock chart (for the Stock Curve tab). */
export interface TimelinePoint {
  date: Date;
  stock: number;
  event?: 'STOCKOUT' | 'DHL_ARRIVAL' | 'CONTAINER_ARRIVAL' | 'PRODUCTION_ARRIVAL' | 'CHINA_ARRIVAL';
}

export interface SKUProjection {
  sku: string;
  product: string;
  abcClass: ABCClass;
  dailyDemand: number;

  // Main-only stockout (ignoring all pipeline) — shows urgency without action
  daysToStockout: number | null;
  stockoutDate: Date | null;

  // Coverage chain (arrival-time based, for swimlane visualization)
  coverageChain: CoverageSegment[];
  /** Last day of combined coverage (combined stockout day, or daysToTarget if fully covered) */
  totalCoveredDays: number;
  /** Day when Tier-1 auto supply (Main + DHL + Container) runs out; null = never within target */
  tier1StockoutDay: number | null;
  /** Day index when combined supply (with China ordered) runs out; null = no stockout */
  combinedStockoutDay: number | null;
  /** Latest date to order China WH via DHL to arrive before Tier-1 stockout */
  chinaOrderDeadline: Date | null;
  /**
   * True when production units will be ready in China before the China DHL order departs,
   * meaning they are included in the China shipment (china effective units = sohChina + onProduction).
   */
  productionIncludedInChina: boolean;

  // Gap analysis
  gapDays: number;
  gapUnits: number;
  /** Latest date to order the gap quantity via DHL to arrive before supply runs out */
  orderDeadline: Date | null;

  // Order recommendation
  requiredUnits: number;
  recommendedOrder: number;   // requiredUnits × 1.1 buffer

  projectedFinalStock: number;
  riskLevel: RiskLevel;

  // Stock curve data for the chart tab
  timeline: TimelinePoint[];
}
