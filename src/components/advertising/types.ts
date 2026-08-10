// The contract with public.advertising_dashboard(p_from, p_to). Changing a field here means changing that RPC.

export interface MerPoint {
  d: string;                 // 'YYYY-MM-DD'
  revenueAud: number;        // Net sales ex tax (same figure as E-commerce tab)
  spendAud: number | null;   // null = Google spend not loaded that day
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
  claimedValueAud: number;   // what the platform's panel claims
  storeLastClickAud: number; // what the store recognises (last non-direct)
  storeFirstClickAud: number;// sales this campaign INITIATED
  note?: string;             // e.g. shopping proxy caveat
}

export interface ChannelView {
  key: 'meta' | 'google';
  label: string;
  spendAud: number;
  claimedAud: number;
  storeLastAud: number;
  storeFirstAud: number;
  campaigns: ChannelCampaign[];
  note?: string;             // channel-level caveat (e.g. Google pre-gate under-count)
}

export interface GoogleBucketRow {
  bucket: string;
  orders: number;
  revenueAud: number;
  note?: string;
}

export interface AdvertisingDashboard {
  from: string;
  to: string;
  blended: {
    spendAud: number;
    revenueAud: number;
    mer: number;
    claimedTotalAud: number;     // Meta claims + Google claims, summed
    doubleCountRatio: number;    // claimedTotal / real attributed revenue
    overlapOrders: number;       // journeys touched by BOTH paid platforms
    cacBlended: number;          // spend ÷ first-time-customer orders
    newCustomerOrders: number;
    unclassifiedOrders: number;  // UTM drift alarm (spec §7)
    noJourneyOrders: number;     // ready=false aged out (spec Bloque 1)
  };
  merSeries: MerPoint[];
  channels: ChannelView[];
  googleBuckets: GoogleBucketRow[];
}
