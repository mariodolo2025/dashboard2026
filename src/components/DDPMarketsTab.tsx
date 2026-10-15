// =============================================================================
// DDP Markets — are the DDP markets charging enough to cover what they cost?
//
// WHICH markets those are is data, not code: ddp_markets (active + zonos_expected)
// is read by the sync, by ddp_markets_dashboard and by this tab, which gets the
// live list back as `markets`. Three copies of that list is how Switzerland was
// carried as a DDP market for a week without ZONOS ever being enabled there.
//
// One order, three sources, reconciled server-side by ddp_markets_dashboard:
//   charged  — Shopify checkout (shipping + duties + taxes)
//   freight  — Starshipit label cost
//   ZONOS    — duties/taxes/fees ZONOS bills Dolo, for the markets whose
//              ddp_markets.zonos_expected is true; the rest complete on freight
//
// Everything shown is AUD. Layout follows the approved mockup: KPI strip,
// component gaps + weekly trend, needs-attention, and the per-order ledger
// collapsed at the bottom.
// =============================================================================

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { STORE_DATE_PRESETS, storeToday } from '@/lib/storeDate';
import { cn } from '@/lib/utils';

const DDP_START = '2026-08-01'; // the markets opened here; nothing exists before
const ADS_START = '2026-08-22'; // the EU Meta campaigns' first spend day

// ── shapes returned by ddp_markets_dashboard ─────────────────────────────────
interface Kpis {
  orders: number; matchedOrders: number; byCountry: Record<string, number>;
  revenue: number; chargedTotal: number; chargedShipping: number; chargedDuties: number;
  chargedTaxes: number; paidTotal: number; paidFreight: number; paidZonosDT: number;
  paidZonosFees: number; chargedMatched: number; paidMatched: number;
  netAbsorbed: number; netPerOrder: number; recoveryPct: number | null;
  /** false = the view is a market that absorbs duties/taxes by policy (USA):
   *  "charged" is shipping only and the gap is intended, not a fault.
   *  null = the view mixes policies (never today - the aggregate is DDP-only). */
  chargesDuties: boolean | null;
  /** Sales tax collected at checkout in absorbing markets. Remitted, not kept;
   *  not import tax; never part of the reconciliation. Shown so nobody wonders
   *  where Shopify's tax column went. */
  salesTax: number;
  /** Total Meta spend delivered in the markets shown, in the window. */
  adSpend: number;
  /** One entry per market in view, each with its OWN spend and ratio: what Meta
   *  delivered IN that country (meta_ads_country_daily), from any campaign.
   *  Never sum the mers; sum the spends. Optional only while an older RPC is
   *  still answering during a deploy. */
  adMarkets?: {
    code: string; name: string; spend: number; campaigns: number;
    firstDay: string | null; revenueSinceAds: number; mer: number | null;
    /** Days Meta actually reported spend on — NOT the calendar span since the
     *  first ad day. Meta's rows lag, and a paused campaign leaves gaps. */
    daysWithSpend: number;
  }[];
}
interface Component { key: string; charged: number; paid: number; gap: number; perOrder: number; orders: number }
interface Week { weekStart: string; charged: number; paid: number; orders: number }
interface Country {
  code: string; orders: number; matchedOrders: number; revenue: number;
  charged: number; paid: number; net: number; netPerOrder: number | null; recoveryPct: number | null;
}
interface LedgerRow {
  order: string; date: string; country: string;
  chargedShipping: number; chargedDuties: number; chargedTaxes: number; chargedTotal: number;
  salesTax: number; chargesDuties: boolean;
  /** true once the sync has asked Starshipit about this order. With freight
   *  null: false = "awaiting" (not looked yet), true = "no label" (looked, nothing). */
  freightChecked: boolean;
  freight: number | null; zonosDT: number | null; zonosFees: number | null; zonosExpected: boolean;
  paidTotal: number | null; net: number | null; tracking: string | null; carrier: string | null; matched: boolean;
}
/** One side of a dated policy change. Money in AUD at the monthly rate. */
interface PolicySide {
  from: string; to: string; orders: number; ordersPerDay: number | null;
  medianSubtotal: number | null;
  checkoutDutiesTaxes: number | null; checkoutDutiesTaxesPct: number | null;
  customerPaysTotal: number | null;
  /** Orders ZONOS has already billed, and what it billed in duties+taxes as a
   *  share of THOSE orders' subtotal. Low coverage = not readable yet. */
  zonosOrders: number; zonosDutiesTaxesPct: number | null; zonosFeePerOrder: number | null;
}
/** Before/after a market moved duties+taxes into the price (Canada, 11-Sep-2026).
 *  Equal windows either side of the cutover, independent of the date range. */
interface PolicyChange {
  country: string; cutAt: string; windowDays: number;
  before: PolicySide | null; after: PolicySide | null;
}

interface Payload {
  kpis: Kpis; components: Component[]; weekly: Week[]; countries: Country[]; ledger: LedgerRow[];
  exceptions: {
    awaitingZonos: string[]; awaitingFreight: string[];
    /** Totals behind the (capped) name lists above. */
    awaitingZonosTotal?: number; awaitingFreightTotal?: number;
    zonosUnmatched: { tracking: string; country: string; amount: number }[];
  };
  /** How many rows the ledger has in total; `ledger` is capped by p_ledger_limit. */
  ledgerTotal: number;
  /** The live markets with their policies, from ddp_markets — the tab holds no
   *  list of its own. inAllMarkets=false sits outside the aggregate (USA).
   *  showsMer false = no ad spend or MER on this tab (USA). */
  markets: { code: string; name: string; chargesDuties: boolean; inAllMarkets: boolean; showsMer?: boolean; dutiesIncludedFrom: string | null }[];
  /** Service segments of a market (ddp_service_segments) — a slice of ONE
   *  market by the service on the label, e.g. United States · IC13. Optional
   *  only while an older RPC is still answering during a deploy. */
  segments?: SegmentRef[];
  /** Null unless one market with a dated policy change is selected. */
  policyChange: PolicyChange | null;
}

/** A segment as the chip row needs it. */
interface SegmentRef { code: string; name: string; country: string; serviceCode: string; ruleFrom: string }

// ── the segment view (ddp_service_segment_dashboard) ─────────────────────────
interface SegKpis {
  /** Orders in the window whose label carries the segment's service. */
  segOrders: number;
  /** Label cost minus the frozen baseline OF EACH ORDER'S OWN RATE BAND,
   *  weighted by how many orders each band carries — not by how many labels
   *  happen to have arrived. A single early label in a 51-order band must not
   *  count as much as the band of 1,458. */
  extraPerOrder: number | null; extraTotal: number | null;
  /** The plain average over the labels themselves. Kept so nobody has to guess
   *  which of the two they are reading; the weighted one is the headline. */
  extraPerOrderRaw: number | null; marginPerOrderRaw: number | null;
  /** Share of orders sitting in bands that already have a label of this
   *  service. The weighted figures above cover only those. */
  bandsCoveredPct: number | null;
  costAvg: number | null; costMedian: number | null;
  /** Everything paid for those labels, summed — not the average times a count. */
  costTotal: number | null;
  /** What those same parcels cost to ship BEFORE the rule (each order's band
   *  baseline, summed). extraTotal = costTotal − beforeTotal. */
  beforeTotal: number | null;
  /** What customers paid for shipping on those orders, summed.
   *  marginTotal = chargedTotal − costTotal. */
  chargedTotal: number | null;
  chargedAvg: number | null;
  marginPerOrder: number | null; marginTotal: number | null; marginMonthly: number | null;
  freeShipOrders: number; freeShipPct: number | null;
  /** Orders a day over the last 28 whole store days — the rate behind the
   *  monthly projection, not something the selected window produces. */
  ordersPerDay: number | null; projMonthly: number | null;
  firstSeenAt: string | null; firstOrderAt: string | null;
  adherence: {
    orders: number; labelled: number; segment: number;
    /** Share of LABELLED orders that got the service. Read off the label. */
    pct: number | null;
    /** Share of orders that have a label at all. Low = not readable yet. */
    coveragePct: number | null;
  };
}
interface SegService { code: string; name: string | null; orders: number; pct: number | null; costAvg: number | null; isSegment: boolean }
/** One cart-size band of the market. The before-cost is a property of the
 *  PARCEL, and the cart size is what tracks the parcel; what the customer was
 *  charged stopped doing that the day one flat rate covered every cart under
 *  US$130 (15-Oct-2026). Each band carries its OWN frozen before-cost. */
interface SegBand {
  key: string; label: string;
  /** USD this cart size is charged under the card in force, and the one before.
   *  Null for the live quote, which has no card price. */
  paysNowUsd: number | null; paysBeforeUsd: number | null;
  /** IC13 labels under the card IN FORCE, and their gap (paid − label). Never
   *  blended across a card change: that would be a number neither card made. */
  labelsNow: number; gapNow: number | null;
  orders: number; labelled: number; segment: number;
  baseline: number; baselineIsBand: boolean;
  chargedAvg: number | null; costAvg: number | null;
  /** Null until a label of this service lands in this band. Null is the honest
   *  answer there — never read it as zero. */
  extraPerOrder: number | null; marginPerOrder: number | null;
  extraMonthly: number | null; marginMonthly: number | null;
  /** Money ALREADY SPENT above the old service in this band — not a rate, not a
   *  projection. Null while no label of the service has landed here. */
  extraSoFar: number | null;
}
/** One priced label since the rule, oldest first — the hero sparkline. */
interface SegLabelPoint { order: string; extra: number | null; cost: number | null; band: string; service: string | null }
interface SegDay {
  day: string; orders: number; labelled: number; segment: number; segmentPct: number | null;
  chargedAvg: number | null; costAvg: number | null; extraPerOrder: number | null;
}
interface SegLedgerRow {
  order: string; date: string; service: string | null; serviceName: string | null;
  isSegment: boolean; labelled: boolean;
  /** Merchandise subtotal, AUD. */
  subtotal: number | null;
  /** The same, in USD: what the customer saw, and what the rate card's limits
   *  are written in. */
  cartUsd: number | null;
  /** The rate card the order was placed under. */
  card: string | null;
  /** Shipping charged in the currency the customer actually paid (USD here),
   *  beside the AUD figure, so the row can be checked against Shopify directly. */
  chargedUsd: number | null;
  charged: number; freight: number | null; baseline: number;
  extra: number | null; margin: number | null;
  tracking: string | null; carrier: string | null; freightChecked: boolean;
}
interface SegPayload {
  segment: {
    code: string; name: string; country: string; serviceCode: string; ruleFrom: string; note: string | null;
    /** The shipping rate card in force for this market. */
    rateCard: { label: string; from: string } | null;
    baseline: {
      costAud: number; medianAud: number | null; chargedAud: number | null;
      orders: number | null; from: string; to: string; note: string | null;
    };
  } | null;
  kpis: SegKpis; bands: SegBand[]; labelSeries: SegLabelPoint[];
  services: SegService[]; daily?: SegDay[];
  ledger: SegLedgerRow[]; ledgerTotal: number;
  markets: Payload['markets']; segments: SegmentRef[];
  window: { from: string; to: string };
}

// Names come from the RPC. Only the flags stay in code — they are drawn, and
// Windows renders emoji flags as bare letters, which is why they are hand-cut
// SVG. A market with no flag here simply shows its name.

// Real SVG flags: Windows renders emoji flags as bare letters, which is what
// made the markets read as "just the code" in the first place.
function Flag({ cc, className }: { cc: string; className?: string }) {
  const cls = cn('inline-block h-[13px] w-[19px] shrink-0 rounded-[2px] border border-black/10 align-[-1.5px]', className);
  if (cc === 'DE') return (
    <svg viewBox="0 0 3 2" className={cls} aria-hidden>
      <rect width="3" height="2" fill="#000" /><rect y="0.667" width="3" height="1.333" fill="#DD0000" /><rect y="1.333" width="3" height="0.667" fill="#FFCE00" />
    </svg>
  );
  if (cc === 'DK') return (
    <svg viewBox="0 0 37 28" className={cls} aria-hidden>
      <rect width="37" height="28" fill="#C8102E" /><rect x="12" width="4" height="28" fill="#fff" /><rect y="12" width="37" height="4" fill="#fff" />
    </svg>
  );
  if (cc === 'CH') return (
    <svg viewBox="0 0 32 32" className={cls} aria-hidden>
      <rect width="32" height="32" fill="#DA291C" /><rect x="13" y="6" width="6" height="20" fill="#fff" /><rect x="6" y="13" width="20" height="6" fill="#fff" />
    </svg>
  );
  if (cc === 'CA') return (
    <svg viewBox="0 0 32 16" className={cls} aria-hidden>
      <rect width="32" height="16" fill="#fff" />
      <rect width="8" height="16" fill="#D52B1E" /><rect x="24" width="8" height="16" fill="#D52B1E" />
      <path fill="#D52B1E" d="M16 3.1l1.05 2.1 2.1-.5-.65 2.1 1.8.4-2.2 1.75.5 1.05-2.4-.4.3 2.9h-.9l.3-2.9-2.4.4.5-1.05L11.7 7.2l1.8-.4-.65-2.1 2.1.5z" />
    </svg>
  );
  if (cc === 'US') return (
    <svg viewBox="0 0 19 10" className={cls} aria-hidden>
      <rect width="19" height="10" fill="#fff" />
      {[0, 2, 4, 6, 8].map((y) => <rect key={y} y={y} width="19" height="1" fill="#B22234" />)}
      <rect width="8" height="5" fill="#3C3B6E" />
    </svg>
  );
  if (cc === 'SE') return (
    <svg viewBox="0 0 16 10" className={cls} aria-hidden>
      <rect width="16" height="10" fill="#006AA7" /><rect x="5" width="2" height="10" fill="#FECC00" /><rect y="4" width="16" height="2" fill="#FECC00" />
    </svg>
  );
  if (cc === 'GB') return (
    <svg viewBox="0 0 60 30" className={cls} aria-hidden>
      <clipPath id="ddp-gb-clip"><path d="M0 0h60v30H0z" /></clipPath>
      <g clipPath="url(#ddp-gb-clip)">
        <path fill="#012169" d="M0 0h60v30H0z" />
        <path stroke="#fff" strokeWidth="6" d="M0 0l60 30m0-30L0 30" />
        <path stroke="#C8102E" strokeWidth="4" d="M0 0l60 30m0-30L0 30" clipPath="url(#ddp-gb-clip)" />
        <path stroke="#fff" strokeWidth="10" d="M30 0v30M0 15h60" />
        <path stroke="#C8102E" strokeWidth="6" d="M30 0v30M0 15h60" />
      </g>
    </svg>
  );
  return null;
}
const aud = (v: number | null | undefined, dec = 0) =>
  v === null || v === undefined ? '—'
    : `${v < 0 ? '−' : ''}A$${Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
const n2 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Presets that make sense for a window that starts 1 Aug 2026: the module-wide
// long presets collapse onto "since launch" anyway.
const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  // Yesterday and Last week, shared with every other tab (Mario, 2026-09-30).
  { label: 'Yesterday', range: STORE_DATE_PRESETS.find((p) => p.label === 'Yesterday')!.range },
  { label: 'Last week', range: STORE_DATE_PRESETS.find((p) => p.label === 'Last week')!.range },
  { label: 'Since ads (22 Aug)', range: () => ({ from: ADS_START, to: storeToday() }) },
  { label: 'From 1 Aug', range: () => ({ from: DDP_START, to: storeToday() }) },
  { label: '30 days', range: STORE_DATE_PRESETS.find((p) => p.label === '30 days')!.range },
  { label: 'This FY', range: STORE_DATE_PRESETS.find((p) => p.label === 'This FY')!.range },
];
const clampFrom = (d: string) => (d < DDP_START ? DDP_START : d);

// Every number on this screen names its source on hover.
const T = {
  orders: 'Shopify orders shipped to a live DDP market in the window (store days, Australia/Brisbane). Which markets are live is ddp_markets.active. Source: ddp_shipments, filled by ddp-sync.',
  charged: 'What customers paid at checkout for shipping + duties + taxes, in AUD (Shopify shop_money USD × the monthly USD→AUD rate the whole dashboard uses). Merchandise is NOT included.',
  paid: 'What Dolo actually paid: Starshipit label cost + everything ZONOS billed (duties, taxes, fees). AUD as billed.',
  net: 'Charged − paid, summed over MATCHED orders only — both legs present, or freight alone where the market does not bill through ZONOS. Negative = Dolo absorbs the difference.',
  recovery: 'Charged ÷ paid over matched orders. 100% = customers cover exactly what the orders cost to land.',
  compShipping: 'Shipping charged at checkout vs the Starshipit label cost, over matched orders in the window.',
  compDT: 'Duties + taxes charged at checkout vs what ZONOS billed. Only the markets that bill through ZONOS are in here; the others have no such leg to compare.',
  compFees: 'ZONOS per-order service fees. Never charged to the customer — a structural cost of selling DDP.',
  weekly: 'Charged vs paid per week (matched orders, store weeks starting Monday; the first and last week are clipped to the selected range). The vertical gap is what Dolo absorbs that week.',
  ledger: 'One row per order, three sources side by side. Net only appears when the order is fully matched.',
  colOrder: 'The Shopify order name, and in brackets the tracking number the parcel shipped under (Starshipit / Australia Post). ZONOS is searchable ONLY by tracking — it does not know the Shopify order name — so this is the handle to copy across. One click selects the whole number. "no tracking" means the label has not been created yet, or the order shipped outside Starshipit.',
  colShip: 'Shipping charged at checkout (AUD, monthly FX). Source: Shopify total_shipping_price_set.',
  colDuties: 'Duties charged at checkout. Source: Shopify current_total_duties_set.',
  colTaxes: 'Taxes charged at checkout. Source: Shopify total_tax_set.',
  colChargedTotal: 'Shipping + duties + taxes charged, AUD.',
  colFreight: 'What the label cost, AUD. Source: Starshipit total_shipping_price.',
  colZonosDT: 'Duties + taxes ZONOS billed for this tracking, AUD. Blank where the market does not bill through ZONOS.',
  colZonosFees: 'ZONOS per-order service fee, AUD.',
  colPaidTotal: 'Freight + ZONOS duties/taxes/fees, AUD.',
  colNet: 'Charged − paid for this order. Blank until every expected leg is matched.',
};

export default function DDPMarketsTab() {
  const [from, setFrom] = useState(ADS_START);
  const [to, setTo] = useState(storeToday());
  const [preset, setPreset] = useState('Since ads (22 Aug)');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  // The ledger is capped server-side (USA alone is thousands of rows); this is
  // the cap in force. "Load more" raises it and refetches.
  const [ledgerLimit, setLedgerLimit] = useState(300);
  // Country filter: narrows every figure server-side (p_country). null = all.
  const [country, setCountry] = useState<string | null>(null);
  // A service segment of a market (United States · IC13). It answers a
  // different question from the markets - what one shipping rule costs, not
  // whether checkout covers the landed cost - so it has its own RPC and its own
  // body below. While one is selected the market query is NOT re-run: the DB is
  // small, and two heavy reads for one screen is how the front page got slow.
  const [segment, setSegment] = useState<string | null>(null);

  // The window a segment opens on: the day its rule started, in store days.
  // Mario, 14-Oct-2026: "cada vez que entro quiero que la fecha de arranque sea
  // el 14 de octubre". Anything before it belongs to the market, not the rule.
  const segmentStart = (sg: SegmentRef) =>
    clampFrom(new Date(sg.ruleFrom).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }));

  const load = useCallback(async (f: string, t: string, c: string | null, lim: number) => {
    setLoading(true); setError(null);
    const { data: d, error: e } = await supabase.rpc('ddp_markets_dashboard', { p_from: f, p_to: t, p_country: c, p_ledger_limit: lim });
    if (e) setError(e.message); else setData(d as unknown as Payload);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (segment) return;
    void load(from, to, country, ledgerLimit);
  }, [load, from, to, country, ledgerLimit, segment]);

  // Entering a segment always resets the window to the day its rule started —
  // including when the tab remounts with one already selected, which is how it
  // kept opening on the module-wide "Since ads" preset.
  useEffect(() => {
    if (!segment) return;
    const sg = (data?.segments ?? []).find((x) => x.code === segment);
    if (!sg) return;
    setPreset('');
    setFrom(segmentStart(sg));
    setTo(storeToday());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment]);

  // Bumped after a Refresh so the segment view refetches. Refresh used to
  // reload only the market payload, and the IC13 view - which fetches on its
  // own - kept showing what it had loaded when the chip was clicked.
  const [segRefresh, setSegRefresh] = useState(0);

  const runSync = useCallback(async () => {
    setSyncing(true); setSyncNote(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ddp-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        // On a segment the question is "did the labels I just printed come in":
        // the freight pass with the last two days of Shopify answers it in
        // seconds. The full window since 1-Aug plus the ZONOS walk is what the
        // market view needs, and it is far too slow to wait for here.
        body: JSON.stringify(segment ? { only: 'freight' } : {}),
      });
      const j = await res.json();
      setSyncNote(!j?.success
        ? `Sync failed: ${j?.message ?? res.status}`
        : segment
          ? `Synced — ${j.starshipit?.matched ?? 0} new label price${j.starshipit?.matched === 1 ? '' : 's'}`
          : `Synced — ${j.shopify?.ddpOrders ?? 0} orders · freight +${j.starshipit?.matched ?? 0} · ZONOS +${j.zonos?.matched ?? 0}`);
      if (segment) setSegRefresh((n) => n + 1);
      else await load(from, to, country, ledgerLimit);
    } catch (e) {
      setSyncNote(`Sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }, [from, to, country, load, segment, ledgerLimit]);

  const k = data?.kpis;
  // "Nothing added at checkout" has two different reasons, and they tell
  // opposite stories about who pays. The USA absorbs duties by policy; Canada
  // moved them INTO THE PRICE on 11-Sep-2026 (prices up ~20%). The words follow
  // the market's own data, never a country code.
  const notChargedWhy = country && data?.markets.find((m) => m.code === country)?.dutiesIncludedFrom
    ? 'included in the price' : 'absorbed by policy';
  // Names come from the payload; an unknown code falls back to itself rather
  // than rendering "undefined" if a market is added while the tab is open.
  const countryName = (cc: string) =>
    data?.markets.find((m) => m.code === cc)?.name ?? cc;
  const weekly = useMemo(() => (data?.weekly ?? []).map((w) => ({
    ...w, label: new Date(`${w.weekStart}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
  })), [data]);
  const maxComp = useMemo(() => Math.max(1, ...(data?.components ?? []).flatMap((c) => [c.charged, c.paid])), [data]);
  const totals = useMemo(() => {
    const rows = data?.ledger ?? [];
    const sum = (f: (r: LedgerRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
    return {
      ship: sum((r) => r.chargedShipping), duties: sum((r) => r.chargedDuties), taxes: sum((r) => r.chargedTaxes),
      charged: sum((r) => r.chargedTotal), freight: sum((r) => r.freight), zonosDT: sum((r) => r.zonosDT),
      zonosFees: sum((r) => r.zonosFees), paid: sum((r) => r.paidTotal), net: sum((r) => r.net),
    };
  }, [data]);

  const compMeta: Record<string, { label: string; tip: string; note: (c: Component) => string }> = {
    shipping: {
      label: 'Shipping', tip: T.compShipping,
      note: (c) => `free-shipping thresholds absorb ${aud(Math.abs(c.perOrder), 2)} per order`,
    },
    duties_taxes: {
      label: 'Duties + taxes', tip: T.compDT,
      // For an absorbing market the gap IS the policy: describing it as
      // "undercharging" would call a decision a defect.
      note: (c) => k?.chargesDuties === false
        ? `${notChargedWhy} — nothing is added at checkout; ZONOS bills ${aud(Math.abs(c.perOrder), 2)} per order`
        : Math.abs(c.gap) <= Math.max(5, c.paid * 0.05)
          ? 'checkout tracks ZONOS closely — charging is calibrated'
          : c.gap < 0 ? 'checkout charges LESS than ZONOS bills — undercharging'
          : 'checkout charges more than ZONOS bills',
    },
    fees: {
      label: 'ZONOS fees', tip: T.compFees,
      note: (c) => `never charged to the customer — ${aud(Math.abs(c.perOrder), 2)} per order, structural`,
    },
  };

  return (
    <div className="space-y-4">
      {/* ── header: window, sources, refresh ─────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold leading-tight">DDP Markets</h2>
          <p className="text-[13px] text-muted-foreground">
            {(data?.markets ?? []).map((mk) => mk.name).join(' · ') || 'Loading'} — checkout vs real landed cost, order by order.
            Sources: <b className="text-foreground">Shopify</b> · <b className="text-foreground">Starshipit</b> · <b className="text-foreground">ZONOS</b>.
            All amounts in <b className="text-foreground">AUD</b>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p.label} size="sm" variant={preset === p.label ? 'default' : 'outline'} className="h-8 text-[13px]"
              onClick={() => { const r = p.range(); setPreset(p.label); setFrom(clampFrom(r.from)); setTo(r.to); }}
            >
              {p.label}
            </Button>
          ))}
          <input
            type="date" value={from} min={DDP_START} max={to}
            onChange={(e) => { setPreset(''); setFrom(clampFrom(e.target.value)); }}
            className="h-8 rounded-md border bg-background px-2 text-[13px]"
            title={`Window start (store days). Nothing exists before ${DDP_START} — the markets opened then.`}
          />
          <input
            type="date" value={to} min={from} max={storeToday()}
            onChange={(e) => { setPreset(''); setTo(e.target.value); }}
            className="h-8 rounded-md border bg-background px-2 text-[13px]"
            title="Window end (store days)."
          />
          <Button size="sm" variant="outline" className="h-8 text-[13px]" onClick={runSync} disabled={syncing}
            title="Re-runs ddp-sync now: re-reads Shopify, looks up pending freight in Starshipit and pending duties in ZONOS.">
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', syncing && 'animate-spin')} />
            {syncing ? 'Syncing…' : 'Refresh'}
          </Button>
        </div>
      </div>
      {syncNote && <div className="text-[13px] text-muted-foreground">{syncNote}</div>}
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[13px]">{error}</div>}

      {/* ── country filter: every figure below narrows server-side ───────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => { setSegment(null); setCountry(null); }}
          className={cn('rounded-full border px-3 py-1 text-[13px]', country === null && !segment ? 'border-foreground bg-foreground font-semibold text-background' : 'bg-card text-muted-foreground hover:text-foreground')}
          title="Every DDP market together - the ones that charge duties and taxes to the customer. Markets that absorb them (the USA) sit outside this total: at forty times the next market's volume, folding it in would make the total read as that one market.">
          All DDP markets
        </button>
        {(data?.markets ?? []).filter((m) => m.inAllMarkets).map(({ code: cc }) => (
          <button key={cc} type="button" onClick={() => { setSegment(null); setCountry(country === cc ? null : cc); }}
            className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px]', country === cc && !segment ? 'border-foreground bg-foreground font-semibold text-background' : 'bg-card text-muted-foreground hover:text-foreground')}
            title={`Only ${countryName(cc)}: KPIs, component gaps, weekly chart, ledger, ad spend and MER all narrow to this market. Ad spend is what Meta delivered in ${countryName(cc)}, from any campaign.`}>
            <Flag cc={cc} /> {countryName(cc)}
          </button>
        ))}
        {(data?.markets ?? []).some((m) => !m.inAllMarkets) && (
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        )}
        {(data?.markets ?? []).filter((m) => !m.inAllMarkets).map(({ code: cc, chargesDuties }) => (
          <button key={cc} type="button" onClick={() => { setSegment(null); setCountry(country === cc ? null : cc); }}
            className={cn('flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[13px]', country === cc && !segment ? 'border-foreground bg-foreground font-semibold text-background' : 'bg-card text-muted-foreground hover:text-foreground')}
            title={`${countryName(cc)} on its own. Outside the "All DDP markets" total.${chargesDuties ? '' : ' Dolo absorbs every duty and tax here by policy - nothing is charged to the customer - so the gap you will see is intended, not a calibration fault.'} No MER on this tab: it lives in Advertising / E-commerce.`}>
            <Flag cc={cc} /> {countryName(cc)}
          </button>
        ))}
        {/* Service segments: the same market, read through the service on the
            label. Not a market of its own — ddp_markets is keyed by country and
            every one of these orders is still 'US'. */}
        {(data?.segments ?? []).map((sg) => (
          <button key={sg.code} type="button"
            onClick={() => {
              const next = segment === sg.code ? null : sg.code;
              setSegment(next);
              if (next) {
                setCountry(null);
                setPreset('');
                setFrom(segmentStart(sg));
                setTo(storeToday());
              }
            }}
            className={cn('flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-[13px]', segment === sg.code ? 'border-foreground bg-foreground font-semibold text-background' : 'bg-card text-muted-foreground hover:text-foreground')}
            title={`${sg.name}: the same ${countryName(sg.country)} orders, read through the service on the label. Only the parcels that shipped on ${sg.serviceCode} count towards the money; what the rule was meant to catch — orders placed since it started — is what adherence is measured over. Nothing about duties, taxes or ZONOS here: that question lives on the ${countryName(sg.country)} chip.`}>
            <Flag cc={sg.country} /> {sg.name}
          </button>
        ))}
        {country && !segment && (
          <span className="text-[13px] text-muted-foreground">
            viewing {countryName(country)} only
            {k?.chargesDuties === false && <> · <b className="font-medium text-amber-700 dark:text-amber-500">duties + taxes {notChargedWhy}</b></>}
          </span>
        )}
      </div>

      {segment && (
        <SegmentView
          code={segment} from={from} to={to} refreshKey={segRefresh}
          marketName={(cc: string) => countryName(cc)}
        />
      )}

      {!segment && (<>
      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      {/* ── row A: the whole window, every order ─────────────────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="cursor-help rounded-xl border bg-card p-3.5" title={T.orders}>
          <div className="text-[13px] text-muted-foreground">DDP orders</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? k.orders : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? (data?.markets ?? []).map((mk) => mk.code).filter((c) => k.byCountry[c]).map((c) => `${c} ${k.byCountry[c]}`).join(' · ') : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border bg-card p-3.5"
          title="Merchandise revenue of ALL the window's orders: Shopify subtotal (before shipping, duties and taxes), shop_money USD converted to AUD with the monthly rate the whole dashboard uses.">
          <div className="text-[13px] text-muted-foreground">Revenue</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? aud(k.revenue) : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {data ? data.countries.map((c) => `${c.code} ${aud(c.revenue)}`).join(' · ') : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border bg-card p-3.5"
          title={`Meta spend DELIVERED in each market inside the window, from any campaign - Meta's own country breakdown (table meta_ads_country_daily, synced 3x a day), not a guess from the campaign name. AUD; the USD ad account converts at the house monthly rate. One line per market, never blended: each market's MER is ITS merchandise revenue (Shopify subtotal, ddp_shipments) since ITS first ad day in the window, divided by ITS spend. Revenue before the first ad day is left out, or a whole month of sales over a few days of spend would flatter the ads. A market with only a few days of spend gives a wild ratio; the day count is shown for that reason. Spend delivered in countries that are not DDP markets (e.g. Switzerland) is not counted here. Blended within a market, not attributed to orders.`}>
          <div className="text-[13px] text-muted-foreground">Ad spend</div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums">{k ? aud(k.adSpend) : '…'}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums space-y-0.5">
            {!k ? '' : (k.adMarkets ?? []).filter((r) => r.spend > 0).length === 0
              ? (country && data?.markets.find((m) => m.code === country)?.showsMer === false
                  ? 'not measured here — this market\'s MER lives in the Advertising tab'
                  : 'no ad spend delivered here in the window')
              : (k.adMarkets ?? []).filter((r) => r.spend > 0).map((r) => {
                // Days Meta reported spend on, straight from the RPC. Deriving
                // it from the calendar counted a day Meta had not reported yet.
                const days = r.daysWithSpend;
                return (
                  <div key={r.code} className="flex flex-wrap items-baseline gap-x-1.5"
                    title={`${r.name}: ${aud(r.spend)} delivered by ${r.campaigns} campaign${r.campaigns === 1 ? '' : 's'} on ${days} day${days === 1 ? '' : 's'}; revenue since ${r.firstDay ?? '—'} ${aud(r.revenueSinceAds)}.`}>
                    <span className="font-medium text-foreground/80">{r.code}</span>
                    <span>{aud(r.spend)}</span>
                    <span>· MER {r.mer ?? '—'}×</span>
                    {/* A ratio built on a handful of days is noise, and 8.38x
                        reads like a triumph unless the card says otherwise. The
                        threshold is on the DAY COUNT, not on a hardcoded market:
                        every market looks like this in its first week. */}
                    {days <= 7
                      ? (
                        <span className="text-amber-700 dark:text-amber-500">
                          · started {r.firstDay
                            ? new Date(`${r.firstDay}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
                            : '—'}, {days} day{days === 1 ? '' : 's'} of spend — too early to read
                        </span>
                      )
                      : <span>· {days} days of spend</span>}
                  </div>
                );
              })}
          </div>
        </div>
      </div>

      {/* ── row B: the reconciliation, matched orders only ───────────────── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="cursor-help rounded-xl border border-dashed bg-muted/30 p-3"
          title={`Shipping + duties + taxes charged at checkout, but ONLY for the ${k?.matchedOrders ?? '…'} orders whose real costs are already known (freight + ZONOS, or freight alone where the market does not bill through ZONOS). This is the comparable half of the reconciliation — the total over every order sits below. AUD, monthly FX.`}>
          <div className="text-[13px] text-muted-foreground">Charged to customers</div>
          <div className="mt-0.5 text-xl font-bold tabular-nums">
            {k ? aud(k.chargedMatched) : '…'}
            <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">from {k ? `${k.matchedOrders} of ${k.orders}` : '…'} orders</span>
          </div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {!k ? '' : k.chargesDuties === false
              ? <>total charged {aud(k.chargedTotal)} · ship {aud(k.chargedShipping)} · <span className="text-amber-700 dark:text-amber-500">duties + taxes not charged at checkout ({notChargedWhy})</span></>
              : `total charged ${aud(k.chargedTotal)} · ship ${aud(k.chargedShipping)} · duties ${aud(k.chargedDuties)} · taxes ${aud(k.chargedTaxes)}`}
          </div>
        </div>
        <div className="cursor-help rounded-xl border border-dashed bg-muted/30 p-3"
          title={`What Dolo really paid for those SAME ${k?.matchedOrders ?? '…'} matched orders: Starshipit label + everything ZONOS billed. The "known so far" line below adds every cost already recorded on not-yet-matched orders — it is NOT comparable with the total charged above it (different universes). AUD as billed.`}>
          <div className="text-[13px] text-muted-foreground">Paid by Dolo</div>
          <div className="mt-0.5 text-xl font-bold tabular-nums">
            {k ? aud(k.paidMatched) : '…'}
            <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">same {k ? k.matchedOrders : '…'} orders</span>
          </div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? `known so far ${aud(k.paidTotal)} · freight ${aud(k.paidFreight)} · ZONOS ${aud(k.paidZonosDT)} · fees ${aud(k.paidZonosFees)}` : ''}
          </div>
        </div>
        <div className="cursor-help rounded-xl border border-dashed bg-muted/30 p-3"
          title={`Charged minus paid over the matched orders only — the two figures to its left. PARTIAL by nature: ZONOS bills days after the parcel ships, so the orders still waiting carry costs that will push this DOWN when they land. Read it as the best case so far, not the result. Negative = Dolo absorbs.`}>
          <div className="text-[13px] text-muted-foreground">Net absorbed <span className="font-normal">(partial · {k ? `${k.matchedOrders}/${k.orders}` : '…'})</span></div>
          <div className={cn('mt-0.5 text-xl font-bold tabular-nums', (k?.netAbsorbed ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700')}>
            {k ? aud(k.netAbsorbed) : '…'}
          </div>
          <div className="text-[13px] text-muted-foreground tabular-nums">
            {k ? `${aud(k.netPerOrder, 2)}/order · recovery ${k.recoveryPct ?? '—'}%` : ''}
          </div>
        </div>
      </div>

      {/* ── per-country line ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(data?.countries ?? []).map((c) => (
          <div key={c.code} className="cursor-help rounded-xl border bg-card px-3.5 py-2.5"
            title={`${c.code}: ${c.orders} orders (${c.matchedOrders} matched), ${aud(c.revenue)} merchandise revenue. Charged ${aud(c.charged)} vs paid ${aud(c.paid)} over matched orders.`}>
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold"><Flag cc={c.code} /> {countryName(c.code)} · {c.orders} orders</span>
              <span className={cn('text-sm font-bold tabular-nums', (c.net ?? 0) < 0 ? 'text-red-600' : 'text-emerald-700')}>
                {c.matchedOrders
                  ? <>{aud(c.netPerOrder, 2)}/order <span className="font-normal text-muted-foreground">· {c.matchedOrders}/{c.orders} matched</span></>
                  : 'no matched orders'}
              </span>
            </div>
            <div className="text-[13px] text-muted-foreground tabular-nums">
              revenue {aud(c.revenue)} · recovery {c.recoveryPct ?? '—'}%
            </div>
          </div>
        ))}
      </div>

      {/* ── before / after a dated policy change ────────────────────────────
          Mario, 2026-09-14: Canada moved duties and taxes into the price on
          11-Sep and he wants to compare against what came before. The trap this
          block exists to avoid: after the change "charged at checkout" is
          shipping only, so recovery collapses on paper while the customer pays
          MORE - the money moved into the subtotal, which the reconciliation
          never reads. So it compares what the customer pays IN TOTAL, and what
          ZONOS bills as a share of the price, over equal windows either side. */}
      {data?.policyChange && (() => {
        const pc = data.policyChange;
        const b = pc.before;
        const a = pc.after;
        const cutLabel = new Date(pc.cutAt).toLocaleString('en-AU', {
          timeZone: 'Australia/Brisbane', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
        });
        const chg = (after: number | null | undefined, before: number | null | undefined) =>
          after == null || before == null || before === 0 ? null : Math.round((100 * (after - before)) / before);
        const signed = (v: number | null, suffix = '%') =>
          v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}${suffix}`;
        // A side's ZONOS share is only worth reading once most of its orders
        // have been billed; below half it is a handful of early parcels.
        const readable = (sd: PolicySide | null) => !!sd && sd.orders > 0 && sd.zonosOrders / sd.orders >= 0.5;
        const zonosCell = (sd: PolicySide | null) => !sd ? '—' : sd.zonosOrders === 0
          ? <span className="text-muted-foreground">not billed yet <span className="text-[12px]">(0 of {sd.orders})</span></span>
          : <span className={cn(!readable(sd) && 'text-muted-foreground')}>
              {sd.zonosDutiesTaxesPct ?? '—'}%
              <span className="ml-1 text-[12px] text-muted-foreground">({sd.zonosOrders} of {sd.orders} billed)</span>
            </span>;
        const dtDiff = a?.checkoutDutiesTaxes != null && b?.checkoutDutiesTaxes != null
          ? a.checkoutDutiesTaxes - b.checkoutDutiesTaxes : null;
        const rows: { label: string; tip: string; before: ReactNode; after: ReactNode; change: string }[] = [
          {
            label: 'Orders per day',
            tip: 'Orders placed per day in each window. Both windows are the same length, so volume compares directly - but they fall on different weekdays, and the weekday moves volume on its own.',
            before: b?.ordersPerDay ?? '—', after: a?.ordersPerDay ?? '—',
            change: signed(chg(a?.ordersPerDay, b?.ordersPerDay)),
          },
          {
            label: 'Median order subtotal',
            tip: 'The middle order\'s merchandise subtotal - before shipping, duties and taxes - in AUD at the monthly rate. The median, not the average: most orders are one product, so the median shows the price change that a few big baskets would blur in an average.',
            before: aud(b?.medianSubtotal, 2), after: aud(a?.medianSubtotal, 2),
            change: signed(chg(a?.medianSubtotal, b?.medianSubtotal)),
          },
          {
            label: 'Duties + taxes added at checkout',
            tip: 'Charged on top of the price at checkout: the average per order, and as a share of the window\'s total subtotal. Zero after the change by design - that money now sits inside the subtotal above.',
            before: <>{aud(b?.checkoutDutiesTaxes, 2)}{b?.checkoutDutiesTaxesPct != null && <span className="ml-1 text-[12px] text-muted-foreground">({b.checkoutDutiesTaxesPct}% of subtotal)</span>}</>,
            after: <>{aud(a?.checkoutDutiesTaxes, 2)}{a?.checkoutDutiesTaxesPct != null && <span className="ml-1 text-[12px] text-muted-foreground">({a.checkoutDutiesTaxesPct}% of subtotal)</span>}</>,
            change: dtDiff == null ? '—' : `${dtDiff > 0 ? '+' : dtDiff < 0 ? '−' : ''}${aud(Math.abs(dtDiff), 2)}`,
          },
          {
            label: 'Customer pays in total, per order',
            tip: 'Everything the customer pays for an order: merchandise, shipping and whatever was added at checkout. This is the like-for-like figure across the two policies. It is an average, so it moves with basket size as well as with price.',
            before: aud(b?.customerPaysTotal, 2), after: aud(a?.customerPaysTotal, 2),
            change: signed(chg(a?.customerPaysTotal, b?.customerPaysTotal)),
          },
          {
            label: 'ZONOS duties + taxes, % of subtotal',
            tip: 'What ZONOS billed Dolo in duties and taxes, as a share of those same orders\' subtotal - counting only orders ZONOS has already billed. ZONOS bills Canada about a week after the parcel ships, so a side where fewer than half the orders are billed is shown grey: not readable yet.',
            before: zonosCell(b), after: zonosCell(a),
            change: readable(a) && readable(b) && a!.zonosDutiesTaxesPct != null && b!.zonosDutiesTaxesPct != null
              ? `${signed(Math.round((a!.zonosDutiesTaxesPct - b!.zonosDutiesTaxesPct) * 10) / 10, ' pts')}` : '—',
          },
        ];
        const priceUp = chg(a?.medianSubtotal, b?.medianSubtotal);
        return (
          <div className="rounded-xl border bg-card p-4">
            <div className="cursor-help text-sm font-bold"
              title={`${countryName(pc.country)} stopped adding duties and taxes at checkout and moved them into the price. Cutover read off the orders themselves: the last one charged tax and the next charged nothing, with no orders in between. Two windows of equal length either side of it, computed server-side; they grow together every day and ignore the date range above.`}>
              Before / after {cutLabel} (Brisbane) — duties + taxes moved into the price
              <span className="ml-2 font-normal text-muted-foreground text-[13px]">
                {pc.windowDays} days each side · independent of the date range above
              </span>
            </div>
            {pc.windowDays < 7 && (
              <div className="mt-1 text-[13px] text-amber-700 dark:text-amber-500">
                Less than a week each side, on different weekdays — an early read, not a verdict.
              </div>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[13px] tabular-nums">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1.5 pr-2 font-semibold" />
                    <th className="cursor-help py-1.5 pl-2 text-right font-semibold"
                      title={b ? `Orders placed ${new Date(b.from).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short' })} to the cutover. Duties and taxes added at checkout.` : 'No orders before the change.'}>
                      Before · charged at checkout
                    </th>
                    <th className="cursor-help py-1.5 pl-2 text-right font-semibold"
                      title={a ? `Orders placed from the cutover to ${new Date(a.to).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short' })}, the latest order synced. Duties and taxes included in the price.` : 'No orders since the change yet.'}>
                      After · included in the price
                    </th>
                    <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title="After against before: % change, or the difference where a percentage would mislead.">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="border-b border-border/60">
                      <td className="cursor-help py-1.5 pr-2" title={r.tip}>{r.label}</td>
                      <td className="py-1.5 pl-2 text-right">{r.before}</td>
                      <td className="py-1.5 pl-2 text-right font-semibold">{r.after}</td>
                      <td className="py-1.5 pl-2 text-right text-muted-foreground">{r.change}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-[13px] text-muted-foreground">
              {readable(a)
                ? <>The price rose <b className="text-foreground">{signed(priceUp)}</b> (median order); ZONOS bills <b className="text-foreground">{a!.zonosDutiesTaxesPct}%</b> of subtotal in duties and taxes on the orders placed after the change.</>
                : <>The cost side is not readable yet: ZONOS has billed <b className="text-foreground">{a?.zonosOrders ?? 0} of {a?.orders ?? 0}</b> orders placed after the change. It bills about a week after shipping. The price side already shows: median order {signed(priceUp)}.</>}
            </div>
          </div>
        );
      })()}

      {/* ── components + weekly ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <div className="cursor-help text-sm font-bold" title="Each pair: what checkout charged (dark) vs what it really cost (teal). Only matched orders compare - counting charged money from orders that have no cost in front of them yet would always flatter the checkout.">
            Charged vs paid, by component
            <span className="ml-2 font-normal text-muted-foreground text-[13px]">
              over {k ? `${k.matchedOrders} of ${k.orders}` : '…'} matched orders
            </span>
          </div>
          <div className="mb-3 mt-1 flex gap-4 text-[13px] text-muted-foreground">
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-slate-700" />Charged to customer</span>
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-teal-600" />Paid by Dolo</span>
          </div>
          {(data?.components ?? []).map((c) => {
            const meta = compMeta[c.key];
            if (!meta) return null;
            return (
              <div key={c.key} className="mb-4 cursor-help last:mb-0" title={meta.tip}>
                <div className="flex items-baseline justify-between text-[13px]">
                  <span className="font-medium">{meta.label} <span className="text-muted-foreground">({c.orders} orders)</span></span>
                  <b className={cn('tabular-nums', c.gap < 0 ? 'text-red-600' : 'text-emerald-700')}>gap {aud(c.gap)}</b>
                </div>
                <div className="mt-1 space-y-0.5">
                  <div className="flex h-3.5 items-center rounded bg-slate-700 text-[11px] font-semibold text-white"
                    style={{ width: `${Math.max(2, (c.charged / maxComp) * 100)}%` }}>
                    <span className="pl-1.5">{c.charged > 0 ? aud(c.charged) : ''}</span>
                  </div>
                  <div className="flex h-3.5 items-center rounded bg-teal-600 text-[11px] font-semibold text-white"
                    style={{ width: `${Math.max(2, (c.paid / maxComp) * 100)}%` }}>
                    <span className="pl-1.5">{c.paid > 0 ? aud(c.paid) : ''}</span>
                  </div>
                </div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">{meta.note(c)}</div>
              </div>
            );
          })}
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="cursor-help text-sm font-bold" title={T.weekly}>Weekly: charged vs paid</div>
          <div className="mb-2 mt-1 text-[13px] text-muted-foreground">Matched orders, store weeks — the vertical distance is what Dolo absorbs</div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weekly} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fontSize: 13 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 13 }} tickLine={false} axisLine={false} width={52}
                  tickFormatter={(v: number) => `$${v}`} />
                <ChartTooltip
                  formatter={(v: number, name: string) => [aud(v), name === 'charged' ? 'Charged to customers' : 'Paid by Dolo']}
                  labelFormatter={(l, p) => `Week of ${l}${p?.[0]?.payload?.orders ? ` · ${p[0].payload.orders} orders` : ''}`}
                  contentStyle={{ fontSize: 13 }}
                />
                <Line dataKey="charged" stroke="#334155" strokeWidth={2.5} dot={{ r: 3.5 }} />
                <Line dataKey="paid" stroke="#0d9488" strokeWidth={2.5} dot={{ r: 3.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-3 border-t pt-2.5">
            <div className="text-[13px] font-bold">Needs attention</div>
            {data && (
              <div className="mt-1 space-y-1 text-[13px] text-muted-foreground">
                {data.exceptions.awaitingZonos.length > 0 && (
                  <div title="DE/DK orders with no ZONOS record yet. ZONOS creates its order when the label goes through the Starshipit integration (live since 25 Aug); older orders may never appear there.">
                    <b className="text-foreground">{data.exceptions.awaitingZonos.length} orders</b> awaiting ZONOS
                    {' '}({data.exceptions.awaitingZonos.slice(0, 4).join(', ')}{data.exceptions.awaitingZonos.length > 4 ? '…' : ''})
                  </div>
                )}
                {data.exceptions.awaitingFreight.length > 0 && (
                  <div title="Orders with no Starshipit label. The 1–19 Aug ones shipped outside Starshipit (DHL Express booked directly) — their per-order freight is not recoverable from any connected API.">
                    <b className="text-foreground">{data.exceptions.awaitingFreight.length} orders</b> without freight cost
                    {' '}({data.exceptions.awaitingFreight.slice(0, 4).join(', ')}{data.exceptions.awaitingFreight.length > 4 ? '…' : ''})
                  </div>
                )}
                {data.exceptions.zonosUnmatched.length > 0 && (
                  <div title="ZONOS billed these trackings but no local order carries them — check the tracking numbers.">
                    <b className="text-foreground">{data.exceptions.zonosUnmatched.length} ZONOS charges</b> with no matching order
                  </div>
                )}
                {!data.exceptions.awaitingZonos.length && !data.exceptions.awaitingFreight.length && !data.exceptions.zonosUnmatched.length && (
                  <div>Every order in the window is fully matched.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── collapsible order ledger ─────────────────────────────────────── */}
      <div className="rounded-xl border bg-card">
        <button
          type="button"
          onClick={() => setLedgerOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-bold"
          title={T.ledger}
        >
          {ledgerOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Order ledger{data ? (data.ledgerTotal > data.ledger.length ? ` (${data.ledger.length} of ${data.ledgerTotal})` : ` (${data.ledger.length})`) : ''}
          <span className="ml-1 font-normal text-muted-foreground text-[13px]">one row per order, three sources side by side</span>
        </button>
        {ledgerOpen && (
          <div className="max-h-[65vh] overflow-auto px-4 pb-4">
            <table className="w-full min-w-[980px] border-collapse text-[13px] tabular-nums">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="text-[13px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1 pr-2 text-left" colSpan={3}></th>
                  <th className="border-l pb-1 text-center text-slate-700" colSpan={4}
                    title="What the customer paid at checkout. Source: Shopify, AUD (monthly FX).">Charged — Shopify</th>
                  <th className="border-l pb-1 text-center text-teal-700" colSpan={4}
                    title="What Dolo paid. Sources: Starshipit (freight) + ZONOS (duties, taxes, fees). AUD.">Paid — Starshipit + ZONOS</th>
                  <th className="border-l pb-1 text-center" title={T.colNet}>Net</th>
                </tr>
                <tr className="border-b text-left">
                  <th className="cursor-help py-1.5 pr-2 font-semibold" title={T.colOrder}>Order (tracking)</th>
                  <th className="py-1.5 pr-2 font-semibold">Date</th>
                  <th className="py-1.5 pr-2 font-semibold">Mkt</th>
                  <th className="cursor-help border-l py-1.5 pl-2 text-right font-semibold" title={T.colShip}>Ship</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colDuties}>Duties</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colTaxes}>Taxes</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colChargedTotal}>Total</th>
                  <th className="cursor-help border-l py-1.5 pl-2 text-right font-semibold" title={T.colFreight}>Freight</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colZonosDT}>ZONOS D+T</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colZonosFees}>Fees</th>
                  <th className="cursor-help py-1.5 pl-2 text-right font-semibold" title={T.colPaidTotal}>Total</th>
                  <th className="cursor-help border-l py-1.5 pl-2 text-right font-semibold" title={T.colNet}>Per order</th>
                </tr>
              </thead>
              <tbody>
                {(data?.ledger ?? []).map((r) => (
                  <tr key={r.order} className={cn('border-b border-border/60', !r.matched && 'text-muted-foreground')}
                    title={r.tracking ? `${r.tracking}${r.carrier ? ` · ${r.carrier}` : ''}` : 'no tracking yet'}>
                    {/* The tracking number is the ONLY handle ZONOS accepts — its
                        portal has no notion of a Shopify order name — so it is
                        printed, not left in a tooltip, and select-all so one
                        click grabs it whole for pasting over there. */}
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <span className="font-semibold text-foreground">{r.order}</span>
                      {r.tracking
                        ? <span className="ml-1 select-all font-normal text-muted-foreground">({r.tracking})</span>
                        : <span className="ml-1 font-normal italic text-muted-foreground/70">(no tracking)</span>}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">{new Date(`${r.date}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap"><span className="flex items-center gap-1.5"><Flag cc={r.country} /> {countryName(r.country)}</span></td>
                    <td className="border-l py-1.5 pl-2 text-right">{n2(r.chargedShipping)}</td>
                    <td className="py-1.5 pl-2 text-right">{r.chargesDuties === false ? <span title="Not charged - absorbed by policy.">—</span> : n2(r.chargedDuties)}</td>
                    <td className="py-1.5 pl-2 text-right">{r.chargesDuties === false
                      ? <span title="Nothing charged. Duties and import taxes are absorbed by policy, and the tax Shopify records on these orders sits inside the shelf price - it was never an amount added at checkout.">—</span>
                      : n2(r.chargedTaxes)}</td>
                    <td className="py-1.5 pl-2 text-right font-semibold text-foreground">{n2(r.chargedTotal)}</td>
                    <td className="border-l py-1.5 pl-2 text-right">
                      {r.freight !== null
                        ? n2(r.freight)
                        : r.freightChecked
                          ? <span className="rounded bg-muted px-1.5 py-0.5 text-[12px]" title="Starshipit was asked and has no label cost for this order: shipped outside Starshipit (DHL Express booked directly), or the label is not created yet. Retried every sync.">no label</span>
                          : <span className="rounded bg-muted px-1.5 py-0.5 text-[12px] italic" title="The sync has not reached this order yet. Freight is fetched newest-first, about fifty orders a run, one Starshipit call each - the USA backlog is thousands of orders deep and drains over the day.">awaiting</span>}
                    </td>
                    <td className="py-1.5 pl-2 text-right">
                      {!r.zonosExpected
                        ? <span title="This market does not bill through ZONOS, so there is nothing to match — freight alone completes the order.">n/a</span>
                        : r.zonosDT === null
                          ? <span className="rounded bg-muted px-1.5 py-0.5 text-[12px]" title="No ZONOS record yet. They arrive days after the parcel ships, once it clears customs.">awaiting</span>
                          : n2(r.zonosDT)}
                    </td>
                    <td className="py-1.5 pl-2 text-right">{!r.zonosExpected ? '—' : r.zonosFees === null ? '' : n2(r.zonosFees)}</td>
                    <td className="py-1.5 pl-2 text-right font-semibold text-foreground">{r.paidTotal === null ? '—' : n2(r.paidTotal)}</td>
                    <td className="border-l py-1.5 pl-2 text-right">
                      {r.net === null ? '—' : (
                        <span className={cn('rounded px-1.5 py-0.5 font-semibold', r.net < 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700')}>
                          {n2(r.net)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-bold">
                  <td className="py-2 pr-2" colSpan={3}
                    title={data && data.ledgerTotal > data.ledger.length
                      ? `Totals below are over the ${data.ledger.length} rows shown, not all ${data.ledgerTotal} orders. Use "Load more" to widen them - the KPI cards above are always over every order.`
                      : 'Totals over every order in the window.'}>
                    {data?.ledger.length ?? 0}{data && data.ledgerTotal > data.ledger.length ? ` of ${data.ledgerTotal}` : ''} orders
                    {data && data.ledgerTotal > data.ledger.length && <span className="ml-1 font-normal text-amber-700 dark:text-amber-500">(totals over rows shown)</span>}
                  </td>
                  <td className="border-l py-2 pl-2 text-right">{n2(totals.ship)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.duties)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.taxes)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.charged)}</td>
                  <td className="border-l py-2 pl-2 text-right">{n2(totals.freight)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.zonosDT)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.zonosFees)}</td>
                  <td className="py-2 pl-2 text-right">{n2(totals.paid)}</td>
                  <td className={cn('border-l py-2 pl-2 text-right', totals.net < 0 ? 'text-red-600' : 'text-emerald-700')}
                    title="Sum over matched orders only.">{n2(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
            {data && data.ledgerTotal > data.ledger.length && (
              <div className="mt-3 flex items-center gap-3 text-[13px] text-muted-foreground">
                <span>Showing the newest {data.ledger.length} of {data.ledgerTotal} orders.</span>
                <Button size="sm" variant="outline" onClick={() => setLedgerLimit((l) => Math.min(l * 3, data.ledgerTotal))}>
                  Load more
                </Button>
              </div>
            )}
            <div className="mt-2 text-[13px] text-muted-foreground">
              Grey rows are not fully matched yet and stay out of Net absorbed. The tracking number sits beside each order name; one click selects it.
            </div>
          </div>
        )}
      </div>
      </>)}

      {loading && !segment && <div className="text-[13px] text-muted-foreground">Loading…</div>}
    </div>
  );
}


// =============================================================================
// A service segment of a market — today: United States · IC13.
//
// Mario, 14-Oct-2026: a Starshipit rule ships EVERY United States order on IC13
// (Australia Post Express, 5-6 days) whatever the customer paid, because the US
// parcel rules change around 25-Oct and IC13 is outside them for now.
//
// The screen answers one question first: HOW MUCH HAVE WE ALREADY SPENT. Mario
// rejected the earlier version for leading with the monthly figure — "eso no
// deja de ser una proyección; lo que me interesa es cuánto llevo gastado de
// diferencia". So the hero is cash already out the door, over the labels that
// really exist, and the projection sits to the right, smaller and muted.
//
// Design E (app-native): no cards, no fills, no shadows, no uppercase labels.
// Hierarchy is weight and size; hairlines separate. Colour appears once, a
// desaturated pine on the sign of a number — the previous attempt was rejected
// as "too much red". Every figure, column header and dash carries its
// definition in a title= tooltip; the page itself holds no prose, because
// explanations sitting on the page are what made it unreadable.
//
// The order ledger stays fully on the page, never behind a toggle: it is how
// Mario cross-checks every figure above it against Shopify and Starshipit.
// =============================================================================
function SegmentView({ code, from, to, marketName, refreshKey }: {
  code: string; from: string; to: string; marketName: (cc: string) => string;
  /** Changes after the Refresh button finishes a sync: refetch. */
  refreshKey: number;
}) {
  const [data, setData] = useState<SegPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ledgerLimit, setLedgerLimit] = useState(60);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    void supabase
      .rpc('ddp_service_segment_dashboard', { p_code: code, p_from: from, p_to: to, p_ledger_limit: ledgerLimit })
      .then(({ data: d, error: e }) => {
        if (!live) return;
        if (e) setError(e.message); else setData(d as unknown as SegPayload);
        setLoading(false);
      });
    return () => { live = false; };
  }, [code, from, to, ledgerLimit, refreshKey]);

  if (error) return <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[13px]">{error}</div>;
  if (!data?.segment) return <div className="text-[13px] text-muted-foreground">Loading…</div>;

  const seg = data.segment;
  const k = data.kpis;
  const ad = k.adherence;
  const svc = seg.serviceCode;
  const bands = data.bands ?? [];
  // The band carrying the most orders — the one decisions turn on. Its name is
  // set in medium weight so the eye lands there first.
  const mainBand = bands.reduce<SegBand | null>((a, b) => (!a || b.orders > a.orders ? b : a), null);
  const series = data.labelSeries ?? [];
  const ruleLabel = new Date(seg.ruleFrom).toLocaleDateString('en-AU', {
    timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric',
  });
  const money = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined ? '—' : Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const signed = (v: number | null | undefined, dec = 2) =>
    v === null || v === undefined ? '—' : `${v < 0 ? '−' : '+'}${money(v, dec)}`;

  // Sparkline geometry. One bar per priced label, oldest first, on a shared
  // scale with a real zero line — a label that came in CHEAPER than the old
  // service has to be able to sit below it.
  const sw = 150, sh = 38, gap = 2;
  const exs = series.map((s) => s.extra ?? 0);
  const hi = Math.max(0.01, ...exs), lo = Math.min(0, ...exs);
  const zeroY = (hi / (hi - lo)) * (sh - 4) + 2;
  const barW = series.length ? Math.max(2, (sw - gap * (series.length - 1)) / series.length) : 0;

  // "Was → now" slope, one shared scale across the bands so the four are
  // comparable at a glance.
  const slopeMax = Math.max(1, ...bands.flatMap((b) => [b.baseline ?? 0, b.costAvg ?? 0]));
  const slopeY = (v: number) => 16 - (v / slopeMax) * 12;

  // The gap the same orders already had before the rule: what customers paid
  // minus what those parcels used to cost. The gap today is this plus the extra.
  const gapBefore = k.chargedTotal !== null && k.beforeTotal !== null ? k.chargedTotal - k.beforeTotal : null;

  const T = {
    hero: `Money already spent, not a forecast: what the ${k.segOrders} ${svc} labels cost (${aud(k.costTotal, 2)}) minus what those same parcels cost to ship before the rule (${aud(k.beforeTotal, 2)}).`,
    spark: `One bar per label, oldest on the left. The line is zero — a bar below it is a label that came out cheaper than before. Hover a bar to see the order.`,
    spent: `The full price of those labels, everything paid to Australia Post. Not the extra part — that is the big figure on the left.`,
    gap: `Customers paid ${aud(k.chargedTotal, 2)} for shipping and the labels cost ${aud(k.costTotal, 2)}. Negative means Dolo covers the difference. Before the rule this gap was ${aud(gapBefore, 2)}; the rest is the extra on the left.`,
    labels: `Orders placed since the rule that already have a priced label, of any service. The rest are still queued: the label price has to be asked of Starshipit one order at a time.`,
    proj: `A projection, not money spent. The extra per order carried across a full month at the current order rate.`,
    bands: `The same orders split by cart size, in USD. Cart size is what tracks the parcel - a one-item box and a heavy one never cost the same - so each band keeps its own before-cost. Split by what the customer paid this no longer works: one flat rate covers every cart under US$130.`,
    was: `What this same parcel cost to ship before the rule: standard Australia Post labels on orders of this cart size placed between the 21-Sep rate change and the rule. Frozen, never recalculated.`,
    card: `Shipping rate card in force for ${marketName(seg.country)}. The start time is read off the orders: the last one charged on the old card and the first on the new.`,
    adherence: `Read off the service printed on the label, not off the rule. Over the orders placed since the rule that already have a label.`,
    ledger: `One row per order since the rule. Shopify on the left, Starshipit on the right, the two calculated columns last. This is where every figure above can be checked.`,
  };

  const th = 'border-b border-border/70 pb-[7px] text-left text-[13px] font-medium text-foreground/80 whitespace-nowrap';
  const td = 'border-b border-border/40 py-[7px] whitespace-nowrap';

  return (
    <div className="text-[14px] tabular-nums">
      {/* ── header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 pb-4">
        <h2 className="text-[19px] font-semibold leading-tight tracking-[-0.015em]"
          title={seg.note ?? `Cost of the Starshipit rule that forces every ${marketName(seg.country)} order onto ${svc}.`}>
          {seg.name}
        </h2>
        <span className="cursor-help text-[13px] text-muted-foreground"
          title={`Every ${marketName(seg.country)} order has shipped on ${svc} since ${ruleLabel}, whatever shipping the customer paid.`}>
          Australia Post Express 5–6 d · rule from {ruleLabel}
        </span>
        {seg.rateCard && (
          <span className="cursor-help text-[13px] text-muted-foreground" title={T.card}>
            · {seg.rateCard.label} since{' '}
            {new Date(seg.rateCard.from).toLocaleString('en-AU', {
              timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
            })}
          </span>
        )}
        <span className="ml-auto cursor-help text-[13px] text-muted-foreground"
          title="Orders and what was charged come from Shopify. The service and the label price come from Starshipit.">
          Source <b className="font-medium text-foreground/80">Shopify + Starshipit</b>
        </span>
      </div>

      {/* ── hero: cash already spent, then the supporting figures ───────── */}
      <div className="flex flex-wrap items-end gap-y-5 border-t border-border/70 pt-5">
        <div className="pr-8">
          <div className="cursor-help text-[13px] font-medium text-foreground/80" title={T.hero}>
            Extra actually spent since the rule
          </div>
          <div className="mt-1.5 flex items-baseline gap-[3px] text-[50px] font-semibold leading-[1.02] tracking-[-0.03em]"
            title={T.hero}>
            <span className="translate-y-[-0.08em] text-[0.44em] font-medium text-muted-foreground">A$</span>
            {money(k.extraTotal)}
          </div>
          {/* The subtraction itself, in numbers: Mario redoes these by hand,
              and a difference shown without its two operands can't be checked. */}
          <div className="mt-1.5 cursor-help text-[13px] text-muted-foreground" title={T.hero}>
            {aud(k.costTotal, 2)} now − {aud(k.beforeTotal, 2)} before the rule
          </div>
        </div>

        {series.length > 1 && (
          <div className="self-end border-l border-border/60 pb-1 pl-7">
            <div className="cursor-help text-[13px] font-medium text-foreground/80" title={T.spark}>Extra per label</div>
            <svg width={sw} height={sh} className="mt-2 block" role="img" aria-label="Extra cost per label, oldest to newest">
              {series.map((s, i) => {
                const v = s.extra ?? 0;
                const h = Math.abs(v) / (hi - lo) * (sh - 4);
                return (
                  <rect key={`${s.order}-${i}`} x={i * (barW + gap)} width={barW}
                    y={v >= 0 ? zeroY - h : zeroY} height={Math.max(1.5, h)}
                    className={v < 0 ? 'fill-emerald-800/55' : 'fill-muted-foreground/35'}>
                    <title>{`${s.order} · ${s.service ?? '—'} · extra ${signed(s.extra)}`}</title>
                  </rect>
                );
              })}
              <line x1={0} y1={zeroY} x2={sw} y2={zeroY} className="stroke-border" strokeWidth={1} />
            </svg>
            <div className="mt-1 flex justify-between text-[12.5px] text-muted-foreground/80" style={{ width: sw }}>
              <span title="Oldest priced label.">{series[0]?.order?.replace(/^\D+/, '')}</span>
              <span title="Newest priced label.">{series[series.length - 1]?.order?.replace(/^\D+/, '')}</span>
            </div>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-end gap-y-4 self-end pb-1">
          <div className="min-w-[132px] pl-0">
            <div className="cursor-help text-[13px] font-medium text-foreground/80" title={T.spent}>
              Total label cost
            </div>
            <div className="mt-1 text-[21px] font-semibold tracking-[-0.018em]" title={T.spent}>
              <span className="text-[0.68em] font-medium text-muted-foreground">A$</span>
              {money(k.costTotal)}
            </div>
            <div className="text-[12.5px] text-muted-foreground/80">
              {k.segOrders} {svc} label{k.segOrders === 1 ? '' : 's'} · A${money(k.costAvg)} each
            </div>
          </div>

          <div className="ml-7 min-w-[132px] border-l border-border/60 pl-7">
            <div className="cursor-help text-[13px] font-medium text-foreground/80" title={T.gap}>Shipping gap so far</div>
            <div className={cn('mt-1 text-[21px] font-semibold tracking-[-0.018em]',
              (k.marginTotal ?? 0) < 0 && 'text-emerald-800 dark:text-emerald-500')} title={T.gap}>
              {(k.marginTotal ?? 0) < 0 ? '−' : ''}
              <span className="text-[0.68em] font-medium text-muted-foreground">A$</span>
              {money(k.marginTotal)}
            </div>
            <div className="cursor-help text-[12.5px] text-muted-foreground/80" title={T.gap}>
              {aud(k.chargedTotal, 2)} paid − {aud(k.costTotal, 2)} labels
            </div>
          </div>

          <div className="ml-7 min-w-[132px] border-l border-border/60 pl-7">
            <div className="cursor-help text-[13px] font-medium text-foreground/80" title={T.labels}>Orders priced</div>
            <div className="mt-1 text-[21px] font-semibold tracking-[-0.018em]" title={T.labels}>
              {ad.labelled}
              <span className="ml-1 text-[0.76em] font-normal text-muted-foreground">/ {ad.orders}</span>
            </div>
            <svg width={120} height={5} className="mt-[7px] block" role="img" aria-label={`${ad.labelled} of ${ad.orders} orders labelled`}>
              <rect x={0} y={0} width={120} height={5} rx={2.5} className="fill-border" />
              <rect x={0} y={0} width={Math.max(2, (120 * (ad.coveragePct ?? 0)) / 100)} height={5} rx={2.5} className="fill-foreground/70" />
            </svg>
            <div className="mt-[3px] cursor-help text-[12.5px] text-muted-foreground/80"
              title="A job runs every 20 minutes pulling the pending label prices, so this fills in on its own.">
              queue clearing on its own
            </div>
          </div>

          {/* The projection: deliberately the smallest and the only muted block
              on the row, because it is the number Mario did NOT want led with. */}
          <div className="ml-7 min-w-[132px] border-l border-border/60 pl-7">
            <div className="cursor-help text-[13px] text-muted-foreground" title={T.proj}>Projection · per month</div>
            <div className="mt-1 text-[17px] font-medium tracking-[-0.01em] text-muted-foreground" title={T.proj}>
              ≈<span className="text-[0.68em]">A$</span>{k.projMonthly === null ? '—' : Math.abs(k.projMonthly).toLocaleString('en-AU')}
            </div>
            <div className="mt-[3px] text-[12.5px] text-muted-foreground/80">
              at {k.ordersPerDay ?? '—'} {marketName(seg.country) === 'United States' ? 'US' : ''} orders/day
            </div>
          </div>
        </div>
      </div>

      {/* ── bands + adherence ───────────────────────────────────────────── */}
      <div className="mt-8 grid grid-cols-1 gap-x-12 gap-y-8 lg:grid-cols-[1fr_330px]">
        <section>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h3 className="cursor-help text-[13.5px] font-semibold" title={T.bands}>By cart size</h3>
            <span className="ml-auto cursor-help text-[13px] text-muted-foreground"
              title={`Only the ${svc} labels. The "Orders priced" figure above counts labels of ANY service, so it is larger.`}>
              {k.segOrders} {svc} label{k.segOrders === 1 ? '' : 's'}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse">
              <thead>
                <tr>
                  <th className={cn(th, 'cursor-help')} title="What the customer spent on products, in USD - the figure the rate card's limits are written in.">Cart size</th>
                  <th className={cn(th, 'cursor-help text-right')} title="What this cart size is charged for shipping: under the previous rate card, then under the one in force.">Pays</th>
                  <th className={cn(th, 'cursor-help text-right')} title={`${svc} labels priced in this band so far. Labels of other services are not counted here.`}>{svc} labels</th>
                  <th className={cn(th, 'cursor-help border-l border-border/50 pl-4 text-right')} title="Money already spent above what these parcels cost before the rule, summed over this band's labels. AUD.">Extra so far</th>
                  <th className={cn(th, 'cursor-help pl-[18px]')} title="Left dot: what it cost before. Right dot: what it costs now. All bands share one scale.">Was → now</th>
                  <th className={cn(th, 'cursor-help text-right')} title={`Average ${svc} label cost in this band, AUD.`}>{svc} label avg</th>
                  <th className={cn(th, 'cursor-help text-right')} title={T.was}>Was</th>
                  <th className={cn(th, 'cursor-help border-l border-border/50 pl-4 text-right')}
                    title={`What the customer paid for shipping minus the ${svc} label, per order, counting ONLY orders under the rate card in force. Blank until those labels come in.`}>Gap / order now</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => {
                  const usd = (v: number | null) => (v === null ? null : v === 0 ? 'free' : `US$${v}`);
                  const before = usd(b.paysBeforeUsd), now = usd(b.paysNowUsd);
                  return (
                    <tr key={b.key} className={cn('hover:bg-muted/40', b.segment === 0 && 'text-muted-foreground')}
                      title={b.segment === 0
                        ? `No ${svc} label has landed in this band yet — its cost is unknown, not zero.`
                        : `${b.orders.toLocaleString('en-AU')} orders in the window, ${b.labelled} with a label, ${b.segment} of them ${svc}.`}>
                      <td className={cn(td, b.key === mainBand?.key ? 'font-medium text-foreground' : '')}>{b.label}</td>
                      <td className={cn(td, 'text-right text-[13px]')}>
                        {now === null
                          ? <span className="text-muted-foreground">live quote</span>
                          : before === null || before === now
                            ? now
                            : <><span className="text-muted-foreground">{before} →</span> <b className="font-medium text-foreground">{now}</b></>}
                      </td>
                      <td className={cn(td, 'text-right')}>{b.segment}</td>
                      <td className={cn(td, 'border-l border-border/40 pl-4 text-right font-medium',
                        (b.extraSoFar ?? 0) < 0 && 'text-emerald-800 dark:text-emerald-500')}>
                        {b.extraSoFar === null || b.extraSoFar === undefined ? '—' : signed(b.extraSoFar)}
                      </td>
                      <td className={cn(td, 'pl-[18px]')}>
                        {b.costAvg === null ? (
                          <span className="text-muted-foreground/60">—</span>
                        ) : (
                          <svg width={72} height={18} role="img"
                            aria-label={`was ${b.baseline}, now ${b.costAvg}`}>
                            <line x1={6} y1={slopeY(b.baseline)} x2={66} y2={slopeY(b.costAvg)}
                              className="stroke-foreground/50" strokeWidth={1.25} />
                            <circle cx={6} cy={slopeY(b.baseline)} r={2} className="fill-muted-foreground/50" />
                            <circle cx={66} cy={slopeY(b.costAvg)} r={2.3} className="fill-foreground" />
                          </svg>
                        )}
                      </td>
                      <td className={cn(td, 'text-right')}>{money(b.costAvg)}</td>
                      <td className={cn(td, 'text-right text-muted-foreground')}>{money(b.baseline)}</td>
                      <td className={cn(td, 'border-l border-border/40 pl-4 text-right',
                        b.gapNow !== null && b.gapNow < 0 && 'text-emerald-800 dark:text-emerald-500')}
                        title={b.gapNow === null ? 'No label under the rate card in force yet.' : `${b.labelsNow} label${b.labelsNow === 1 ? '' : 's'} under the rate card in force.`}>
                        {b.gapNow === null
                          ? <span className="text-muted-foreground/60">—</span>
                          : <>{signed(b.gapNow)}<span className="ml-1 text-[12px] text-muted-foreground">({b.labelsNow})</span></>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-baseline gap-2.5">
            <h3 className="cursor-help text-[13.5px] font-semibold" title={T.adherence}>Rule adherence</h3>
          </div>
          <div className="flex items-baseline justify-between text-[13px] text-foreground/80">
            <span title={`Orders that really left on ${svc}.`}>{svc}</span>
            <span title="Orders the rule did not catch.">
              {(data.services ?? []).find((s) => !s.isSegment)?.code ?? 'other'}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <b className="text-[21px] font-semibold tracking-[-0.018em]">{ad.pct === null ? '—' : `${ad.pct}%`}</b>
            <b className="text-[21px] font-semibold tracking-[-0.018em] text-muted-foreground">
              {ad.pct === null ? '—' : `${Math.round((100 - ad.pct) * 10) / 10}%`}
            </b>
          </div>
          <div className="mb-2 mt-3 flex h-[7px] overflow-hidden rounded-full bg-border" title={T.adherence}>
            <div className="bg-foreground/75" style={{ width: `${ad.pct ?? 0}%` }} />
          </div>
          <div className="mt-4 border-t border-border/50">
            {(data.services ?? []).filter((s) => !s.isSegment && s.costAvg !== null).slice(0, 2).map((s) => (
              <div key={s.code} className="flex items-baseline justify-between border-b border-border/40 py-[7px] text-[13px] text-foreground/80"
                title={`${s.orders} labelled orders since the rule left on ${s.code}${s.name ? ` (${s.name})` : ''}. Each one is money not spent, and a parcel outside the new US rules.`}>
                <span>{s.code} label cost</span>
                <b className="text-[14px] font-semibold text-foreground">A${money(s.costAvg)}</b>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-b border-border/40 py-[7px] text-[13px] text-foreground/80"
              title={`Average ${svc} label cost over every band.`}>
              <span>{svc} label avg</span>
              <b className="text-[14px] font-semibold text-foreground">A${money(k.costAvg)}</b>
            </div>
            <div className="flex items-baseline justify-between border-b border-border/40 py-[7px] text-[13px] text-foreground/80"
              title={`What the rule adds on an average order, weighting each band by how many orders it carries. Covers ${k.bandsCoveredPct ?? '—'}% of orders.`}>
              <span>Per parcel difference</span>
              <b className="text-[14px] font-semibold text-foreground">{signed(k.extraPerOrder)}</b>
            </div>
            <div className="flex items-baseline justify-between py-[7px] text-[13px] text-foreground/80"
              title={`${marketName(seg.country)} orders placed since the rule started, labelled or not.`}>
              <span>Orders since the rule</span>
              <b className="text-[14px] font-semibold text-foreground">{ad.orders}</b>
            </div>
          </div>
        </section>
      </div>

      {/* ── order ledger: always on the page, never behind a toggle ─────── */}
      <section className="mt-8">
        <div className="mb-2 flex items-baseline gap-2.5">
          <h3 className="cursor-help text-[13.5px] font-semibold" title={T.ledger}>Order ledger</h3>
          <span className="ml-auto text-[13px] text-muted-foreground">
            {data.ledger.length} of {data.ledgerTotal} orders since the rule
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                <th className={cn(th, 'cursor-help')} title="The Shopify order name.">Order</th>
                <th className={cn(th, 'cursor-help')} title="Tracking number. One click selects it whole, to paste into Starshipit or ZONOS.">Tracking</th>
                <th className={cn(th, 'cursor-help text-right')} title="What the customer spent on products, in USD - the currency they saw and the one the rate card's limits are written in.">Cart US$</th>
                <th className={cn(th, 'cursor-help text-right')} title="What the customer paid for shipping, in the currency they were charged.">Customer paid USD</th>
                <th className={cn(th, 'cursor-help text-right')} title="The same shipping charge, converted to AUD.">Charged A$</th>
                <th className={cn(th, 'cursor-help border-l border-border/50 pl-4')} title="The service printed on the label. Blank until the label exists.">Service</th>
                <th className={cn(th, 'cursor-help text-right')} title="What the label cost, in AUD.">Label A$</th>
                <th className={cn(th, 'cursor-help text-right')} title={T.was}>Was A$</th>
                <th className={cn(th, 'cursor-help text-right')} title="Label cost minus what this parcel cost before the rule. What the rule added on this order.">Extra A$</th>
                <th className={cn(th, 'cursor-help text-right')} title="What the customer paid for shipping minus what the label cost. Negative means Dolo covers the difference.">Gap A$</th>
              </tr>
            </thead>
            <tbody>
              {data.ledger.map((r) => (
                <tr key={r.order} className={cn('hover:bg-muted/40', !r.labelled && 'text-muted-foreground')}>
                  <td className={cn(td, 'font-medium text-foreground')}>{r.order}</td>
                  <td className={cn(td, 'select-all text-[12.5px] tracking-[-0.015em] text-muted-foreground')}>
                    {r.tracking ?? <span className="italic text-muted-foreground/70">no tracking yet</span>}
                  </td>
                  <td className={cn(td, 'text-right text-muted-foreground')} title={r.card ? `Rate card: ${r.card}` : undefined}>{money(r.cartUsd)}</td>
                  <td className={cn(td, 'text-right text-muted-foreground')}>{money(r.chargedUsd)}</td>
                  <td className={cn(td, 'text-right')}>{money(r.charged)}</td>
                  <td className={cn(td, 'border-l border-border/40 pl-4 text-[13px]')}>
                    {r.service
                      ? <span className={cn(r.isSegment ? 'font-medium text-foreground' : 'text-amber-700 dark:text-amber-500')}
                          title={r.serviceName ?? r.carrier ?? ''}>{r.service}</span>
                      : <span className="italic text-muted-foreground/70"
                          title={r.freightChecked
                            ? 'Starshipit was asked and has no label for this order yet.'
                            : 'The sync has not reached this order yet. Labels are fetched a few dozen per run.'}>
                          {r.freightChecked ? 'no label' : 'awaiting'}
                        </span>}
                  </td>
                  <td className={cn(td, 'text-right')}>{money(r.freight)}</td>
                  <td className={cn(td, 'text-right text-muted-foreground')}>{money(r.baseline)}</td>
                  <td className={cn(td, 'text-right font-medium',
                    r.extra !== null && r.extra < 0 && 'text-emerald-800 dark:text-emerald-500')}>
                    {r.extra === null ? <span className="text-muted-foreground/60" title="No label of this service on this order.">—</span> : signed(r.extra)}
                  </td>
                  <td className={cn(td, 'text-right text-[13.5px] text-foreground/80',
                    r.margin !== null && r.margin < 0 && 'text-emerald-800 dark:text-emerald-500')}>
                    {r.margin === null ? <span className="text-muted-foreground/60">—</span> : signed(r.margin)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.ledgerTotal > data.ledger.length && (
          <div className="mt-3 flex items-center gap-3 text-[13px] text-muted-foreground">
            <span>Showing the newest {data.ledger.length} of {data.ledgerTotal}.</span>
            <Button size="sm" variant="outline" onClick={() => setLedgerLimit((l) => Math.min(l * 4, data.ledgerTotal))}>
              Load more
            </Button>
          </div>
        )}
      </section>

      {loading && <div className="mt-3 text-[13px] text-muted-foreground">Loading…</div>}
    </div>
  );
}
