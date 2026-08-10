// =============================================================================
// Advertising tab — mock data (fixture)
// =============================================================================
// This is the empty-state/dev fallback fixture, not the source: the tab reads
// public.advertising_dashboard. The shape below must match AdvertisingDashboard
// in ./types — see that file for the RPC contract. Money is AUD, dates Brisbane.
//
// Every AUD figure carries its USD companion, as the RPC does. The real RPC
// derives USD per contributing row (native USD where the money originated in
// USD, otherwise aud ÷ that row's monthly rate) and only then sums; the fixture
// window is a single month, so one flat rate reproduces that faithfully.

import type { AdvertisingDashboard } from './types';

const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 7, 6 + n)); // 2026-08-06 + n
  return d.toISOString().slice(0, 10);
};

// AUD per USD, Aug-2026 (currency_exchange_rates). Fixture only.
const FX = 1.4249;
const usd = (aud: number) => Math.round((aud / FX) * 100) / 100;

// 14 days, 6–19 Aug. Revenue ~16-18k/day, Meta ~1.9k/day, Google ~0.6k/day.
export const ADVERTISING_MOCK: AdvertisingDashboard = {
  from: day(0),
  to: day(13),
  blended: {
    spendAud: 34_820,
    spendUsd: usd(34_820),
    revenueAud: 236_400,
    revenueUsd: usd(236_400),
    mer: 6.79,
    claimedTotalAud: 97_300,
    claimedTotalUsd: usd(97_300),
    doubleCountRatio: 1.42,
    overlapOrders: 31,
    cacBlended: 38.9,
    cacBlendedUsd: usd(38.9),
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
      revenueUsd: usd(revenue),
      spendAud: spend,
      // Null on exactly the same days as spendAud — the RPC guarantees it.
      spendUsd: spend === null ? null : usd(spend),
      mer: spend === null ? null : Math.round((revenue / spend) * 100) / 100,
      // The fixture window (6–19 Aug 2026) is entirely after google_active_from
      // (2026-06-25), so every day with spend loaded carries BOTH platforms;
      // the two days missing the Google row are incomplete by definition.
      spendComplete: spend !== null,
    };
  }),
  channels: [
    {
      key: 'meta',
      label: 'Meta',
      spendAud: 26_900,
      spendUsd: usd(26_900),
      claimedAud: 78_400,
      claimedUsd: usd(78_400),
      storeLastAud: 52_300,
      storeLastUsd: usd(52_300),
      storeFirstAud: 68_900,
      storeFirstUsd: usd(68_900),
      campaigns: [
        { campaign: 'HD Shower Screen — Campaign NEW Videos', spendAud: 11_200, spendUsd: usd(11_200), claimedValueAud: 36_800, claimedValueUsd: usd(36_800), storeLastClickAud: 24_100, storeLastClickUsd: usd(24_100), storeFirstClickAud: 31_500, storeFirstClickUsd: usd(31_500) },
        { campaign: 'AUS De’Longhi Sales Campaign — Video', spendAud: 8_400, spendUsd: usd(8_400), claimedValueAud: 24_300, claimedValueUsd: usd(24_300), storeLastClickAud: 16_800, storeLastClickUsd: usd(16_800), storeFirstClickAud: 21_200, storeFirstClickUsd: usd(21_200) },
        { campaign: 'US Prospecting — Broad', spendAud: 7_300, spendUsd: usd(7_300), claimedValueAud: 17_300, claimedValueUsd: usd(17_300), storeLastClickAud: 11_400, storeLastClickUsd: usd(11_400), storeFirstClickAud: 16_200, storeFirstClickUsd: usd(16_200) },
      ],
    },
    {
      key: 'google',
      label: 'Google',
      spendAud: 7_920,
      spendUsd: usd(7_920),
      claimedAud: 18_900,
      claimedUsd: usd(18_900),
      storeLastAud: 14_600,
      storeLastUsd: usd(14_600),
      storeFirstAud: 6_100,
      storeFirstUsd: usd(6_100),
      campaigns: [
        { campaign: 'brand-search', spendAud: 700, spendUsd: usd(700), claimedValueAud: 6_200, claimedValueUsd: usd(6_200), storeLastClickAud: 5_900, storeLastClickUsd: usd(5_900), storeFirstClickAud: 1_200, storeFirstClickUsd: usd(1_200) },
        { campaign: 'non-brand', spendAud: 4_830, spendUsd: usd(4_830), claimedValueAud: 7_400, claimedValueUsd: usd(7_400), storeLastClickAud: 5_100, storeLastClickUsd: usd(5_100), storeFirstClickAud: 3_600, storeFirstClickUsd: usd(3_600) },
        { campaign: 'shopping', spendAud: 2_390, spendUsd: usd(2_390), claimedValueAud: 5_300, claimedValueUsd: usd(5_300), storeLastClickAud: 3_600, storeLastClickUsd: usd(3_600), storeFirstClickAud: 1_300, storeFirstClickUsd: usd(1_300), note: 'product_sync/sag_organic proxy — mixes in free listings until the clean tagging lands' },
      ],
    },
  ],
  googleBuckets: [
    { bucket: 'Google brand (paid)', orders: 58, revenueAud: 5_900, revenueUsd: usd(5_900) },
    { bucket: 'Google non-brand (paid)', orders: 49, revenueAud: 5_100, revenueUsd: usd(5_100) },
    { bucket: 'Google Shopping (proxy)', orders: 34, revenueAud: 3_600, revenueUsd: usd(3_600), note: 'includes free listings' },
    { bucket: 'Google organic (SEO)', orders: 412, revenueAud: 41_800, revenueUsd: usd(41_800), note: 'baseline total google bucket Jul-2026: ~AUD 3.0k/day (untagged paid + organic, converted from USD)' },
  ],
  // Ordered by revenueAud desc, raw bucket keys, and — the point of the block —
  // summing to blended.revenueAud (236,400) exactly. Keep it that way when editing.
  channelMix: [
    { bucket: 'meta-paid', orders: 1_180, revenueAud: 52_300, revenueUsd: usd(52_300), isPaid: true },
    { bucket: 'direct', orders: 1_050, revenueAud: 48_900, revenueUsd: usd(48_900), isPaid: false },
    { bucket: 'google-organic', orders: 902, revenueAud: 41_800, revenueUsd: usd(41_800), isPaid: false },
    { bucket: 'sin-journey', orders: 540, revenueAud: 25_400, revenueUsd: usd(25_400), isPaid: false },
    { bucket: 'email', orders: 448, revenueAud: 21_300, revenueUsd: usd(21_300), isPaid: false },
    { bucket: 'social-organic', orders: 265, revenueAud: 12_400, revenueUsd: usd(12_400), isPaid: false },
    { bucket: 'search-other', orders: 210, revenueAud: 9_800, revenueUsd: usd(9_800), isPaid: false },
    { bucket: 'referral-other', orders: 143, revenueAud: 6_700, revenueUsd: usd(6_700), isPaid: false },
    { bucket: 'google-brand', orders: 58, revenueAud: 5_900, revenueUsd: usd(5_900), isPaid: true },
    { bucket: 'google-nonbrand', orders: 49, revenueAud: 5_100, revenueUsd: usd(5_100), isPaid: true },
    { bucket: 'google-shopping-proxy', orders: 34, revenueAud: 3_600, revenueUsd: usd(3_600), isPaid: true },
    { bucket: 'other-tagged', orders: 68, revenueAud: 3_200, revenueUsd: usd(3_200), isPaid: false },
  ],
};
