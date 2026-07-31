import { useState, useEffect, useCallback, useMemo, useRef, Fragment, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react';
import { format, subDays } from 'date-fns';
import { Calendar as CalendarIcon, Loader2, AlertTriangle, RefreshCw, BookOpen, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Calendar } from '@/components/ui/calendar';
import { DateRangePresets } from '@/components/DateRangePresets';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { SkuSalesDialog } from '@/components/SkuSalesDialog';

interface DateRange { from?: Date; to?: Date; }
interface WebUpgradeTabProps { dateRange?: DateRange; setDateRange?: (r: DateRange) => void; }
type Env = 'production' | 'preview' | 'all';
type View = 'daily' | 'modules' | 'products' | 'blocks';

interface Dash {
  params: { from: string; to: string; environment: string };
  totals: { exposedSessions: number; totalEvents: number; directOrders: number; directLines: number; directRevenue: number; assistedOrders: number };
  modules: Array<{ module: string; sessions: number; views: number; selects: number; clicks: number; adds: number; ctr: number | null; addsPerSession: number | null; orders: number; revenue: number; aov: number | null }>;
  compatFunnel: { pageViews: number; modelSelect: number; addClicks: number; addSuccess: number; sessions: number; completeKit: number; orders: number } | null;
  byBrand: Array<{ brand: string; selects: number; addClicks: number; adds: number }>;
  byModel: Array<{ brand: string; model: string; selects: number; addClicks: number; adds: number }>;
  byScreen: Array<{ sku: string; fitment: string | null; title: string; clicks: number; adds: number; attributedRevenue: number; unitsPerWeek: number; baselineUnitsPerWeek: number; deltaPct: number | null }>;
  rewards: Array<{ name: string; unlocks: number; sessions: number; bought: number }>;
  storeShare: { storeOrders: number; storeRevenue: number; upgradeOrders: number; upgradeOrderRevenue?: number; attributedRevenue: number; orderSharePct: number | null; revenueSharePct: number | null; preLaunchAov?: number | null; preLaunchItems?: number | null; preLaunchOrders?: number | null; preLaunchFrom?: string | null; preLaunchTo?: string | null } | null;
  orderImpact: { upgradeOrders: number; upgradeAov: number | null; upgradeItems: number | null; otherOrders: number; otherAov: number | null; otherItems: number | null; aovLiftPct: number | null; itemsLiftPct: number | null } | null;
  // The compatibility entry point, keyed by surface: `mobile` is the orange bar
  // (compatibility_bar_*), `desktop` the orange button (compatibility_button_*).
  // A surface only appears once it emits. Measured apart from the modules on
  // purpose: inside `ev` these views would count every page of the site as an
  // exposed module session.
  compatibilityBar?: Partial<Record<'mobile' | 'desktop', { views: number; clicks: number; sessions: number; clickSessions: number; ctr: number | null }>> | null;
  bySource: Array<{ source: string; orders: number; lines: number; revenue: number; addedItems: number; addedPerOrder: number | null; aov: number | null; itemsPerOrder: number | null }>;
  byMachine: Array<{ machine: string; orders: number; lines: number; revenue: number; variants: Array<{ label: string; orders: number; lines: number; revenue: number }> | null }>;
  byFamily: Array<{ family: string; lines: number; revenue: number }>;
  trend: Array<{ d: string; events: number; sessions: number; attributedRevenue?: number; storeRevenue?: number }>;
}

const HELP: Record<string, string> = {
  module: 'Each module end to end: sessions exposed → views → clicks → adds (into the cart) → ORDERS (actually paid for) and the revenue behind them. The funnel columns are real-time from the pixel; the Orders/Revenue columns come from the Shopify sales sync — refreshed every few minutes by the fast sales sync (default 5 min — interval configurable in Config → Connections), with a full reconciliation 3×/day — so they can lag a few minutes. Adding to a cart is not a purchase — Orders is the real bottom line.',
  rewards: 'Reward tiers shoppers crossed IN THEIR CART, listed lowest tier first (free shipping $100 → 10% off $200 → 15% off $300). "carts" = distinct sessions whose basket reached that threshold; "bought" = how many of those sessions actually completed a purchase. Crossing a tier is intent, not a sale — expect far more unlocks than orders, because most carts are abandoned.',
  impact: 'A simple question: do people who use an upgrade module end up buying MORE per order than everyone else? It takes every paid order in the window, splits them into "used an upgrade module" vs "did not", and compares the average order value (AOV) and the average number of items. It is an observed gap between two groups of shoppers, not a controlled test.',
  compat: 'Activity on the standalone Compatibility Guide page (/pages/compatibility-guide) — where a shopper browses by machine brand → model to find compatible parts. This is that page\'s funnel, end to end: landed on the page → picked their machine → clicked add → add confirmed. It stays empty until someone uses that page (adds made on a normal product page show up under the other sections, not here).',
  brand: 'Which machine brand visitors picked in the guide, with each specific model listed underneath it. A brand (or model) with many picks but few adds means the guide finds their machine but the offer does not land.',
  screen: 'Only products a customer added THROUGH an upgrade module (machine finder or a recommendation). A product added with the normal Add-to-cart button is the base product, not a module add, so it will not appear here. Shows module clicks/adds plus sales now vs the frozen pre-launch run rate — the delta is a before/after observation (ad spend and seasonality move it too), not proof the modules caused it.',
  conv: 'Conversion rate: paid orders ÷ exposed sessions. The share of people who saw the module and ended up buying something it added.',
  rps: 'Revenue per session: attributed revenue ÷ exposed sessions. What each exposed visitor is worth — the best number for comparing modules with very different traffic.',
  env: 'preview = test traffic (theme preview). production = live customers. Commercial stats use production.',
};

// Definition tooltips (data-def): ~40 terms, written as explanations rather than
// restatements. Lifted verbatim from the design mock. Rendered by a single
// delegated floating card (see onDefOver in the component) so SVG hover targets
// work too — Radix stays for the image tooltips (ModuleTip) and legacy HELP.
const DEFS = {
  storeImpact: 'How much of the whole store — not just upgrade traffic — runs through a module. Click to open the full store breakdown.',
  exposed: 'Unique browsing sessions in which at least one upgrade module rendered on screen. Counted once per session, however many times the module appeared.',
  directRevenue: 'Net revenue of the order lines a module placed — the customer clicked add inside the module. It excludes the rest of that basket. The smaller figure after the slash is the whole store’s net revenue in the same window, and the bar is the share.',
  directOrders: 'Paid orders containing at least one line a module placed. The smaller figure after the slash is EVERY paid store order in the same window (module or not), and the bar is the share.',
  assisted: 'Paid orders carrying a module attribution id whose lines were added somewhere else — the module was seen, the add happened later.',
  trendChart: 'Net revenue of module-placed lines, by day. Hover a day for its numbers. The last day in the window is still filling.',
  ranking: 'Modules ranked by attributed revenue per exposed session. Revenue alone rewards whichever module sits on the busiest page.',
  insideTouched: 'Of the money those orders billed, how much the module put in the basket and how much the customer came for anyway.',
  modulePlaced: 'Order lines added by a click inside a module — the accessory the module put in the basket.',
  alreadyInBasket: 'Everything else in those same orders: the product the customer came for regardless of the module.',
  growOrder: 'Orders that used an upgrade module, measured against the store BEFORE the modules existed — the frozen 84-day window ending Jul 21, every order in the shop. Not an A/B test: product mix, ad spend and seasonality also move these numbers. The comparison against today’s no-module shoppers is shown underneath, but that group self-selects — someone using a compatibility finder already arrives with accessory intent, so the group without one is missing exactly the baskets a module would have grown.',
  rps: 'Attributed revenue divided by exposed sessions. The only fair way to rank modules whose traffic differs by 20×.',
  conversion: 'Share of exposed sessions that ended in a paid order containing a line from this module.',
  aov: 'Average value of the paid orders this module contributed to — the whole order, not just the line the module placed.',
  dropoff: 'The four funnel stages with the conversion of each step between them. The percentages, not the bar heights, are what to read.',
  views: 'Times the module rendered on screen. One session can produce several.',
  ctr: 'Views that became a click on something inside the module. Low CTR means the module is not being noticed or not being believed.',
  clicks: 'Interactions with a product inside the module.',
  add: 'Clicks that ended with the item actually in the cart. A gap here is a broken add, not a weak offer.',
  adds: 'Successful add-to-cart events fired from inside the module.',
  close: 'Cart adds that survived to a paid order.',
  orders: 'Paid orders containing at least one line from this module.',
  runRate: 'Units sold per week today against the weekly run rate frozen before the Jul 23 launch.',
  family: 'SKU grouping derived from the product code prefix plus the detected size, the same rule the SKU table already uses.',
  colAdds: 'Times a MODULE put this product in a cart (for the variants in view). An add is not a sale — the cart can still be abandoned.',
  colAttributed: 'Net revenue of PAID orders where a module placed the line — only the module’s slice of this product’s sales. A "—" next to real adds means the module put it in carts but none of those carts were paid; any sales in u/wk now came through the normal Add-to-cart path.',
  colNow: 'ALL Shopify sales of this product in the selected window — every path, the normal Add-to-cart button included — divided by the window’s weeks. It answers "how is the product selling overall?", so it can be high while Attributed is empty: the product sells, just not through a module.',
  colBase: 'The frozen pre-launch run rate: real Shopify units sold per SKU over the 84 days before launch (Apr 28 → Jul 21, 2026 — the old theme), divided by 12 weeks. Captured on Jul 22 and never recalculated. Example: PF02BR58-WSL-HY sold 3 units in those 12 weeks → 0.25 u/wk. A 0.0 means the SKU sold nothing (or did not exist) before launch — that is why brand-new products show +100%.',
  colDelta: 'The average of the individual variant percentages currently in view. Change the filter and this changes: under Delta + a family averages only the variants that grew.',
  avgOf: 'The average of every variant percentage currently in view — how much a typical product moved, not how the catalogue moved in units.',
  byMachine: 'Attributed revenue grouped by the machine the customer selected in a module.',
  rewards: 'Carts that crossed a free-shipping or discount threshold while a module was open. A cart milestone, not a sale.',
  splitInTwo: 'Every paid order in the window lands on one side or the other: it either contains a module-placed line, or it does not.',
  counterfactual: 'What the module orders are worth against the store BEFORE the upgrades existed: the same orders repriced at the pre-launch store AOV (the frozen 84-day window ending Jul 21, every order in the shop). It is arithmetic, not a controlled test — product mix, ad spend and seasonality also move AOV.',
  preLaunchAov: 'The average value of EVERY paid store order in the 84 days before the new theme went live (Apr 29 → Jul 21, 2026) — the same frozen window the Products baseline uses. It does not change with the date range you pick.',
  dayByDay: 'Total store revenue per day, with the module-attributed part shaded underneath.',
};

// Dashed-underline definition term. The definition itself is shown by the
// delegated data-def handler on the tab root.
function D({ d, children }: { d: string; children: ReactNode }) {
  return <span data-def={d} className="wu-def">{children}</span>;
}

// Real screenshots of each on-site module (captured from the live theme), shown
// inside the module tooltips so the reader sees WHICH surface the row refers to.
// Note: the cart drawer renders the same "Complete your setup" panel as the
// product page, so both Compatible Additions entries share one capture.
const MODULE_IMG: Record<string, string> = {
  'Compatibility Guide': '/wu/guide.jpg',
  'Machine finder (product page)': '/wu/machine-finder-selected.jpg',
  'Compatible Additions (product page)': '/wu/additions-product.jpg',
  'Compatible Additions (cart)': '/wu/additions-product.jpg',
};

// Plain-language explanation of each on-site module, keyed by the exact label the
// RPC emits. Shown on hover of the module name.
const MODULE_HELP: Record<string, string> = {
  'Compatibility Guide': 'The dedicated Compatibility Guide page. The shopper browses by machine brand → model to find the parts that fit their machine, and can add them straight from the guide.',
  'Machine finder (product page)': 'The "Find your machine" tool built into a product page: the shopper picks their espresso machine and it shows — and adds — the exact shower screen that fits it. Screens added here appear under the Products view.',
  'Compatible Additions (product page)': 'The "Complete your setup" recommendations rendered ON the product page itself, while the shopper is still looking at the product (before opening the cart). Same look as the cart one — different place and different code, so we count them apart to see which surface actually converts.',
  'Compatible Additions (cart)': 'The "Complete your setup" recommendations that appear INSIDE the cart / mini-cart drawer, as the shopper reviews the basket right before checkout.',
  'Other': 'Events that did not match a known module (e.g. a new event name the theme started sending).',
};

// Where each module lives on the site — the "what it is" line of its card.
const MODULE_SURFACE: Record<string, string> = {
  'Compatibility Guide': 'Own page',
  'Machine finder (product page)': 'Product page',
  'Compatible Additions (product page)': 'Product page',
  'Compatible Additions (cart)': 'Cart drawer',
};

// Which module wrote a raw machine label — inferred from the label style each
// module uses when stamping _pesado_machine on the sold line.
const variantOrigin = (label: string): string =>
  /^Compatible with your /i.test(label)
    ? 'This slice of the sales was recorded by the "Complete your setup" panel in the cart drawer (it prefixes the machine with "Compatible with your …").'
    : /^The /i.test(label)
      ? 'This slice was recorded by the "Find your machine" tool on the product page (it prefixes the machine with "The …").'
      : 'This slice was recorded with the machine name as-is — typically the "Find your machine" tool or the Compatibility Guide.';

// First real production event (theme published): 2026-07-23 10:21 Brisbane.
const LAUNCH = new Date('2026-07-23T00:21:48Z');

const REWARD_LABEL: Record<string, string> = { free_shipping: 'Free shipping', discount_10: '10% off', discount_15: '15% off' };
const REWARD_TIER: Record<string, string> = { free_shipping: '$100', discount_10: '$200', discount_15: '$300' };
const money = (v: number | null | undefined) => { const n = Number(v) || 0; return Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`; };
const money1 = (v: number | null | undefined) => { const n = Number(v) || 0; return Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${Math.round(n)}`; };
const int = (v: number | null | undefined) => (Number(v) || 0).toLocaleString('en-US');
const toYMD = (d: Date) => format(d, 'yyyy-MM-dd');

// Family (+ detected size) a product belongs to, derived from its SKU. The same
// mapping the E-commerce tab uses, plus the 54/58 mm size read from SKU/title.
const famOf = (sku0: string, title: string, withSize = true): string => {
  const sku = sku0.toUpperCase(); const blob = (sku0 + ' ' + title).toUpperCase();
  const fam = sku.startsWith('PSD-HD') || sku.startsWith('PSDBREVILLE') ? 'Shower Screens'
    : sku.startsWith('PSD-PUCK') ? 'Puck Screens'
    : sku.startsWith('PSD-HE') || sku.startsWith('EP-') || sku.startsWith('EP_') ? 'Filter Baskets'
    : sku.startsWith('PF') ? 'Portafilters'
    : sku.startsWith('EXT') || sku.startsWith('PRE') ? 'Bundles'
    : /DISTRIBUT|TAMP|RING|CRUSHER|DOSING/.test(blob) ? 'Distribution & Prep'
    : 'Accessories';
  if (!withSize) return fam;
  const size = /58/.test(blob) ? ' · 58mm' : /(54|53\.5)/.test(blob) ? ' · 54mm' : '';
  return fam + size;
};

// The Products view delta rule (deliberate, per the design handoff): a variant
// with no baseline but sales counts as +100%; a family's delta is the MEAN of
// its visible variants' percentages, never the sum-based ratio.
const pctOf = (now: number, base: number) => (base > 0 ? (now - base) / base : now > 0 ? 1 : 0);
const fmtPct = (x: number) => { const a = Math.abs(x * 100); return `${x < 0 ? '−' : '+'}${a < 10 ? a.toFixed(1) : Math.round(a)}%`; };

function Info({ k }: { k: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="wu-info" tabIndex={0} aria-label="What is this?">i</span></TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs leading-relaxed">{HELP[k]}</TooltipContent>
    </Tooltip>
  );
}

// A hover target that shows explanatory text on the TEXT itself (dotted underline
// signals it), so you don't have to aim at a tiny "i".
function Tip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="wu-help">{children}</span></TooltipTrigger>
      <TooltipContent className="max-w-[300px] text-xs leading-relaxed">{content}</TooltipContent>
    </Tooltip>
  );
}
function HelpTitle({ k, children }: { k: string; children: ReactNode }) {
  return <Tip content={HELP[k]}>{children}</Tip>;
}
// Module tooltip: a real screenshot of the on-site surface + the explanation.
function ModuleTip({ module, children }: { module: string; children?: ReactNode }) {
  const img = MODULE_IMG[module];
  const text = MODULE_HELP[module];
  if (!img && !text) return <>{children ?? module}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="wu-help">{children ?? module}</span></TooltipTrigger>
      <TooltipContent className="max-w-[340px] p-2">
        {img && <img src={img} alt={module} style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(0,0,0,.12)', marginBottom: text ? 6 : 0 }} />}
        {text && <div className="text-xs leading-relaxed px-1 pb-1">{text}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

// Hoverable table-column header: the header text itself explains the column.
function Th({ children, tip, right }: { children: ReactNode; tip: string; right?: boolean }) {
  return <th className={right ? 'r' : undefined}><Tip content={tip}>{children}</Tip></th>;
}

export default function WebUpgradeTab({ dateRange, setDateRange }: WebUpgradeTabProps) {
  const [env, setEnv] = useState<Env>('production');
  // Purposeful views (daily brief / modules / products) + the legacy Module
  // blocks layout, kept for now. Stale stored picks migrate to the closest new view.
  const [view, setView] = useState<View>(() => {
    try {
      const LEGACY: Record<string, View> = { current: 'modules', zones: 'products', summary: 'modules' };
      const s = localStorage.getItem('wu-view') ?? '';
      if (['daily', 'modules', 'products', 'blocks'].includes(s)) return s as View;
      return LEGACY[s] ?? 'daily';
    } catch { return 'daily'; }
  });
  const [data, setData] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeOpen, setStoreOpen] = useState(false);
  const [moduleSort, setModuleSort] = useState<'rps' | 'revenue' | 'conv'>('rps');

  // Delegated data-def tooltip: one floating card for every dashed term,
  // including the sparkline's SVG hover bands. Dismissal is unconditional
  // (any mouseout + root mouseleave) and the tip clears on view change and on
  // opening the modal — guarding the clear leaves it pinned over new content.
  const wuRef = useRef<HTMLDivElement>(null);
  const [def, setDef] = useState<{ text: string; x: number; y: number } | null>(null);
  const onDefOver = (e: ReactMouseEvent) => {
    const target = e.target as Element;
    const el = target.closest ? (target.closest('[data-def]') as HTMLElement | null) : null;
    if (!el || !wuRef.current) return;
    const text = el.getAttribute('data-def') ?? '';
    if (def?.text === text) return;
    const r = el.getBoundingClientRect();
    const h = wuRef.current.getBoundingClientRect();
    setDef({ text, x: Math.max(10, Math.min(r.left - h.left, h.width - 322)), y: r.bottom - h.top + 9 });
  };
  const clearDef = () => setDef((d) => (d ? null : d));
  const pickView = (v: View) => { setView(v); clearDef(); try { localStorage.setItem('wu-view', v); } catch { /* ignore */ } };
  const openStore = () => { clearDef(); setStoreOpen(true); };

  // Manual range picked inside the tab wins over the app-wide range.
  // Default window: launch day → today. Earlier dates predate the tracking, so
  // opening with the app-wide range would silently mix in empty days.
  const [localRange, setLocalRange] = useState<DateRange | null>(() => ({ from: new Date('2026-07-23T00:00:00'), to: new Date() }));
  const [pickerOpen, setPickerOpen] = useState(false);
  // In-progress calendar selection. Without it, a half-picked range (start only)
  // never reaches `selected`, so the calendar keeps extending the old range and
  // the start date appears unclickable.
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const [screenFilter, setScreenFilter] = useState<'all' | 'up' | 'down' | 'sold'>('all');
  const [screenGroup, setScreenGroup] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [openFams, setOpenFams] = useState<Record<string, boolean>>({});
  // Clicking a SKU opens its Shopify sales in the shared B2C panel.
  const [skuDialog, setSkuDialog] = useState<{ sku: string; title: string } | null>(null);
  // Per-card collapse, persisted. openS(id) says whether a card body is shown.
  const [closedCards, setClosedCards] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('wu-closed2') || '{}'); } catch { return {}; }
  });
  const openS = (id: string) => !closedCards[id];
  const toggleS = (id: string) => setClosedCards((prev) => {
    const next = { ...prev, [id]: !prev[id] };
    try { localStorage.setItem('wu-closed2', JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const CollBtn = ({ id }: { id: string }) => (
    <button type="button" className="wu-collbtn" aria-label={openS(id) ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); toggleS(id); }}>
      <span className={cn('wu-chev', openS(id) && 'open')}>›</span>
    </button>
  );
  // Whole header row toggles the card; inner buttons (filters, CollBtn) keep their own clicks.
  const headToggle = (id: string) => (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    toggleS(id);
  };
  const range = useMemo<DateRange>(() => {
    if (localRange?.from && localRange?.to) return localRange;
    if (dateRange?.from && dateRange?.to) return dateRange;
    const now = new Date();
    return { from: subDays(now, 30), to: now };
  }, [localRange, dateRange]);
  const applyRange = (r: DateRange) => {
    setLocalRange(r);
    if (r.from && r.to) setDateRange?.(r);
  };

  const fetchData = useCallback(async () => {
    if (!range.from || !range.to) return;
    setLoading(true); setError(null);
    const { data: res, error: err } = await supabase.rpc('web_upgrade_performance', {
      p_from: toYMD(range.from), p_to: toYMD(range.to), p_environment: env,
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setData(res as Dash); setLoading(false);
  }, [range.from, range.to, env]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const t = data?.totals;
  const noData = !!data && (data.totals.totalEvents === 0);
  const rangeLabel = `${range.from ? format(range.from, 'MMM d') : ''} – ${range.to ? format(range.to, 'MMM d, yyyy') : ''}`;

  // Entry-point surfaces, ordered by views so the busier one reads first. A
  // surface with no events is absent from the payload rather than zeroed — an
  // untracked button and a button nobody uses are not the same claim.
  const compatEntry = useMemo(() => {
    const src = data?.compatibilityBar;
    if (!src) return null;
    const rows = ([
      { key: 'mobile' as const, label: 'Orange bar · mobile' },
      { key: 'desktop' as const, label: 'Orange button · desktop' },
    ])
      .map((s) => ({ ...s, ...(src[s.key] ?? { views: 0, clicks: 0, sessions: 0, clickSessions: 0, ctr: null }) }))
      .filter((r) => r.views > 0)
      .sort((a, b) => b.views - a.views);
    if (rows.length === 0) return null;
    return { rows, totalViews: rows.reduce((n, r) => n + r.views, 0) };
  }, [data]);

  // Module maths shared by Daily brief + Modules view.
  const rpsOf = (m: Dash['modules'][number]) => (m.sessions > 0 ? m.revenue / m.sessions : 0);
  const convOf = (m: Dash['modules'][number]) => (m.sessions > 0 ? (100 * m.orders) / m.sessions : 0);
  const mods = useMemo(() => (data?.modules ?? []).filter((m) => m.module !== 'Other'), [data]);
  const bestRps = Math.max(...mods.map(rpsOf), 0.01);
  const bestConv = Math.max(...mods.map(convOf), 0.01);
  const bestAov = Math.max(...mods.map((m) => m.aov ?? 0), 1);
  const RPS_FLOOR = 0.5;
  const badModule = (m: Dash['modules'][number]) => rpsOf(m) < RPS_FLOOR && rpsOf(m) === Math.min(...mods.map(rpsOf));

  // Store split numbers (strip, rail panel and modal share these).
  const ss = data?.storeShare ?? null;
  const uor = ss ? ss.upgradeOrderRevenue ?? (data?.orderImpact?.upgradeAov != null ? Math.round(data.orderImpact.upgradeAov * data.orderImpact.upgradeOrders) : null) : null;
  const touchedPct = ss && uor != null && ss.storeRevenue > 0 ? Math.round((1000 * uor) / ss.storeRevenue) / 10 : null;
  const restRev = ss && uor != null ? ss.storeRevenue - uor : null;
  const insidePct = ss && uor != null && uor > 0 ? Math.round((1000 * ss.attributedRevenue) / uor) / 10 : null;
  const rideRev = ss && uor != null ? Math.max(0, uor - ss.attributedRevenue) : null;
  // Lifts recomputed from the numbers as DISPLAYED (rounded dollars / 2dp items),
  // so a reader multiplying the visible figures lands on the visible result —
  // the RPC's unrounded lift can be off by a point against what is on screen.
  const shownLift = (a: number | null | undefined, b: number | null | undefined) => {
    if (a == null || b == null || b === 0) return null;
    const v = (100 * (a - b)) / b;
    return Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  };
  // Denominator for every "share of the store" figure: ALL paid store orders in
  // the window, not just the upgrade ones.
  const storeOrders = data?.storeShare?.storeOrders ?? null;
  const fmtShare = (v: number) => (v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`);
  // ── The reference every AOV comparison is made against ────────────────────
  // The pre-launch store, not the shoppers who happened not to use a module
  // today. Those two are not the same question: someone who opens a module is
  // already shopping for a compatible part, so the no-module group is depleted
  // of exactly the baskets a module would have grown. Measured: items per order
  // are 1.39 for module orders against 1.40 pre-launch — flat — but 1.22 for
  // today's no-module group, which is what turned a flat number into "+14%".
  // Frozen 84-day window (Apr 29 → Jul 21 2026), the same one the Products
  // baseline uses, so the whole tab compares against a single reference.
  const preAovRef = data?.storeShare?.preLaunchAov ?? null;
  const preItemsRef = data?.storeShare?.preLaunchItems ?? null;

  const aovLiftShown = data?.orderImpact
    ? shownLift(
        data.orderImpact.upgradeAov != null ? Math.round(data.orderImpact.upgradeAov) : null,
        preAovRef != null ? Math.round(preAovRef) : null
      )
    : null;
  const itemsLiftShown = data?.orderImpact ? shownLift(data.orderImpact.upgradeItems, preItemsRef) : null;
  // Kept as the secondary reading — informative, but self-selected.
  const aovLiftVsOther = data?.orderImpact ? shownLift(data.orderImpact.upgradeAov != null ? Math.round(data.orderImpact.upgradeAov) : null, data.orderImpact.otherAov != null ? Math.round(data.orderImpact.otherAov) : null) : null;
  const itemsLiftVsOther = data?.orderImpact ? shownLift(data.orderImpact.upgradeItems, data.orderImpact.otherItems) : null;
  const fmtLift = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v}%`);

  const secGuide = t ? (
    <>
            {/* Compatibility guide — full funnel + brand split */}
            <SectionH eyebrow="Compatibility Guide page" title="Guide page funnel" help="compat" note="stats for /pages/compatibility-guide · landed → picked machine → clicked → added → purchased" href="https://pesado585.com/pages/compatibility-guide?view=compatibility-v3" linkLabel="Open the guide page" />
            <div className="wu-two">
              <div className="wu-card">
                <div className="wu-klabel wu-clickhead" onClick={headToggle('guidef')}><HelpTitle k="compat">Guide funnel</HelpTitle>{!openS('guidef') && data!.compatFunnel && <span className="wu-coll-sum tnum">{int(data!.compatFunnel.pageViews)} landed → {int(data!.compatFunnel.addSuccess)} added → {int(data!.compatFunnel.orders ?? 0)} bought</span>}<CollBtn id="guidef" /></div>
                {openS('guidef') && (!data!.compatFunnel || data!.compatFunnel.pageViews === 0 ? (
                  <div className="wu-muted">No activity on the Compatibility Guide page in this window. This fills in when someone uses <b>/pages/compatibility-guide</b> — adds made on a normal product page count elsewhere, not here.</div>
                ) : (
                  <div>
                    {(() => {
                      const f = data!.compatFunnel!;
                      const steps: Array<[string, number]> = [
                        ['Landed on the guide', f.pageViews],
                        ['Picked their machine', f.modelSelect],
                        ['Clicked add', f.addClicks],
                        ['Added to cart', f.addSuccess],
                        ['Purchased (paid orders)', f.orders ?? 0],
                      ];
                      const top = Math.max(f.pageViews, 1);
                      return steps.map(([label, n], i) => {
                        const prev = i === 0 ? null : steps[i - 1][1];
                        return (
                          <div key={label} className="wu-step">
                            <div className="wu-step-h">
                              <span>{label}</span>
                              <b className="tnum">{int(n)}{prev != null && prev > 0 && (
                                <span className="wu-faint" style={{ fontWeight: 400 }}> · {Math.round((100 * n) / prev)}%</span>
                              )}</b>
                            </div>
                            <div className="wu-bar"><span style={{ width: `${(100 * n) / top}%` }} /></div>
                          </div>
                        );
                      });
                    })()}
                    <div className="wu-muted" style={{ marginTop: 10 }}>
                      {int(data!.compatFunnel!.sessions)} sessions · {int(data!.compatFunnel!.completeKit)} complete-kit adds
                    </div>
                  </div>
                ))}
              </div>
              <div className="wu-card">
                <div className="wu-klabel wu-clickhead" onClick={headToggle('brand')}><HelpTitle k="brand">Machine brand picked</HelpTitle>{!openS('brand') && data!.byBrand.length > 0 && <span className="wu-coll-sum tnum">{int(data!.byBrand.reduce((a, b) => a + b.selects, 0))} picks → {int(data!.byBrand.reduce((a, b) => a + b.adds, 0))} adds · top {data!.byBrand[0].brand}</span>}<CollBtn id="brand" /></div>
                {openS('brand') && (data!.byBrand.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No brand selections yet.</div> : (
                  <div className="wu-scrollbody">
                  <table className="wu-table">
                    <thead><tr>
                      <Th tip="The machine brand the shopper selected in the compatibility guide.">Brand</Th>
                      <Th right tip="Times a shopper picked a machine of this brand in the guide.">Picked</Th>
                      <Th right tip="Times they clicked 'add' after picking this brand.">Clicked</Th>
                      <Th right tip="Confirmed adds after picking this brand.">Added</Th>
                    </tr></thead>
                    <tbody>
                      {data!.byBrand.map((b) => (
                        <Fragment key={b.brand}>
                          <tr className="wu-brand-row">
                            <td className="wu-mod">{b.brand}</td>
                            <td className="r tnum">{int(b.selects)}</td>
                            <td className="r tnum wu-dim">{int(b.addClicks)}</td>
                            <td className="r tnum" style={{ color: b.selects > 0 && b.adds === 0 ? 'var(--wu-neg)' : 'var(--wu-crema)', fontWeight: 600 }}>{int(b.adds)}</td>
                          </tr>
                          {data!.byModel.filter((m) => m.brand === b.brand).map((m) => (
                            <tr key={b.brand + '·' + m.model} className="wu-model-row">
                              <td className="wu-model-name">{m.model}</td>
                              <td className="r tnum">{int(m.selects)}</td>
                              <td className="r tnum wu-dim">{int(m.addClicks)}</td>
                              <td className="r tnum" style={{ color: m.selects > 0 && m.adds === 0 ? 'var(--wu-neg)' : 'var(--wu-crema)', fontWeight: 600 }}>{int(m.adds)}</td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                  </div>
                ))}
              </div>
            </div>

    </>
  ) : null;

  // ——— Daily brief ———
  const daily = (() => {
    if (!t || !data) return null;
    const tr = data.trend ?? [];
    const todayYmd = toYMD(new Date());
    const endsToday = tr.length > 0 && tr[tr.length - 1].d === todayYmd;
    const hero = endsToday && tr.length > 1 ? tr[tr.length - 2] : tr[tr.length - 1];
    const completeDays = endsToday ? tr.slice(0, -1) : tr;
    const avg = completeDays.length > 0 ? completeDays.reduce((a, b) => a + (b.attributedRevenue ?? 0), 0) / completeDays.length : 0;
    const heroRev = hero?.attributedRevenue ?? 0;
    const heroDelta = avg > 0 ? Math.round((100 * (heroRev - avg)) / avg) : null;
    const heroWhen = hero ? (endsToday ? 'yesterday' : `on ${format(new Date(hero.d + 'T00:00:00'), 'MMM d')}`) : '';

    // Sparkline geometry: wide viewBox with UNIFORM scaling (no
    // preserveAspectRatio="none" — that stretched the stroke and flattened the
    // curve). x 20→880, baseline y=130.
    const revs = tr.map((d2) => d2.attributedRevenue ?? 0);
    const maxRev = Math.max(...revs, 1);
    const bestIdx = revs.indexOf(Math.max(...(endsToday ? revs.slice(0, -1) : revs), 0));
    const px = (i: number) => (tr.length > 1 ? 20 + (860 * i) / (tr.length - 1) : 450);
    const py = (v: number) => 130 - (110 * v) / maxRev;
    const pts = revs.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
    const labelStep = Math.max(1, Math.ceil(tr.length / 7));
    const bandDef = (d2: Dash['trend'][number], i: number) => {
      const store = d2.storeRevenue ?? 0;
      const attr = d2.attributedRevenue ?? 0;
      const share = store > 0 ? Math.round((100 * attr) / store) : null;
      const dt = format(new Date(d2.d + 'T00:00:00'), 'MMM d');
      const isLast = endsToday && i === tr.length - 1;
      const bits = [`${dt} — ${money1(attr)}${isLast ? ' so far' : ' attributed'}`, store > 0 ? `${money1(store)} store that day` : null, share != null ? `${share}% of it` : null].filter(Boolean).join(' · ');
      return bits + (isLast ? ' — the day is still filling' : i === bestIdx && tr.length > 1 ? ' — the best day so far' : '');
    };

    const ranked = [...mods].sort((a, b) => rpsOf(b) - rpsOf(a));

    // Families that moved (rail).
    //
    // Two rules that used to differ from the Products view, both fixed here:
    //
    // 1. A variant with no frozen baseline is EXCLUDED from the delta, not
    //    counted as a zero. On 2026-07-23 the shower screens were consolidated
    //    (EX54 + 54 -> BR54, MV58 -> BR58); the replacements had no baseline row,
    //    so the family read +1018% — its whole volume against the baseline of its
    //    five smallest members. The retired SKUs' baselines now carry over via
    //    web_upgrade_sku_successor, and anything still without one is set aside
    //    and counted in the note instead of dragging the number to +100%.
    // 2. The delta is the MEAN of the comparable variants' percentages, the same
    //    rule the Products view uses (documented in its column tooltip). The two
    //    surfaces used to disagree by a factor of ~500 on the same family.
    const famBaseMap = new Map<string, { upw: number; base: number; pcts: number[]; noBase: number }>();
    for (const r of data.byScreen) {
      const k = famOf(r.sku, r.title, false);
      const cur = famBaseMap.get(k) ?? { upw: 0, base: 0, pcts: [], noBase: 0 };
      cur.upw += r.unitsPerWeek;
      if (r.baselineUnitsPerWeek > 0) {
        cur.base += r.baselineUnitsPerWeek;
        cur.pcts.push(pctOf(r.unitsPerWeek, r.baselineUnitsPerWeek));
      } else {
        cur.noBase += 1;
      }
      famBaseMap.set(k, cur);
    }
    const famMoves = [...famBaseMap.entries()]
      .filter(([, v]) => v.base > 0 && v.pcts.length > 0)
      .map(([k, v]) => {
        const ups = v.pcts.filter((p) => p > 0).length;
        const downs = v.pcts.filter((p) => p < 0).length;
        const parts: string[] = [];
        if (v.pcts.length > 1 && downs === v.pcts.length) parts.push(`all ${v.pcts.length} variants down`);
        else if (v.pcts.length > 1 && ups > 0 && downs > 0) parts.push(`mixed — ${ups} up, ${downs} down`);
        if (v.noBase > 0) parts.push(`${v.noBase} new, no baseline`);
        return {
          family: k,
          upw: Math.round(v.upw * 10) / 10,
          base: Math.round(v.base * 10) / 10,
          delta: Math.round((100 * v.pcts.reduce((s, p) => s + p, 0)) / v.pcts.length),
          note: parts.length ? parts.join(' · ') : null,
        };
      });
    const byAbs = [...famMoves].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const worst = [...famMoves].sort((a, b) => a.delta - b.delta)[0];
    let famCards = byAbs.slice(0, 4);
    if (worst && !famCards.some((f) => f.family === worst.family)) famCards = [...famCards.slice(0, 3), worst];

    const notes = signalNotes(data).slice(0, 3);
    const oi = data.orderImpact;

    return (
      <div>
        <div className="wu-hero">
          <h2>Upgrades made <em>{money1(heroRev)}</em> {heroWhen}</h2>
          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div style={{ fontSize: 10.5, color: 'var(--wu-faint)' }}>vs daily average since launch</div>
            <div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 22, fontWeight: 600, lineHeight: 1.1, color: heroDelta == null ? 'var(--wu-faint)' : heroDelta >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>
              {heroDelta == null ? '—' : `${heroDelta >= 0 ? '+' : ''}${heroDelta}%`}
            </div>
          </div>
        </div>

        <div className="wu-dgrid">
          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="wu-card" style={{ borderRadius: 14, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span className="wu-kicker"><D d={DEFS.trendChart}>Attributed revenue per day</D></span>
                <span className="tnum" style={{ fontSize: 11, color: 'var(--wu-dim)' }}>{money1(revs.reduce((a, b) => a + b, 0))} over {tr.length} day{tr.length === 1 ? '' : 's'}{tr.length > 1 ? ' · hover for the day' : ''}</span>
              </div>
              {tr.length > 1 ? (
                <>
                  <svg viewBox="0 0 900 150" width="100%" height="150" style={{ marginTop: 8, display: 'block' }}>
                    <path d={`M${pts.join(' L')} L880,130 L20,130 Z`} fill="rgba(201,138,41,.14)" />
                    <polyline points={pts.join(' ')} fill="none" stroke="var(--wu-crema)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                    {revs.map((v, i) => {
                      const last = endsToday && i === tr.length - 1;
                      if (last) return <circle key={i} cx={px(i)} cy={py(v)} r={4.5} fill="var(--wu-ground)" stroke="var(--wu-crema)" strokeWidth={2} />;
                      return <circle key={i} cx={px(i)} cy={py(v)} r={i === bestIdx ? 5.5 : 3.5} fill="var(--wu-crema)" />;
                    })}
                    <line x1={20} y1={130} x2={880} y2={130} stroke="var(--wu-line)" strokeWidth={1.5} />
                    {tr.map((d2, i) => {
                      const left = i === 0 ? 0 : (px(i - 1) + px(i)) / 2;
                      const right = i === tr.length - 1 ? 900 : (px(i) + px(i + 1)) / 2;
                      return <rect key={d2.d} x={left} y={0} width={right - left} height={150} fill="transparent" data-def={bandDef(d2, i)} />;
                    })}
                  </svg>
                  <div className="tnum" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--wu-faint)', marginTop: 2 }}>
                    {tr.filter((_, i) => i % labelStep === 0 || i === tr.length - 1).map((d2, i) => (
                      <span key={d2.d}>{i === 0 ? format(new Date(d2.d + 'T00:00:00'), 'MMM d') : format(new Date(d2.d + 'T00:00:00'), 'd')}</span>
                    ))}
                  </div>
                </>
              ) : <div className="wu-muted" style={{ marginTop: 12 }}>One day of data — the line appears from day two.</div>}
            </div>

            <div>
              <div className="wu-h3row">
                <h3><D d={DEFS.ranking}>What each exposed visitor is worth</D></h3>
                <span style={{ fontSize: 11, color: 'var(--wu-faint)' }}>$/session</span>
              </div>
              {ranked.map((m, i) => {
                const v = rpsOf(m);
                const bad = v < RPS_FLOOR;
                return (
                  <div key={m.module} className="wu-rankrow">
                    <span className="wu-rankchip" style={i === 0 ? { background: 'var(--wu-crema)', color: '#fff' } : undefined}>{i + 1}</span>
                    <span style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 14, fontWeight: 600 }}>
                      <ModuleTip module={m.module}>{m.module.replace(/ \((cart|product page)\)$/, '')}</ModuleTip>
                      {/ \((cart|product page)\)$/.test(m.module) && <span style={{ fontWeight: 400, color: 'var(--wu-dim)' }}> ({m.module.includes('(cart)') ? 'cart' : 'PDP'})</span>}
                    </span>
                    <div style={{ height: 20, borderRadius: 3, background: bad ? 'rgba(198,81,58,.12)' : 'var(--wu-crema-soft)', overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: '100%', width: `${Math.max(2, Math.round((100 * v) / bestRps))}%`, background: bad ? 'var(--wu-neg)' : 'linear-gradient(90deg,var(--wu-crema),var(--wu-crema2))' }} />
                    </div>
                    <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 17, textAlign: 'right', color: bad ? 'var(--wu-neg)' : undefined }}>${v.toFixed(2)}</b>
                    <span className="tnum" style={{ fontSize: 10.5, color: 'var(--wu-faint)', textAlign: 'right' }}>{int(m.sessions)} sessions<br />{t.exposedSessions > 0 ? `${Math.round((100 * m.sessions) / t.exposedSessions)}% of traffic` : ''}</span>
                  </div>
                );
              })}
            </div>

            {notes.length > 0 && (
              <div className="wu-ink" style={{ borderRadius: 14, padding: '18px 20px' }}>
                <div className="wu-kicker" style={{ color: 'var(--wu-gold)', letterSpacing: '.14em' }}>What to move today</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                  {notes.map((n, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--wu-gold)', fontSize: 13, lineHeight: 1.5 }}>{i + 1}</span>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--wu-inkfg2)' }}>{n}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right rail — the store context, inline */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {ss && uor != null && touchedPct != null && (
              <div className="wu-card" style={{ borderRadius: 14, padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                  <span className="wu-kicker" style={{ color: 'var(--wu-crema)' }}><D d={DEFS.storeImpact}>Store impact</D></span>
                  <span className="tnum" style={{ fontSize: 11, color: 'var(--wu-dim)' }}>{money1(ss.storeRevenue)} · {int(ss.storeOrders)} orders</span>
                </div>
                <div style={{ display: 'flex', height: 34, marginTop: 12, borderRadius: 3, overflow: 'hidden' }}>
                  <span className="tnum" style={{ width: `${touchedPct}%`, background: 'linear-gradient(90deg,var(--wu-crema),var(--wu-crema2))', display: 'flex', alignItems: 'center', paddingLeft: 12, color: '#fff', fontSize: 12, fontWeight: 600 }}>{touchedPct}%</span>
                  <span className="tnum" style={{ width: `${100 - touchedPct}%`, background: 'rgba(120,106,83,.22)', display: 'flex', alignItems: 'center', paddingLeft: 12, color: 'var(--wu-dim)', fontSize: 12, fontWeight: 600 }}>{Math.round((100 - touchedPct) * 10) / 10}%</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: `${touchedPct}% 1fr`, marginTop: 9 }}>
                  <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 19, fontWeight: 600, lineHeight: 1 }}>{money1(uor)}</div><div style={{ fontSize: 10.5, color: 'var(--wu-faint)', marginTop: 4 }}>{int(ss.upgradeOrders)} orders with a module</div></div>
                  <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 19, fontWeight: 600, lineHeight: 1, color: 'var(--wu-dim)' }}>{money1(restRev)}</div><div style={{ fontSize: 10.5, color: 'var(--wu-faint)', marginTop: 4 }}>{int(ss.storeOrders - ss.upgradeOrders)} orders without</div></div>
                </div>
                {insidePct != null && (
                  <div style={{ marginTop: 15, paddingTop: 13, borderTop: '1px solid var(--wu-line)' }}>
                    <div className="wu-kicker"><D d={DEFS.insideTouched}>What is inside those {money1(uor)}</D></div>
                    <div style={{ display: 'flex', height: 18, marginTop: 9, borderRadius: 3, overflow: 'hidden' }}><span style={{ width: `${insidePct}%`, background: 'var(--wu-crema)' }} /><span style={{ width: `${100 - insidePct}%`, background: 'rgba(120,106,83,.30)' }} /></div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 9 }}>
                      <div style={{ flex: 1, display: 'flex', gap: 8 }}><span style={{ width: 8, height: 8, background: 'var(--wu-crema)', borderRadius: 2, flex: 'none', marginTop: 4 }} /><span style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--wu-dim)' }}><b className="tnum" style={{ color: 'var(--wu-text)' }}>{money1(ss.attributedRevenue)}</b> <D d={DEFS.modulePlaced}>the module placed</D><br /><span style={{ color: 'var(--wu-faint)' }}>{int(t.directLines)} lines</span></span></div>
                      <div style={{ flex: 1, display: 'flex', gap: 8 }}><span style={{ width: 8, height: 8, background: 'rgba(120,106,83,.30)', borderRadius: 2, flex: 'none', marginTop: 4 }} /><span style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--wu-dim)' }}><b className="tnum" style={{ color: 'var(--wu-text)' }}>{money1(rideRev)}</b> <D d={DEFS.alreadyInBasket}>already in the basket</D><br /><span style={{ color: 'var(--wu-faint)' }}>base product</span></span></div>
                    </div>
                  </div>
                )}
                <div role="button" tabIndex={0} onClick={openStore} style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--wu-line)', fontSize: 11.5, fontWeight: 600, color: 'var(--wu-crema)', cursor: 'pointer' }}>Day by day, and what the store would have made without it →</div>
              </div>
            )}

            {oi && oi.upgradeOrders > 0 && (
              <div className="wu-card" style={{ borderRadius: 14, padding: '16px 18px' }}>
                <div className="wu-kicker"><D d={DEFS.growOrder}>Does the module grow the order?</D></div>
                <div className="wu-oigrid" style={{ marginTop: 12, fontSize: 9.5, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--wu-faint)' }}>
                  <span /><span style={{ textAlign: 'right' }}>With</span><span style={{ textAlign: 'right' }}>Pre-launch</span><span style={{ textAlign: 'right' }}>Diff</span>
                </div>
                <div className="wu-oigrid" style={{ padding: '10px 0', borderTop: '1px solid var(--wu-line)', fontSize: 12.5, color: 'var(--wu-dim)', alignItems: 'baseline' }}>
                  <span>Items per order</span>
                  <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 17, textAlign: 'right', color: 'var(--wu-text)' }}>{oi.upgradeItems ?? '—'}</b>
                  <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 17, textAlign: 'right', color: 'var(--wu-dim)' }}>{preItemsRef ?? '—'}</b>
                  <b className="tnum" style={{ textAlign: 'right', color: (itemsLiftShown ?? 0) >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtLift(itemsLiftShown)}</b>
                </div>
                <div className="wu-oigrid" style={{ padding: '10px 0', borderTop: '1px solid var(--wu-line)', fontSize: 12.5, color: 'var(--wu-dim)', alignItems: 'baseline' }}>
                  <span>Average order value</span>
                  <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 17, textAlign: 'right', color: 'var(--wu-text)' }}>{money(oi.upgradeAov)}</b>
                  <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 17, textAlign: 'right', color: 'var(--wu-dim)' }}>{money(preAovRef)}</b>
                  <b className="tnum" style={{ textAlign: 'right', color: (aovLiftShown ?? 0) >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtLift(aovLiftShown)}</b>
                </div>
                {itemsLiftShown != null && aovLiftShown != null && itemsLiftShown > aovLiftShown && itemsLiftShown > 0 && (
                  <p style={{ margin: '11px 0 0', fontSize: 10.5, lineHeight: 1.5, color: 'var(--wu-faint)' }}>The module adds items, not expensive ones — the basket grows by {itemsLiftShown}% but its value by only {aovLiftShown}%.</p>
                )}
                {/* The self-selected reading, kept but demoted: shoppers who open a
                    module are already after a compatible part, so the no-module
                    group is missing exactly the baskets a module would have grown. */}
                {(aovLiftVsOther != null || itemsLiftVsOther != null) && (
                  <p style={{ margin: '9px 0 0', fontSize: 10.5, lineHeight: 1.5, color: 'var(--wu-faint)' }}>
                    Against today’s no-module shoppers instead ({money(oi.otherAov)} · {oi.otherItems ?? '—'} items):{' '}
                    <b className="tnum">{fmtLift(aovLiftVsOther)}</b> AOV · <b className="tnum">{fmtLift(itemsLiftVsOther)}</b> items.
                    That group self-selects — it is missing the shoppers a module would have helped.
                  </p>
                )}
              </div>
            )}

            {famCards.length > 0 && (
              <div>
                <div className="wu-h3row" style={{ marginBottom: 10 }}>
                  <h3><D d={DEFS.runRate}>Families that moved</D></h3>
                  <span style={{ fontSize: 11, color: 'var(--wu-faint)' }}>u/week vs baseline</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {famCards.map((f) => (
                    <div key={f.family} className="wu-famcard" role="button" tabIndex={0} onClick={() => pickView('products')}>
                      <div style={{ fontSize: 11.5, color: 'var(--wu-dim)', lineHeight: 1.35 }}>{f.family}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
                        <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 20, color: Math.abs(f.delta) < 3 ? 'var(--wu-dim)' : f.delta >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{f.delta >= 0 ? '+' : ''}{f.delta}%</b>
                        <span className="tnum" style={{ fontSize: 10.5, color: 'var(--wu-faint)' }}>{f.upw} / {f.base}</span>
                      </div>
                      {f.note && <div style={{ fontSize: 10, color: 'var(--wu-crema)', marginTop: 5 }}>{f.note}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  })();

  // ——— Modules view: the three-band module card ———
  const modulesView = (() => {
    if (!t || !data) return null;
    const sorted = [...mods].sort((a, b) => moduleSort === 'revenue' ? b.revenue - a.revenue : moduleSort === 'conv' ? convOf(b) - convOf(a) : rpsOf(b) - rpsOf(a));
    // Step-to-step conversion rates, with best/worst per step across modules.
    const steps = (m: Dash['modules'][number]) => [
      m.views > 0 ? (100 * m.clicks) / m.views : null,
      m.clicks > 0 ? (100 * m.adds) / m.clicks : null,
      m.adds > 0 ? (100 * m.orders) / m.adds : null,
    ];
    const stepMatrix = mods.map(steps);
    const stepBest = [0, 1, 2].map((i) => Math.max(...stepMatrix.map((s) => s[i] ?? -1)));
    const stepWorst = [0, 1, 2].map((i) => Math.min(...stepMatrix.map((s) => s[i] ?? 1e9)));
    const stepColor = (v: number | null, i: number) => {
      if (v == null || mods.length < 2 || stepBest[i] === stepWorst[i]) return 'var(--wu-crema)';
      if (v === stepBest[i]) return 'var(--wu-pos)';
      if (v === stepWorst[i]) return 'var(--wu-neg)';
      return 'var(--wu-crema)';
    };
    const fmtStep = (v: number | null) => (v == null ? '—' : v >= 10 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`);
    const STEP_DEFS = [[DEFS.ctr, 'CTR'], [DEFS.add, 'ADD'], [DEFS.close, 'CLOSE']] as const;
    const STAGE_DEFS = [DEFS.views, DEFS.clicks, DEFS.adds] as const;
    return (
      <>
        <div className="wu-section-h">
          <div className="wu-eyebrow">Funnel</div>
          <h2><HelpTitle k="module">By module</HelpTitle></h2>
          <span className="wu-faint" style={{ fontSize: 12.5 }}>ranked by what each exposed visitor is worth</span>
          <span className="wu-seg wu-seg-sm" style={{ marginLeft: 'auto' }} role="group" aria-label="Sort modules">
            {([['rps', '$/session'], ['revenue', 'Revenue'], ['conv', 'Conversion']] as Array<[typeof moduleSort, string]>).map(([k, lb]) => (
              <button key={k} aria-pressed={moduleSort === k} onClick={() => setModuleSort(k)}>{lb}</button>
            ))}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--wu-faint)', margin: '0 2px 14px' }}>Each card answers three things, always in the same order: <b style={{ color: 'var(--wu-dim)' }}>what it is</b> · <b style={{ color: 'var(--wu-dim)' }}>what it brings</b> · <b style={{ color: 'var(--wu-dim)' }}>where it drops off</b>.</div>
        <div className="wu-blocks">
          {sorted.map((m, rank) => {
            const s = steps(m);
            const bad = badModule(m);
            const revShare = t.directRevenue > 0 ? Math.round((100 * m.revenue) / t.directRevenue) : 0;
            // Against the pre-launch store, not the store as it is now. Comparing a
            // module to a current average that already contains that module's own
            // orders is partly comparing it to itself.
            const aovDelta = preAovRef && m.aov != null ? Math.round((100 * (m.aov - preAovRef)) / preAovRef) : null;
            const endRate = m.views > 0 ? (100 * m.orders) / m.views : null;
            return (
              <div key={m.module} className="wu-card wu-mcard">
                <div className="wu-mband1">
                  {MODULE_IMG[m.module] && <img className="wu-block-thumb wu-mthumb" src={MODULE_IMG[m.module]} alt={m.module} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="wu-rankchip" style={{ background: rank === sorted.length - 1 ? 'var(--wu-faint)' : 'var(--wu-crema)', color: '#fff', flex: 'none' }}>{rank + 1}</span>
                      <span style={{ fontFamily: "'Fraunces',Georgia,serif", fontWeight: 600, fontSize: 16, lineHeight: 1.15 }}><ModuleTip module={m.module}>{m.module}</ModuleTip></span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--wu-faint)', marginTop: 6 }}>{MODULE_SURFACE[m.module] ?? '—'} · {int(m.sessions)} exposed sessions · {t.exposedSessions > 0 ? Math.round((100 * m.sessions) / t.exposedSessions) : 0}% of traffic</div>
                  </div>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontWeight: 600, fontSize: 26, color: 'var(--wu-crema)', lineHeight: 1 }}>{money(m.revenue)}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--wu-faint)', marginTop: 5 }}>{revShare}% of attributed revenue</div>
                    <div style={{ width: 96, height: 4, borderRadius: 999, background: 'var(--wu-crema-soft)', marginTop: 5, marginLeft: 'auto', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${revShare}%`, background: 'var(--wu-crema)' }} /></div>
                  </div>
                </div>
                <div className="wu-mrates">
                  <div className="wu-mrate">
                    <div className="wu-kicker"><D d={DEFS.rps}>$ / session</D></div>
                    <div className="tnum wu-mrate-v" style={bad ? { color: 'var(--wu-neg)' } : undefined}>${rpsOf(m).toFixed(2)}</div>
                    <div className="wu-mrate-bar" style={bad ? { background: 'rgba(198,81,58,.16)' } : undefined}><span style={{ width: `${Math.max(2, Math.round((100 * rpsOf(m)) / bestRps))}%`, background: bad ? 'var(--wu-neg)' : 'var(--wu-crema)' }} /></div>
                    <div className="wu-mrate-c">{rpsOf(m) === bestRps ? `best of the ${mods.length}` : `${Math.round((100 * rpsOf(m)) / bestRps)}% of the best`}</div>
                  </div>
                  <div className="wu-mrate">
                    <div className="wu-kicker"><D d={DEFS.conversion}>Conversion</D></div>
                    <div className="tnum wu-mrate-v" style={bad ? { color: 'var(--wu-neg)' } : undefined}>{convOf(m).toFixed(1)}%</div>
                    <div className="wu-mrate-bar" style={bad ? { background: 'rgba(198,81,58,.16)' } : undefined}><span style={{ width: `${Math.max(2, Math.round((100 * convOf(m)) / bestConv))}%`, background: bad ? 'var(--wu-neg)' : 'var(--wu-crema)' }} /></div>
                    <div className="wu-mrate-c">session → paid order</div>
                  </div>
                  <div className="wu-mrate" style={{ borderRight: 'none' }}>
                    <div className="wu-kicker"><D d={DEFS.aov}>AOV</D></div>
                    <div className="tnum wu-mrate-v">{m.aov != null ? `$${Math.round(m.aov)}` : '—'}</div>
                    <div className="wu-mrate-bar"><span style={{ width: `${m.aov != null ? Math.max(2, Math.round((100 * m.aov) / bestAov)) : 0}%`, background: 'var(--wu-crema)' }} /></div>
                    <div className="wu-mrate-c">{preAovRef != null && <>pre-launch ${Math.round(preAovRef)}{aovDelta != null && <> · <span style={{ fontWeight: 600, color: Math.abs(aovDelta) < 3 ? 'var(--wu-dim)' : aovDelta > 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{aovDelta > 0 ? '+' : ''}{aovDelta}%</span></>}</>}</div>
                  </div>
                </div>
                <div style={{ padding: '14px 18px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 9 }}>
                    <span className="wu-kicker"><D d={DEFS.dropoff}>Where it drops off</D></span>
                    <span style={{ fontSize: 10.5, color: 'var(--wu-faint)' }}>{int(m.views)} views end as <b className="tnum" style={{ color: bad ? 'var(--wu-neg)' : 'var(--wu-pos)' }}>{int(m.orders)} orders</b>{endRate != null && <> · {endRate >= 10 ? Math.round(endRate) : endRate.toFixed(1)}%</>}</span>
                  </div>
                  <div className="wu-mfun">
                    {([['Views', m.views, 1], ['Clicks', m.clicks, 0.8], ['Adds', m.adds, 0.62]] as Array<[string, number, number]>).map(([lb, v, op], i) => (
                      <Fragment key={lb}>
                        <div><div className="tnum wu-mstep-n">{int(v)}</div><div className="wu-mstep-l"><D d={STAGE_DEFS[i]}>{lb}</D></div><div className="wu-mstep-b" style={{ opacity: op }} /></div>
                        <div className="wu-mconn"><div className="wu-mconn-l"><D d={STEP_DEFS[i][0]}>{STEP_DEFS[i][1]}</D></div><div className="tnum wu-mconn-v" style={{ color: stepColor(s[i], i) }}>{fmtStep(s[i])}</div></div>
                      </Fragment>
                    ))}
                    <div><div className="tnum wu-mstep-n" style={{ color: bad ? 'var(--wu-neg)' : 'var(--wu-pos)' }}>{int(m.orders)}</div><div className="wu-mstep-l"><D d={DEFS.orders}>Orders</D></div><div className="wu-mstep-b wu-mstep-share" data-def={storeOrders ? `${int(m.orders)} of the ${int(storeOrders)} orders the whole store took in this window — ${fmtShare((100 * m.orders) / storeOrders)}. Denominator is EVERY paid store order, not just the upgrade ones. An order that used two modules counts in both cards, so the four percentages do not add up to the store's module share.` : undefined} style={{ background: bad ? 'var(--wu-neg)' : 'var(--wu-pos)' }}>{storeOrders ? <span className="tnum">{fmtShare((100 * m.orders) / storeOrders)}</span> : null}</div></div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* How people REACH the guide: the orange bar on mobile vs the orange
            button on desktop. This is an acquisition measure, so both surfaces
            are counted only outside the guide — the desktop button also renders
            inside it, where a view is not acquisition and nobody clicks it, and
            the mobile bar does not render there at all. Counting the guide page
            would inflate desktop views and sink its CTR against a mobile figure
            that structurally cannot have the same rows.
            Kept out of the module cards on purpose: these views span the whole
            site, so inside a module funnel they would count every page of the
            store as an exposed session — the bug that halved the guide's
            numbers on 2026-07-30. Each surface is its own row; one CTR covering
            both would answer nothing. */}
        {compatEntry && (
          <div className="wu-card" style={{ borderRadius: 14, padding: '14px 18px', marginTop: 14 }}>
            <div className="wu-kicker">Compatibility entry point · mobile vs desktop</div>
            <table className="wu-entry-tbl">
              <thead>
                <tr><th>Surface</th><th>Views</th><th>Share of views</th><th>Clicks</th><th>CTR</th><th>Sessions</th></tr>
              </thead>
              <tbody>
                {compatEntry.rows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td className="tnum">{int(r.views)}</td>
                    <td className="tnum">{compatEntry.totalViews > 0 ? `${Math.round((100 * r.views) / compatEntry.totalViews)}%` : '—'}</td>
                    <td className="tnum">{int(r.clicks)}</td>
                    <td className="tnum">{r.ctr != null ? `${r.ctr}%` : '—'}</td>
                    <td className="tnum">{int(r.sessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ margin: '10px 0 0', fontSize: 10.5, color: 'var(--wu-faint)', lineHeight: 1.5 }}>
              {compatEntry.rows.length > 1
                ? 'Counted only outside the guide, so this measures how people get there. Share of views says where the entry point is seen; each surface’s own CTR says where it works.'
                : 'Only the mobile bar reports. The desktop orange button emits no events yet, so this is not a mobile-vs-desktop comparison.'}
            </p>
          </div>
        )}
        {secGuide}
      </>
    );
  })();

  // ——— Products view: filter-driven family aggregation ———
  // ⚠ The Delta rule (deliberate, per the handoff — do NOT "fix" back to sums):
  // the filter chips define the population. Family numbers are computed only
  // over the variants that pass the filter; Adds/Attributed/units are SUMS but
  // Delta is the MEAN of the individual variant percentages. Families with no
  // passing variants disappear; sort and bar scale change with the filter.
  const productsView = (() => {
    if (!t || !data) return null;
    const keeps = (r: Dash['byScreen'][number]) => {
      const p = pctOf(r.unitsPerWeek, r.baselineUnitsPerWeek);
      if (screenFilter === 'up') return p > 0;
      if (screenFilter === 'down') return p < 0;
      if (screenFilter === 'sold') return r.unitsPerWeek > 0;
      return true;
    };
    const famMap = new Map<string, Dash['byScreen']>();
    for (const r of data.byScreen) {
      const k = famOf(r.sku, r.title);
      famMap.set(k, [...(famMap.get(k) ?? []), r]);
    }
    let tAdds = 0, tRev = 0, tNow = 0, tBase = 0, pctSum = 0, n = 0;
    const fams = [...famMap.entries()].map(([key, members]) => {
      const rows = members.filter(keeps);
      if (rows.length === 0) return null;
      const adds = rows.reduce((a, b) => a + b.adds, 0);
      const rev = rows.reduce((a, b) => a + b.attributedRevenue, 0);
      const now = rows.reduce((a, b) => a + b.unitsPerWeek, 0);
      const base = rows.reduce((a, b) => a + b.baselineUnitsPerWeek, 0);
      const acc = rows.reduce((a, b) => a + pctOf(b.unitsPerWeek, b.baselineUnitsPerWeek), 0);
      tAdds += adds; tRev += rev; tNow += now; tBase += base; pctSum += acc; n += rows.length;
      return { key, rows, adds, rev, now, base, avg: acc / rows.length };
    }).filter((f): f is NonNullable<typeof f> => f !== null).sort((a, b) => b.avg - a.avg);
    const maxAbs = Math.max(0.01, ...fams.map((f) => Math.abs(f.avg)));
    const totAvg = n > 0 ? pctSum / n : 0;
    return (
      <>
        <div className="wu-section-h">
          <div className="wu-eyebrow">Products</div>
          <h2><D d={DEFS.runRate}>Against the pre-launch run rate</D></h2>
          <span className="wu-faint" style={{ fontSize: 12.5 }}>units/week today vs the frozen Jul 21 baseline · click a family to see its variants</span>
          <span className="wu-seg wu-seg-sm" style={{ marginLeft: 'auto' }} role="group" aria-label="Family filter">
            {([['all', 'All'], ['up', 'Delta +'], ['down', 'Delta −'], ['sold', 'With sales']] as Array<[typeof screenFilter, string]>).map(([k, lb]) => (
              <button key={k} aria-pressed={screenFilter === k} onClick={() => { setScreenFilter(k); clearDef(); }}>{lb}</button>
            ))}
          </span>
        </div>
        <div className="wu-card" style={{ padding: 0 }}>
          <div className="wu-famgrid wu-famhead">
            <span><D d={DEFS.family}>Family</D></span>
            <span style={{ textAlign: 'right' }}><D d={DEFS.colAdds}>Adds</D></span>
            <span style={{ textAlign: 'right' }}><D d={DEFS.colAttributed}>Attributed</D></span>
            <span style={{ textAlign: 'right' }}><D d={DEFS.colNow}>u/wk now</D></span>
            <span style={{ textAlign: 'right' }}><D d={DEFS.colBase}>Pre-launch</D></span>
            <span style={{ textAlign: 'right' }}><D d={DEFS.colDelta}>Delta</D></span>
          </div>
          {fams.length === 0 && <div className="wu-muted" style={{ padding: '14px 18px' }}>Nothing matches this filter in the window.</div>}
          {fams.map((g) => {
            const up = g.avg >= 0;
            return (
              <Fragment key={g.key}>
                <div className="wu-famgrid wu-famrow" onClick={() => setOpenFams((p) => ({ ...p, [g.key]: !p[g.key] }))}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span className={cn('wu-chev', openFams[g.key] && 'open')} style={{ fontSize: 14 }}>›</span>
                    <b style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 14.5, fontWeight: 600 }}>{g.key}</b>
                    <span style={{ fontSize: 11, color: 'var(--wu-faint)' }}>{g.rows.length} variant{g.rows.length === 1 ? '' : 's'}</span>
                  </span>
                  <span className="tnum" style={{ textAlign: 'right', fontSize: 12.5, color: 'var(--wu-dim)' }}>{int(g.adds)}</span>
                  <b className="tnum" style={{ textAlign: 'right', fontFamily: "'Fraunces',Georgia,serif", fontSize: 14, color: 'var(--wu-crema)' }}>{g.rev > 0 ? money1(g.rev) : '—'}</b>
                  <b className="tnum" style={{ textAlign: 'right', fontFamily: "'Fraunces',Georgia,serif", fontSize: 14 }}>{g.now.toFixed(1)}</b>
                  <span className="tnum" style={{ textAlign: 'right', fontSize: 12.5, color: 'var(--wu-faint)' }}>{g.base.toFixed(1)}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'flex-end' }}>
                    <span style={{ flex: 1, height: 6, overflow: 'hidden', borderRadius: 2, background: up ? 'rgba(46,158,110,.14)' : 'rgba(198,81,58,.14)' }}>
                      <span style={{ display: 'block', height: '100%', width: `${Math.round((Math.abs(g.avg) / maxAbs) * 100)}%`, background: up ? 'var(--wu-pos)' : 'var(--wu-neg)' }} />
                    </span>
                    <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 14, minWidth: 50, textAlign: 'right', color: up ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtPct(g.avg)}</b>
                  </span>
                </div>
                {openFams[g.key] && (
                  <div style={{ background: 'rgba(201,138,41,.04)', borderBottom: '1px solid var(--wu-line)' }}>
                    {g.rows.map((r) => {
                      const p = pctOf(r.unitsPerWeek, r.baselineUnitsPerWeek);
                      return (
                        <div key={r.sku} className="wu-famgrid wu-varrow">
                          {/* The SKU opens its Shopify sales — the same panel as the
                              B2C Sales Explorer, scoped to this product. */}
                          <span style={{ color: 'var(--wu-dim)' }}>
                            {r.title}
                            <button
                              type="button"
                              onClick={() => setSkuDialog({ sku: r.sku, title: r.title })}
                              title={`See B2C sales for ${r.sku}`}
                              className="tnum"
                              style={{
                                display: 'block', fontFamily: 'ui-monospace,monospace', fontSize: 10,
                                color: 'var(--wu-faint)', marginTop: 2, background: 'none', border: 'none',
                                padding: 0, cursor: 'pointer', textDecoration: 'underline',
                                textUnderlineOffset: 2, textDecorationStyle: 'dotted', textAlign: 'left',
                              }}
                            >
                              {r.sku}{r.fitment ? ` · ${r.fitment}` : ''}
                            </button>
                          </span>
                          <span className="tnum" style={{ textAlign: 'right', color: 'var(--wu-faint)' }}>{int(r.adds)}</span>
                          <span className="tnum" style={{ textAlign: 'right', color: 'var(--wu-dim)' }}>{r.attributedRevenue > 0 ? money1(r.attributedRevenue) : '—'}</span>
                          <span className="tnum" style={{ textAlign: 'right' }}>{(Math.round(r.unitsPerWeek * 10) / 10).toFixed(1)}</span>
                          <span className="tnum" style={{ textAlign: 'right', color: 'var(--wu-faint)' }}>{r.baselineUnitsPerWeek > 0 ? r.baselineUnitsPerWeek.toFixed(2) : '—'}</span>
                          <b className="tnum" style={{ textAlign: 'right', color: p >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtPct(p)}</b>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Fragment>
            );
          })}
          {fams.length > 0 && (
            <div className="wu-famgrid wu-famtotal">
              <b style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 14.5, fontWeight: 600, paddingLeft: 23 }}>{fams.length} famil{fams.length === 1 ? 'y' : 'ies'}</b>
              <b className="tnum" style={{ textAlign: 'right', fontSize: 12.5 }}>{int(tAdds)}</b>
              <b className="tnum" style={{ textAlign: 'right', fontFamily: "'Fraunces',Georgia,serif", fontSize: 14, color: 'var(--wu-crema)' }}>{money(tRev)}</b>
              <b className="tnum" style={{ textAlign: 'right', fontFamily: "'Fraunces',Georgia,serif", fontSize: 14 }}>{tNow.toFixed(1)}</b>
              <span className="tnum" style={{ textAlign: 'right', fontSize: 12.5, color: 'var(--wu-dim)' }}>{tBase.toFixed(1)}</span>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 9, justifyContent: 'flex-end' }}>
                <D d={DEFS.avgOf}><span style={{ fontSize: 10, color: 'var(--wu-faint)' }}>avg of {n}</span></D>
                <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 14, minWidth: 50, textAlign: 'right', color: totAvg >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtPct(totAvg)}</b>
              </span>
            </div>
          )}
        </div>

        <div className="wu-two">
          <div className="wu-card">
            <div className="wu-klabel wu-clickhead" onClick={headToggle('machines')}><D d={DEFS.byMachine}>Sales by machine</D>{!openS('machines') && data.byMachine.length > 0 && <span className="wu-coll-sum tnum">{int(data.byMachine.length)} machines · {money(data.byMachine.reduce((a, b) => a + b.revenue, 0))} · top {data.byMachine[0].machine}</span>}<CollBtn id="machines" /></div>
            {openS('machines') && (data.byMachine.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No attributed sales yet — populates as real orders come in.</div> : (
              <div style={{ marginTop: 10 }}>
                {data.byMachine.map((m) => (
                  <Fragment key={m.machine}>
                    <div className="wu-row">
                      <span>{m.machine}</span>
                      <b className="tnum">{money(m.revenue)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {int(m.orders)} ord</span></b>
                    </div>
                    {(m.variants ?? []).map((v) => (
                      <div key={m.machine + '·' + v.label} className="wu-row wu-machine-variant">
                        <span className="wu-model-name"><Tip content={variantOrigin(v.label)}>{v.label}</Tip></span>
                        <b className="tnum" style={{ fontWeight: 400, color: 'var(--wu-dim)' }}>{money(v.revenue)} <span className="wu-faint">· {int(v.orders)} ord</span></b>
                      </div>
                    ))}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
          <div className="wu-card">
            <div className="wu-klabel"><D d={DEFS.rewards}>Reward unlocks</D></div>
            {data.rewards.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No rewards unlocked.</div> : (
              <div style={{ marginTop: 10 }}>
                {data.rewards.map((rw) => (
                  <div key={rw.name} className="wu-row">
                    <span>{REWARD_LABEL[rw.name] ?? rw.name}{REWARD_TIER[rw.name] && <span className="wu-faint"> · {REWARD_TIER[rw.name]}</span>}</span>
                    <b className="tnum">
                      {int(rw.sessions)} <span className="wu-faint" style={{ fontWeight: 400 }}>carts</span>
                      <span style={{ color: rw.bought > 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}> → {int(rw.bought)} bought</span>
                    </b>
                  </div>
                ))}
                <div className="wu-muted" style={{ marginTop: 10 }}>
                  Crossing a tier is a <b>cart</b> milestone, not a sale — most of these carts are never paid for.
                </div>
              </div>
            )}
          </div>
        </div>
      </>
    );
  })();

  // ——— Store context modal ———
  const storeModal = (() => {
    if (!ss || !t || uor == null || touchedPct == null) return null;
    const oi = data!.orderImpact;
    const days = (data!.trend ?? []).filter((d2) => (d2.storeRevenue ?? 0) > 0);
    const maxStore = Math.max(...days.map((d2) => d2.storeRevenue ?? 0), 1);
    const todayYmd = toYMD(new Date());
    // The counterfactual prices the module orders at the PRE-LAUNCH store AOV
    // (frozen 84-day window), not at today's no-module group: comparing the same
    // window against self-selected shoppers answered nothing about the upgrades.
    // Multiply by the ROUNDED AOV so "at $104 × 388 orders" reproduces the figure shown.
    const preAov = ss.preLaunchAov ?? null;
    const wouldBill = preAov != null ? Math.round(preAov) * ss.upgradeOrders : null;
    const extra = wouldBill != null ? uor - wouldBill : null;
    const extraPerOrder = extra != null && ss.upgradeOrders > 0 ? extra / ss.upgradeOrders : null;
    const per100attr = Math.round(ss.revenueSharePct ?? 0);
    const per100ride = Math.max(0, Math.round(touchedPct - (ss.revenueSharePct ?? 0)));
    const per100rest = Math.max(0, 100 - per100attr - per100ride);
    return (
      <Dialog open={storeOpen} onOpenChange={setStoreOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <div className="wu">
            <DialogHeader>
              <div className="wu-eyebrow">Context · {rangeLabel}</div>
              <DialogTitle asChild><h2 style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 24, fontWeight: 600, margin: '6px 0 0', borderBottom: '2px solid var(--wu-text)', paddingBottom: 12 }}>The whole store: <em style={{ fontStyle: 'italic', color: 'var(--wu-crema)' }}>{money1(ss.storeRevenue)}</em> across {int(ss.storeOrders)} orders</h2></DialogTitle>
            </DialogHeader>

            <div style={{ marginTop: 14 }}>
              <div className="wu-kicker"><Tip content={DEFS.splitInTwo}>The store, split in two</Tip></div>
              <div style={{ display: 'flex', height: 38, marginTop: 11, borderRadius: 3, overflow: 'hidden' }}>
                <span className="tnum" style={{ width: `${touchedPct}%`, background: 'linear-gradient(90deg,var(--wu-crema),var(--wu-crema2))', display: 'flex', alignItems: 'center', paddingLeft: 14, color: '#fff', fontSize: 12.5, fontWeight: 600 }}>{money1(uor)} · {touchedPct}%</span>
                <span className="tnum" style={{ width: `${100 - touchedPct}%`, background: 'rgba(120,106,83,.22)', display: 'flex', alignItems: 'center', paddingLeft: 14, color: 'var(--wu-dim)', fontSize: 12.5, fontWeight: 600 }}>{money1(restRev)} · {Math.round((100 - touchedPct) * 10) / 10}%</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1.12fr .88fr', gap: 14, marginTop: 14, alignItems: 'start' }}>
                <div style={{ background: 'rgba(201,138,41,.07)', border: '1px solid var(--wu-line)', borderRadius: 14, padding: '16px 18px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                    <span style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 15.5, fontWeight: 600 }}>Orders that touched a module</span>
                    <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 21, fontWeight: 600, color: 'var(--wu-crema)' }}>{money1(uor)}</b>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 13, paddingTop: 12, borderTop: '1px solid var(--wu-line)' }}>
                    <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{int(ss.upgradeOrders)}</div><div style={{ fontSize: 10, color: 'var(--wu-faint)', marginTop: 3 }}>orders</div></div>
                    <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{money(oi?.upgradeAov)}</div><div style={{ fontSize: 10, color: 'var(--wu-faint)', marginTop: 3 }}>AOV</div></div>
                    <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{oi?.upgradeItems ?? '—'}</div><div style={{ fontSize: 10, color: 'var(--wu-faint)', marginTop: 3 }}>items per order</div></div>
                  </div>
                  {insidePct != null && (
                    <div style={{ marginTop: 15, paddingTop: 13, borderTop: '1px solid var(--wu-line)' }}>
                      <div className="wu-kicker"><Tip content={DEFS.insideTouched}>What is inside those {money1(uor)}</Tip></div>
                      <div style={{ display: 'flex', height: 20, marginTop: 9, borderRadius: 3, overflow: 'hidden' }}><span style={{ width: `${insidePct}%`, background: 'var(--wu-crema)' }} /><span style={{ width: `${100 - insidePct}%`, background: 'rgba(120,106,83,.30)' }} /></div>
                      <div style={{ display: 'flex', gap: 14, marginTop: 9 }}>
                        <div style={{ flex: 1, display: 'flex', gap: 8 }}><span style={{ width: 8, height: 8, background: 'var(--wu-crema)', borderRadius: 2, flex: 'none', marginTop: 4 }} /><span style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--wu-dim)' }}><b className="tnum" style={{ color: 'var(--wu-text)' }}>{money1(ss.attributedRevenue)}</b> <Tip content={DEFS.modulePlaced}>the module placed</Tip><br /><span style={{ color: 'var(--wu-faint)' }}>{int(t.directLines)} lines added by a module click</span></span></div>
                        <div style={{ flex: 1, display: 'flex', gap: 8 }}><span style={{ width: 8, height: 8, background: 'rgba(120,106,83,.30)', borderRadius: 2, flex: 'none', marginTop: 4 }} /><span style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--wu-dim)' }}><b className="tnum" style={{ color: 'var(--wu-text)' }}>{money1(rideRev)}</b> <Tip content={DEFS.alreadyInBasket}>already in the basket</Tip><br /><span style={{ color: 'var(--wu-faint)' }}>base product the customer came for</span></span></div>
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="wu-card" style={{ borderRadius: 14, padding: '16px 18px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 15.5, fontWeight: 600, color: 'var(--wu-dim)' }}>Orders with no module</span>
                      <b className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 21, fontWeight: 600, color: 'var(--wu-dim)' }}>{money1(restRev)}</b>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginTop: 13, paddingTop: 12, borderTop: '1px solid var(--wu-line)' }}>
                      <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{int(ss.storeOrders - ss.upgradeOrders)}</div><div style={{ fontSize: 10, color: 'var(--wu-faint)', marginTop: 3 }}>orders</div></div>
                      <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{money(oi?.otherAov)}</div><div style={{ fontSize: 10, color: 'var(--wu-faint)', marginTop: 3 }}>AOV</div></div>
                      <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{oi?.otherItems ?? '—'}</div><div style={{ fontSize: 10, color: 'var(--wu-faint)', marginTop: 3 }}>items per order</div></div>
                    </div>
                    {oi && (
                      <div style={{ display: 'flex', gap: 16, marginTop: 13, paddingTop: 12, borderTop: '1px solid var(--wu-line)' }}>
                        {/* This line compares against the group shown right above it,
                            so it keeps the vs-no-module lift — the headline elsewhere
                            is against pre-launch. */}
                        <span style={{ fontSize: 11, color: 'var(--wu-faint)' }}>the module group vs these: <b className="tnum" style={{ color: (aovLiftVsOther ?? 0) >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtLift(aovLiftVsOther)}</b> AOV · <b className="tnum" style={{ color: (itemsLiftVsOther ?? 0) >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>{fmtLift(itemsLiftVsOther)}</b> items</span>
                      </div>
                    )}
                  </div>
                  {wouldBill != null && extra != null && preAov != null && (
                    <div className="wu-ink" style={{ borderRadius: 14, padding: '15px 18px' }}>
                      <div className="wu-kicker" style={{ color: 'var(--wu-gold)', letterSpacing: '.14em' }}><Tip content={DEFS.counterfactual}>Against the store before the upgrades</Tip></div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                        <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1 }}>${Math.round(preAov)}</div><div style={{ fontSize: 10, color: 'rgba(242,234,223,.55)', marginTop: 3, lineHeight: 1.4 }}>AOV before launch<br />{ss.preLaunchFrom ? format(new Date(ss.preLaunchFrom + 'T00:00:00'), 'MMM d') : ''} → {ss.preLaunchTo ? format(new Date(ss.preLaunchTo + 'T00:00:00'), 'MMM d') : ''}</div></div>
                        <div><div className="tnum" style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18, fontWeight: 600, lineHeight: 1, color: 'var(--wu-gold)' }}>{money(oi?.upgradeAov)}</div><div style={{ fontSize: 10, color: 'rgba(242,234,223,.55)', marginTop: 3, lineHeight: 1.4 }}>AOV of the {int(ss.upgradeOrders)} module orders<br />{preAov > 0 && oi?.upgradeAov != null ? `${Math.round(oi.upgradeAov) >= Math.round(preAov) ? '+' : ''}${Math.round((100 * (Math.round(oi.upgradeAov) - Math.round(preAov))) / Math.round(preAov))}% vs before` : ''}</div></div>
                      </div>
                      <div style={{ marginTop: 13, paddingTop: 12, borderTop: '1px solid rgba(242,234,223,.14)' }}>
                        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--wu-inkfg2)' }}>Priced at the old ${Math.round(preAov)}, those {int(ss.upgradeOrders)} orders would have billed {money1(wouldBill)}. They billed {money1(uor)} — <b className="tnum" style={{ color: extra >= 0 ? 'var(--wu-gold)' : 'var(--wu-neg)' }}>{extra >= 0 ? '+' : '−'}{money1(Math.abs(extra))}</b> in this window{extraPerOrder != null && <>, about ${Math.abs(extraPerOrder).toFixed(2)} {extra >= 0 ? 'more' : 'less'} per order</>}.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="wu-card" style={{ borderRadius: 14, padding: '16px 18px', marginTop: 18 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span className="wu-kicker"><Tip content={DEFS.dayByDay}>Day by day — store vs module</Tip></span>
                <span style={{ display: 'flex', gap: 14, fontSize: 10.5, color: 'var(--wu-dim)' }}><span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, background: 'var(--wu-crema)', borderRadius: 2 }} />module</span><span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 9, height: 9, background: 'rgba(120,106,83,.25)', borderRadius: 2 }} />rest</span></span>
              </div>
              {days.length === 0 ? <div className="wu-muted" style={{ marginTop: 12 }}>No per-day store revenue in this window.</div> : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length},1fr)`, gap: Math.min(16, Math.max(4, Math.round(80 / days.length))), marginTop: 16, alignItems: 'end', height: 140 }}>
                    {days.map((d2) => {
                      const store = d2.storeRevenue ?? 0;
                      const attr = Math.min(d2.attributedRevenue ?? 0, store);
                      const total = Math.round((105 * store) / maxStore);
                      const lower = store > 0 ? Math.round((total * attr) / store) : 0;
                      const share = store > 0 ? Math.round((100 * attr) / store) : 0;
                      return (
                        <div key={d2.d} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
                          <span className="tnum" style={{ fontSize: 11, color: 'var(--wu-crema)', fontWeight: 700, textAlign: 'center', marginBottom: 5 }}>{share}%</span>
                          <div style={{ height: Math.max(0, total - lower), background: 'rgba(120,106,83,.22)', borderRadius: '3px 3px 0 0' }} />
                          <div style={{ height: lower, background: 'var(--wu-crema)', borderRadius: '0 0 3px 3px' }} />
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length},1fr)`, gap: 4, marginTop: 8, borderTop: '1px solid var(--wu-line)', paddingTop: 7 }}>
                    {days.map((d2, i) => (
                      <span key={d2.d} className="tnum" style={{ fontSize: 10.5, color: 'var(--wu-faint)', textAlign: 'center' }}>{format(new Date(d2.d + 'T00:00:00'), i === 0 ? 'MMM d' : 'd')}{d2.d === todayYmd && <span style={{ fontSize: 9 }}> (partial)</span>}<br /><b style={{ color: 'var(--wu-dim)' }}>{days.length <= 10 ? money1(d2.storeRevenue) : ''}</b></span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <p style={{ margin: '16px 0 0', fontSize: 11.5, lineHeight: 1.6, color: 'var(--wu-dim)', borderTop: '1px solid var(--wu-line)', paddingTop: 12 }}>Of every <b style={{ color: 'var(--wu-text)' }}>$100</b> the store bills: <b style={{ color: 'var(--wu-crema)' }}>${per100attr}</b> is a line a module placed, <b style={{ color: 'var(--wu-text)' }}>${per100ride}</b> is base product riding along in the same order, and <b style={{ color: 'var(--wu-text)' }}>${per100rest}</b> never touched a module. The two groups are <b style={{ color: 'var(--wu-text)' }}>different customers</b>, not an A/B test — someone using a compatibility finder already arrives with accessory intent, so part of the AOV gap is the shopper, not the module.</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  })();

  return (
    <TooltipProvider delayDuration={120}>
      <style>{WU_CSS}</style>
      <div className="wu" ref={wuRef} onMouseOver={onDefOver} onMouseOut={clearDef} onMouseLeave={clearDef}>
        <div className="wu-head">
          <div>
            <div className="wu-eyebrow">Pesado · Website upgrades</div>
            <h1 className="wu-title">Web Upgrade <em>Performance</em></h1>
            <div className="wu-sub" style={{ marginTop: 6 }}>Measuring live since <b>{format(LAUNCH, 'MMM d, yyyy')}</b> · {format(LAUNCH, 'h:mm a')} Brisbane — the moment the new theme went live and real events started flowing.</div>
          </div>
          <div className="flex items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <button type="button" className="wu-pill wu-gloss"><Sparkles className="h-3.5 w-3.5" />What stands out</button>
              </DialogTrigger>
              <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
                <DialogHeader><DialogTitle>What stands out</DialogTitle></DialogHeader>
                {data ? <Signals data={data} windowLabel={`${rangeLabel} · ${env}`} /> : <div className="wu-muted">Loading…</div>}
              </DialogContent>
            </Dialog>
            <Dialog>
              <DialogTrigger asChild>
                <button type="button" className="wu-pill wu-gloss"><BookOpen className="h-3.5 w-3.5" />How it's measured</button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Web Upgrade — every concept, and how it's calculated</DialogTitle></DialogHeader>
                <Glossary />
              </DialogContent>
            </Dialog>
            <span className="wu-pill"><span className="wu-live" />Live from DB</span>
          </div>
        </div>

        <div className="wu-ctx">
          <div className="wu-seg" role="group" aria-label="Environment">
            {(['production', 'preview', 'all'] as Env[]).map((e) => (
              <button key={e} aria-pressed={env === e} onClick={() => setEnv(e)}>
                {e === 'production' ? 'Production' : e === 'preview' ? 'Preview (test)' : 'All'}
              </button>
            ))}
          </div>
          <Info k="env" />
          <div className="wu-seg">
            {[7, 30, 90].map((d2) => (
              <button key={d2} onClick={() => { const now = new Date(); applyRange({ from: subDays(now, d2), to: now }); }}>Last {d2}d</button>
            ))}
          </div>
          <select className="wu-view" value={view} onChange={(e) => pickView(e.target.value as View)} aria-label="Layout view">
            <option value="daily">View: Daily brief</option>
            <option value="modules">View: Modules</option>
            <option value="products">View: Products</option>
            <option value="blocks">View: Module blocks</option>
          </select>
          {/* Manual calendar — same picker as the rest of the dashboard */}
          <Popover open={pickerOpen} onOpenChange={(o) => { setPickerOpen(o); if (!o) setDraft(undefined); }} modal>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-medium">
                <CalendarIcon className="h-3.5 w-3.5" />
                {range.from && range.to ? `${format(range.from, 'MMM d, yyyy')} – ${format(range.to, 'MMM d, yyyy')}` : 'Custom range'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <div className="flex">
                <DateRangePresets onSelect={(r) => { setDraft(undefined); applyRange(r); setPickerOpen(false); }} />
                <div>
                  <Calendar initialFocus mode="range" defaultMonth={range.from} selected={(draft ?? range) as never}
                    onSelect={(_sel: unknown, day: Date) => {
                      // Deterministic two-click pick: first click always STARTS a new
                      // range (the default picker instead extended the old one, which
                      // made the start date feel unclickable); second click ends it.
                      if (!draft?.from || draft.to) {
                        setDraft({ from: day, to: undefined });
                      } else {
                        const r: DateRange = day < draft.from ? { from: day, to: draft.from } : { from: draft.from, to: day };
                        setDraft(r);
                        applyRange(r);
                      }
                    }} numberOfMonths={2} weekStartsOn={1} />
                  <div className="p-2 border-t flex justify-end"><Button size="sm" onClick={() => { setDraft(undefined); setPickerOpen(false); }}>Apply</Button></div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="sm" className="h-8" onClick={fetchData} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {error && <div className="wu-err"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}

        {t && (
          <>
            {ss && ss.upgradeOrders > 0 && (
              <div className="wu-share" role="button" tabIndex={0} onClick={openStore}>
                <D d={DEFS.storeImpact}><span className="wu-share-k">Store impact</span></D>
                <span className="wu-share-item"><b className="tnum">{ss.orderSharePct ?? '—'}%</b> of all store orders ({int(ss.upgradeOrders)} of {int(ss.storeOrders)}) touched an upgrade module</span>
                <span className="wu-share-item"><b className="tnum">{ss.revenueSharePct ?? '—'}%</b> of store net revenue ({money(ss.attributedRevenue)} of {money(ss.storeRevenue)}) is module-attributed</span>
                <span className="wu-share-cta">See the whole store →</span>
              </div>
            )}

            {view !== 'daily' && (
              <div className="wu-kpis" style={{ marginTop: 14 }}>
                <Kpi label="Exposed sessions" def={DEFS.exposed} val={int(t.exposedSessions)} sub="saw at least one module" accent />
                <Kpi label="Direct revenue" def={DEFS.directRevenue} val={money(t.directRevenue)} ofVal={ss ? money(ss.storeRevenue) : undefined} pct={ss?.revenueSharePct ?? null} sub={`${int(t.directLines)} lines · ${ss?.revenueSharePct ?? '—'}% of store revenue`} accent />
                <Kpi label="Direct orders" def={DEFS.directOrders} val={int(t.directOrders)} ofVal={ss ? int(ss.storeOrders) : undefined} pct={ss?.orderSharePct ?? null} sub={`with an upgrade line · ${ss?.orderSharePct ?? '—'}% of store orders`} />
                <Kpi label="Assisted orders" def={DEFS.assisted} val={int(t.assistedOrders)} sub="via attribution id" />
              </div>
            )}

            {noData && (
              <div className="wu-empty" style={{ marginTop: 14 }}>
                No <b>{env}</b> events in this window.{env === 'production' ? ' Switch to Preview (test) to see the test session, or wait for the theme to go live.' : ''}
              </div>
            )}

            {view === 'daily' && daily}
            {view === 'modules' && modulesView}
            {view === 'products' && productsView}

            {view === 'blocks' && (
              <>
                <SectionH eyebrow="Funnel" title="By module" help="module" note="each module in one card — funnel down to paid orders" />
                <div className="wu-blocks">
                  {data!.modules.map((m) => {
                    const top = Math.max(m.views, m.clicks, m.adds, m.orders, 1);
                    return (
                      <div key={m.module} className="wu-card wu-block">
                        <div className="wu-block-h">
                          {MODULE_IMG[m.module] && <img className="wu-block-thumb" src={MODULE_IMG[m.module]} alt={m.module} />}
                          <div>
                            <div className="wu-block-name"><ModuleTip module={m.module}>{m.module}</ModuleTip></div>
                            <div className="wu-sub">{int(m.sessions)} sessions · CTR {m.ctr != null ? `${m.ctr}%` : '—'}</div>
                          </div>
                          <div className="wu-block-rev">
                            <div className="wu-block-money">{m.revenue > 0 ? money(m.revenue) : '—'}</div>
                            <div className="wu-sub">{int(m.orders)} paid orders{m.aov != null && <> · AOV <b>${Math.round(m.aov)}</b></>}</div>
                            <div className="wu-sub"><Tip content={HELP.conv}><span className="wu-help">Conv {m.sessions > 0 ? `${((100 * m.orders) / m.sessions).toFixed(1)}%` : '—'}</span></Tip> · <Tip content={HELP.rps}><span className="wu-help">${m.sessions > 0 ? (m.revenue / m.sessions).toFixed(2) : '—'}/session</span></Tip></div>
                          </div>
                        </div>
                        <div className="wu-block-bars">
                          {([['Views', m.views], ['Clicks', m.clicks], ['Adds', m.adds], ['Orders', m.orders]] as Array<[string, number]>).map(([lb, v], i) => (
                            <div key={lb} className="wu-block-bar">
                              <span>{lb}</span>
                              <div className="wu-bar"><span style={{ width: `${(100 * v) / top}%`, ...(i === 3 ? { background: 'var(--wu-pos)' } : {}) }} /></div>
                              <b className="tnum">{int(v)}</b>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Rewards — full width */}
                <div className="wu-card" style={{ marginTop: 14 }}>
                  <div className="wu-klabel"><HelpTitle k="rewards">Reward unlocks</HelpTitle></div>
                  {data!.rewards.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No rewards unlocked.</div> : (
                    <div style={{ marginTop: 10 }}>
                      {data!.rewards.map((rw) => (
                        <div key={rw.name} className="wu-row">
                          <span>{REWARD_LABEL[rw.name] ?? rw.name}</span>
                          <b className="tnum">
                            {int(rw.sessions)} <span className="wu-faint" style={{ fontWeight: 400 }}>carts</span>
                            <span style={{ color: rw.bought > 0 ? 'var(--wu-pos)' : 'var(--wu-faint)' }}> → {int(rw.bought)} bought</span>
                          </b>
                        </div>
                      ))}
                      <div className="wu-muted" style={{ marginTop: 10 }}>
                        Unlocking a tier is a <b>cart</b> milestone, not a sale — most of these carts are never paid for.
                      </div>
                    </div>
                  )}
                </div>

                {/* Basket impact — one plain question */}
                <div className="wu-card" style={{ marginTop: 14 }}>
                  <div className="wu-klabel"><HelpTitle k="impact">Do upgrades grow the order?</HelpTitle></div>
                  <div className="wu-muted" style={{ marginTop: 6 }}>
                    Average order value and items — orders that used an upgrade module vs everyone else.
                  </div>
                  {!data!.orderImpact || data!.orderImpact.upgradeOrders === 0 ? (
                    <div className="wu-muted" style={{ marginTop: 10 }}>
                      No upgrade orders yet in this window. All other orders so far: {data!.orderImpact ? `${int(data!.orderImpact.otherOrders)} orders · AOV ${money(data!.orderImpact.otherAov)} · ${data!.orderImpact.otherItems} items` : '—'}.
                    </div>
                  ) : (
                    <div style={{ marginTop: 10 }}>
                      <div className="wu-row"><span>Orders that used an upgrade</span><b className="tnum">{money(data!.orderImpact.upgradeAov)} <span className="wu-faint" style={{ fontWeight: 400 }}>AOV · {data!.orderImpact.upgradeItems} items · {int(data!.orderImpact.upgradeOrders)} ord</span></b></div>
                      <div className="wu-row"><span>All other orders</span><b className="tnum">{money(data!.orderImpact.otherAov)} <span className="wu-faint" style={{ fontWeight: 400 }}>AOV · {data!.orderImpact.otherItems} items · {int(data!.orderImpact.otherOrders)} ord</span></b></div>
                      <div className="wu-row"><span><b>Upgrade lift</b></span>
                        <b className="tnum" style={{ color: (data!.orderImpact.aovLiftPct ?? 0) >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>
                          {data!.orderImpact.aovLiftPct == null ? '—' : `${data!.orderImpact.aovLiftPct > 0 ? '+' : ''}${data!.orderImpact.aovLiftPct}% AOV`}
                          {data!.orderImpact.itemsLiftPct != null && <span className="wu-faint" style={{ fontWeight: 400 }}> · {data!.orderImpact.itemsLiftPct > 0 ? '+' : ''}{data!.orderImpact.itemsLiftPct}% items</span>}
                        </b>
                      </div>
                    </div>
                  )}
                </div>

                {secGuide}

                {/* Per product: module engagement + sales vs the pre-launch baseline */}
                <SectionH eyebrow="Products" title="By screen &amp; product" help="screen" note="engagement + sales vs pre-launch run rate" />
                <div className="wu-card">
                  <div className="wu-klabel wu-clickhead" style={{ display: 'flex' }} onClick={headToggle('screens')}>
                    {openS('screens') && (
                      <>
                        <span className="wu-seg wu-seg-sm" role="group" aria-label="Screen filter">
                          {([['all', 'All'], ['up', 'Delta +'], ['down', 'Delta −'], ['sold', 'With sales']] as Array<[typeof screenFilter, string]>).map(([k, lb]) => (
                            <button key={k} aria-pressed={screenFilter === k} onClick={() => setScreenFilter(k)}>{lb}</button>
                          ))}
                        </span>
                        <span className="wu-seg wu-seg-sm" role="group" aria-label="Grouping">
                          <button aria-pressed={!screenGroup} onClick={() => setScreenGroup(false)}>Flat</button>
                          <button aria-pressed={screenGroup} onClick={() => setScreenGroup(true)}>Group by family</button>
                        </span>
                      </>
                    )}
                    {!openS('screens') && data!.byScreen.length > 0 && <span className="wu-coll-sum tnum">{int(data!.byScreen.length)} products · {money(data!.byScreen.reduce((a, b) => a + b.attributedRevenue, 0))} attributed</span>}
                    <CollBtn id="screens" />
                  </div>
                  {openS('screens') && (() => {
                    type Row = Dash['byScreen'][number];
                    const applyFilter = <T extends { deltaPct: number | null; attributedRevenue: number }>(rows: T[]): T[] => {
                      if (screenFilter === 'up') return rows.filter((r) => (r.deltaPct ?? 0) > 0).sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0));
                      if (screenFilter === 'down') return rows.filter((r) => (r.deltaPct ?? 0) < 0).sort((a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0));
                      if (screenFilter === 'sold') return rows.filter((r) => r.attributedRevenue > 0).sort((a, b) => b.attributedRevenue - a.attributedRevenue);
                      return rows;
                    };
                    const head = (
                      <thead><tr>
                        <Th tip="The product (or, grouped, the product family) a shopper engaged with through an upgrade module. Grouped mode: click a family to unfold its variants.">Product</Th>
                        <Th tip="Which machine the screen fits, read from the SKU. For fitments shared by many brands, the SKU can't say the machine brand — that only comes from the machine the customer picked.">Fitment</Th>
                        <Th right tip="Module 'add' clicks.">Clicks</Th>
                        <Th right tip="Confirmed adds through a module.">Adds</Th>
                        <Th right tip="AUD revenue from real completed orders where the line was module-added.">Attributed</Th>
                        <Th right tip="Units sold per week in the selected window — from real completed orders.">Units/wk now</Th>
                        <Th right tip="The frozen pre-launch weekly run-rate (old-theme baseline).">Pre-launch</Th>
                        <Th right tip="Change of units/week vs the pre-launch run-rate. Grouped mode recomputes it over the whole family's units. Observational — ad spend and seasonality move it too.">Delta</Th>
                      </tr></thead>
                    );
                    const rowTr = (r: Row, indent = false) => (
                      <tr key={r.sku} className={indent ? 'wu-model-row' : undefined}>
                        <td className={indent ? 'wu-model-name' : 'wu-mod'}>{r.title}<div className="wu-mono wu-faint">{r.sku}</div></td>
                        <td className="wu-dim" style={{ fontSize: 12 }}>{r.fitment ?? '—'}</td>
                        <td className="r tnum">{int(r.clicks)}</td>
                        <td className="r tnum">{int(r.adds)}</td>
                        <td className="r tnum">{r.attributedRevenue > 0 ? money(r.attributedRevenue) : '—'}</td>
                        <td className="r tnum">{Math.round(r.unitsPerWeek * 10) / 10}</td>
                        <td className="r tnum wu-dim">{r.baselineUnitsPerWeek || '—'}</td>
                        <td className="r tnum" style={{ fontWeight: 600, color: r.deltaPct == null ? 'var(--wu-faint)' : r.deltaPct >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>
                          {r.deltaPct == null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%`}
                        </td>
                      </tr>
                    );
                    if (!screenGroup) {
                      const rows = applyFilter(data!.byScreen);
                      if (rows.length === 0) return <div className="wu-muted" style={{ marginTop: 10 }}>Nothing matches this filter in the window.</div>;
                      return <table className="wu-table" style={{ marginTop: 6 }}>{head}<tbody>{rows.map((r) => rowTr(r))}</tbody></table>;
                    }
                    // Grouped: aggregate per family (+ detected size); delta recomputed on the group totals.
                    const groupsMap = new Map<string, Row[]>();
                    for (const r of data!.byScreen) {
                      const k = famOf(r.sku, r.title);
                      groupsMap.set(k, [...(groupsMap.get(k) ?? []), r]);
                    }
                    const groups = applyFilter([...groupsMap.entries()].map(([k, members]) => {
                      const upw = members.reduce((a, b) => a + b.unitsPerWeek, 0);
                      const base = members.reduce((a, b) => a + b.baselineUnitsPerWeek, 0);
                      return {
                        key: k, members,
                        clicks: members.reduce((a, b) => a + b.clicks, 0),
                        adds: members.reduce((a, b) => a + b.adds, 0),
                        attributedRevenue: members.reduce((a, b) => a + b.attributedRevenue, 0),
                        unitsPerWeek: Math.round(upw * 10) / 10,
                        baselineUnitsPerWeek: Math.round(base * 100) / 100,
                        deltaPct: base > 0 ? Math.round(((upw - base) / base) * 1000) / 10 : null,
                      };
                    }));
                    if (groups.length === 0) return <div className="wu-muted" style={{ marginTop: 10 }}>Nothing matches this filter in the window.</div>;
                    return (
                      <table className="wu-table" style={{ marginTop: 6 }}>{head}<tbody>
                        {groups.map((g) => (
                          <Fragment key={g.key}>
                            <tr className="wu-group-row" onClick={() => setOpenGroups((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}>
                              <td className="wu-mod"><span className={cn('wu-chev', openGroups[g.key] && 'open')}>›</span> {g.key}<span className="wu-faint" style={{ fontWeight: 400 }}> · {g.members.length} variant{g.members.length > 1 ? 's' : ''}</span></td>
                              <td className="wu-dim" style={{ fontSize: 12 }}>—</td>
                              <td className="r tnum">{int(g.clicks)}</td>
                              <td className="r tnum">{int(g.adds)}</td>
                              <td className="r tnum">{g.attributedRevenue > 0 ? money(g.attributedRevenue) : '—'}</td>
                              <td className="r tnum">{g.unitsPerWeek}</td>
                              <td className="r tnum wu-dim">{g.baselineUnitsPerWeek || '—'}</td>
                              <td className="r tnum" style={{ fontWeight: 700, color: g.deltaPct == null ? 'var(--wu-faint)' : g.deltaPct >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>
                                {g.deltaPct == null ? '—' : `${g.deltaPct > 0 ? '+' : ''}${g.deltaPct}%`}
                              </td>
                            </tr>
                            {openGroups[g.key] && g.members.map((r) => rowTr(r, true))}
                          </Fragment>
                        ))}
                      </tbody></table>
                    );
                  })()}
                </div>

                {/* Direct sales — machine + family split */}
                <div className="wu-two">
                  <div className="wu-card">
                    <div className="wu-klabel wu-clickhead" onClick={headToggle('machines')}><D d={DEFS.byMachine}>Sales by machine</D>{!openS('machines') && data!.byMachine.length > 0 && <span className="wu-coll-sum tnum">{int(data!.byMachine.length)} machines · {money(data!.byMachine.reduce((a, b) => a + b.revenue, 0))} · top {data!.byMachine[0].machine}</span>}<CollBtn id="machines" /></div>
                    {openS('machines') && (data!.byMachine.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No attributed sales yet — populates as real orders come in.</div> : (
                      <div style={{ marginTop: 10 }}>
                        {data!.byMachine.map((m) => (
                          <Fragment key={m.machine}>
                            <div className="wu-row">
                              <span>{m.machine}</span>
                              <b className="tnum">{money(m.revenue)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {int(m.orders)} ord</span></b>
                            </div>
                            {(m.variants ?? []).map((v) => (
                              <div key={m.machine + '·' + v.label} className="wu-row wu-machine-variant">
                                <span className="wu-model-name"><Tip content={variantOrigin(v.label)}>{v.label}</Tip></span>
                                <b className="tnum" style={{ fontWeight: 400, color: 'var(--wu-dim)' }}>{money(v.revenue)} <span className="wu-faint">· {int(v.orders)} ord</span></b>
                              </div>
                            ))}
                          </Fragment>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="wu-card">
                    <div className="wu-klabel wu-clickhead" onClick={headToggle('families')}><Tip content={HELP.screen}>Sales by product family</Tip>{!openS('families') && data!.byFamily.length > 0 && <span className="wu-coll-sum tnum">{money(data!.byFamily.reduce((a, b) => a + b.revenue, 0))} · top {data!.byFamily[0].family}</span>}<CollBtn id="families" /></div>
                    {openS('families') && (data!.byFamily.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No attributed sales yet — populates as real orders come in.</div> : (
                      <div style={{ marginTop: 10 }}>
                        {data!.byFamily.map((f) => (
                          <div key={f.family} className="wu-row">
                            <span>{f.family}</span>
                            <b className="tnum">{money(f.revenue)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {int(f.lines)}</span></b>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="wu-foot">
              <b>Data cadence:</b> the funnel (sessions, views, clicks, adds, rewards) updates in <b>real time</b> — the pixel sends each event instantly, so a refresh shows it. <b>Sales</b> (direct &amp; assisted) come from Shopify orders via the fast sales sync — refreshed <b>every ~5 minutes</b> (interval configurable in Config → Connections), with a full reconciliation 3×/day — reaching checkout is not an order, only a completed purchase counts.<br />
              <b>Preview</b> = test traffic · <b>Production</b> = live customers. Assisted attribution lands once the theme's <b>__pesado_*</b> cart attributes reach the orders.
            </div>
          </>
        )}

        {loading && !t && (
          <div className="flex items-center justify-center min-h-[220px] gap-2"><Loader2 className="h-5 w-5 animate-spin wu-faint" /><span className="wu-faint">Loading…</span></div>
        )}

        {def && (
          <div className="wu-defcard" style={{ left: def.x, top: def.y }}>{def.text}</div>
        )}
      </div>
      {storeModal}
      <SkuSalesDialog
        sku={skuDialog?.sku ?? null}
        productTitle={skuDialog?.title ?? null}
        open={!!skuDialog}
        onClose={() => setSkuDialog(null)}
        // Opens on the window this tab is showing, so the drill-down answers the
        // same period as the row that was clicked.
        initialFrom={range.from ? toYMD(range.from) : undefined}
        initialTo={range.to ? toYMD(range.to) : undefined}
      />
    </TooltipProvider>
  );
}

function Kpi({ label, def, val, sub, accent, ofVal, pct }: { label: string; def: string; val: string; sub: ReactNode; accent?: boolean; ofVal?: string; pct?: number | null }) {
  return (
    <div className={cn('wu-card wu-kpi', accent && 'accent')}>
      <div className="wu-klabel"><D d={def}>{label}</D></div>
      <div className="wu-val">{val}{ofVal && <span className="wu-val-of tnum">/{ofVal}</span>}</div>
      {pct != null && (
        <div className="wu-kpi-bar"><span style={{ width: `${Math.max(1, Math.min(100, pct))}%` }} /></div>
      )}
      <div className="wu-sub">{sub}</div>
    </div>
  );
}
function SectionH({ eyebrow, title, help, note, href, linkLabel }: { eyebrow: string; title: string; help: string; note: string; href?: string; linkLabel?: string }) {
  return (
    <div className="wu-section-h">
      <div className="wu-eyebrow">{eyebrow}</div>
      <h2><HelpTitle k={help}>{title}</HelpTitle></h2>
      <span className="wu-faint" style={{ fontSize: 12.5 }}>{note}</span>
      {href && <a className="wu-link" href={href} target="_blank" rel="noopener noreferrer">{linkLabel ?? 'Open page'} ↗</a>}
    </div>
  );
}

// Dynamic reading of the data — the comparisons a marketer would make by hand.
// Pure client-side arithmetic over the RPC payload; recomputed on every fetch.
// Used by the "What stands out" dialog (full list) and the Daily brief's
// "What to move today" card (top three).
function signalNotes(data: Dash): ReactNode[] {
  const mods = data.modules.filter((m) => m.module !== 'Other' && m.sessions >= 30);
  const conv = (m: Dash['modules'][number]) => (m.sessions > 0 ? (100 * m.orders) / m.sessions : 0);
  const rps = (m: Dash['modules'][number]) => (m.sessions > 0 ? m.revenue / m.sessions : 0);
  const notes: ReactNode[] = [];

  if (mods.length >= 2) {
    const topRev = [...mods].sort((a, b) => b.revenue - a.revenue)[0];
    const topRps = [...mods].sort((a, b) => rps(b) - rps(a))[0];
    if (topRev.revenue > 0 && rps(topRps) > 0 && topRev.module !== topRps.module) {
      notes.push(<><b>{topRev.module}</b> bills the most ({money(topRev.revenue)}) but <b>{topRps.module}</b> is worth {(rps(topRps) / Math.max(rps(topRev), 0.01)).toFixed(1)}× more per visitor — ${rps(topRps).toFixed(2)}/session and {conv(topRps).toFixed(1)}% conversion vs ${rps(topRev).toFixed(2)} and {conv(topRev).toFixed(1)}%. If it gets more traffic, it should out-earn its size.</>);
    }
    const withAdds = mods.filter((m) => m.adds >= 20);
    if (withAdds.length >= 2) {
      const worst = [...withAdds].sort((a, b) => a.orders / a.adds - b.orders / b.adds)[0];
      const best = [...withAdds].sort((a, b) => b.orders / b.adds - a.orders / a.adds)[0];
      const rate = (100 * worst.orders) / worst.adds;
      if (rate < 20 && worst.module !== best.module) notes.push(<><b>{worst.module}</b> fills carts that don't close: {int(worst.adds)} adds became only {int(worst.orders)} paid orders ({rate.toFixed(0)}% cart-close, vs {((100 * best.orders) / best.adds).toFixed(0)}% for {best.module}). Worth checking what happens between its add and checkout.</>);
    }
  }

  // A mixed family — calm total, disagreeing variants — is the most actionable
  // thing on the page and is invisible everywhere else.
  const famMap = new Map<string, Array<{ title: string; pct: number }>>();
  for (const r of data.byScreen) {
    if (r.baselineUnitsPerWeek <= 0) continue;
    const k = famOf(r.sku, r.title, false);
    famMap.set(k, [...(famMap.get(k) ?? []), { title: r.title, pct: pctOf(r.unitsPerWeek, r.baselineUnitsPerWeek) }]);
  }
  const mixed = [...famMap.entries()]
    .map(([k, rows]) => {
      const best = [...rows].sort((a, b) => b.pct - a.pct)[0];
      const worst2 = [...rows].sort((a, b) => a.pct - b.pct)[0];
      const mean = rows.reduce((a, b) => a + b.pct, 0) / rows.length;
      return { family: k, rows, best, worst: worst2, mean };
    })
    .filter((f) => f.rows.length >= 2 && Math.abs(f.mean) < 0.12 && f.best.pct > 0.15 && f.worst.pct < -0.15)
    .sort((a, b) => (b.best.pct - b.worst.pct) - (a.best.pct - a.worst.pct))[0];
  if (mixed) {
    const downs = mixed.rows.filter((r) => r.pct < 0).length;
    notes.push(<><b>{mixed.family} looks flat at {fmtPct(mixed.mean)}, and it isn't</b>: {mixed.best.title} is up {fmtPct(mixed.best.pct)} while {downs === 1 ? `${mixed.worst.title} is down` : `${downs} items are down`} — {mixed.worst.title} lost {fmtPct(Math.abs(mixed.worst.pct))} of its run rate. Products are moving in opposite directions behind a calm number — check <b>View: Products</b>.</>);
  }

  const screens = data.byScreen.filter((r) => r.baselineUnitsPerWeek > 0 && r.adds >= 3 && r.deltaPct != null);
  if (screens.length >= 2) {
    const up = [...screens].sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0))[0];
    const down = [...screens].sort((a, b) => (a.deltaPct ?? 0) - (b.deltaPct ?? 0))[0];
    if ((up.deltaPct ?? 0) > 10) notes.push(<><b>{up.title}</b> is selling <b>+{up.deltaPct}%</b> vs its pre-launch run rate ({up.unitsPerWeek} vs {up.baselineUnitsPerWeek} units/wk) with {int(up.adds)} module adds behind it.</>);
    if ((down.deltaPct ?? 0) < -10 && down.sku !== up.sku) notes.push(<><b>{down.title}</b> is running <b>{down.deltaPct}%</b> below its pre-launch rate despite {int(down.adds)} module adds — the modules push it, something else dropped.</>);
  }
  const deadReward = data.rewards.find((r) => r.sessions >= 10 && r.bought === 0);
  if (deadReward) notes.push(<>{int(deadReward.sessions)} carts crossed the <b>{REWARD_LABEL[deadReward.name] ?? deadReward.name}</b> threshold and none bought — money sitting in abandoned carts.</>);
  if (data.orderImpact?.aovLiftPct != null) {
    const l = data.orderImpact.aovLiftPct;
    notes.push(<>Orders that used an upgrade average <b>{l > 0 ? '+' : ''}{l}%</b> AOV vs everyone else ({money(data.orderImpact.upgradeAov)} vs {money(data.orderImpact.otherAov)}). Observed difference, not a controlled test.</>);
  }
  return notes;
}

function Signals({ data, windowLabel }: { data: Dash; windowLabel: string }) {
  const notes = signalNotes(data);
  return (
    <div className="wu-signals">
      <div className="wu-muted" style={{ marginBottom: 4 }}>Computed live from the numbers currently on the page — window <b>{windowLabel}</b>. Change the dates or environment and these re-rank.</div>
      {notes.length === 0 ? <div className="wu-muted">Not enough data in this window to say anything with confidence.</div> : <ul>{notes.map((n, i2) => <li key={i2}>{n}</li>)}</ul>}
    </div>
  );
}

// Every concept used on this page, with its formula. Opened from the header.
function Glossary() {
  const G: Array<[string, string, string]> = [
    ['Exposed session', '—', 'A distinct anonymous visitor (attribution_id, persisted in their browser) that fired at least one upgrade-module event in the window.'],
    ['View', '—', 'The module was shown on screen (its panel or nudge rendered).'],
    ['Pick', '—', 'The shopper engaged the middle step — selected their machine, or opened a recommendation.'],
    ['Click', '—', "Clicked 'add' on something the module offered."],
    ['Add', '—', 'The cart confirmed the item went in. An add is NOT a purchase.'],
    ['Order (paid)', '—', 'A completed, paid Shopify order containing at least one line the module added. The real bottom line.'],
    ['CTR', 'clicks ÷ views × 100', 'How tempting the module is to the people who see it.'],
    ['Adds/session', 'adds ÷ sessions', 'An average (a session can add twice), not a percentage.'],
    ['Conversion rate', 'paid orders ÷ sessions × 100', 'The share of exposed visitors who ended up buying.'],
    ['$/session', 'attributed revenue ÷ sessions', 'What each exposed visitor is worth — best metric for comparing modules with different traffic.'],
    ['Cart-close rate (CLOSE)', 'paid orders ÷ adds × 100', 'Of what entered the cart, how much actually got paid for.'],
    ['Step conversion (Where it drops off)', 'next stage ÷ this stage × 100', 'The percentage between two funnel stages — CTR (views→clicks), ADD (clicks→adds), CLOSE (adds→orders). Green = best of the four modules at that step, red = worst.'],
    ['Direct order / revenue', 'sum of module-added lines (AUD net)', "Orders and revenue of the specific lines a module added (the line carries _pesado_source) — only those lines, not the whole order."],
    ['Assisted order', '—', "An order linked to a previous module interaction via the attribution id the theme writes on the cart (__pesado_*) — the shopper interacted earlier, maybe another day, then bought."],
    ['AOV (per module)', 'sum(full order value) ÷ orders that used the module', 'The whole basket of those orders, not just the added line.'],
    ['Basket impact / upgrade lift', '(upgrade AOV − other AOV) ÷ other AOV × 100', 'Orders that used any module vs every other store order in the window. Observed difference between two groups, not a controlled test.'],
    ['Store impact', 'module orders ÷ all store orders · attributed revenue ÷ all store net revenue', 'The weight of the upgrade work in the whole business for the window. Three different percentages exist: orders share, attributed-revenue share, and (in the store context) the module-ORDER revenue share — each is labelled with its unit.'],
    ['Order revenue touched', 'sum(full order total of orders with a module line)', 'Everything billed by orders that used a module — the module lines plus whatever rode along in the same order. The middle layer between attributed revenue and the store total.'],
    ['Pre-launch / Delta (Products)', 'units sold Apr 28 → Jul 21 ÷ 12 weeks · delta = mean of variant %', "The baseline is real Shopify units per SKU over the 84 days before launch (Apr 28 → Jul 21, 2026, the old theme) ÷ 12 weeks — e.g. PF02BR58-WSL-HY sold 3 units in that window → 0.25 u/wk. Captured on Jul 22, never recalculated. A variant with no baseline but sales now counts as +100%. The family delta is the AVERAGE of the variant percentages currently passing the filter — how much a typical product moved, not how the catalogue moved in units. Directional — ad spend and seasonality move it too."],
    ['Attributed vs u/wk now (Products)', '—', 'Two different questions about the same product. u/wk now = ALL its Shopify sales in the window (normal Add-to-cart included) — used for the before/after vs the pre-launch rate. Attributed = only the paid orders where a MODULE placed the line. A row can sell well overall with an empty Attributed: the modules offered it, nobody bought through them.'],
    ['Reward carts → bought', '—', 'Carts that crossed a reward threshold (free shipping $100 / 10% $200 / 15% $300) and how many of those sessions completed a purchase. Crossing a tier is intent, not a sale.'],
    ['Preview vs Production', '—', 'preview = test traffic from the theme preview; production = live customers. Commercial numbers use production.'],
    ['Data cadence', '—', 'Funnel events are real-time (the pixel posts each one instantly). Sales refresh every ~5 minutes via the fast sync (interval configurable in Config → Connections), with a full reconciliation 3×/day.'],
  ];
  return (
    <div className="wu-glossary">
      {G.map(([term, formula, def]) => (
        <div key={term} className="wu-gloss-row">
          <div className="wu-gloss-term">{term}{formula !== '—' && <div className="wu-gloss-formula">{formula}</div>}</div>
          <div className="wu-gloss-def">{def}</div>
        </div>
      ))}
    </div>
  );
}

const WU_CSS = `
.wu{--wu-ground:#F4EEE3;--wu-card:#FFFFFF;--wu-card2:#FBF6EC;--wu-line:#E8DFCC;--wu-text:#241B12;--wu-dim:#786A53;--wu-faint:#A2937C;--wu-crema:#B9812A;--wu-crema2:#D19B34;--wu-crema-soft:rgba(201,138,41,.10);--wu-pos:#2E9E6E;--wu-neg:#C6513A;--wu-shadow:0 1px 2px rgba(60,40,10,.06),0 10px 34px rgba(60,40,10,.07);--wu-inkbg:#241B12;--wu-inkfg:#F2EADF;--wu-inkfg2:rgba(242,234,223,.82);--wu-gold:#E9B252;
  position:relative;font-family:'Inter',system-ui,sans-serif;color:var(--wu-text);background:radial-gradient(1200px 500px at 12% -10%,var(--wu-crema-soft),transparent 60%),var(--wu-ground);padding:clamp(14px,2vw,22px);border-radius:16px}
.dark .wu{--wu-ground:#17120E;--wu-card:#221B15;--wu-card2:#2A2119;--wu-line:#33291E;--wu-text:#F2EADF;--wu-dim:#B7A991;--wu-faint:#87795F;--wu-crema:#E9B252;--wu-crema2:#F0C877;--wu-crema-soft:rgba(233,178,82,.13);--wu-pos:#5BC08E;--wu-neg:#E0725A;--wu-shadow:0 1px 2px rgba(0,0,0,.4),0 8px 30px rgba(0,0,0,.28);--wu-inkbg:#1C1610}
.wu h1,.wu h2{font-family:'Fraunces',Georgia,serif}
.wu .tnum{font-variant-numeric:tabular-nums}.wu-faint{color:var(--wu-faint)}.wu-dim{color:var(--wu-dim)}.wu-mono{font-family:ui-monospace,monospace;font-size:12px}
.wu-def{border-bottom:1px dashed var(--wu-faint);cursor:help}
.wu-defcard{position:absolute;z-index:90;width:300px;background:var(--wu-card);border:1px solid var(--wu-line);border-radius:10px;padding:11px 14px;box-shadow:0 12px 34px rgba(60,40,10,.18);font-size:11.5px;line-height:1.55;color:var(--wu-dim);pointer-events:none}
.wu-info{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--wu-faint);color:var(--wu-faint);font-size:9px;font-weight:700;cursor:help;line-height:1;vertical-align:middle}
.wu-info:hover,.wu-info:focus{border-color:var(--wu-crema);color:var(--wu-crema);outline:none}
.wu-help{border-bottom:1px dashed var(--wu-faint);cursor:help;transition:border-color .15s,color .15s}
.wu-help:hover,.wu-help:focus{border-bottom-color:var(--wu-crema);color:var(--wu-crema);outline:none}
.wu-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.wu-eyebrow{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--wu-crema)}
.wu-title{font-size:clamp(24px,3vw,36px);font-weight:600;letter-spacing:-.01em;line-height:1.05;margin-top:6px}.wu-title em{font-style:italic;color:var(--wu-crema)}
.wu-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--wu-dim);background:var(--wu-card);border:1px solid var(--wu-line);border-radius:999px;padding:7px 14px}
.wu-live{width:7px;height:7px;border-radius:50%;background:var(--wu-pos)}
.wu-gloss{cursor:pointer;gap:6px}
.wu-gloss:hover{border-color:var(--wu-crema);color:var(--wu-crema)}
.wu-share{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center;background:linear-gradient(158deg,var(--wu-card),var(--wu-card2));border:1px solid var(--wu-line);border-left:3px solid var(--wu-crema);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--wu-dim);box-shadow:var(--wu-shadow);cursor:pointer;transition:border-color .15s}
.wu-share:hover{border-color:var(--wu-crema)}
.wu-share-k{font-weight:700;color:var(--wu-crema);font-size:11px;letter-spacing:.12em;text-transform:uppercase}
.wu-share-item b{color:var(--wu-text);font-family:'Fraunces',Georgia,serif;font-size:15px}
.wu-share-cta{margin-left:auto;font-size:11.5px;font-weight:600;color:var(--wu-crema);white-space:nowrap}
.wu-signals ul{margin:10px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:8px}
.wu-signals li{font-size:13px;line-height:1.55;color:var(--wu-dim)}
.wu-signals li b{color:var(--wu-text)}
.wu-signals li::marker{color:var(--wu-crema)}
.wu-glossary{display:flex;flex-direction:column}
.wu-gloss-row{display:grid;grid-template-columns:180px 1fr;gap:14px;padding:9px 0;border-bottom:1px solid rgba(128,110,80,.15)}
.wu-gloss-row:last-child{border-bottom:none}
.wu-gloss-term{font-weight:600;font-size:13px}
.wu-gloss-def{font-size:13px;line-height:1.55;opacity:.85}
.wu-gloss-formula{font-family:ui-monospace,monospace;font-size:11px;color:var(--wu-crema);margin-top:3px;font-weight:500}
.wu-collbtn{margin-left:auto;background:none;border:none;cursor:pointer;color:var(--wu-faint);padding:2px 4px;line-height:1}
.wu-collbtn:hover{color:var(--wu-crema)}
.wu-collbtn .wu-chev{font-size:15px}
.wu-collbtn .wu-chev.open{transform:rotate(90deg)}
.wu-seg-sm button{padding:4px 10px;font-size:11.5px}
.wu-coll-sum{margin-left:auto;font-size:12.5px;color:var(--wu-dim);font-weight:600;font-family:'Fraunces',Georgia,serif}
.wu-coll-sum + .wu-collbtn{margin-left:8px}
.wu-clickhead{cursor:pointer}
.wu-clickhead:hover .wu-chev{color:var(--wu-crema)}
.wu-scrollbody{max-height:290px;overflow-y:auto;margin-top:10px;scrollbar-width:thin;scrollbar-color:var(--wu-faint) transparent}
.wu-scrollbody::-webkit-scrollbar{width:8px}
.wu-scrollbody::-webkit-scrollbar-thumb{background:var(--wu-line);border-radius:99px}
.wu-scrollbody .wu-table th{position:sticky;top:0;background:var(--wu-card);z-index:1}
.wu-group-row{cursor:pointer}
.wu-group-row:hover td{background:var(--wu-crema-soft)}
.wu-group-row .wu-chev{display:inline-block;transition:transform .15s;color:var(--wu-faint)}
.wu-group-row .wu-chev.open{transform:rotate(90deg)}
.wu-ctx{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.wu-seg{display:inline-flex;background:var(--wu-card);border:1px solid var(--wu-line);border-radius:999px;padding:3px}
.wu-seg button{font-size:12px;font-weight:500;color:var(--wu-dim);background:none;border:none;padding:6px 13px;border-radius:999px;cursor:pointer;transition:.18s;white-space:nowrap}
.wu-seg button[aria-pressed="true"]{background:var(--wu-crema);color:#20160a;font-weight:600}
.wu-range{font-size:12px;color:var(--wu-dim)}
.wu-err{display:flex;gap:8px;align-items:center;color:var(--wu-neg);border:1px solid var(--wu-neg);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px}
.wu-empty{background:var(--wu-crema-soft);border:1px solid var(--wu-line);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--wu-dim);margin-bottom:14px}
.wu-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.wu-card{background:linear-gradient(158deg,var(--wu-card),var(--wu-card2));border:1px solid var(--wu-line);border-radius:16px;padding:18px;position:relative;box-shadow:var(--wu-shadow);overflow:hidden}
.wu-card.accent::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--wu-crema),transparent 70%)}
.wu-klabel{font-size:12px;font-weight:500;color:var(--wu-dim);display:flex;align-items:center;gap:6px}
.wu-val{font-size:clamp(22px,2.4vw,30px);font-weight:600;letter-spacing:-.02em;margin-top:10px;line-height:1;font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.wu-sub{font-size:11.5px;color:var(--wu-faint);margin-top:7px}
.wu-section-h{display:flex;align-items:baseline;gap:12px;margin:28px 2px 14px;flex-wrap:wrap}
.wu-section-h h2{font-size:18px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:7px}
.wu-link{font-size:12px;font-weight:600;color:var(--wu-crema);text-decoration:none;border-bottom:1px solid transparent;transition:border-color .15s}
.wu-link:hover{border-bottom-color:var(--wu-crema)}
.wu-two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.wu-table{width:100%;border-collapse:collapse;font-size:13px}
.wu-table th{text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--wu-faint);padding:0 0 10px;border-bottom:1px solid var(--wu-line)}
.wu-table th.r,.wu-table td.r{text-align:right}
.wu-table td{padding:11px 0;border-bottom:1px solid var(--wu-line)}
.wu-table tr:last-child td{border-bottom:none}
.wu-mod{font-weight:600;font-family:'Fraunces',Georgia,serif}
.wu-brand-row td{border-bottom:none;padding-bottom:4px}
.wu-model-row td{padding:2px 0 6px;border-bottom:1px solid var(--wu-line);font-size:12.5px}
.wu-model-name{padding-left:16px !important;color:var(--wu-dim);position:relative}
.wu-model-name::before{content:"└";position:absolute;left:4px;color:var(--wu-faint)}
.wu-row{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--wu-line)}
.wu-row:last-child{border-bottom:none}.wu-row b{font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.wu-muted{font-size:12.5px;color:var(--wu-faint)}
.wu-step{margin-bottom:12px}.wu-step:last-of-type{margin-bottom:0}
.wu-step-h{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}
.wu-step-h b{font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.wu-bar{height:7px;border-radius:999px;background:var(--wu-crema-soft);overflow:hidden}
.wu-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--wu-crema),var(--wu-crema2))}
.wu-foot{margin-top:24px;padding-top:16px;border-top:1px solid var(--wu-line);font-size:12px;color:var(--wu-faint);line-height:1.7}.wu-foot b{color:var(--wu-dim);font-weight:600}
.wu-view{height:32px;border-radius:999px;border:1.5px solid var(--wu-crema);background:var(--wu-card);color:var(--wu-text);font-size:12px;font-weight:600;padding:0 12px;cursor:pointer}
.wu-view:hover{border-color:var(--wu-crema2)}
.wu-blocks{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.wu-block-thumb{width:104px;height:60px;object-fit:cover;object-position:left top;border-radius:6px;border:1px solid var(--wu-line);flex-shrink:0;transition:transform .18s ease;transform-origin:top left;position:relative;cursor:zoom-in}
.wu-block-thumb:hover{transform:scale(3.2);z-index:40;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.wu-card.wu-block{overflow:visible}
.wu-machine-variant{font-size:12px;padding:4px 0 6px}
.wu-block-h{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.wu-block-name{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:15px}
.wu-block-rev{text-align:right}
.wu-block-money{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:18px;color:var(--wu-crema)}
.wu-block-bars{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.wu-block-bar{display:grid;grid-template-columns:76px 1fr 52px;gap:8px;align-items:center;font-size:11.5px;color:var(--wu-dim)}
.wu-block-bar b{text-align:right}
.wu-chev{color:var(--wu-faint);transition:transform .15s;display:inline-block}
.wu-chev.open{transform:rotate(90deg)}
.wu-hero{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-bottom:2px solid var(--wu-text);padding-bottom:10px;margin-top:22px}
.wu-hero h2{font-size:26px;font-weight:600;margin:0;letter-spacing:-.01em}
.wu-hero h2 em{font-style:italic;color:var(--wu-crema)}
.wu-dgrid{display:grid;grid-template-columns:1.5fr 1fr;gap:18px;margin-top:16px;align-items:start}
.wu-kicker{font-size:9.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--wu-faint)}
.wu-h3row{display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--wu-line);padding-bottom:7px}
.wu-h3row h3{font-family:'Fraunces',Georgia,serif;font-size:15px;font-weight:600;margin:0}
.wu-rankrow{display:grid;grid-template-columns:22px 1fr 1.1fr 76px 100px;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--wu-line)}
.wu-rankchip{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:5px;background:rgba(36,27,18,.12);color:var(--wu-text);font-size:10px;font-weight:700}
.dark .wu-rankchip{background:rgba(242,234,223,.16);color:var(--wu-text)}
.wu-ink{background:var(--wu-inkbg);color:var(--wu-inkfg)}
.dark .wu-ink{border:1px solid var(--wu-line)}
.wu-oigrid{display:grid;grid-template-columns:1fr 76px 76px 56px;gap:10px;align-items:center}
.wu-famcard{border:1px solid var(--wu-line);border-radius:12px;padding:12px 14px;background:var(--wu-card);cursor:pointer;transition:border-color .15s}
.wu-famcard:hover{border-color:var(--wu-crema)}
.wu-entry-tbl{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
.wu-entry-tbl th{text-align:right;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--wu-faint);font-weight:500;padding:0 0 6px}
.wu-entry-tbl th:first-child,.wu-entry-tbl td:first-child{text-align:left}
.wu-entry-tbl td{text-align:right;padding:7px 0;border-top:1px solid var(--wu-line)}
.wu-entry-tbl tbody tr:first-child td{font-weight:600}
.wu-mcard{padding:0}
.wu-mband1{display:flex;gap:14px;padding:16px 18px 14px;align-items:flex-start}
.wu-mthumb{width:112px;height:66px;border-radius:8px}
.wu-card.wu-mcard{overflow:visible}
.wu-mrates{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--wu-line);border-bottom:1px solid var(--wu-line);background:rgba(201,138,41,.045)}
.wu-mrate{padding:11px 14px;border-right:1px solid var(--wu-line)}
.wu-mrate-v{font-family:'Fraunces',Georgia,serif;font-size:21px;font-weight:600;margin-top:4px;line-height:1}
.wu-mrate-bar{height:3px;border-radius:999px;background:rgba(201,138,41,.16);margin-top:7px;overflow:hidden}
.wu-mrate-bar span{display:block;height:100%}
.wu-mrate-c{font-size:10px;color:var(--wu-faint);margin-top:5px}
.wu-mfun{display:grid;grid-template-columns:1fr 48px 1fr 48px 1fr 48px 1fr;align-items:end;gap:0 8px}
.wu-mstep-n{font-family:'Fraunces',Georgia,serif;font-size:17px;font-weight:600}
.wu-mstep-l{font-size:10px;color:var(--wu-faint);margin-top:2px}
.wu-mstep-b{height:22px;margin-top:9px;border-radius:3px;background:linear-gradient(180deg,var(--wu-crema2),var(--wu-crema))}
.wu-mstep-share{display:flex;align-items:center;justify-content:center;cursor:help}
.wu-mstep-share span{font-size:10px;font-weight:700;color:#fff;letter-spacing:.02em;line-height:1}
.wu-val-of{font-size:.52em;font-weight:500;color:var(--wu-faint);margin-left:5px;letter-spacing:0}
.wu-kpi-bar{height:4px;border-radius:999px;background:var(--wu-crema-soft);overflow:hidden;margin-top:9px}
.wu-kpi-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--wu-crema),var(--wu-crema2))}
.wu-mconn{text-align:center;padding-bottom:1px}
.wu-mconn-l{font-size:8.5px;font-weight:700;letter-spacing:.04em;color:var(--wu-faint)}
.wu-mconn-v{font-size:11px;font-weight:700;line-height:1.25}
.wu-famgrid{display:grid;grid-template-columns:1fr 74px 92px 84px 84px 158px;gap:12px;align-items:center;padding:13px 18px}
.wu-famhead{padding:11px 18px;border-bottom:2px solid var(--wu-text);font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--wu-faint)}
.wu-famrow{border-bottom:1px solid var(--wu-line);cursor:pointer}
.wu-famrow:hover{background:rgba(201,138,41,.06)}
.wu-varrow{padding:9px 18px 9px 40px;font-size:12px}
.wu-famtotal{background:rgba(201,138,41,.07)}
@media (max-width:900px){.wu-kpis{grid-template-columns:repeat(2,1fr)}.wu-two{grid-template-columns:1fr}.wu-blocks{grid-template-columns:1fr}.wu-dgrid{grid-template-columns:1fr}.wu-rankrow{grid-template-columns:22px 1fr 60px;grid-template-rows:auto auto}.wu-famgrid{grid-template-columns:1fr 60px 70px 60px}}
`;
