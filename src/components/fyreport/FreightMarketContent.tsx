// =============================================================================
// Freight by Market — outbound B2C shipping by destination (AU / US / Rest of
// World). MONEY = real Xero spend; DESTINATION SPLIT + ORDER COUNTS = Starshipit
// (see the starshipit-market edge function). Reconciles to the Freight by
// Category "Outbound — B2C AU / USA" totals.
//
// The headline: the US carrier switch (DHL eCommerce → Australia Post) and what
// it did to the cost per US parcel.
// =============================================================================

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts';
import { RefreshCw, Download, HelpCircle, Package, Wallet, Globe2, ArrowRight, TrendingDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn, downloadCSV } from '@/lib/utils';

interface MarketRow {
  market: string; orders: number; shipping: number; avgPerOrder: number; pctShipping: number; zonos: number;
  revenue: number; revenueOrders: number; netShipping: number; recovery: number;
}
interface CarrierRow { carrier: string; carrier_key: string; orders: number; paid: number | null; avgPerOrder: number | null; }
interface Data {
  fy: string;
  months: { year: number; month: number; label: string }[];
  totals: { orders: number; shipping: number; zonos: number; avgPerOrder: number; revenue: number; netShipping: number; recovery: number };
  markets: MarketRow[];
  monthlyVolume: { label: string; AU: number; US: number; Other: number }[];
  usByCarrier: { label: string; dhl_ecommerce: number; auspost: number; other: number }[];
  usComparison: {
    dhl: { orders: number; paid: number; avgPerOrder: number };
    auspost: { orders: number; shipping: number; duties: number; paid: number; avgPerOrder: number; avgShippingOnly: number };
  };
  carriers: CarrierRow[];
  zonosPaid: number;
}

const M: Record<string, { label: string; color: string; tint: string; text: string }> = {
  AU: { label: 'Australia', color: '#10b981', tint: '#ecfdf5', text: '#047857' },
  US: { label: 'United States', color: '#f59e0b', tint: '#fffbeb', text: '#b45309' },
  Other: { label: 'Rest of World', color: '#64748b', tint: '#f8fafc', text: '#475569' },
};

const fmtAUD = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtAUD2 = (v: number) => `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (v: number) => v.toLocaleString('en-AU');

export function FreightMarketContent() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/starshipit-market`, {
      headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setData(d); else throw new Error(d.message); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  const exportCsv = () => {
    if (!data) return;
    downloadCSV(data.markets, 'freight-by-market.csv', [
      { header: 'Market', key: 'market' },
      { header: 'Orders', key: 'orders', formatter: (v) => String(v) },
      { header: 'Shipping paid (AUD)', key: 'shipping', formatter: (v) => (v as number).toFixed(2) },
      { header: 'Avg per order (AUD)', key: 'avgPerOrder', formatter: (v) => (v as number).toFixed(2) },
    ]);
  };

  const savings = useMemo(() => {
    if (!data) return null;
    const { dhl, auspost } = data.usComparison;
    if (!dhl.avgPerOrder || !auspost.avgPerOrder) return null;
    const diff = dhl.avgPerOrder - auspost.avgPerOrder;
    // Counterfactual: what the Australia Post-era US parcels would have cost had
    // they shipped on DHL at its duty-paid rate.
    const totalSaved = auspost.orders * diff;
    return { dhl, auspost, diff, pct: dhl.avgPerOrder > 0 ? diff / dhl.avgPerOrder : 0, totalSaved };
  }, [data]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="reports-no-print flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#0f1115]">Freight by Market</h3>
          <HelpPopover data={data} />
          <span className="text-xs text-muted-foreground">Xero spend · Starshipit destination split</span>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportCsv} disabled={!data}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f7f5]">
        <div className="mx-auto max-w-6xl space-y-6 p-6">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading shipping data…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

          {data && !loading && (
            <>
              {/* Hero KPI tiles */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <KpiTile icon={<Package className="h-4 w-4" />} label="Parcels shipped" value={fmtInt(data.totals.orders)} sub={`${data.months.length} months · ${data.fy}`} />
                <KpiTile icon={<Wallet className="h-4 w-4" />} label="Shipping paid" value={fmtAUD(data.totals.shipping)} sub="carrier cost (excl. import taxes)" />
                <KpiTile icon={<Globe2 className="h-4 w-4" />} label="Avg cost / parcel" value={fmtAUD2(data.totals.avgPerOrder)} sub="blended across markets" />
                <KpiTile icon={<TrendingDown className="h-4 w-4" />} label="ZONOS (US import taxes)" value={fmtAUD(data.zonosPaid)} sub="paid to ship to the US" accent />
              </div>

              {/* Market cards */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {data.markets.map((m) => {
                  const meta = M[m.market] ?? M.Other;
                  return (
                    <div key={m.market} className="overflow-hidden rounded-xl border border-[#e8e8e3] bg-white">
                      <div className="h-1" style={{ background: meta.color }} />
                      <div className="p-4">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-semibold" style={{ color: meta.text }}>{meta.label}</p>
                          <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: meta.tint, color: meta.text }}>
                            {(m.pctShipping * 100).toFixed(0)}% of spend
                          </span>
                        </div>
                        <p className="mt-2 text-2xl font-bold tabular-nums text-[#0f1115]">{fmtAUD(m.shipping)}</p>
                        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#f0efec] pt-3 text-xs">
                          <div>
                            <p className="text-muted-foreground">Parcels</p>
                            <p className="font-semibold tabular-nums text-[#0f1115]">{fmtInt(m.orders)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground">Cost / parcel</p>
                            <p className="font-semibold tabular-nums text-[#0f1115]">{fmtAUD2(m.avgPerOrder)}</p>
                          </div>
                        </div>
                        {m.market === 'US' && m.zonos > 0 && (
                          <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] leading-tight text-amber-800">
                            + {fmtAUD(m.zonos)} ZONOS import taxes ({fmtAUD2(m.orders > 0 ? m.zonos / m.orders : 0)}/parcel) — a US cost on top of shipping
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* The switch story — cost per US parcel: DHL era vs Australia Post */}
              {savings && (
                <div className="overflow-hidden rounded-xl border border-emerald-200 bg-white">
                  <div className="border-b border-emerald-100 bg-emerald-50/60 px-5 py-2.5">
                    <p className="text-sm font-semibold text-emerald-900">US carrier switch — cost per parcel</p>
                    <p className="text-xs text-emerald-700">
                      Moving US shipments off DHL eCommerce onto Australia Post. DHL billed duty-paid, so the
                      Australia Post side adds ZONOS import taxes for a like-for-like comparison.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 items-stretch gap-0 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
                    <SwitchLeg title="DHL eCommerce" tag="was" value={fmtAUD2(savings.dhl.avgPerOrder)} sub={`${fmtInt(savings.dhl.orders)} parcels · ${fmtAUD(savings.dhl.paid)} incl. duties`} />
                    <div className="hidden items-center justify-center px-2 sm:flex"><ArrowRight className="h-5 w-5 text-muted-foreground" /></div>
                    <SwitchLeg
                      title="Australia Post"
                      tag="now"
                      value={fmtAUD2(savings.auspost.avgPerOrder)}
                      sub={`${fmtInt(savings.auspost.orders)} parcels · ${fmtAUD(savings.auspost.shipping)} ship + ${fmtAUD(savings.auspost.duties)} ZONOS`}
                      highlight
                    />
                    <div className="hidden items-center justify-center px-2 sm:flex"><span className="h-8 w-px bg-[#e8e8e3]" /></div>
                    <div className="flex flex-col justify-center gap-0.5 p-4">
                      <p className="text-xs text-muted-foreground">Saved per parcel</p>
                      <p className="text-2xl font-bold tabular-nums text-emerald-700">
                        {fmtAUD2(savings.diff)}{' '}
                        <span className="text-base font-semibold">(≈{fmtAUD(savings.totalSaved)})</span>
                      </p>
                      <p className="text-xs font-medium text-emerald-700">−{(savings.pct * 100).toFixed(0)}% cheaper</p>
                      <p className="text-[11px] leading-tight text-muted-foreground">
                        {fmtInt(savings.auspost.orders)} parcels × {fmtAUD2(savings.diff)} — vs having stayed on DHL
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Net shipping cost — what we paid carriers vs what customers covered */}
              <Card>
                <CardContent className="pt-5">
                  <div className="mb-3 flex items-baseline justify-between">
                    <p className="text-sm font-semibold">What shipping actually cost us</p>
                    <p className="text-xs text-muted-foreground">
                      Paid to carriers (Xero) vs charged to customers (Shopify, ex-GST) · {(data.totals.recovery * 100).toFixed(0)}% recovered overall
                    </p>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3">Market</th>
                        <th className="py-2 pr-3 text-right">We paid</th>
                        <th className="py-2 pr-3 text-right">Customers paid</th>
                        <th className="py-2 pr-3 text-right">Net cost</th>
                        <th className="py-2 pl-2 text-right">Recovery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.markets.map((m) => {
                        const meta = M[m.market] ?? M.Other;
                        const profit = m.netShipping < 0;
                        return (
                          <tr key={m.market} className="border-b last:border-0">
                            <td className="py-2 pr-3">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="h-2 w-2 rounded-sm" style={{ background: meta.color }} />{meta.label}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">{fmtAUD(m.shipping)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{fmtAUD(m.revenue)}</td>
                            <td className={cn('py-2 pr-3 text-right tabular-nums font-semibold', profit ? 'text-emerald-600' : 'text-[#0f1115]')}>
                              {profit ? `+${fmtAUD(-m.netShipping)}` : fmtAUD(m.netShipping)}
                            </td>
                            <td className="py-2 pl-2 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#f0efec]">
                                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, m.recovery * 100)}%`, background: profit ? '#10b981' : meta.color }} />
                                </div>
                                <span className="w-10 tabular-nums text-xs">{(m.recovery * 100).toFixed(0)}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      <tr className="border-t-2">
                        <td className="py-2 pr-3 font-semibold">Total shipping</td>
                        <td className="py-2 pr-3 text-right font-semibold tabular-nums">{fmtAUD(data.totals.shipping)}</td>
                        <td className="py-2 pr-3 text-right font-semibold tabular-nums">{fmtAUD(data.totals.revenue)}</td>
                        <td className="py-2 pr-3 text-right font-bold tabular-nums">{fmtAUD(data.totals.netShipping)}</td>
                        <td className="py-2 pl-2 text-right font-semibold tabular-nums">{(data.totals.recovery * 100).toFixed(0)}%</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                    On top of shipping, the US absorbed <b>{fmtAUD(data.zonosPaid)}</b> of ZONOS import taxes (no customer
                    revenue) → total US cost absorbed ≈ <b>{fmtAUD((data.markets.find((m) => m.market === 'US')?.netShipping ?? 0) + data.zonosPaid)}</b>.
                    Rest of World shipping runs a surplus — customers are over-charged relative to what we pay.
                  </p>
                </CardContent>
              </Card>

              {/* Shipments by market (donut) + cost per parcel (bars) */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card>
                  <CardContent className="pt-5">
                    <p className="mb-3 text-sm font-semibold">Parcels by market</p>
                    <div className="flex items-center gap-4">
                      <ResponsiveContainer width="55%" height={180}>
                        <PieChart>
                          <Pie data={data.markets} dataKey="orders" nameKey="market" cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2}>
                            {data.markets.map((m) => <Cell key={m.market} fill={(M[m.market] ?? M.Other).color} />)}
                          </Pie>
                          <Tooltip formatter={(v: number, n: string) => [`${fmtInt(v)} parcels`, (M[n] ?? M.Other).label]} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-2">
                        {data.markets.map((m) => {
                          const meta = M[m.market] ?? M.Other;
                          return (
                            <div key={m.market} className="flex items-center justify-between text-xs">
                              <span className="flex items-center gap-1.5">
                                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: meta.color }} />
                                {meta.label}
                              </span>
                              <span className="tabular-nums font-medium">{fmtInt(m.orders)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-5">
                    <p className="mb-3 text-sm font-semibold">Cost per parcel by market</p>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={data.markets} layout="vertical" margin={{ left: 8, right: 24 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eee" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                        <YAxis type="category" dataKey="market" tick={{ fontSize: 11 }} tickFormatter={(v: string) => (M[v] ?? M.Other).label} width={90} />
                        <Tooltip formatter={(v: number) => fmtAUD2(v)} />
                        <Bar dataKey="avgPerOrder" radius={[0, 4, 4, 0]} barSize={22}>
                          {data.markets.map((m) => <Cell key={m.market} fill={(M[m.market] ?? M.Other).color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>

              {/* US carrier switch over time (real Xero $) */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-1 text-sm font-semibold">US shipping spend by carrier</p>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Monthly US freight paid (from Xero), by carrier — the handover from DHL eCommerce to Australia Post.
                  </p>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={data.usByCarrier}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => fmtAUD(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="dhl_ecommerce" name="DHL eCommerce" stackId="c" fill="#6366f1" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="auspost" name="Australia Post" stackId="c" fill="#10b981" />
                      <Bar dataKey="other" name="Other" stackId="c" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Monthly parcel volume by market */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">Parcel volume by month</p>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.monthlyVolume}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)} />
                      <Tooltip formatter={(v: number, n: string) => [fmtInt(v), (M[n] ?? M.Other).label]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => (M[v] ?? M.Other).label} />
                      <Bar dataKey="AU" stackId="v" fill={M.AU.color} />
                      <Bar dataKey="US" stackId="v" fill={M.US.color} />
                      <Bar dataKey="Other" stackId="v" fill={M.Other.color} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Carrier rollup */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">By carrier</p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3">Carrier</th>
                        <th className="py-2 pr-3 text-right">Parcels</th>
                        <th className="py-2 pr-3 text-right">Paid</th>
                        <th className="py-2 text-right">Cost / parcel</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.carriers.map((c) => (
                        <tr key={c.carrier_key} className="border-b last:border-0">
                          <td className="py-1.5 pr-3">{c.carrier}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(c.orders)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{c.paid !== null ? fmtAUD(c.paid) : '—'}</td>
                          <td className="py-1.5 text-right tabular-nums">{c.avgPerOrder !== null ? fmtAUD2(c.avgPerOrder) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Parcels from Starshipit; paid from Xero. ZONOS (US import taxes, {fmtAUD(data.zonosPaid)}) isn't a shipping
                    carrier and is excluded here.
                  </p>
                </CardContent>
              </Card>

              {/* Delivery performance — needs the Starshipit performance data */}
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Delivery performance & handling time</p>
                      <p className="mt-1 max-w-xl text-xs text-muted-foreground">
                        On-time / early / late split, average processing and transit days, and per-carrier SLA — the
                        operational metrics from Starshipit's Shipping Performance. These need per-parcel tracking dates,
                        which aren't in the cost data loaded here.
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                      Needs Starshipit performance data
                    </span>
                  </div>
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

function KpiTile({ icon, label, value, sub, accent }: { icon: ReactNode; label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl border bg-white p-4', accent ? 'border-amber-200' : 'border-[#e8e8e3]')}>
      <div className={cn('flex items-center gap-1.5 text-xs font-medium', accent ? 'text-amber-700' : 'text-muted-foreground')}>
        {icon}{label}
      </div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums text-[#0f1115]">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function SwitchLeg({ title, tag, value, sub, highlight }: { title: string; tag: string; value: string; sub: string; highlight?: boolean }) {
  return (
    <div className={cn('flex flex-col justify-center gap-0.5 p-4', highlight && 'bg-emerald-50/40')}>
      <div className="flex items-center gap-1.5">
        <p className="text-sm font-semibold text-[#0f1115]">{title}</p>
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', highlight ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>{tag}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums text-[#0f1115]">{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function HelpPopover({ data }: { data: Data | null }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-gray-200/70 hover:text-foreground" title="How this report is built">
          <HelpCircle className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[470px] p-0 text-sm leading-relaxed">
        <div className="max-h-[65vh] space-y-3 overflow-y-auto overscroll-contain p-4" onWheel={(e) => e.stopPropagation()}>
          <div>
            <h4 className="font-semibold text-foreground">Two sources, one report</h4>
            <p className="text-muted-foreground">
              <b>Money</b> comes from Xero — what we actually paid each carrier. <b>Destination split</b> and
              <b> parcel counts</b> come from Starshipit, which knows each parcel's country (Xero only knows the
              carrier). We split each carrier's real Xero spend AU/US/Rest-of-World by its Starshipit ratio.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Why not use Starshipit's own charges?</h4>
            <p className="text-muted-foreground">
              Starshipit under-captured DHL eCommerce (${'≈'}$88k recorded vs $193k actually invoiced in Xero).
              For spend, Xero is the source of truth; Starshipit is used only for the split and counts.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Reconciles to Freight by Category</h4>
            <p className="text-muted-foreground">
              Total shipping{data ? ` (${fmtAUD(data.totals.shipping)})` : ''} + ZONOS{data ? ` (${fmtAUD(data.zonosPaid)})` : ''} equals
              <b> Outbound — B2C AU + Outbound — B2C USA</b> in the Freight by Category report. The only wrinkle:
              that report is a 2-way split (AU vs US), so it folds Rest of World into B2C USA; here it's shown
              separately.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Cost per parcel</h4>
            <p className="text-muted-foreground">
              Shipping paid ÷ parcels, per market. ZONOS (US import taxes) is a real US cost but not a shipping
              charge, so it's shown separately, not inside the per-parcel shipping figure.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-foreground">Not here yet</h4>
            <p className="text-muted-foreground">
              Delivery performance (on-time/late, handling & transit time) needs Starshipit's per-parcel tracking
              dates — a separate data feed from the cost data used here.
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
