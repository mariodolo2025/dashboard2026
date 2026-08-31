// The contract with public.advertising_dashboard(p_from, p_to). Changing a field here means changing that RPC.
//
// MONEY: every figure is AUD with a USD companion (`…Usd`), the house convention the
// rest of the dashboard already renders as `A$1,234 (US$867)` — see B2CSalesPanel's
// <Usd> component. The RPC builds the USD side per contributing ROW (native USD where
// the money originated in USD, otherwise aud ÷ that row's monthly rate) and only then
// sums, so a multi-month window carries a blended implied rate instead of one month's.
// Never divide an AUD total by a single rate in the UI to reproduce these.
//
// TAX: revenue here is TAX-INCLUSIVE (Mario, 2026-08-10) so the figures line up with
// Triple Whale. The B2C Sales Explorer deliberately differs — it reports ex-tax.

export interface MerPoint {
  d: string;                 // 'YYYY-MM-DD'
  revenueAud: number;        // Net sales (same figure as E-commerce tab)
  revenueUsd: number;
  spendAud: number | null;   // null = Google spend not loaded that day
  spendUsd: number | null;   // null on exactly the same days as spendAud
  mer: number | null;        // null when spendAud is null/incomplete — never 0
  // true only when spendAud covers EVERY platform with coverage that day.
  // false on days before google_active_from (Meta-only spend: Google did not
  // exist yet, so that MER is NOT comparable with a both-platform MER — the
  // 24-jun 2.74 → 25-jun 2.51 step is Google entering the denominator, not a
  // performance drop) and false whenever a platform row is missing (mer null).
  spendComplete: boolean;
}

export interface ChannelCampaign {
  campaign: string;          // Meta: campaign name · Google: brand-search | non-brand | shopping
  spendAud: number;
  spendUsd: number;
  claimedValueAud: number;   // what the platform's panel claims
  claimedValueUsd: number;
  storeLastClickAud: number; // what the store recognises (last non-direct)
  storeLastClickUsd: number;
  storeFirstClickAud: number;// sales this campaign INITIATED
  storeFirstClickUsd: number;
  orders: number;            // last-click orders the store credits to this campaign
  newCustomerOrders: number; // of those, first purchases (customer_order_index = 1)
  note?: string;             // e.g. shopping proxy caveat
}

export interface ChannelView {
  key: 'meta' | 'google';
  label: string;
  spendAud: number;
  spendUsd: number;
  claimedAud: number;
  claimedUsd: number;
  storeLastAud: number;
  storeLastUsd: number;
  storeFirstAud: number;
  storeFirstUsd: number;
  orders: number;            // last-click orders credited to this channel
  newCustomerOrders: number; // of those, first purchases — CPA/NC-CPA divide these
  newCustomerRevenueAud: number; // revenue of those first purchases — NC-ROAS
  newCustomerRevenueUsd: number;
  campaigns: ChannelCampaign[];
  note?: string;             // channel-level caveat (e.g. Google pre-gate under-count)
}

export interface GoogleBucketRow {
  bucket: string;
  orders: number;
  revenueAud: number;
  revenueUsd: number;
  note?: string;
}

/** One last-click bucket's share of the window. This is what lets the tab reconcile
 * on screen: paid channels are a SLICE of total revenue, not a rival figure.
 * INVARIANT: sum(channelMix[].revenueAud) === blended.revenueAud (±0.05 rounding).
 * `bucket` is the RAW key from advertising_bucket ('meta-paid', 'google-organic',
 * 'direct', 'sin-journey', …); the UI owns the English labels. */
export interface ChannelMixRow {
  bucket: string;
  orders: number;
  revenueAud: number;
  revenueUsd: number;
  isPaid: boolean;           // meta-paid + the google-*paid* buckets
}

/** Paid-touch split of the window's journeys (C1 Channel Overlap). Sides are
 * exclusive: 'only*' = touched that platform's paid click and NOT the other's.
 * bothOrders === blended.overlapOrders by construction. */
export interface OverlapSplit {
  bothOrders: number;
  onlyMetaOrders: number;
  onlyGoogleOrders: number;
  bothRevenueAud: number;
  bothRevenueUsd: number;
  onlyMetaRevenueAud: number;
  onlyMetaRevenueUsd: number;
  onlyGoogleRevenueAud: number;
  onlyGoogleRevenueUsd: number;
}

/** One row of the Live Orders ticker (C2). WINDOW-INDEPENDENT: always the 12
 * most recent orders by creation time, whatever range the tab shows. */
export interface LiveOrder {
  name: string;              // visible number (PSD#65185); '#'+id when not yet captured
  createdAt: string;         // 'YYYY-MM-DD HH:MM' Brisbane
  netAud: number | null;     // null = sales lines not synced yet (mid-sync) — never 0
  netUsd: number | null;
  lastBucket: string;        // raw bucket keys — UI owns labels
  firstBucket: string;
  touchesMeta: boolean;      // a Meta paid click anywhere in the journey
  touchesGoogle: boolean;
}

/** Juan's unit-economics constants (monthly workbook, stored in
 * advertising_unit_economics). USD as the workbook states them. The two MER
 * lines are DERIVED by the RPC from the inputs so they can never drift:
 * breakevenMer = 1/cm1Pct · targetMer = 1/(cm1Pct - targetMarginPct -
 * fixedCostsUsd/baselineRevenueUsd). null when no row covers the window. */
export interface UnitEconomics {
  month: string;             // 'YYYY-MM' the workbook describes
  cm1Pct: number;            // 0.706
  fixedCostsUsd: number;
  revenuePerOrderUsd: number;
  pctNewCustomers: number;   // 0.924
  targetMarginPct: number;   // 0.20
  baselineRevenueUsd: number;
  breakevenMer: number;      // 1.42
  targetMer: number | null;  // 2.77 · null = target unreachable at current economics
  source: string;
}

/** Committed monthly budget plan (B4). null = no plan committed for the month
 * of p_to; the MTD-vs-plan tracking only renders when present. */
export interface MonthlyPlan {
  month: string;             // 'YYYY-MM'
  plannedSpendUsd: number;
  targetProfitUsd: number;
  notes: string | null;
}

export interface AdvertisingDashboard {
  from: string;
  to: string;
  blended: {
    spendAud: number;
    spendUsd: number;
    revenueAud: number;
    revenueUsd: number;
    mer: number;
    claimedTotalAud: number;     // Meta claims + Google claims, summed
    claimedTotalUsd: number;
    doubleCountRatio: number;    // claimedTotal / real attributed revenue
    overlapOrders: number;       // journeys touched by BOTH paid platforms
    cacBlended: number;          // spend ÷ first-time-customer orders
    cacBlendedUsd: number;
    newCustomerOrders: number;
    orders: number;              // every order in the window — AOV and new-customer share
    newCustomerRevenueAud: number; // revenue of first purchases — blended NC-ROAS
    newCustomerRevenueUsd: number;
    unclassifiedOrders: number;  // UTM drift alarm (spec §7)
    noJourneyOrders: number;     // ready=false aged out (spec Bloque 1)
  };
  merSeries: MerPoint[];
  channels: ChannelView[];
  googleBuckets: GoogleBucketRow[];
  channelMix: ChannelMixRow[];
  overlap: OverlapSplit;
  liveOrders: LiveOrder[];
  unitEconomics: UnitEconomics | null;
  plan: MonthlyPlan | null;
}

// ── advertising_incrementality() — separate RPC, lazy-loaded by Leadership ──

export interface IncrementalityMonth {
  month: string;             // 'YYYY-MM'
  bagAud: number;            // the WHOLE Google bag (paid + organic + pre-gate mixto)
  restAud: number;           // store total minus the bag
  ratioPct: number;          // 100 * bag / rest — never "% of total" (self-inflating)
  googleOrders: number;
  googleSpendAud: number;
}

export interface AdvertisingIncrementality {
  monthly: IncrementalityMonth[];
  /** Counterfactual band: 326 rolling 10-day windows over the zero-spend period
   * (frozen constants — the period is closed, they can never change). */
  band: {
    windows: number;
    windowDays: number;
    period: string;
    minPct: number; p25Pct: number; medianPct: number; p75Pct: number; maxPct: number;
    samePeriodAug2025Pct: number;
  };
  /** The same distribution in MONTHS — the unit the chart's bars are drawn in.
   * Computed live from the closed zero-spend months, so the band and the bars
   * can never disagree. The 10-day `band` above is for the 10-day card only:
   * drawing it over monthly bars set a ceiling (62.3%) no month can reach, so
   * no month could ever read as a signal (migration 20260901100000). */
  monthlyBand: {
    months: number;
    period: string;
    minPct: number; p25Pct: number; medianPct: number; p75Pct: number; maxPct: number;
    maxMonth: string;
  };
  /** The last COMPLETE month, and whether it cleared the best month the store
   * ever had with zero Google spend. Null before any month has closed. */
  latestClosedMonth: {
    month: string; ratioPct: number; googleSpendAud: number; aboveZeroSpendMax: boolean;
  } | null;
  last10Days: { to: string; bagAud: number; ratioPct: number };
  /** Brand-cut natural experiment (2026-08-06, $375/day -> $50/day). If the bag
   * holds while brand spend stays cut, brand was harvesting. Verdict 2026-08-31. */
  brandCut: {
    cutDate: string;
    verdictDate: string;
    pre: { from: string; to: string; days: number; bagAud: number; ratioPct: number; brandSpendPerDayAud: number };
    post: { from: string; to: string; days: number; bagAud: number; ratioPct: number; brandSpendPerDayAud: number };
  };
}
