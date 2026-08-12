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

import type { AdvertisingDashboard, AdvertisingIncrementality } from './types';

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
    // orders == sum(channelMix[].orders) below, so AOV and the new-customer
    // share are consistent with the mix table in the fixture too.
    orders: 4_947,
    newCustomerRevenueAud: 198_600,
    newCustomerRevenueUsd: usd(198_600),
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
  // Campaign orders/newCustomerOrders sum to the channel totals, and the
  // channel totals match the paid rows of channelMix (last-click credit).
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
      orders: 1_180,
      newCustomerOrders: 640,
      newCustomerRevenueAud: 41_800,
      newCustomerRevenueUsd: usd(41_800),
      campaigns: [
        { campaign: 'HD Shower Screen — Campaign NEW Videos', spendAud: 11_200, spendUsd: usd(11_200), claimedValueAud: 36_800, claimedValueUsd: usd(36_800), storeLastClickAud: 24_100, storeLastClickUsd: usd(24_100), storeFirstClickAud: 31_500, storeFirstClickUsd: usd(31_500), orders: 545, newCustomerOrders: 290 },
        { campaign: 'AUS De’Longhi Sales Campaign — Video', spendAud: 8_400, spendUsd: usd(8_400), claimedValueAud: 24_300, claimedValueUsd: usd(24_300), storeLastClickAud: 16_800, storeLastClickUsd: usd(16_800), storeFirstClickAud: 21_200, storeFirstClickUsd: usd(21_200), orders: 380, newCustomerOrders: 205 },
        { campaign: 'US Prospecting — Broad', spendAud: 7_300, spendUsd: usd(7_300), claimedValueAud: 17_300, claimedValueUsd: usd(17_300), storeLastClickAud: 11_400, storeLastClickUsd: usd(11_400), storeFirstClickAud: 16_200, storeFirstClickUsd: usd(16_200), orders: 255, newCustomerOrders: 145 },
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
      orders: 141,
      newCustomerOrders: 77,
      newCustomerRevenueAud: 9_400,
      newCustomerRevenueUsd: usd(9_400),
      campaigns: [
        { campaign: 'brand-search', spendAud: 700, spendUsd: usd(700), claimedValueAud: 6_200, claimedValueUsd: usd(6_200), storeLastClickAud: 5_900, storeLastClickUsd: usd(5_900), storeFirstClickAud: 1_200, storeFirstClickUsd: usd(1_200), orders: 58, newCustomerOrders: 12 },
        { campaign: 'non-brand', spendAud: 4_830, spendUsd: usd(4_830), claimedValueAud: 7_400, claimedValueUsd: usd(7_400), storeLastClickAud: 5_100, storeLastClickUsd: usd(5_100), storeFirstClickAud: 3_600, storeFirstClickUsd: usd(3_600), orders: 49, newCustomerOrders: 38 },
        { campaign: 'shopping', spendAud: 2_390, spendUsd: usd(2_390), claimedValueAud: 5_300, claimedValueUsd: usd(5_300), storeLastClickAud: 3_600, storeLastClickUsd: usd(3_600), storeFirstClickAud: 1_300, storeFirstClickUsd: usd(1_300), orders: 34, newCustomerOrders: 27, note: 'product_sync/sag_organic proxy — mixes in free listings until the clean tagging lands' },
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
  // C1: paid-touch split. bothOrders === blended.overlapOrders by construction.
  // "Touched anywhere in the journey" ≥ last-click credit, so the sides sit a
  // little above/below the channelMix paid rows — that asymmetry is real.
  overlap: {
    bothOrders: 31,
    onlyMetaOrders: 1_203,
    onlyGoogleOrders: 124,
    bothRevenueAud: 2_950,
    bothRevenueUsd: usd(2_950),
    onlyMetaRevenueAud: 53_800,
    onlyMetaRevenueUsd: usd(53_800),
    onlyGoogleRevenueAud: 12_400,
    onlyGoogleRevenueUsd: usd(12_400),
  },
  // C2: always the latest 12 by creation time, window-independent. The first
  // one is mid-sync: netAud null (NEVER 0 — the UI shows "syncing…").
  liveOrders: [
    { name: 'PSD#65231', createdAt: '2026-08-19 16:41', netAud: null, netUsd: null, lastBucket: 'sin-journey', firstBucket: 'sin-journey', touchesMeta: false, touchesGoogle: false },
    { name: 'PSD#65230', createdAt: '2026-08-19 15:58', netAud: 187, netUsd: usd(187), lastBucket: 'meta-paid', firstBucket: 'meta-paid', touchesMeta: true, touchesGoogle: false },
    { name: 'PSD#65229', createdAt: '2026-08-19 15:12', netAud: 96, netUsd: usd(96), lastBucket: 'direct', firstBucket: 'google-organic', touchesMeta: false, touchesGoogle: false },
    { name: 'PSD#65228', createdAt: '2026-08-19 14:03', netAud: 445, netUsd: usd(445), lastBucket: 'google-brand', firstBucket: 'meta-paid', touchesMeta: true, touchesGoogle: true },
    { name: 'PSD#65227', createdAt: '2026-08-19 12:37', netAud: 152, netUsd: usd(152), lastBucket: 'email', firstBucket: 'email', touchesMeta: false, touchesGoogle: false },
    { name: 'PSD#65226', createdAt: '2026-08-19 10:20', netAud: 78, netUsd: usd(78), lastBucket: 'google-organic', firstBucket: 'google-organic', touchesMeta: false, touchesGoogle: false },
    { name: 'PSD#65225', createdAt: '2026-08-19 08:44', netAud: 233, netUsd: usd(233), lastBucket: 'meta-paid', firstBucket: 'social-organic', touchesMeta: true, touchesGoogle: false },
    { name: 'PSD#65224', createdAt: '2026-08-18 22:15', netAud: 129, netUsd: usd(129), lastBucket: 'google-nonbrand', firstBucket: 'google-nonbrand', touchesMeta: false, touchesGoogle: true },
    { name: 'PSD#65223', createdAt: '2026-08-18 20:51', netAud: 64, netUsd: usd(64), lastBucket: 'direct', firstBucket: 'direct', touchesMeta: false, touchesGoogle: false },
    { name: 'PSD#65222', createdAt: '2026-08-18 19:36', netAud: 310, netUsd: usd(310), lastBucket: 'meta-paid', firstBucket: 'meta-paid', touchesMeta: true, touchesGoogle: false },
    { name: 'PSD#65221', createdAt: '2026-08-18 18:02', netAud: 92, netUsd: usd(92), lastBucket: 'social-organic', firstBucket: 'social-organic', touchesMeta: false, touchesGoogle: false },
    { name: 'PSD#65220', createdAt: '2026-08-18 16:47', netAud: 141, netUsd: usd(141), lastBucket: 'google-shopping-proxy', firstBucket: 'google-shopping-proxy', touchesMeta: false, touchesGoogle: true },
  ],
  // B2/B4: Juan's July workbook, real numbers. baselineRevenueUsd chosen so the
  // RPC derivation reproduces the workbook's lines exactly:
  //   breakevenMer = 1/0.706 = 1.42
  //   targetMer = 1/(0.706 - 0.20 - 48_559/334_889) = 2.77
  unitEconomics: {
    month: '2026-07',
    cm1Pct: 0.706,
    fixedCostsUsd: 48_559,
    revenuePerOrderUsd: 77.99,
    pctNewCustomers: 0.924,
    targetMarginPct: 0.20,
    baselineRevenueUsd: 334_889,
    breakevenMer: 1.42,
    targetMer: 2.77,
    source: 'PESADO_58_5_-_Ecommerce_Unit_Economics_July2026_FINAL VERSION.xlsx',
  },
  // B4: non-null here to exercise the MTD tracking (production has no committed
  // plan yet — the RPC returns null and the tracking block simply doesn't render).
  plan: {
    month: '2026-08',
    plannedSpendUsd: 129_939,
    targetProfitUsd: 58_000,
    notes: "Juan's scale plan — workbook Simulators §4",
  },
};

// ── advertising_incrementality() fixture ─────────────────────────────────────
// Band constants are the real frozen ones (326 zero-spend 10-day windows:
// median 28.1 / p75 31.4 / max 62.3). Monthly ratios hover inside the band
// until the spend era; Aug-2026 carries the post-brand-cut surge.

const incMonth = (month: string, restAud: number, ratioPct: number, googleSpendAud: number) => {
  const bagAud = Math.round((restAud * ratioPct) / 100);
  return { month, bagAud, restAud, ratioPct, googleOrders: Math.round(bagAud / 95), googleSpendAud };
};

export const ADVERTISING_INCREMENTALITY_MOCK: AdvertisingIncrementality = {
  monthly: [
    incMonth('2025-07', 289_400, 29.1, 0),
    incMonth('2025-08', 301_200, 29.6, 0),
    incMonth('2025-09', 296_800, 27.8, 0),
    incMonth('2025-10', 312_500, 28.6, 0),
    incMonth('2025-11', 355_900, 30.2, 0),
    incMonth('2025-12', 338_100, 31.0, 0),
    incMonth('2026-01', 305_600, 28.9, 0),
    incMonth('2026-02', 291_300, 27.4, 0),
    incMonth('2026-03', 314_800, 29.8, 0),
    incMonth('2026-04', 322_400, 30.6, 0),
    incMonth('2026-05', 318_700, 28.2, 0),
    incMonth('2026-06', 326_900, 29.4, 1_200),   // spend starts 25-Jun
    incMonth('2026-07', 331_500, 30.1, 7_400),
    incMonth('2026-08', 208_300, 44.6, 3_900),   // partial month, post-cut surge
  ],
  band: {
    windows: 326,
    windowDays: 10,
    period: '2025-07-01 → 2026-06-24',
    minPct: 18.2,
    p25Pct: 25.9,
    medianPct: 28.1,
    p75Pct: 31.4,
    maxPct: 62.3,
    samePeriodAug2025Pct: 29.6,
  },
  last10Days: { to: '2026-08-19', bagAud: 46_300, ratioPct: 51.8 },
  brandCut: {
    cutDate: '2026-08-06',
    verdictDate: '2026-08-31',
    pre:  { from: '2026-08-01', to: '2026-08-05', days: 5,  bagAud: 14_950, ratioPct: 30.9, brandSpendPerDayAud: 375 },
    post: { from: '2026-08-06', to: '2026-08-19', days: 14, bagAud: 46_300, ratioPct: 51.8, brandSpendPerDayAud: 59 },
  },
};
