import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { format } from 'date-fns';
import { Calendar as CalendarIcon, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DateRangePresets } from '@/components/DateRangePresets';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

// ── design tokens (coffee "espresso terminal": cream/gold in light, espresso in dark) ──
const CHART_GOLD = '#E9B252';
const CHART_POS = '#4FB98C';
const CHART_AXIS = '#93826A';

interface DateRange { from?: Date; to?: Date; }
interface EcommerceTabProps { dateRange?: DateRange; setDateRange?: (r: DateRange) => void; fxRate?: number; }

type Market = 'all' | 'usa' | 'australia';

interface Dash {
  params: { from: string; to: string; market: string; margin: number };
  kpis: Record<string, number | null>;
  prior: Record<string, number | boolean | null>;
  bridge: Record<string, number>;
  funnel: Record<string, number>;
  market: { usa: Record<string, number | null>; australia: Record<string, number | null> };
  trend: Array<{ ym: string; revenue: number; spend: number; conv: number; orders: number; mer: number | null }>;
  geo: Array<{ country: string; revenue: number; units: number }>;
  family: Array<{ family: string; revenue: number; units: number; pct: number; aovUnit: number }>;
  products: Array<{ title: string; revenue: number; units: number }>;
}

const HELP: Record<string, string> = {
  mer: "Marketing Efficiency Ratio — total store revenue ÷ total ad spend. The attribution-proof 'north star': how many dollars of revenue every ad dollar returns across all orders, not just the ones a platform claims.",
  revenue: 'Gross sales minus discounts and returns (excludes tax and shipping). The revenue that actually reaches the business.',
  spend: "Total Meta ad spend across the USA (USD) and Australia (AUD) accounts, converted to AUD at each month's rate.",
  poas: 'Profit on Ad Spend — contribution margin ÷ ad spend, using an editable blended-margin assumption. Unlike ROAS it accounts for product cost, so it reflects profit, not just revenue, per ad dollar.',
  orders: 'Count of distinct Shopify orders in the selected period and market.',
  purchaseRoas: 'Meta-attributed conversion value ÷ Meta ad spend. Platform-reported return; tends to over-credit ads versus the blended MER.',
  conv: "Total purchase value Meta attributes to its ads (omni_purchase). The 'return' side of ROAS.",
  cpo: 'Ad spend ÷ orders. A proxy for customer-acquisition cost; true CAC needs new-vs-returning data we do not have yet.',
  aov: 'Average Order Value — net revenue ÷ orders. Rising AOV lifts margin without extra acquisition cost.',
  ctr: 'Click-through rate — clicks ÷ impressions. Creative and audience resonance; a leading indicator of ad fatigue.',
  cpc: 'Cost per click — ad spend ÷ clicks.',
  cpm: 'Cost per mille — ad spend per 1,000 impressions. The cost of reach.',
  returnRate: 'Value of returns ÷ gross sales. Returns quietly erode ROAS and margin, so they get a first-class tile.',
  trend: 'Monthly net revenue (area) against Meta ad spend (bars), with MER on the right axis. Hover any month for exact values.',
  funnel: "Meta's ad funnel: impressions → clicks → add-to-cart → checkout → purchase, with the drop-off at each step. Meta events, not strictly nested.",
  marketSplit: 'USA is the USD Meta account + US-shipping orders; Australia is the AUD account + AU orders. Recomputes for the selected date range.',
  geo: 'Net revenue by shipping destination for the selected range and market.',
  bridge: 'How gross sales become net revenue: subtract discounts, then returns. Shipping and tax sit outside net.',
  signals: 'Conclusions pulled from SKU-level sales: which families carry the business and where the biggest baskets come from.',
  products: 'Top products by net revenue for the selected range and market.',
};

// ── formatters ──
const money = (v: number | null | undefined) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
};
const int = (v: number | null | undefined) => (Number(v) || 0).toLocaleString('en-US');
const toYMD = (d: Date) => format(d, 'yyyy-MM-dd');
function currentFY(): DateRange {
  const now = new Date();
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: new Date(y, 6, 1), to: now };
}

// ── small building blocks ──
function Info({ k }: { k: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ecom-info" tabIndex={0} aria-label="What is this?">i</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-xs leading-relaxed">{HELP[k]}</TooltipContent>
    </Tooltip>
  );
}
function Delta({ cur, prev, goodUp = true }: { cur: number; prev: number | null | undefined; goodUp?: boolean }) {
  if (prev == null || prev === 0) return <span className="text-[11px] ecom-faint">— no prior</span>;
  const p = ((cur - prev) / prev) * 100;
  const up = p >= 0;
  const good = goodUp ? up : !up;
  return (
    <span className={cn('ecom-delta', good ? 'up' : 'down')}>
      {up ? '▴' : '▾'} {Math.abs(p).toFixed(1)}% <span className="ecom-faint" style={{ fontWeight: 400 }}>vs prior</span>
    </span>
  );
}

function TrendTip({ active, payload, label }: { active?: boolean; payload?: Array<{ payload: Dash['trend'][number] }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="ecom-charttip">
      <div className="tt">{label}</div>
      <div className="tr"><span>Net revenue</span><b>{money(d.revenue)}</b></div>
      <div className="tr"><span>Ad spend</span><b>{money(d.spend)}</b></div>
      <div className="tr"><span>MER</span><b style={{ color: CHART_POS }}>{d.mer != null ? `${d.mer.toFixed(2)}×` : '–'}</b></div>
    </div>
  );
}

export default function EcommerceTab({ dateRange, setDateRange }: EcommerceTabProps) {
  const [market, setMarket] = useState<Market>('all');
  const [data, setData] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const range = useMemo<DateRange>(() => (dateRange?.from && dateRange?.to ? dateRange : currentFY()), [dateRange]);

  const fetchData = useCallback(async () => {
    if (!range.from || !range.to) return;
    setLoading(true); setError(null);
    const { data: res, error: err } = await supabase.rpc('ecommerce_dashboard', {
      p_from: toYMD(range.from), p_to: toYMD(range.to), p_market: market, p_margin: 0.45,
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setData(res as Dash);
    setLoading(false);
  }, [range.from, range.to, market]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const k = data?.kpis;
  const prior = data?.prior;
  const trend = useMemo(() => (data?.trend ?? []).map((t) => ({ ...t, label: t.ym.slice(2).replace('-', "/") })), [data]);
  const funnelSteps = useMemo(() => {
    const f = data?.funnel; if (!f) return [];
    return [
      { n: 'Impressions', v: f.impressions, w: 100 },
      { n: 'Clicks', v: f.clicks, w: 78, rate: f.impressions ? (f.clicks / f.impressions) * 100 : 0, rl: 'CTR' },
      { n: 'Add to cart', v: f.addToCart, w: 56, rate: f.clicks ? (f.addToCart / f.clicks) * 100 : 0, rl: 'of clicks' },
      { n: 'Checkout', v: f.initiateCheckout, w: 40, rate: f.addToCart ? (f.initiateCheckout / f.addToCart) * 100 : 0, rl: 'of add-to-cart' },
      { n: 'Purchases', v: f.purchases, w: 26, rate: f.initiateCheckout ? (f.purchases / f.initiateCheckout) * 100 : 0, rl: 'of checkout' },
    ];
  }, [data]);

  return (
    <TooltipProvider delayDuration={120}>
      <style>{ECOM_CSS}</style>
      <div className="ecom">
        {/* Header */}
        <div className="ecom-head">
          <div>
            <div className="ecom-eyebrow">Dolo Coffee Supplies · Marketing</div>
            <h1 className="ecom-title">E-commerce <em>Performance</em></h1>
          </div>
          <span className="ecom-pill"><span className="ecom-live" />Live from DB · auto-synced 3×/day</span>
        </div>

        {/* Controls */}
        <div className="ecom-ctx">
          <div className="ecom-seg" role="group" aria-label="Market">
            {(['all', 'usa', 'australia'] as Market[]).map((m) => (
              <button key={m} aria-pressed={market === m} onClick={() => setMarket(m)}>
                {m === 'all' ? 'All markets' : m === 'usa' ? '🇺🇸 USA' : '🇦🇺 Australia'}
              </button>
            ))}
          </div>
          {setDateRange && (
            <Popover open={pickerOpen} onOpenChange={setPickerOpen} modal>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-medium">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {range.from && range.to ? `${format(range.from, 'MMM d, yyyy')} – ${format(range.to, 'MMM d, yyyy')}` : 'Date range'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="flex">
                  <DateRangePresets onSelect={(r) => { setDateRange(r); setPickerOpen(false); }} />
                  <div>
                    <Calendar initialFocus mode="range" defaultMonth={range.from} selected={range as never}
                      onSelect={(r) => setDateRange((r as DateRange) || {})} numberOfMonths={2} weekStartsOn={1} />
                    <div className="p-2 border-t flex justify-end"><Button size="sm" onClick={() => setPickerOpen(false)}>Apply</Button></div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
          <Button variant="ghost" size="sm" className="h-8" onClick={fetchData} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          {loading && <span className="text-xs ecom-faint">updating…</span>}
        </div>

        {error && (
          <div className="ecom-err"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{error}</span></div>
        )}

        {k && (
          <>
            {/* Hero bento */}
            <div className="ecom-bento">
              <div className="ecom-card accent ecom-hero">
                <div>
                  <div className="ecom-klabel">Blended MER — Marketing Efficiency Ratio <Info k="mer" /></div>
                  <div className="ecom-hero-val">{k.mer != null ? Number(k.mer).toFixed(2) : '–'}<span className="x">×</span></div>
                </div>
                <div className="ecom-hero-cap">${k.mer != null ? Number(k.mer).toFixed(2) : '–'} of store revenue for every $1 spent on Meta.</div>
                <div className="ecom-hero-foot">
                  <Delta cur={Number(k.mer) || 0} prev={prior?.mer as number} />
                  <span className="ecom-faint" style={{ fontSize: 12 }}>Purchase ROAS (Meta) {k.purchaseRoas != null ? `${Number(k.purchaseRoas).toFixed(2)}×` : '–'}</span>
                </div>
              </div>
              <div className="ecom-strip">
                <div className="ecom-card accent">
                  <div className="ecom-klabel">Net Revenue <Info k="revenue" /></div>
                  <div className="ecom-val">{money(k.revenue)}</div>
                  <div className="ecom-sub">net of discounts &amp; returns</div>
                  <div className="ecom-dwrap"><Delta cur={Number(k.revenue) || 0} prev={prior?.revenue as number} /></div>
                </div>
                <div className="ecom-card">
                  <div className="ecom-klabel">Ad Spend <Info k="spend" /></div>
                  <div className="ecom-val">{money(k.spend)}</div>
                  <div className="ecom-sub">Meta · native AUD</div>
                  <div className="ecom-dwrap"><Delta cur={Number(k.spend) || 0} prev={prior?.spend as number} goodUp={false} /></div>
                </div>
                <div className="ecom-card profit">
                  <div className="ecom-klabel">est. POAS <span className="ecom-tag">Profit</span> <Info k="poas" /></div>
                  <div className="ecom-val">{k.poas != null ? `${Number(k.poas).toFixed(2)}×` : '–'}</div>
                  <div className="ecom-sub">assumes 45% blended margin</div>
                </div>
                <div className="ecom-card">
                  <div className="ecom-klabel">Orders <Info k="orders" /></div>
                  <div className="ecom-val">{int(k.orders)}</div>
                  <div className="ecom-sub">AOV ${Number(k.aov).toFixed(0)} · {Number(k.upo).toFixed(1)} units/order</div>
                  <div className="ecom-dwrap"><Delta cur={Number(k.orders) || 0} prev={prior?.orders as number} /></div>
                </div>
              </div>
            </div>

            {/* Mini KPIs */}
            <div className="ecom-mini">
              <MiniKpi label="Purchase ROAS" help="purchaseRoas" val={k.purchaseRoas != null ? `${Number(k.purchaseRoas).toFixed(2)}×` : '–'} sub="Meta-attributed" />
              <MiniKpi label="Conversion Value" help="conv" val={money(k.conv)} sub="Meta omni_purchase" />
              <MiniKpi label="Cost / Order" help="cpo" val={k.cpo != null ? `$${Number(k.cpo).toFixed(2)}` : '–'} sub="CAC proxy" />
              <MiniKpi label="AOV" help="aov" val={`$${Number(k.aov).toFixed(0)}`} sub={<Delta cur={Number(k.aov) || 0} prev={prior?.aov as number} />} />
              <MiniKpi label="CTR" help="ctr" val={`${Number(k.ctr).toFixed(2)}%`} sub={`CPC $${Number(k.cpc).toFixed(2)} · CPM $${Number(k.cpm).toFixed(1)}`} />
              <MiniKpi label="Return rate" help="returnRate" val={`${Number(k.returnRate).toFixed(1)}%`} sub={`${money(k.returns)} returned`} />
            </div>

            {/* Trend */}
            <SectionH eyebrow="Trend" title="Revenue vs Ad Spend" help="trend" note="hover for detail · follows the filters" />
            <div className="ecom-card">
              <div className="ecom-legend">
                <span><i style={{ background: CHART_GOLD }} />Net revenue</span>
                <span><i style={{ background: CHART_AXIS }} />Ad spend</span>
                <span><i style={{ background: CHART_POS }} />MER (right)</span>
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ecomRev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_GOLD} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={CHART_GOLD} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(147,130,106,.22)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART_AXIS }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="l" tick={{ fontSize: 10, fill: CHART_AXIS }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} width={46} />
                  <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: CHART_AXIS }} tickLine={false} axisLine={false} width={30} />
                  <RTooltip content={<TrendTip />} cursor={{ stroke: CHART_GOLD, strokeOpacity: 0.4 }} />
                  <Bar yAxisId="l" dataKey="spend" fill={CHART_AXIS} fillOpacity={0.5} radius={[3, 3, 0, 0]} maxBarSize={34} isAnimationActive={false} />
                  <Area yAxisId="l" dataKey="revenue" stroke={CHART_GOLD} strokeWidth={2.5} fill="url(#ecomRev)" isAnimationActive={false} />
                  <Line yAxisId="r" dataKey="mer" stroke={CHART_POS} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Funnel + Market */}
            <div className="ecom-two">
              <div className="ecom-card">
                <div className="ecom-klabel" style={{ marginBottom: 4 }}>Acquisition funnel · Meta <Info k="funnel" /></div>
                <div className="ecom-funnel">
                  {funnelSteps.map((s, i) => (
                    <div key={s.n}>
                      <div className="fstep" style={{ width: `${s.w}%` }}>
                        <span className="fn">{s.n}</span><span className="fv">{int(s.v)}</span>
                      </div>
                      {i < funnelSteps.length - 1 && funnelSteps[i + 1].rate != null && (
                        <div className="fdrop">↓ {funnelSteps[i + 1].rate!.toFixed(funnelSteps[i + 1].rate! < 10 ? 2 : 1)}% {funnelSteps[i + 1].rl}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="ecom-card">
                <div className="ecom-klabel" style={{ marginBottom: 12 }}>Market split · USA vs Australia <Info k="marketSplit" /></div>
                <div className="ecom-mkt">
                  {(['usa', 'australia'] as const).map((mk) => {
                    const m = data!.market[mk];
                    return (
                      <div key={mk}>
                        <div className="ecom-flag">{mk === 'usa' ? '🇺🇸 USA' : '🇦🇺 Australia'} <span className="ecom-faint">· {mk === 'usa' ? 'USD' : 'AUD'} account</span></div>
                        <div className="ecom-mrow"><span className="ecom-dim">Revenue</span><b>{money(m.revenue)}</b></div>
                        <div className="ecom-mrow"><span className="ecom-dim">Ad spend</span><b>{money(m.spend)}</b></div>
                        <div className="ecom-mrow"><span className="ecom-dim">Purchase ROAS</span><b>{m.roas != null ? `${Number(m.roas).toFixed(2)}×` : '–'}</b></div>
                        <div className="ecom-mrow"><span className="ecom-dim">Rev share</span><b>{m.share}%</b></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Geo + Bridge */}
            <div className="ecom-two">
              <div className="ecom-card">
                <div className="ecom-klabel" style={{ marginBottom: 10 }}>Revenue by country <Info k="geo" /></div>
                {(() => {
                  const mx = data!.geo[0]?.revenue || 1;
                  return data!.geo.map((g) => (
                    <div key={g.country} className="ecom-bar-row">
                      <span>{COUNTRY[g.country] ?? g.country}</span>
                      <div className="ecom-bar-track"><div className="ecom-bar-fill" style={{ width: `${(g.revenue / mx) * 100}%` }} /></div>
                      <span className="ecom-bar-val">{money(g.revenue)}</span>
                    </div>
                  ));
                })()}
              </div>
              <div className="ecom-card">
                <div className="ecom-klabel" style={{ marginBottom: 6 }}>Sales bridge · gross → net <Info k="bridge" /></div>
                <Bridge b={data!.bridge} />
              </div>
            </div>

            {/* Signals / deductions */}
            <SectionH eyebrow="Signals" title="What the catalogue is telling us" help="signals" note="from SKU-level sales" />
            <div className="ecom-card deduce">
              <div className="ecom-dgrid">
                <div className="ecom-dlist">{buildSignals(data!).map((s, i) => (
                  <div key={i} className="ecom-ded"><div className="mk">{i + 1}</div><p dangerouslySetInnerHTML={{ __html: s }} /></div>
                ))}</div>
                <div>
                  <div className="ecom-famhead">Revenue share by family</div>
                  {(() => {
                    const mx = data!.family[0]?.pct || 1;
                    return data!.family.map((f, i) => (
                      <div key={f.family} className="ecom-fam-row">
                        <span className="ecom-dim">{f.family}</span>
                        <div className="ecom-fam-track"><div className={cn('ecom-fam-fill', i > 0 && 'mut')} style={{ width: `${(f.pct / mx) * 100}%` }} /></div>
                        <span className="ecom-fam-pct">{f.pct.toFixed(1)}%</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>

            {/* Products */}
            <SectionH eyebrow="Catalogue" title="Top products" help="products" note="by net revenue" />
            <div className="ecom-card">
              <table className="ecom-table">
                <thead><tr><th>Product</th><th className="r">Units</th><th style={{ width: '34%' }}>Share</th><th className="r">Net revenue</th></tr></thead>
                <tbody>
                  {(() => { const mx = data!.products[0]?.revenue || 1; return data!.products.map((p, i) => (
                    <tr key={i}>
                      <td><div className="pname"><span className="dotrank">{i + 1}</span>{p.title}</div></td>
                      <td className="r ecom-dim tnum">{int(p.units)}</td>
                      <td><div className="inbar" style={{ width: `${(p.revenue / mx) * 100}%` }} /></td>
                      <td className="r tnum" style={{ fontFamily: 'Fraunces, Georgia, serif' }}>{money(p.revenue)}</td>
                    </tr>
                  )); })()}
                </tbody>
              </table>
            </div>

            <div className="ecom-foot">
              Aggregated live from <b>meta_ads_daily</b> + <b>shopify_sales_lines</b> (auto-synced 3×/day). Every control recomputes from the database.
              <b> est. POAS</b> uses a 45% blended-margin assumption. Not available yet (needs customer IDs / sessions): LTV, new-vs-returning, cohort retention, site conversion rate.
            </div>
          </>
        )}

        {loading && !k && (
          <div className="flex items-center justify-center min-h-[220px] gap-2"><Loader2 className="h-5 w-5 animate-spin ecom-faint" /><span className="ecom-faint">Loading E-commerce…</span></div>
        )}
      </div>
    </TooltipProvider>
  );
}

function MiniKpi({ label, help, val, sub }: { label: string; help: string; val: string; sub: ReactNode }) {
  return (
    <div className="ecom-card ecom-minicard">
      <div className="ecom-klabel">{label} <Info k={help} /></div>
      <div className="ecom-val">{val}</div>
      <div className="ecom-sub">{sub}</div>
    </div>
  );
}
function SectionH({ eyebrow, title, help, note }: { eyebrow: string; title: string; help: string; note: string }) {
  return (
    <div className="ecom-section-h">
      <div className="ecom-eyebrow">{eyebrow}</div>
      <h2>{title} <Info k={help} /></h2>
      <span className="ecom-faint" style={{ fontSize: 12.5 }}>{note}</span>
    </div>
  );
}
function Bridge({ b }: { b: Record<string, number> }) {
  const W = 460, H = 250, T = 34, B = 34, L = 10, R = 10, ih = H - T - B;
  const steps: Array<[string, number, 'base' | 'neg']> = [['Gross', b.gross, 'base'], ['Discounts', -b.discounts, 'neg'], ['Returns', -b.returns, 'neg'], ['Net', b.net, 'base']];
  const max = b.gross || 1, y = (v: number) => T + ih - (v / max) * ih, n = steps.length, gap = (W - L - R) / n, bw = gap * 0.56;
  let run = 0;
  const els: ReactNode[] = [];
  steps.forEach(([name, val, kind], i) => {
    const cx = L + gap * i + gap / 2; let top: number, bot: number;
    if (kind === 'base') { top = y(val); bot = y(0); run = val; } else { const st = run; run += val; top = y(Math.max(st, run)); bot = y(Math.min(st, run)); }
    const hh = Math.max(2, bot - top), col = kind === 'neg' ? 'var(--ecom-neg)' : 'var(--ecom-crema)';
    if (i > 0) els.push(<line key={`c${i}`} x1={L + gap * (i - 1) + gap / 2 + bw / 2} y1={top} x2={cx - bw / 2} y2={top} stroke="var(--ecom-faint)" strokeDasharray="2 2" opacity={0.5} />);
    els.push(<rect key={`r${i}`} x={cx - bw / 2} y={top} width={bw} height={hh} rx={3} fill={col} opacity={kind === 'neg' ? 0.85 : 1} />);
    els.push(<text key={`t${i}`} x={cx} y={H - 14} textAnchor="middle" fontSize={11} fill="var(--ecom-dim)" fontFamily="Inter">{name}</text>);
    els.push(<text key={`v${i}`} x={cx} y={top - 9} textAnchor="middle" fontSize={11.5} fontWeight={600} fill={col} fontFamily="Fraunces, Georgia, serif">{val < 0 ? '−' : ''}{money(Math.abs(val))}</text>);
  });
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>{els}</svg>;
}

const COUNTRY: Record<string, string> = { US: 'United States', AU: 'Australia', NZ: 'New Zealand', GB: 'United Kingdom', DE: 'Germany', CA: 'Canada', SG: 'Singapore', JP: 'Japan', FR: 'France', NL: 'Netherlands' };

function buildSignals(d: Dash): string[] {
  const fam = Object.fromEntries(d.family.map((f) => [f.family, f]));
  const total = d.kpis.revenue as number;
  const screens = fam['Shower Screens'], baskets = fam['Filter Baskets'], pf = fam['Portafilters'], bundles = fam['Bundles'];
  const setupPct = ((screens?.pct ?? 0) + (baskets?.pct ?? 0) + (pf?.pct ?? 0)).toFixed(0);
  const storeUnit = d.kpis.orders ? (total / (d.kpis.units as number)) : 0;
  const out: string[] = [];
  if (screens) out.push(`<b>Shower screens are the business.</b> The PSD-HD family is <b>${screens.pct.toFixed(0)}%</b> of revenue — <span>more than every other category combined.</span> ${money(screens.revenue)} across ${int(screens.units)} units.`);
  out.push(`<b>The full setup — screens + baskets + portafilters — is ${setupPct}% of revenue.</b> <span>Distribution, prep tools and accessories are the long tail.</span>`);
  if (bundles && pf) out.push(`<b>Bundles &amp; portafilters carry the biggest ticket:</b> <b>$${Math.round(bundles.aovUnit)}</b> and <b>$${Math.round(pf.aovUnit)}</b> per unit versus <span>$${storeUnit.toFixed(0)} store-wide.</span> Combos are the upsell lever.`);
  if (baskets) out.push(`<b>Baskets are high-volume, low-ticket</b> — ${int(baskets.units)} units at $${Math.round(baskets.aovUnit)}. <span>The natural attach product alongside every screen.</span>`);
  const topGeo = d.market.usa.revenue && d.market.australia.revenue ? (Number(d.market.usa.revenue) >= Number(d.market.australia.revenue) ? 'USA' : 'Australia') : null;
  if (topGeo) out.push(`<b>${topGeo} leads the two core markets</b> at <b>${topGeo === 'USA' ? d.market.usa.share : d.market.australia.share}%</b> of USA+AU revenue, <span>with a long international tail behind them.</span>`);
  return out.slice(0, 5);
}

const ECOM_CSS = `
.ecom{--ecom-ground:#F4EEE3;--ecom-card:#FFFFFF;--ecom-card2:#FBF6EC;--ecom-line:#E8DFCC;--ecom-hair:rgba(160,120,40,.14);--ecom-text:#241B12;--ecom-dim:#786A53;--ecom-faint:#A2937C;--ecom-crema:#B9812A;--ecom-crema2:#D19B34;--ecom-crema-soft:rgba(201,138,41,.10);--ecom-pos:#2E9E6E;--ecom-neg:#C6513A;--ecom-shadow:0 1px 2px rgba(60,40,10,.06),0 10px 34px rgba(60,40,10,.07);
  font-family:'Inter',system-ui,sans-serif;color:var(--ecom-text);background:radial-gradient(1200px 500px at 12% -10%,var(--ecom-crema-soft),transparent 60%),var(--ecom-ground);padding:clamp(14px,2vw,22px);border-radius:16px}
.dark .ecom{--ecom-ground:#17120E;--ecom-card:#221B15;--ecom-card2:#2A2119;--ecom-line:#33291E;--ecom-hair:rgba(233,178,82,.10);--ecom-text:#F2EADF;--ecom-dim:#B7A991;--ecom-faint:#87795F;--ecom-crema:#E9B252;--ecom-crema2:#F0C877;--ecom-crema-soft:rgba(233,178,82,.13);--ecom-pos:#5BC08E;--ecom-neg:#E0725A;--ecom-shadow:0 1px 2px rgba(0,0,0,.4),0 8px 30px rgba(0,0,0,.28)}
.ecom h1,.ecom h2{font-family:'Fraunces',Georgia,serif}
.ecom .tnum{font-variant-numeric:tabular-nums}
.ecom-eyebrow{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--ecom-crema)}
.ecom-faint{color:var(--ecom-faint)}.ecom-dim{color:var(--ecom-dim)}
.ecom-info{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--ecom-faint);color:var(--ecom-faint);font-size:9px;font-weight:700;cursor:help;line-height:1;vertical-align:middle}
.ecom-info:hover,.ecom-info:focus{border-color:var(--ecom-crema);color:var(--ecom-crema);outline:none}
.ecom-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:20px}
.ecom-title{font-size:clamp(24px,3vw,36px);font-weight:600;letter-spacing:-.01em;line-height:1.05;margin-top:6px}
.ecom-title em{font-style:italic;color:var(--ecom-crema)}
.ecom-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--ecom-dim);background:var(--ecom-card);border:1px solid var(--ecom-line);border-radius:999px;padding:7px 14px}
.ecom-live{width:7px;height:7px;border-radius:50%;background:var(--ecom-pos)}
.ecom-ctx{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.ecom-seg{display:inline-flex;background:var(--ecom-card);border:1px solid var(--ecom-line);border-radius:999px;padding:3px}
.ecom-seg button{font-size:12px;font-weight:500;color:var(--ecom-dim);background:none;border:none;padding:6px 13px;border-radius:999px;cursor:pointer;transition:.18s;white-space:nowrap}
.ecom-seg button[aria-pressed="true"]{background:var(--ecom-crema);color:#20160a;font-weight:600}
.ecom-err{display:flex;gap:8px;align-items:center;color:var(--ecom-neg);border:1px solid var(--ecom-neg);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px}
.ecom-bento{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
.ecom-card{background:linear-gradient(158deg,var(--ecom-card),var(--ecom-card2));border:1px solid var(--ecom-line);border-radius:18px;padding:20px;position:relative;box-shadow:var(--ecom-shadow);overflow:hidden}
.ecom-card.accent::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--ecom-crema),transparent 70%)}
.ecom-klabel{font-size:12px;font-weight:500;color:var(--ecom-dim);display:flex;align-items:center;gap:6px}
.ecom-val{font-size:clamp(24px,2.6vw,32px);font-weight:600;letter-spacing:-.02em;margin-top:10px;line-height:1;font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.ecom-sub{font-size:11.5px;color:var(--ecom-faint);margin-top:7px}
.ecom-dwrap{margin-top:8px}
.ecom-delta{font-size:12px;font-weight:600;display:inline-flex;gap:3px;align-items:center}
.ecom-delta.up{color:var(--ecom-pos)}.ecom-delta.down{color:var(--ecom-neg)}
.ecom-hero{grid-column:span 6;display:flex;flex-direction:column;justify-content:space-between;min-height:224px;padding:26px}
.ecom-hero-val{font-size:clamp(52px,7vw,88px);color:var(--ecom-crema);letter-spacing:-.03em;font-family:'Fraunces',Georgia,serif;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.ecom-hero-val .x{font-size:.42em;color:var(--ecom-dim)}
.ecom-hero-cap{font-family:'Fraunces',Georgia,serif;font-size:clamp(15px,1.7vw,18px);font-style:italic;max-width:27ch;line-height:1.35}
.ecom-hero-foot{display:flex;gap:16px;align-items:center}
.ecom-strip{grid-column:span 6;display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.ecom-profit{}
.ecom-card.profit{background:radial-gradient(120% 120% at 100% 0%,rgba(233,178,82,.16),transparent 55%),linear-gradient(158deg,var(--ecom-card),var(--ecom-card2))}
.ecom-card.profit .ecom-val{color:var(--ecom-crema)}
.ecom-tag{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ecom-crema);background:var(--ecom-crema-soft);border:1px solid var(--ecom-hair);padding:3px 8px;border-radius:6px}
.ecom-mini{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-top:14px}
.ecom-minicard{padding:16px}.ecom-minicard .ecom-val{font-size:clamp(18px,1.8vw,23px)}
.ecom-section-h{display:flex;align-items:baseline;gap:12px;margin:28px 2px 14px;flex-wrap:wrap}
.ecom-section-h h2{font-size:18px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:7px}
.ecom-legend{display:flex;gap:16px;font-size:11.5px;color:var(--ecom-dim);margin-bottom:8px}
.ecom-legend span{display:inline-flex;align-items:center;gap:6px}.ecom-legend i{width:14px;height:3px;border-radius:2px}
.ecom-two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.ecom-funnel{display:flex;flex-direction:column;gap:8px;margin-top:6px}
.ecom-funnel .fstep{border-radius:9px;padding:11px 15px;color:#20160a;background:linear-gradient(90deg,var(--ecom-crema),var(--ecom-crema2));display:flex;justify-content:space-between;align-items:center;font-weight:600;min-width:120px}
.ecom-funnel .fn{font-size:12px;font-weight:600;opacity:.85}.ecom-funnel .fv{font-family:'Fraunces',Georgia,serif;font-size:16px;font-variant-numeric:tabular-nums}
.ecom-funnel .fdrop{font-size:11px;color:var(--ecom-faint);text-align:right;padding:3px 6px 0 0}
.ecom-mkt{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ecom-flag{font-size:12px;font-weight:600;color:var(--ecom-dim);margin-bottom:4px}
.ecom-mrow{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--ecom-line)}
.ecom-mrow:last-child{border-bottom:none}.ecom-mrow b{font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.ecom-bar-row{display:grid;grid-template-columns:118px 1fr 74px;gap:12px;align-items:center;font-size:12.5px;padding:5px 0}
.ecom-bar-track{height:9px;background:var(--ecom-card2);border-radius:6px;overflow:hidden}
.ecom-bar-fill{height:100%;background:linear-gradient(90deg,var(--ecom-crema),var(--ecom-crema2));border-radius:6px}
.ecom-bar-val{text-align:right;color:var(--ecom-dim);font-variant-numeric:tabular-nums}
.ecom-card.deduce{background:radial-gradient(130% 100% at 0% 0%,rgba(233,178,82,.10),transparent 55%),linear-gradient(158deg,var(--ecom-card),var(--ecom-card2))}
.ecom-dgrid{display:grid;grid-template-columns:1.15fr .85fr;gap:26px}
.ecom-dlist{display:flex;flex-direction:column;gap:15px}
.ecom-ded{display:flex;gap:13px}.ecom-ded .mk{font-family:'Fraunces',Georgia,serif;font-size:22px;color:var(--ecom-crema);line-height:1;width:26px;flex:0 0 auto}
.ecom-ded p{font-size:13.5px;line-height:1.5}.ecom-ded p b{color:var(--ecom-crema);font-family:'Fraunces',Georgia,serif;font-weight:600}.ecom-ded p span{color:var(--ecom-faint)}
.ecom-famhead{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ecom-faint);margin-bottom:12px}
.ecom-fam-row{display:grid;grid-template-columns:96px 1fr 42px;gap:10px;align-items:center;font-size:12px;padding:4px 0}
.ecom-fam-track{height:14px;background:var(--ecom-card2);border-radius:4px;overflow:hidden}
.ecom-fam-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--ecom-crema),var(--ecom-crema2))}
.ecom-fam-fill.mut{background:linear-gradient(90deg,var(--ecom-faint),var(--ecom-dim));opacity:.5}
.ecom-fam-pct{text-align:right;font-variant-numeric:tabular-nums;color:var(--ecom-dim);font-weight:600}
.ecom-table{width:100%;border-collapse:collapse;font-size:13px}
.ecom-table th{text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ecom-faint);padding:0 0 10px;border-bottom:1px solid var(--ecom-line)}
.ecom-table th.r,.ecom-table td.r{text-align:right}
.ecom-table td{padding:11px 0;border-bottom:1px solid var(--ecom-line);vertical-align:middle}
.ecom-table tr:last-child td{border-bottom:none}
.ecom-table .pname{display:flex;align-items:center;gap:10px}
.ecom-table .dotrank{width:20px;height:20px;border-radius:6px;background:var(--ecom-crema-soft);color:var(--ecom-crema);font-family:'Fraunces',Georgia,serif;font-size:11px;display:grid;place-items:center;flex:0 0 auto}
.ecom-table .inbar{height:6px;border-radius:4px;background:var(--ecom-crema);opacity:.5}
.ecom-charttip{background:var(--ecom-card);border:1px solid var(--ecom-line);border-radius:11px;box-shadow:var(--ecom-shadow);padding:10px 12px;font-size:12px}
.ecom-charttip .tt{font-family:'Fraunces',Georgia,serif;font-size:13px;color:var(--ecom-crema);margin-bottom:5px;font-weight:600}
.ecom-charttip .tr{display:flex;justify-content:space-between;gap:18px;font-variant-numeric:tabular-nums;color:var(--ecom-text)}
.ecom-charttip .tr span{color:var(--ecom-faint)}
.ecom-foot{margin-top:28px;padding-top:16px;border-top:1px solid var(--ecom-line);font-size:12px;color:var(--ecom-faint);line-height:1.7}
.ecom-foot b{color:var(--ecom-dim);font-weight:600}
@media (max-width:900px){.ecom-hero,.ecom-strip{grid-column:span 12}.ecom-mini{grid-template-columns:repeat(2,1fr)}.ecom-two,.ecom-mkt,.ecom-dgrid{grid-template-columns:1fr}}
`;
