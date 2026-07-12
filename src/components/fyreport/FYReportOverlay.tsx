// =============================================================================
// FY Report — fiscal-year closing report over the frozen fy2025-26 snapshot.
//
// Full-screen overlay (same pattern as AIM2026Overlay: portal + fixed inset-0,
// no Radix Dialog side effects). Three separate role views — CEO (default),
// Operations, Marketing — selected with a segmented control. Every number
// comes from the immutable snapshot in csv-files/fy2025-26/, so this report
// renders the same forever regardless of new-FY uploads.
//
// Print: the "Print / PDF" button triggers window.print(); a scoped print
// stylesheet isolates the report content so Ctrl+P produces a clean document
// to share with Andrea.
// =============================================================================

import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn, downloadCSV } from '@/lib/utils';
import {
  FY_LABEL,
  FYMetrics,
  FYStockValuation,
  FYOpsExtras,
  computeFYMetrics,
  loadFYSnapshotData,
  loadFYStockValuation,
  loadFYOpsExtras,
} from '@/lib/fyreport';

type Role = 'ceo' | 'operations' | 'marketing';

const fmtAUD = (v: number, decimals = 0) =>
  `$${v.toLocaleString('en-AU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;

const fmtPct = (v: number | null, decimals = 1) =>
  v === null ? '—' : `${v.toFixed(decimals)}%`;

const fmtRatio = (v: number | null) => (v === null ? '—' : v.toFixed(2));

// Embeddable content for the Reports tab (the Reports shell owns the portal,
// close button and Escape/scroll handling). Loads the FY snapshot on mount —
// it is only mounted when FY Report is the active report.
export function FYReportContent() {
  const [role, setRole] = useState<Role>('ceo');
  const [metrics, setMetrics] = useState<FYMetrics | null>(null);
  const [stockValuation, setStockValuation] = useState<FYStockValuation | null>(null);
  const [opsExtras, setOpsExtras] = useState<FYOpsExtras | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (metrics || loading) return;
    setLoading(true);
    setError(null);
    Promise.all([loadFYSnapshotData(), loadFYStockValuation(), loadFYOpsExtras()])
      .then(([data, valuation, extras]) => {
        setMetrics(computeFYMetrics(data));
        setStockValuation(valuation);
        setOpsExtras(extras);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load FY snapshot'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Report sub-header: role selector (print handled centrally by ReportsOverlay) */}
      <div className="fy-no-print flex shrink-0 items-center justify-between gap-3 border-b border-[#e8e8e3] bg-white px-5 py-2.5">
        <div className="flex items-center gap-4">
          <h3 className="text-sm font-semibold text-[#0f1115]">FY Report {FY_LABEL}</h3>
          <div className="flex items-center rounded-xl bg-[#f1f1ee] p-0.5">
            {(['ceo', 'operations', 'marketing'] as Role[]).map((r) => (
              <Button
                key={r}
                variant="ghost"
                size="sm"
                className={cn(
                  'h-7 rounded-xl px-3.5 py-1.5 text-sm font-medium',
                  role === r ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setRole(r)}
              >
                {r === 'ceo' ? 'CEO' : r === 'operations' ? 'Operations' : 'Marketing'}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto" id="fy-report-print">
        <div className="mx-auto max-w-6xl p-6">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Loading FY snapshot…
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              Failed to load FY snapshot: {error}
            </div>
          )}

          {metrics && !loading && (
            <>
              {role === 'ceo' && <CEOView m={metrics} />}
              {role === 'operations' && <OperationsView m={metrics} valuation={stockValuation} extras={opsExtras} />}
              {role === 'marketing' && <MarketingView m={metrics} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Shared building blocks ----------------------------------------------------

function KpiCard({ label, value, sub, tip }: { label: string; value: string; sub?: string | null; tip?: string }) {
  return (
    <Card className="fy-print-break">
      <CardContent className="pt-5 pb-4">
        <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          {tip && (
            <span
              tabIndex={0}
              title={tip}
              aria-label={tip}
              className="fy-no-print inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] font-semibold not-italic text-muted-foreground"
            >
              i
            </span>
          )}
        </p>
        <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function SectionCard({
  title,
  description,
  onExport,
  children,
}: {
  title: string;
  description?: string;
  onExport?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="fy-print-break">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {onExport && (
          <Button variant="outline" size="sm" className="fy-no-print h-7 gap-1.5 text-xs" onClick={onExport}>
            <Download className="h-3 w-3" />
            CSV
          </Button>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const th = 'py-2 px-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground';
const thRight = 'py-2 px-3 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground';
const td = 'py-2 px-3 text-sm';
const tdNum = 'py-2 px-3 text-sm text-right tabular-nums';

function MonthlySalesChart({ m }: { m: FYMetrics }) {
  const hasPrior = m.months.some(p => p.priorSales !== null);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={m.months.map(p => ({ ...p, priorSales: p.priorSales ?? undefined }))}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
        <Tooltip formatter={(v: number) => fmtAUD(v)} />
        {hasPrior && <Legend wrapperStyle={{ fontSize: 12 }} />}
        <Bar dataKey="sales" name="FY 2025–26" fill="#2563eb" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        {hasPrior && (
          <Line dataKey="priorSales" name="FY 2024–25" stroke="#94a3b8" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// --- CEO view --------------------------------------------------------------------

function CEOView({ m }: { m: FYMetrics }) {
  const yoyTotal =
    m.priorTotalSales && m.priorTotalSales > 0
      ? ((m.totalSales - m.priorTotalSales) / m.priorTotalSales) * 100
      : null;
  const xeroTotals = m.costsSnapshot.totals;
  const fixedTotal = xeroTotals.fixed.b2c + xeroTotals.fixed.b2b;
  const variableTotal = xeroTotals.variable.b2c + xeroTotals.variable.b2b;
  const andreaTotal = xeroTotals.andrea.b2c + xeroTotals.andrea.b2b;

  const topCostItems = [...m.costsSnapshot.items]
    .sort((a, b) => b.adjustedAmount - a.adjustedAmount)
    .slice(0, 10);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Total Sales"
          value={fmtAUD(m.totalSales)}
          sub={yoyTotal !== null ? `${yoyTotal >= 0 ? '+' : ''}${yoyTotal.toFixed(1)}% vs prior FY` : m.priorCoverageNote}
        />
        <KpiCard
          label="Gross Margin"
          value={fmtAUD(m.grossMargin)}
          sub={`${fmtPct(m.grossMarginPct)} of sales · COGS ${fmtAUD(m.shopifyCOGS + m.b2bCOGS)}`}
        />
        <KpiCard
          label="Operating Result (est.)"
          value={fmtAUD(m.operatingResult)}
          sub={`after ${fmtAUD(fixedTotal + variableTotal + andreaTotal)} Xero costs`}
        />
        <KpiCard
          label="Blended ROAS"
          value={fmtRatio(m.blendedROAS)}
          sub={`Meta spend ${fmtAUD(m.metaSpend)}`}
        />
      </div>

      {m.priorCoverageNote && yoyTotal !== null && (
        <p className="text-xs text-muted-foreground">Note: {m.priorCoverageNote}. YoY figures compare against available data only.</p>
      )}

      <SectionCard
        title="Sales by Channel"
        description="Shopify gross (net + taxes + shipping) plus Unleashed channels"
        onExport={() =>
          downloadCSV(m.channels, `fy2025-26-sales-by-channel.csv`, [
            { header: 'Channel', key: 'channel' },
            { header: 'Sales (AUD)', key: 'sales', formatter: (v) => v.toFixed(2) },
            { header: 'Share %', key: 'share', formatter: (v) => v.toFixed(2) },
            { header: 'Prior FY (AUD)', key: 'priorSales', formatter: (v) => (v == null ? '' : v.toFixed(2)) },
            { header: 'YoY %', key: 'yoyPct', formatter: (v) => (v == null ? '' : v.toFixed(1)) },
          ])
        }
      >
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className={th}>Channel</th>
              <th className={thRight}>Sales (AUD)</th>
              <th className={thRight}>Share</th>
              <th className={thRight}>Prior FY</th>
              <th className={thRight}>YoY</th>
            </tr>
          </thead>
          <tbody>
            {m.channels.map((c) => (
              <tr key={c.channel} className="border-b last:border-0">
                <td className={cn(td, 'font-medium')}>{c.channel}</td>
                <td className={tdNum}>{fmtAUD(c.sales, 2)}</td>
                <td className={tdNum}>{c.share.toFixed(1)}%</td>
                <td className={tdNum}>{c.priorSales != null ? fmtAUD(c.priorSales, 2) : '—'}</td>
                <td className={cn(tdNum, c.yoyPct != null && (c.yoyPct >= 0 ? 'text-green-600' : 'text-red-600'))}>
                  {c.yoyPct != null ? `${c.yoyPct >= 0 ? '+' : ''}${c.yoyPct.toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      <SectionCard
        title="Monthly Sales"
        description="Total sales per month, prior FY overlaid where data exists"
        onExport={() =>
          downloadCSV(m.months, `fy2025-26-monthly-sales.csv`, [
            { header: 'Month', key: 'label' },
            { header: 'Sales (AUD)', key: 'sales', formatter: (v) => v.toFixed(2) },
            { header: 'Prior FY (AUD)', key: 'priorSales', formatter: (v) => (v == null ? '' : v.toFixed(2)) },
            { header: 'Meta Spend (AUD)', key: 'metaSpend', formatter: (v) => v.toFixed(2) },
          ])
        }
      >
        <MonthlySalesChart m={m} />
      </SectionCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SectionCard
          title="Operating Costs (Xero)"
          description="Frozen costs canvas allocation for the FY"
          onExport={() =>
            downloadCSV(m.costsSnapshot.items, `fy2025-26-xero-costs.csv`, [
              { header: 'Item', key: 'name' },
              { header: 'Board', key: 'board' },
              { header: 'Amount (AUD)', key: 'adjustedAmount', formatter: (v) => v.toFixed(2) },
            ])
          }
        >
          <div className="mb-3 grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Fixed</p>
              <p className="text-lg font-semibold tabular-nums">{fmtAUD(fixedTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Variable</p>
              <p className="text-lg font-semibold tabular-nums">{fmtAUD(variableTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Andrea</p>
              <p className="text-lg font-semibold tabular-nums">{fmtAUD(andreaTotal)}</p>
            </div>
          </div>
          <table className="w-full">
            <tbody>
              {topCostItems.map((item) => (
                <tr key={item.name} className="border-b last:border-0">
                  <td className={td}>{item.name}</td>
                  <td className={cn(td, 'text-xs text-muted-foreground')}>{item.board}</td>
                  <td className={tdNum}>{fmtAUD(item.adjustedAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard
          title="Brand Mix"
          description="Shopify counted under Pesado, consistent with the dashboard"
          onExport={() =>
            downloadCSV(m.brands, `fy2025-26-brand-mix.csv`, [
              { header: 'Brand', key: 'brand' },
              { header: 'Sales (AUD)', key: 'sales', formatter: (v) => v.toFixed(2) },
              { header: 'Share %', key: 'share', formatter: (v) => v.toFixed(2) },
            ])
          }
        >
          <table className="w-full">
            <tbody>
              {m.brands.slice(0, 8).map((b) => (
                <tr key={b.brand} className="border-b last:border-0">
                  <td className={cn(td, 'font-medium')}>{b.brand}</td>
                  <td className={tdNum}>{fmtAUD(b.sales)}</td>
                  <td className={tdNum}>{b.share.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      </div>

      <SectionCard
        title="Top 15 SKUs by Revenue"
        onExport={() =>
          downloadCSV(m.topSkusByRevenue, `fy2025-26-top-skus-revenue.csv`, [
            { header: 'SKU', key: 'sku' },
            { header: 'Units', key: 'units', formatter: (v) => String(v) },
            { header: 'Revenue (AUD)', key: 'revenue', formatter: (v) => v.toFixed(2) },
            { header: 'Margin %', key: 'marginPct', formatter: (v) => (v == null ? '' : v.toFixed(1)) },
          ])
        }
      >
        <SkuTable rows={m.topSkusByRevenue} />
      </SectionCard>
    </div>
  );
}

function SkuTable({ rows }: { rows: FYMetrics['topSkusByRevenue'] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b">
          <th className={th}>SKU</th>
          <th className={thRight}>Units</th>
          <th className={thRight}>Revenue (AUD)</th>
          <th className={thRight}>Margin</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sku} className="border-b last:border-0">
            <td className={cn(td, 'font-mono text-xs')}>{r.sku}</td>
            <td className={tdNum}>{r.units.toLocaleString('en-AU')}</td>
            <td className={tdNum}>{fmtAUD(r.revenue)}</td>
            <td className={tdNum}>{fmtPct(r.marginPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Operations view --------------------------------------------------------------

function OperationsView({ m, valuation, extras }: { m: FYMetrics; valuation: FYStockValuation | null; extras: FYOpsExtras | null }) {
  const n = (v: number) => Math.round(v).toLocaleString('en-AU');
  const totalUnits = m.unitsByChannel.reduce((s, u) => s + u.units, 0);
  const totalCOGS = m.shopifyCOGS + m.b2bCOGS;
  const avgInventory =
    valuation?.opening && valuation?.closing
      ? (valuation.opening.total + valuation.closing.total) / 2
      : null;
  const turnover = avgInventory && avgInventory > 0 ? totalCOGS / avgInventory : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard label="Units Sold" value={totalUnits.toLocaleString('en-AU')} sub="all channels" />
        <KpiCard label="COGS (China FOB)" value={fmtAUD(totalCOGS)} sub={`Shopify ${fmtAUD(m.shopifyCOGS)} · B2B ${fmtAUD(m.b2bCOGS)}`} />
        <KpiCard
          label="Landed COGS"
          value={fmtAUD(m.landedCOGS)}
          sub={`+ ${fmtAUD(m.inboundFreight)} inbound freight · ${fmtPct(m.landedGrossMarginPct)} landed margin`}
        />
        <KpiCard
          label="Stock Value at FY Close"
          value={valuation?.closing ? fmtAUD(valuation.closing.total) : '—'}
          sub={valuation?.opening ? `opening ${fmtAUD(valuation.opening.total)}` : 'no valuation history in range'}
        />
        <KpiCard
          label="Inventory Turnover (est.)"
          value={turnover !== null ? `${turnover.toFixed(2)}×` : '—'}
          sub="COGS / avg(opening, closing)"
        />
        <KpiCard
          label="Landed margin"
          value={fmtPct(m.landedGrossMarginPct)}
          sub={`sales ${fmtAUD(m.totalSales)} − landed COGS`}
        />
      </div>

      {extras && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Shopify orders (FY)"
            value={n(extras.shopifyOrders.current.orders)}
            sub={extras.shopifyOrders.ordersYoYPct !== null
              ? `${extras.shopifyOrders.ordersYoYPct >= 0 ? '+' : ''}${extras.shopifyOrders.ordersYoYPct.toFixed(0)}% vs ${n(extras.shopifyOrders.prior.orders)} last FY`
              : 'no prior-FY data'}
          />
          <KpiCard
            label="Avg orders / day"
            value={n(extras.shopifyOrders.currentDaily)}
            sub={`vs ${n(extras.shopifyOrders.priorDaily)}/day last FY`}
          />
          <KpiCard
            label="Orders to AU / International"
            value={`${n(extras.marketSplit.au)} / ${n(extras.marketSplit.international)}`}
            sub={`shipped parcels · US ${n(extras.marketSplit.us)} · RoW ${n(extras.marketSplit.other)}`}
          />
          {extras.b2bPayment && (
            <KpiCard
              label="B2B payment (DSO)"
              value={`${extras.b2bPayment.dso_days.toFixed(0)} days`}
              sub={`median ${extras.b2bPayment.median_days.toFixed(0)}d · ${extras.b2bPayment.ontime_pct.toFixed(0)}% on-time`}
              tip="DSO (Days Sales Outstanding), weighted by invoice value: sum(amount × days-to-pay) / sum(amount). Large invoices count more than small ones, so it reflects how long the actual cash takes to arrive — here ~50 days — even though the typical (median) invoice is paid in 15 days."
            />
          )}
        </div>
      )}

      {extras?.b2bPayment && (
        <SectionCard
          title="B2B receivables — payment behaviour"
          description="Paid wholesale invoices (Xero, retail excluded). DSO is $-weighted days-to-pay."
        >
          <table className="w-full">
            <tbody>
              <tr className="border-b"><td className={td}>Paid invoices · customers</td><td className={tdNum}>{n(extras.b2bPayment.invoices)} · {n(extras.b2bPayment.customers)}</td></tr>
              <tr className="border-b"><td className={td}>Value collected</td><td className={tdNum}>{fmtAUD(extras.b2bPayment.total)}</td></tr>
              <tr className="border-b"><td className={td}>Avg days to pay</td><td className={tdNum}>{extras.b2bPayment.avg_days.toFixed(0)} days</td></tr>
              <tr className="border-b"><td className={td}>Median days to pay</td><td className={tdNum}>{extras.b2bPayment.median_days.toFixed(0)} days</td></tr>
              <tr className="border-b"><td className={td}>DSO ($-weighted)</td><td className={tdNum}>{extras.b2bPayment.dso_days.toFixed(0)} days</td></tr>
              <tr><td className={td}>Paid on time / late</td><td className={tdNum}>{extras.b2bPayment.ontime_pct.toFixed(0)}% / {extras.b2bPayment.late_pct.toFixed(0)}%</td></tr>
            </tbody>
          </table>
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SectionCard
          title="Units by Channel"
          onExport={() =>
            downloadCSV(m.unitsByChannel, `fy2025-26-units-by-channel.csv`, [
              { header: 'Channel', key: 'channel' },
              { header: 'Units', key: 'units', formatter: (v) => String(v) },
            ])
          }
        >
          <table className="w-full">
            <tbody>
              {m.unitsByChannel.map((u) => (
                <tr key={u.channel} className="border-b last:border-0">
                  <td className={cn(td, 'font-medium')}>{u.channel}</td>
                  <td className={tdNum}>{u.units.toLocaleString('en-AU')}</td>
                  <td className={tdNum}>{totalUnits > 0 ? ((u.units / totalUnits) * 100).toFixed(1) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Stock Valuation" description="From valuation history (append-only)">
          <table className="w-full">
            <tbody>
              <tr className="border-b">
                <td className={td}>Opening (first record in FY)</td>
                <td className={tdNum}>{valuation?.opening ? fmtAUD(valuation.opening.total) : '—'}</td>
              </tr>
              <tr className="border-b">
                <td className={td}>Closing (last record in FY)</td>
                <td className={tdNum}>{valuation?.closing ? fmtAUD(valuation.closing.total) : '—'}</td>
              </tr>
              <tr>
                <td className={td}>Net change</td>
                <td className={tdNum}>
                  {valuation?.opening && valuation?.closing
                    ? fmtAUD(valuation.closing.total - valuation.opening.total)
                    : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </SectionCard>
      </div>

      <SectionCard
        title="Top 15 SKUs by Units"
        onExport={() =>
          downloadCSV(m.topSkusByUnits, `fy2025-26-top-skus-units.csv`, [
            { header: 'SKU', key: 'sku' },
            { header: 'Units', key: 'units', formatter: (v) => String(v) },
            { header: 'Revenue (AUD)', key: 'revenue', formatter: (v) => v.toFixed(2) },
            { header: 'Margin %', key: 'marginPct', formatter: (v) => (v == null ? '' : v.toFixed(1)) },
          ])
        }
      >
        <SkuTable rows={m.topSkusByUnits} />
      </SectionCard>
    </div>
  );
}

// --- Marketing view -----------------------------------------------------------------

function MarketingView({ m }: { m: FYMetrics }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Meta Spend" value={fmtAUD(m.metaSpend)} sub="full FY, AUD" />
        <KpiCard label="Blended ROAS" value={fmtRatio(m.blendedROAS)} sub="Shopify net / Meta spend" />
        <KpiCard label="Purchase ROAS" value={fmtRatio(m.purchaseROAS)} sub={`Meta conversions ${fmtAUD(m.metaConversionValue)}`} />
        <KpiCard label="Meta / Shopify Ratio" value={fmtPct(m.metaShopifyRatio)} sub="conversion value vs net sales" />
      </div>

      <SectionCard
        title="Monthly Meta Spend, B2C Sales & ROAS"
        onExport={() =>
          downloadCSV(m.months, `fy2025-26-monthly-marketing.csv`, [
            { header: 'Month', key: 'label' },
            { header: 'Meta Spend (AUD)', key: 'metaSpend', formatter: (v) => v.toFixed(2) },
            { header: 'B2C Sales (AUD)', key: 'b2cSales', formatter: (v) => v.toFixed(2) },
            { header: 'Blended ROAS', key: 'roas', formatter: (v) => (v == null ? '' : v.toFixed(2)) },
          ])
        }
      >
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={m.months.map(p => ({ ...p, roas: p.roas ?? undefined }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="spend" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`} />
            <YAxis yAxisId="roas" orientation="right" tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: number, name: string) => (name === 'Blended ROAS' ? v.toFixed(2) : fmtAUD(v))}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="spend" dataKey="metaSpend" name="Meta Spend" fill="#16a34a" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Line yAxisId="spend" dataKey="b2cSales" name="B2C Sales" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
            <Line yAxisId="roas" dataKey="roas" name="Blended ROAS" stroke="#2563eb" strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </SectionCard>

      <SectionCard
        title="Shopify Sales by Region"
        description="Net sales, current-file data"
        onExport={() =>
          downloadCSV(m.regions, `fy2025-26-shopify-by-region.csv`, [
            { header: 'Region', key: 'region' },
            { header: 'Net Sales (AUD)', key: 'sales', formatter: (v) => v.toFixed(2) },
            { header: 'Share %', key: 'share', formatter: (v) => v.toFixed(2) },
          ])
        }
      >
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className={th}>Region</th>
              <th className={thRight}>Net Sales (AUD)</th>
              <th className={thRight}>Share</th>
            </tr>
          </thead>
          <tbody>
            {m.regions.map((r) => (
              <tr key={r.region} className="border-b last:border-0">
                <td className={cn(td, 'font-medium')}>{r.region}</td>
                <td className={tdNum}>{fmtAUD(r.sales, 2)}</td>
                <td className={tdNum}>{r.share.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>
    </div>
  );
}
