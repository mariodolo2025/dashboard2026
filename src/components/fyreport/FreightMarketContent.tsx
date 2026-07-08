// =============================================================================
// Freight by Market report — from the Starshipit Shipping Price Report.
//
// Shows outbound shipping cost split by destination market (AU / US / Other),
// paid (Freight Charge) vs quoted (Price), the DHL eCommerce → Australia Post
// switch for US, and ZONOS (US import taxes, from Xero) inside the US view.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { RefreshCw, Download, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn, downloadCSV } from '@/lib/utils';

interface MarketRow { market: string; orders: number; freight: number; price: number; }
interface Data {
  months: { year: number; month: number; label: string }[];
  markets: MarketRow[];
  monthly: Record<string, any>[];
  usByCarrier: { label: string; dhl_ecommerce: number; auspost: number; other: number }[];
  zonosPaid: number;
}

const MARKET_LABEL: Record<string, string> = { AU: 'Australia', US: 'United States', Other: 'Rest of World' };
const MARKET_COLOR: Record<string, string> = { AU: '#22c55e', US: '#f59e0b', Other: '#94a3b8' };
const fmtAUD = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;

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

  const totalPaid = useMemo(() => (data?.markets ?? []).reduce((s, m) => s + m.freight, 0), [data]);

  const exportCsv = () => {
    if (!data) return;
    downloadCSV(data.markets, 'freight-by-market.csv', [
      { header: 'Market', key: 'market' },
      { header: 'Orders', key: 'orders', formatter: (v) => String(v) },
      { header: 'Paid (AUD)', key: 'freight', formatter: (v) => v.toFixed(2) },
      { header: 'Quoted (AUD)', key: 'price', formatter: (v) => v.toFixed(2) },
    ]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#0f1115]">Freight by Market</h3>
          <span className="text-xs text-muted-foreground">Starshipit · outbound shipping cost by destination</span>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportCsv} disabled={!data}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 p-6">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading Starshipit data…
            </div>
          )}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

          {data && !loading && (
            <>
              {/* Market cards */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {data.markets.map((m) => {
                  const diff = m.freight - m.price;
                  return (
                    <Card key={m.market}>
                      <CardContent className="pt-4 pb-3">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: MARKET_COLOR[m.market] }} />
                          <p className="text-xs font-medium text-muted-foreground">{MARKET_LABEL[m.market] ?? m.market}</p>
                        </div>
                        <p className="mt-1 text-xl font-bold tabular-nums">{fmtAUD(m.freight)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          paid · {m.orders.toLocaleString('en-AU')} orders · {totalPaid > 0 ? ((m.freight / totalPaid) * 100).toFixed(0) : 0}% of freight
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          quoted {fmtAUD(m.price)} · <span className={cn(diff <= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {diff <= 0 ? 'under' : 'over'} by {fmtAUD(Math.abs(diff))}
                          </span>
                        </p>
                        {m.market === 'US' && (
                          <p className="mt-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">
                            incl. ZONOS (US import taxes) paid: {fmtAUD(data.zonosPaid)} — from Xero
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <b>Paid</b> = Freight Charge (what the carrier actually billed). <b>Quoted</b> = Price the app
                  estimated at checkout. The gap is over/under-quoting (heavier/lighter parcels than expected).
                </span>
              </div>

              {/* DHL vs Australia Post for US */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-1 text-sm font-semibold">US shipping: DHL eCommerce → Australia Post</p>
                  <p className="mb-3 text-xs text-muted-foreground">Monthly US freight paid, by carrier — the switch from DHL to Australia Post.</p>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={data.usByCarrier}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => fmtAUD(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="dhl_ecommerce" name="DHL eCommerce" stackId="c" fill="#6366f1" />
                      <Bar dataKey="auspost" name="Australia Post" stackId="c" fill="#22c55e" />
                      <Bar dataKey="other" name="Other" stackId="c" fill="#94a3b8" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Paid vs quoted by month, per market */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">Paid vs quoted by month</p>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={data.monthly}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => fmtAUD(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="AU_freight" name="AU paid" fill="#22c55e" />
                      <Bar dataKey="US_freight" name="US paid" fill="#f59e0b" />
                      <Line dataKey="AU_price" name="AU quoted" stroke="#15803d" strokeWidth={2} dot={false} />
                      <Line dataKey="US_price" name="US quoted" stroke="#b45309" strokeWidth={2} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Table */}
              <Card>
                <CardContent className="pt-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3">Market</th>
                        <th className="py-2 pr-3 text-right">Orders</th>
                        <th className="py-2 pr-3 text-right">Paid</th>
                        <th className="py-2 pr-3 text-right">Quoted</th>
                        <th className="py-2 text-right">Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.markets.map((m) => (
                        <tr key={m.market} className="border-b last:border-0">
                          <td className="py-1.5 pr-3">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="h-2 w-2 rounded-full" style={{ background: MARKET_COLOR[m.market] }} />
                              {MARKET_LABEL[m.market] ?? m.market}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{m.orders.toLocaleString('en-AU')}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{fmtAUD(m.freight)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{fmtAUD(m.price)}</td>
                          <td className={cn('py-1.5 text-right tabular-nums', m.freight - m.price <= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {fmtAUD(m.freight - m.price)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
