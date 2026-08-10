// =============================================================================
// Advertising tab — mock data (fixture)
// =============================================================================
// This is the empty-state/dev fallback fixture, not the source: the tab reads
// public.advertising_dashboard. The shape below must match AdvertisingDashboard
// in ./types — see that file for the RPC contract. Money is AUD, dates Brisbane.

import type { AdvertisingDashboard } from './types';

const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 7, 6 + n)); // 2026-08-06 + n
  return d.toISOString().slice(0, 10);
};

// 14 days, 6–19 Aug. Revenue ~16-18k/day, Meta ~1.9k/day, Google ~0.6k/day.
export const ADVERTISING_MOCK: AdvertisingDashboard = {
  from: day(0),
  to: day(13),
  blended: {
    spendAud: 34_820,
    revenueAud: 236_400,
    mer: 6.79,
    claimedTotalAud: 97_300,
    doubleCountRatio: 1.42,
    overlapOrders: 31,
    cacBlended: 38.9,
    newCustomerOrders: 895,
    unclassifiedOrders: 12,
    noJourneyOrders: 4,
  },
  merSeries: Array.from({ length: 14 }, (_, i) => {
    const revenue = 15_500 + Math.round(3_000 * Math.sin(i / 2.1)) + i * 120;
    // Day 12-13: Google spend not loaded yet -> MER null, chart shows the gap
    const spend = i >= 12 ? null : 2_380 + Math.round(260 * Math.sin(i / 1.7));
    return {
      d: day(i),
      revenueAud: revenue,
      spendAud: spend,
      mer: spend === null ? null : Math.round((revenue / spend) * 100) / 100,
    };
  }),
  channels: [
    {
      key: 'meta',
      label: 'Meta',
      spendAud: 26_900,
      claimedAud: 78_400,
      storeLastAud: 52_300,
      storeFirstAud: 68_900,
      campaigns: [
        { campaign: 'HD Shower Screen — Campaign NEW Videos', spendAud: 11_200, claimedValueAud: 36_800, storeLastClickAud: 24_100, storeFirstClickAud: 31_500 },
        { campaign: 'AUS De’Longhi Sales Campaign — Video', spendAud: 8_400, claimedValueAud: 24_300, storeLastClickAud: 16_800, storeFirstClickAud: 21_200 },
        { campaign: 'US Prospecting — Broad', spendAud: 7_300, claimedValueAud: 17_300, storeLastClickAud: 11_400, storeFirstClickAud: 16_200 },
      ],
    },
    {
      key: 'google',
      label: 'Google',
      spendAud: 7_920,
      claimedAud: 18_900,
      storeLastAud: 14_600,
      storeFirstAud: 6_100,
      campaigns: [
        { campaign: 'brand-search', spendAud: 700, claimedValueAud: 6_200, storeLastClickAud: 5_900, storeFirstClickAud: 1_200 },
        { campaign: 'non-brand', spendAud: 4_830, claimedValueAud: 7_400, storeLastClickAud: 5_100, storeFirstClickAud: 3_600 },
        { campaign: 'shopping', spendAud: 2_390, claimedValueAud: 5_300, storeLastClickAud: 3_600, storeFirstClickAud: 1_300, note: 'proxy product_sync/sag_organic — mezcla free listings hasta el tagueo limpio' },
      ],
    },
  ],
  googleBuckets: [
    { bucket: 'Google brand (pago)', orders: 58, revenueAud: 5_900 },
    { bucket: 'Google non-brand (pago)', orders: 49, revenueAud: 5_100 },
    { bucket: 'Google Shopping (proxy)', orders: 34, revenueAud: 3_600, note: 'incluye free listings' },
    { bucket: 'Google orgánico (SEO)', orders: 412, revenueAud: 41_800, note: 'baseline bucket google total jul-2026: ~AUD 3,0k/día (pago sin tag + orgánico, convertido de USD)' },
  ],
};
