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
    unclassifiedOrders: number;  // UTM drift alarm (spec §7)
    noJourneyOrders: number;     // ready=false aged out (spec Bloque 1)
  };
  merSeries: MerPoint[];
  channels: ChannelView[];
  googleBuckets: GoogleBucketRow[];
  channelMix: ChannelMixRow[];
}
