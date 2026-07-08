// =============================================================================
// Shipping Performance — Starshipit delivery metrics (from the Delivery
// Performance export, aggregated in starshipit_delivery_perf / served by the
// starshipit-performance edge function).
//
// Delivered rate, on-time / early / late split, handling & transit time, split
// by market, shipment type, carrier and month. The operational companion to the
// cost-focused Freight reports.
// =============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts';
import { RefreshCw, Download, HelpCircle, Package, CheckCircle2, Clock, Truck, Home, Globe2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn, downloadCSV } from '@/lib/utils';

interface Metric {
  shipped: number; delivered: number; est: number; early: number; ontime: number; late: number;
  estCoverage: number; deliveredPct: number;
  // null when Starshipit gave no delivery estimate for those parcels (DHL/UPS).
  earlyPct: number | null; ontimePct: number | null; latePct: number | null; onTimeOrBetterPct: number | null;
  handleHours: number; transitDays: number; totalDays: number;
}
interface MarketM extends Metric { market: string }
interface TypeM extends Metric { type: string }
interface CarrierM extends Metric { carrier: string }
interface MonthM extends Metric { month: string; label: string }
interface UsSwitch {
  dhl: { parcels: number; transitDays: number; handleHours: number };
  auspost: { parcels: number; transitDays: number; handleHours: number };
  transitDelta: number;
}
interface Data {
  fy: string;
  overview: Metric | null;
  markets: MarketM[];
  byType: TypeM[];
  carriers: CarrierM[];
  monthly: MonthM[];
  marketMonthly: { month: string; label: string; AU?: Metric; US?: Metric; Other?: Metric }[];
  usSwitch: UsSwitch | null;
}
/** Cost side of the same switch, from the Freight by Market endpoint — so the
 *  trade-off card never hardcodes a figure that could drift. */
interface CostSwitch { dhl: { avgPerOrder: number }; auspost: { avgPerOrder: number } }

const MARKET: Record<string, { label: string; color: string; text: string }> = {
  AU: { label: 'Australia', color: '#10b981', text: '#047857' },
  US: { label: 'United States', color: '#f59e0b', text: '#b45309' },
  Other: { label: 'Rest of World', color: '#64748b', text: '#475569' },
};
const STATUS = { early: '#10b981', ontime: '#3b82f6', late: '#ef4444' };

// null → "—": Starshipit has no delivery estimate for that carrier, so an
// on-time ratio would be a fabricated 0%.
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const pct1 = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const days = (v: number) => `${v.toFixed(1)}d`;
const hours = (v: number) => `${v.toFixed(1)}h`;
const fmtInt = (v: number) => Math.round(v).toLocaleString('en-AU');
const fmtAUD2 = (v: number) => `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ShippingPerformanceContent() {
  const [data, setData] = useState<Data | null>(null);
  const [cost, setCost] = useState<CostSwitch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const auth = { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` };
    const base = import.meta.env.VITE_SUPABASE_URL;
    Promise.all([
      fetch(`${base}/functions/v1/starshipit-performance`, { headers: auth }).then((r) => r.json()),
      // Cost side of the US switch (best-effort — the report works without it).
      fetch(`${base}/functions/v1/starshipit-market`, { headers: auth }).then((r) => r.json()).catch(() => null),
    ])
      .then(([perf, market]) => {
        if (!perf?.success) throw new Error(perf?.message ?? 'Failed to load');
        setData(perf);
        if (market?.success && market.usComparison) setCost(market.usComparison);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const statusPie = useMemo(() => {
    if (!data?.overview) return [];
    const o = data.overview;
    return [
      { name: 'Early', key: 'early', value: o.early, color: STATUS.early },
      { name: 'On time', key: 'ontime', value: o.ontime, color: STATUS.ontime },
      { name: 'Late', key: 'late', value: o.late, color: STATUS.late },
    ];
  }, [data]);

  const statusByMonth = useMemo(() =>
    (data?.monthly ?? []).map((m) => ({
      label: m.label,
      Early: Math.round((m.earlyPct ?? 0) * 100),
      'On time': Math.round((m.ontimePct ?? 0) * 100),
      Late: Math.round((m.latePct ?? 0) * 100),
    })), [data]);

  const speedVsCost = useMemo(() => {
    if (!data?.usSwitch) return null;
    const s = data.usSwitch;
    const costDelta = cost ? cost.dhl.avgPerOrder - cost.auspost.avgPerOrder : null;
    const costPct = cost && cost.dhl.avgPerOrder > 0 ? costDelta! / cost.dhl.avgPerOrder : null;
    return { s, cost, costDelta, costPct };
  }, [data, cost]);

  const transitByMonth = useMemo(() =>
    (data?.marketMonthly ?? []).map((m) => ({
      label: m.label,
      AU: m.AU ? +m.AU.transitDays.toFixed(1) : null,
      US: m.US ? +m.US.transitDays.toFixed(1) : null,
      Other: m.Other ? +m.Other.transitDays.toFixed(1) : null,
    })), [data]);

  const exportCsv = () => {
    if (!data) return;
    downloadCSV(data.markets, 'shipping-performance-by-market.csv', [
      { header: 'Market', key: 'market' },
      { header: 'Shipped', key: 'shipped', formatter: (v) => String(Math.round(v as number)) },
      { header: 'Delivered %', key: 'deliveredPct', formatter: (v) => (100 * (v as number)).toFixed(1) },
      { header: 'On-time+ %', key: 'onTimeOrBetterPct', formatter: (v) => (100 * (v as number)).toFixed(1) },
      { header: 'Late %', key: 'latePct', formatter: (v) => (100 * (v as number)).toFixed(1) },
      { header: 'Transit days', key: 'transitDays', formatter: (v) => (v as number).toFixed(2) },
      { header: 'Handling hours', key: 'handleHours', formatter: (v) => (v as number).toFixed(2) },
    ]);
  };

  const o = data?.overview;
  const dom = data?.byType.find((t) => t.type === 'Domestic');
  const intl = data?.byType.find((t) => t.type === 'International');

  return (
    <div className="flex h-full flex-col">
      <div className="reports-no-print flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#0f1115]">Shipping Performance</h3>
          <HelpPopover />
          <span className="text-xs text-muted-foreground">Starshipit · delivery & transit</span>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportCsv} disabled={!data}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f7f5]">
        <div className="mx-auto max-w-6xl space-y-6 p-6">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading delivery data…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

          {data && o && !loading && (
            <>
              {/* Hero KPIs */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiTile icon={<Package className="h-4 w-4" />} label="Parcels shipped" value={fmtInt(o.shipped)} sub={`${data.fy}`} />
                <KpiTile icon={<CheckCircle2 className="h-4 w-4" />} label="Delivered" value={pct1(o.deliveredPct)} sub={`${fmtInt(o.delivered)} parcels`} />
                <KpiTile icon={<Truck className="h-4 w-4" />} label="Avg transit" value={days(o.transitDays)} sub="pickup → delivered" />
                <KpiTile icon={<Clock className="h-4 w-4" />} label="Avg handling" value={hours(o.handleHours)} sub="label → pickup" />
              </div>

              {/* Delivery status donut + speed */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.1fr_1fr]">
                <Card>
                  <CardContent className="pt-5">
                    <p className="mb-1 text-sm font-semibold">Delivery status</p>
                    <p className="mb-2 text-xs text-muted-foreground">
                      vs Starshipit's estimated delivery date · {fmtInt(o.est)} of {fmtInt(o.shipped)} parcels
                      ({pct(o.estCoverage)}) have one — effectively all Australia Post
                    </p>
                    <div className="flex items-center gap-4">
                      <ResponsiveContainer width="48%" height={170}>
                        <PieChart>
                          <Pie isAnimationActive={false}data={statusPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={44} outerRadius={72} paddingAngle={2}>
                            {statusPie.map((s) => <Cell key={s.key} fill={s.color} />)}
                          </Pie>
                          <Tooltip formatter={(v: number, n: string) => [`${fmtInt(v)} (${pct(v / (o.est || 1))})`, n]} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {statusPie.map((s) => (
                          <div key={s.key} className="flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>
                            <span className="tabular-nums font-medium">{pct(s.value / (o.est || 1))}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="mt-2 rounded bg-slate-50 px-2 py-1 text-[10px] leading-tight text-slate-500">
                      "Late" is vs Starshipit's own delivery estimate, which is optimistic on international lanes — so a
                      high late share reflects aggressive estimates as much as speed. Transit days is the neutral measure.
                    </p>
                  </CardContent>
                </Card>

                <div className="grid grid-cols-1 gap-3">
                  <SpeedTile label="Avg transit time" value={days(o.transitDays)} note="carrier pickup → delivered" tone="blue" />
                  <SpeedTile label="Avg total fulfilment" value={days(o.totalDays)} note="label printed → delivered" tone="slate" />
                  <SpeedTile label="On-time or better" value={pct(o.onTimeOrBetterPct)} note="early + on-time share" tone="emerald" />
                </div>
              </div>

              {/* Domestic vs International */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {dom && <TypeCard icon={<Home className="h-4 w-4" />} title="Domestic (AU)" m={dom} accent="#10b981" />}
                {intl && <TypeCard icon={<Globe2 className="h-4 w-4" />} title="International" m={intl} accent="#f59e0b" />}
              </div>

              {/* US carrier switch — what the cheaper lane cost in speed */}
              {speedVsCost && (
                <div className="overflow-hidden rounded-xl border border-amber-200 bg-white">
                  <div className="border-b border-amber-100 bg-amber-50/60 px-5 py-2.5">
                    <p className="text-sm font-semibold text-amber-900">US carrier switch — the speed you traded for the saving</p>
                    <p className="text-xs text-amber-700">Same switch as in Freight by Market, seen from the delivery side.</p>
                  </div>
                  <div className="grid grid-cols-1 gap-0 sm:grid-cols-[1fr_1fr_1fr]">
                    <SwitchLeg
                      title="DHL eCommerce" tag="was"
                      main={days(speedVsCost.s.dhl.transitDays)}
                      sub={`${fmtInt(speedVsCost.s.dhl.parcels)} US parcels`}
                      cost={speedVsCost.cost ? `${fmtAUD2(speedVsCost.cost.dhl.avgPerOrder)} / parcel` : undefined}
                    />
                    <SwitchLeg
                      title="Australia Post" tag="now"
                      main={days(speedVsCost.s.auspost.transitDays)}
                      sub={`${fmtInt(speedVsCost.s.auspost.parcels)} US parcels`}
                      cost={speedVsCost.cost ? `${fmtAUD2(speedVsCost.cost.auspost.avgPerOrder)} / parcel` : undefined}
                      highlight
                    />
                    <div className="flex flex-col justify-center gap-1 border-l border-[#f0efec] p-4">
                      <div>
                        <p className="text-xs text-muted-foreground">Transit</p>
                        <p className="text-xl font-bold tabular-nums text-red-500">+{speedVsCost.s.transitDelta.toFixed(1)} days slower</p>
                      </div>
                      {speedVsCost.costDelta !== null && (
                        <div>
                          <p className="text-xs text-muted-foreground">Cost</p>
                          <p className="text-xl font-bold tabular-nums text-emerald-600">
                            −{fmtAUD2(speedVsCost.costDelta)} {speedVsCost.costPct !== null && <span className="text-sm">({pct(speedVsCost.costPct)})</span>}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  <p className="border-t border-[#f0efec] px-5 py-2 text-[11px] text-muted-foreground">
                    DHL eCommerce has no Starshipit delivery estimate, so its on-time split is unavailable — transit days
                    is the like-for-like comparison.
                  </p>
                </div>
              )}

              {/* By market */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">By market</p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3">Market</th>
                        <th className="py-2 pr-3 text-right">Shipped</th>
                        <th className="py-2 pr-3 text-right">Delivered</th>
                        <th className="py-2 pr-3 text-right">On-time+</th>
                        <th className="py-2 pr-3 text-right">Late</th>
                        <th className="py-2 pr-3 text-right">Transit</th>
                        <th className="py-2 text-right">Handling</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.markets.map((m) => {
                        const meta = MARKET[m.market] ?? MARKET.Other;
                        return (
                          <tr key={m.market} className="border-b last:border-0">
                            <td className="py-2 pr-3"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: meta.color }} />{meta.label}</span></td>
                            <td className="py-2 pr-3 text-right tabular-nums">{fmtInt(m.shipped)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{pct1(m.deliveredPct)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-emerald-600">{pct(m.onTimeOrBetterPct)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-red-500">{pct(m.latePct)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums font-medium">{days(m.transitDays)}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">{hours(m.handleHours)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              {/* Delivered status by month */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">Delivery status by month</p>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={statusByMonth} stackOffset="expand">
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
                      <Tooltip formatter={(v: number) => `${v}%`} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar isAnimationActive={false}dataKey="Early" stackId="s" fill={STATUS.early} />
                      <Bar isAnimationActive={false}dataKey="On time" stackId="s" fill={STATUS.ontime} />
                      <Bar isAnimationActive={false}dataKey="Late" stackId="s" fill={STATUS.late} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Transit days by month, by market */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">Transit days by month</p>
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={transitByMonth}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}d`} />
                      <Tooltip formatter={(v: number, n: string) => [days(v), (MARKET[n] ?? MARKET.Other).label]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => (MARKET[v] ?? MARKET.Other).label} />
                      <Line isAnimationActive={false}dataKey="AU" stroke={MARKET.AU.color} strokeWidth={2} dot={false} connectNulls />
                      <Line isAnimationActive={false}dataKey="US" stroke={MARKET.US.color} strokeWidth={2} dot={false} connectNulls />
                      <Line isAnimationActive={false}dataKey="Other" stroke={MARKET.Other.color} strokeWidth={2} dot={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Carrier performance */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">By carrier</p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3">Carrier</th>
                        <th className="py-2 pr-3 text-right">Shipped</th>
                        <th className="py-2 pr-3 text-right">Delivered</th>
                        <th className="py-2 pr-3 text-right">Late</th>
                        <th className="py-2 pr-3 text-right">Transit</th>
                        <th className="py-2 text-right">Handling</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.carriers.filter((c) => c.shipped >= 10).map((c) => (
                        <tr key={c.carrier} className="border-b last:border-0">
                          <td className="py-2 pr-3">{c.carrier}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{fmtInt(c.shipped)}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{pct1(c.deliveredPct)}</td>
                          <td className={cn('py-2 pr-3 text-right tabular-nums', c.latePct === null ? 'text-muted-foreground' : 'text-red-500')}>
                            {pct(c.latePct)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums font-medium">{days(c.transitDays)}</td>
                          <td className="py-2 text-right tabular-nums text-muted-foreground">{hours(c.handleHours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    <b>Late = "—"</b> means Starshipit supplied no estimated delivery date for that carrier (DHL eCommerce,
                    UPS, DHL Express) — an on-time split would be fabricated. Only Australia Post carries estimates
                    ({pct(data.carriers.find((c) => c.carrier === 'Australia Post')?.estCoverage ?? null)} of its parcels).
                    Compare those lanes on <b>transit days</b>.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- pieces --------------------------------------------------------------------

function KpiTile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[#e8e8e3] bg-white p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{icon}{label}</div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums text-[#0f1115]">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function SwitchLeg({ title, tag, main, sub, cost, highlight }: { title: string; tag: string; main: string; sub: string; cost?: string; highlight?: boolean }) {
  return (
    <div className={cn('flex flex-col justify-center gap-0.5 p-4', highlight && 'bg-amber-50/30')}>
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-semibold text-[#0f1115]">{title}</p>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', highlight ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500')}>{tag}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums text-[#0f1115]">{main}</p>
      <p className="text-[11px] text-muted-foreground">{sub}{cost && <> · {cost}</>}</p>
    </div>
  );
}

function SpeedTile({ label, value, note, tone }: { label: string; value: string; note: string; tone: 'blue' | 'slate' | 'emerald' }) {
  const c = { blue: 'text-blue-600', slate: 'text-slate-600', emerald: 'text-emerald-600' }[tone];
  return (
    <div className="flex items-center justify-between rounded-xl border border-[#e8e8e3] bg-white px-4 py-3">
      <div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{note}</p>
      </div>
      <p className={cn('text-2xl font-bold tabular-nums', c)}>{value}</p>
    </div>
  );
}

function TypeCard({ icon, title, m, accent }: { icon: ReactNode; title: string; m: Metric; accent: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#e8e8e3] bg-white">
      <div className="h-1" style={{ background: accent }} />
      <div className="p-4">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-[#0f1115]">{icon}{title}</div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Shipped" value={fmtInt(m.shipped)} />
          <Stat label="Delivered" value={pct1(m.deliveredPct)} />
          <Stat label="On-time or better" value={pct(m.onTimeOrBetterPct)} tone="emerald" />
          <Stat label="Late" value={pct(m.latePct)} tone="red" />
          <Stat label="Avg transit" value={days(m.transitDays)} />
          <Stat label="Avg handling" value={hours(m.handleHours)} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'emerald' | 'red' }) {
  const c = tone === 'emerald' ? 'text-emerald-600' : tone === 'red' ? 'text-red-500' : 'text-[#0f1115]';
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums', c)}>{value}</p>
    </div>
  );
}

function HelpPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-gray-200/70 hover:text-foreground" title="How these metrics are built">
          <HelpCircle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[460px] p-0 text-sm leading-relaxed">
        <div className="max-h-[65vh] space-y-3 overflow-y-auto overscroll-contain p-4" onWheel={(e) => e.stopPropagation()}>
          <div>
            <h4 className="font-semibold text-foreground">Source</h4>
            <p className="text-muted-foreground">
              Starshipit's <b>Delivery Performance</b> export — one row per shipped parcel with its tracking dates.
              65.8k rows; the ~13.9k blank/unshipped rows are dropped, leaving 51,918 real parcels.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Metrics</h4>
            <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
              <li><b>Delivered %</b>: parcels with a delivered date ÷ shipped.</li>
              <li><b>Early / On-time / Late</b>: delivered date vs <b>Starshipit's estimated delivery date</b>, over the parcels that have an estimate.</li>
              <li><b>Handling</b>: label printed → carrier pickup (hours).</li>
              <li><b>Transit</b>: carrier pickup → delivered (days).</li>
              <li><b>Total fulfilment</b>: label printed → delivered (days).</li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Why not order → delivered?</h4>
            <p className="text-muted-foreground">
              Many orders are pre-orders/backorders placed weeks before they ship, so order→ship time isn't a shipping
              metric — the clock starts when the label is printed.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Reading "Late"</h4>
            <p className="text-muted-foreground">
              The estimate is Starshipit's own and is optimistic on international lanes, so US "late" is very high. Use
              <b> transit days</b> for a carrier-neutral speed comparison (US ≈ 12d vs AU ≈ 4d).
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Missing estimates ("—")</h4>
            <p className="text-muted-foreground">
              Starshipit only supplies an estimated delivery date for <b>Australia Post</b>. DHL eCommerce, UPS and DHL
              Express parcels have none, so their early/on-time/late split is shown as <b>—</b> rather than a fabricated
              0% late. It also means the US on-time figures describe the Australia Post lane only.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
