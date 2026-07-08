// =============================================================================
// Freight by Category report — Xero Freight & Courier split into virtual
// accounts (Inbound Container / Inbound DHL / Outbound B2C AU / Outbound B2B /
// Outbound US / Subscription / Review / Unclassified), reconciled to the P&L.
//
// Rolling 12 months from the live Xero API tables (parse-xero-costs). Market-
// level split (AU vs US) needs the Starshipit connector — noted in-report.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { RefreshCw, Download, Info, X, Search, HelpCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn, downloadCSV } from '@/lib/utils';

interface DetailLine {
  date: string; contact: string | null; description: string | null;
  reference: string | null; amount: number; currency: string; source: string; bucket: string;
}
interface Reallocation {
  applies: boolean;
  direction: 'out' | 'in';
  rawShown: number;
  cardTotal: number;
  moved: number;
  carriers: { carrier: string; raw: number; au: number; us: number }[];
}
interface DetailData {
  total: number; count: number;
  byContact: { contact: string; total: number; count: number }[];
  lines: DetailLine[];
  reallocation?: Reallocation | null;
}

// Categories whose card total differs from the raw transactions because of the
// Starshipit market reallocation (AusPost/DHL US share moves AU → USA).
const REALLOCATED = new Set(['Outbound — B2C AU', 'Outbound — B2C USA']);

const fmtAUD2 = (v: number) => `$${v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface MonthMeta { label: string; year: number; month: number; }
interface CostItem { name: string; monthly: number[]; }

const PREFIX = 'Freight & Courier — ';

// Display order + colour per category. Starshipit (software subscription,
// mis-booked in the freight account) is deliberately NOT listed — it's kept
// out of the freight view.
const CATEGORY_ORDER = [
  'Inbound — Container',
  'Inbound — DHL International',
  'Inbound — B2B related',
  'Outbound — B2C AU',
  'Outbound — B2B',
  'Outbound — B2C USA',
  'Review',
  'Unclassified',
];
const COLORS: Record<string, string> = {
  'Inbound — Container': '#0ea5e9',
  'Inbound — DHL International': '#6366f1',
  'Inbound — B2B related': '#8b5cf6',
  'Outbound — B2C AU': '#22c55e',
  'Outbound — B2B': '#14b8a6',
  'Outbound — B2C USA': '#f59e0b',
  'Review': '#94a3b8',
  'Unclassified': '#cbd5e1',
};

const fmtAUD = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;

export function FreightReportContent() {
  const [months, setMonths] = useState<MonthMeta[]>([]);
  const [items, setItems] = useState<CostItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drill-down state: the category (+ optional month) being inspected.
  const [detailBucket, setDetailBucket] = useState<string | null>(null);
  const [detailMonthLabel, setDetailMonthLabel] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailSearch, setDetailSearch] = useState('');

  const openDetail = (bucket: string, m?: MonthMeta) => {
    // Unclassified has no transaction lines (it's the P&L remainder), so skip.
    if (bucket === 'Unclassified') return;
    setDetailBucket(bucket);
    setDetailMonthLabel(m ? m.label : null);
    setDetail(null);
    setDetailSearch('');
    setDetailLoading(true);
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero-account-detail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ account: 'Freight & Courier', bucket, ...(m ? { year: m.year, month: m.month } : {}) }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setDetail(d); else throw new Error(d.message); })
      .catch((e) => setDetail({ total: 0, count: 0, byContact: [], lines: [], ...{ error: String(e) } } as any))
      .finally(() => setDetailLoading(false));
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/parse-xero-costs`, {
      headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setMonths(d.months ?? []);
        setItems((d.items ?? []).filter((i: CostItem) => i.name.startsWith(PREFIX)));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load freight data'))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const it of items) {
      map.set(it.name.slice(PREFIX.length), it.monthly);
    }
    return CATEGORY_ORDER
      .filter((c) => map.has(c))
      .map((c) => ({ name: c, monthly: map.get(c)!, total: map.get(c)!.reduce((a, b) => a + b, 0) }));
  }, [items]);

  const grandTotal = categories.reduce((s, c) => s + c.total, 0);

  const chartData = useMemo(() =>
    months.map((m, i) => {
      const row: Record<string, any> = { label: m.label };
      for (const c of categories) row[c.name] = Math.round(c.monthly[i] ?? 0);
      return row;
    }),
    [months, categories],
  );

  const exportCsv = () => {
    const rows = categories.map((c) => {
      const row: Record<string, any> = { category: c.name, total: c.total.toFixed(2) };
      months.forEach((m, i) => { row[m.label] = (c.monthly[i] ?? 0).toFixed(2); });
      return row;
    });
    downloadCSV(rows, 'freight-by-category.csv', [
      { header: 'Category', key: 'category' },
      ...months.map((m) => ({ header: m.label, key: m.label, formatter: (v: any) => String(v ?? '') })),
      { header: 'Total (AUD)', key: 'total' },
    ]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[#0f1115]">Freight by Category</h3>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-gray-200/70 hover:text-foreground" title="How categories are built">
                <HelpCircle className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[460px] p-0 text-sm leading-relaxed">
              <div className="max-h-[65vh] space-y-3 overflow-y-auto overscroll-contain p-4" onWheel={(e) => e.stopPropagation()}>
                <div>
                  <h4 className="font-semibold text-foreground">Source of the data</h4>
                  <p className="text-muted-foreground">
                    From Xero's <b>Account Transactions</b> export (uploaded), which already gives the
                    AUD-converted amount per line. USD/EUR bills are already in AUD — no conversion here.
                    Totals reconcile to the Xero P&amp;L to the cent.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-foreground">How each line is categorised (by supplier Contact)</h4>
                  <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                    <li><b>Inbound — Container</b>: Diamond Freight (sea freight into AU).</li>
                    <li><b>Inbound — DHL International</b>: the DHL forwarding contact (air freight for stock that missed the container).</li>
                    <li><b>Inbound — B2B related</b>: freight on merchandise we receive/move for the B2B channel — BWT, Dipacci, Coffee Machine Technologies, El Rocio, REPA Italia, Xtracted Espresso.</li>
                    <li><b>Outbound — B2C AU</b>: Australia Post, DHL e-commerce (customer parcels).</li>
                    <li><b>Outbound — B2B</b>: One Freight, Star Track, Interparcel, TFM, Regional Express, Interflow.</li>
                    <li><b>Outbound — B2C USA</b>: UPS, ZONOS (US import taxes we pay to ship there), Hoon Choi (US returns/replacements).</li>
                    <li><b>Review</b>: not tied to a channel — e.g. Mavam LLC (freight of a trade-show stand to Belgium).</li>
                    <li><b>Unclassified</b>: a month's P&amp;L total not covered by uploaded lines (e.g. the current month before you re-export).</li>
                  </ul>
                  <p className="mt-1 text-xs text-muted-foreground">The Starshipit software subscription is booked in this account but excluded from the freight view (it isn't shipping).</p>
                </div>
                <div>
                  <h4 className="font-semibold text-foreground">"TAX DISBURSEMENT INVOICE" &amp; duty/GST lines</h4>
                  <p className="text-muted-foreground">
                    These are import duty/GST that the forwarder (Diamond, DHL) pays at customs and re-bills.
                    They are <b>NOT excluded</b> — they sit inside <b>Inbound — Container</b> (Diamond) and
                    <b> Inbound — DHL International</b> (DHL's "AUST GOVT CHARGES / DUTY TAX PROCESSING").
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-foreground">Market split (AU vs US) — why the card ≠ the transactions</h4>
                  <p className="text-muted-foreground">
                    Xero books freight by <b>supplier</b>, so Australia Post (which ships to AU <i>and</i> US)
                    and DHL eCommerce (100% US) all land under <b>Outbound — B2C AU</b>. Starshipit knows each
                    parcel's country, so we reallocate each carrier's Xero spend by its real monthly AU/US split:
                  </p>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground space-y-0.5">
                    <li><b>Outbound — B2C AU</b> keeps only Australia Post's <b>AU</b> share. Its US share + all of DHL eCommerce move out.</li>
                    <li><b>Outbound — B2C USA</b> = its direct-US suppliers (UPS, ZONOS, Hoon Choi) <b>plus</b> the US share reallocated in from Australia Post &amp; DHL eCommerce.</li>
                  </ul>
                  <p className="mt-1 text-muted-foreground">
                    So on those two cards the total is the <b>market-adjusted</b> figure, which won't match the
                    raw supplier transactions in the drill-down. Open either card — the detail shows the full
                    bridge (raw → reallocated). The <b>Freight by Market</b> report breaks the same money down by
                    destination.
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">Click a category card, a monthly cell, or a row to see the transactions behind it.</p>
              </div>
            </PopoverContent>
          </Popover>
          <span className="text-xs text-muted-foreground">Xero · reconciled to P&amp;L</span>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={exportCsv} disabled={!categories.length}>
          <Download className="h-3.5 w-3.5" /> CSV
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 p-6">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" /> Loading freight data…
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
          )}

          {!loading && !error && categories.length > 0 && (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {categories.map((c) => {
                  const clickable = c.name !== 'Unclassified';
                  return (
                    <Card
                      key={c.name}
                      onClick={() => clickable && openDetail(c.name)}
                      className={cn(clickable && 'cursor-pointer transition-shadow hover:shadow-md')}
                    >
                      <CardContent className="pt-4 pb-3">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[c.name] }} />
                          <p className="text-xs font-medium text-muted-foreground">{c.name}</p>
                        </div>
                        <p className="mt-1 text-xl font-bold tabular-nums">{fmtAUD(c.total)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {grandTotal > 0 ? ((c.total / grandTotal) * 100).toFixed(1) : 0}% of freight
                          {clickable && <span className="ml-1 text-blue-600">· view detail</span>}
                        </p>
                        {REALLOCATED.has(c.name) && (
                          <p className="mt-1 text-[10px] leading-tight text-amber-700">
                            ⓘ Starshipit-adjusted — differs from the raw supplier transactions (see detail)
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Note about market split */}
              <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Split by supplier from Xero. The two <b>Outbound — B2C</b> cards are then <b>market-adjusted</b> with
                  Starshipit: Australia Post's US share and all of DHL eCommerce move from AU to USA (open either card for
                  the bridge). For the full destination breakdown see the <b>Freight by Market</b> report.
                </span>
              </div>

              {/* Monthly stacked bar */}
              <Card>
                <CardContent className="pt-5">
                  <p className="mb-3 text-sm font-semibold">Monthly freight by category</p>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v: number) => fmtAUD(v)} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {categories.map((c) => (
                        <Bar key={c.name} dataKey={c.name} stackId="f" fill={COLORS[c.name]} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Table */}
              <Card>
                <CardContent className="overflow-x-auto pt-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-2 py-2">Category</th>
                        {months.map((m) => <th key={m.label} className="px-2 py-2 text-right">{m.label}</th>)}
                        <th className="px-2 py-2 text-right font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categories.map((c) => (
                        <tr
                          key={c.name}
                          className={cn('border-b last:border-0', c.name !== 'Unclassified' && 'cursor-pointer hover:bg-[#faf9f7]')}
                          onClick={() => openDetail(c.name)}
                        >
                          <td className="px-2 py-1.5">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="h-2 w-2 rounded-full" style={{ background: COLORS[c.name] }} />
                              {c.name}
                            </span>
                          </td>
                          {c.monthly.map((v, i) => (
                            <td
                              key={i}
                              className={cn(
                                'px-2 py-1.5 text-right tabular-nums text-muted-foreground',
                                v && c.name !== 'Unclassified' && 'cursor-pointer hover:bg-blue-50 hover:text-blue-700',
                              )}
                              onClick={(e) => { if (v && c.name !== 'Unclassified') { e.stopPropagation(); openDetail(c.name, months[i]); } }}
                            >
                              {v ? fmtAUD(v) : '·'}
                            </td>
                          ))}
                          <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{fmtAUD(c.total)}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2">
                        <td className="px-2 py-2 font-semibold">Total</td>
                        {months.map((_, i) => (
                          <td key={i} className="px-2 py-2 text-right font-semibold tabular-nums">
                            {fmtAUD(categories.reduce((s, c) => s + (c.monthly[i] ?? 0), 0))}
                          </td>
                        ))}
                        <td className="px-2 py-2 text-right font-bold tabular-nums">{fmtAUD(grandTotal)}</td>
                      </tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {detailBucket && (
        <DetailModal
          bucket={detailBucket}
          monthLabel={detailMonthLabel}
          data={detail}
          loading={detailLoading}
          search={detailSearch}
          onSearch={setDetailSearch}
          onClose={() => setDetailBucket(null)}
        />
      )}
    </div>
  );
}

// --- Reallocation bridge banner ------------------------------------------------
// Shown at the top of the drill-down for the two reallocated B2C buckets, so the
// user understands why the card total isn't the sum of the transactions below.

function ReallocationBanner({ bucket, r }: { bucket: string; r: Reallocation }) {
  const out = r.direction === 'out'; // B2C AU loses its US share; B2C USA gains it
  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs text-amber-900">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">Market-adjusted card total: {fmtAUD(r.cardTotal)}</span>
        <span className="text-amber-700">
          {out ? 'raw supplier transactions below' : 'direct-US suppliers below'}: {fmtAUD(r.rawShown)}
        </span>
      </div>
      <p className="mt-1 leading-relaxed text-amber-800">
        {out ? (
          <>
            Australia Post ships to AU <b>and</b> US and DHL eCommerce is 100% US, but Xero books both under
            this category by supplier. Only Australia Post's AU share stays here — <b>{fmtAUD(r.moved)}</b> is
            reallocated to <b>Outbound — B2C USA</b> using Starshipit's per-carrier market split:
          </>
        ) : (
          <>
            The transactions below are this category's direct-US suppliers (UPS, ZONOS, Hoon Choi). On top,
            <b> {fmtAUD(r.moved)}</b> is reallocated <b>in</b> from <b>Outbound — B2C AU</b> — parcels booked
            under Australia Post/DHL eCommerce by supplier but shipped to the US per Starshipit:
          </>
        )}
      </p>
      {r.carriers.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
          {r.carriers.map((c) => (
            <span key={c.carrier} className="tabular-nums">
              <b>{c.carrier}</b> {fmtAUD(c.raw)} → AU {fmtAUD(c.au)} · US {fmtAUD(c.us)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Drill-down modal ----------------------------------------------------------

function DetailModal({
  bucket, monthLabel, data, loading, search, onSearch, onClose,
}: {
  bucket: string;
  monthLabel: string | null;
  data: DetailData | null;
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  onClose: () => void;
}) {
  const lines = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return q
      ? data.lines.filter((l) => `${l.contact ?? ''} ${l.description ?? ''}`.toLowerCase().includes(q))
      : data.lines;
  }, [data, search]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-3">
          <div>
            <h3 className="text-sm font-bold">Freight — {bucket}{monthLabel ? ` · ${monthLabel}` : ''}</h3>
            {data && (
              <p className="text-xs text-muted-foreground">
                {data.count} transactions · {fmtAUD(data.total)} AUD{monthLabel ? '' : ' (full period)'}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-[#828a98] hover:bg-[#faf9f7]" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" /> Loading transactions…
          </div>
        )}

        {data && !loading && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Reallocation bridge — explains why the card total differs from the
                raw supplier transactions listed below. */}
            {data.reallocation?.applies && <ReallocationBanner bucket={bucket} r={data.reallocation} />}

            {/* Contact rollup */}
            <div className="shrink-0 border-b bg-[#faf9f7] px-5 py-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {data.byContact.map((c) => (
                  <span key={c.contact} className="text-muted-foreground">
                    <b className="text-foreground">{c.contact}</b> {fmtAUD(c.total)} <span className="opacity-60">({c.count})</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Search */}
            <div className="shrink-0 px-5 py-2">
              <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => onSearch(e.target.value)}
                  placeholder="Search contact / description"
                  className="h-7 w-full rounded-md border pl-7 pr-2 text-sm"
                />
              </div>
            </div>

            {/* Lines */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1.5 pr-3">Date</th>
                    <th className="py-1.5 pr-3">Contact</th>
                    <th className="py-1.5 pr-3">Description</th>
                    <th className="py-1.5 pr-3">Ref</th>
                    <th className="py-1.5 text-right">Amount (AUD)</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{l.date}</td>
                      <td className="py-1.5 pr-3">{l.contact ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{l.description || '·'}</td>
                      <td className="py-1.5 pr-3 text-[11px] text-muted-foreground">{l.reference || '·'}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {fmtAUD2(l.amount)}
                        {l.currency && l.currency !== 'AUD' && (
                          <span className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700">{l.currency}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr><td colSpan={5} className="py-10 text-center text-sm text-muted-foreground">No transactions match.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
