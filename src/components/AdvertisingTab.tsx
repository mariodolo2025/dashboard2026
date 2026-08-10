// =============================================================================
// Advertising tab — mini Triple Whale
// =============================================================================
// Spec: docs/DESIGN-ADVERTISING-TAB.md (v2.1). Reads public.advertising_dashboard
// (Plan 4). The data shape is the RPC contract — see advertising/types.ts.

import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip as RTooltip, CartesianGrid,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { STORE_DATE_PRESETS, storeToday } from '@/lib/storeDate';
import type {
  AdvertisingDashboard, ChannelView, MerPoint, GoogleBucketRow,
} from '@/components/advertising/types';

const fmtAud = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-AU')}`;
const fmtNum = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-AU');
const fmtX = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(2)}×`;

function StatCard({ label, value, sub, accent, warn }: {
  label: string; value: string; sub: string; accent?: string; warn?: boolean;
}) {
  return (
    <Card className="relative overflow-hidden p-4 border border-border/60">
      {accent && (
        <div className="absolute inset-x-0 top-0 h-[2px] opacity-70"
             style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
      )}
      <p className="text-xs font-medium tracking-wide uppercase text-muted-foreground mb-2 truncate">{label}</p>
      <p className={cn('text-2xl font-semibold tracking-tight tabular-nums leading-none',
                       warn && 'text-amber-600 dark:text-amber-400')}>{value}</p>
      {/* The definition lives ON the card (spec §2.5) — no hidden formulas. */}
      <p className="text-[11px] text-muted-foreground/70 leading-tight mt-1.5">{sub}</p>
    </Card>
  );
}

function MerChart({ series }: { series: MerPoint[] }) {
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
          <XAxis dataKey="d" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }}
                 axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis yAxisId="money" tick={{ fontSize: 11 }} axisLine={false} tickLine={false}
                 width={56} tickFormatter={(v: number) => fmtAud(v)} />
          <YAxis yAxisId="mer" orientation="right" tick={{ fontSize: 11 }} axisLine={false}
                 tickLine={false} width={40} tickFormatter={(v: number) => `${v}×`} />
          <RTooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as MerPoint;
              return (
                <div className="rounded-lg border bg-popover px-2.5 py-2 text-xs shadow-md space-y-0.5">
                  <div className="font-medium">{String(label)}</div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Revenue</span><span className="tabular-nums">{fmtAud(p.revenueAud)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">Spend</span><span className="tabular-nums">{p.spendAud === null ? 'incompleto' : fmtAud(p.spendAud)}</span></div>
                  <div className="flex justify-between gap-4"><span className="text-muted-foreground">MER</span><span className="tabular-nums font-medium" style={{ color: '#f59e0b' }}>{p.mer === null ? '— (gasto sin cargar)' : fmtX(p.mer)}</span></div>
                </div>
              );
            }}
          />
          <Bar yAxisId="money" dataKey="revenueAud" fill="#3b82f6" radius={[4, 4, 0, 0]} name="revenue" />
          <Bar yAxisId="money" dataKey="spendAud" fill="#94a3b8" radius={[4, 4, 0, 0]} name="spend" />
          {/* connectNulls=false ON PURPOSE: a day without loaded spend must show
              a hole, never a fake MER (spec Bloque 2: null, nunca 0). */}
          <Line yAxisId="mer" type="monotone" dataKey="mer" stroke="#f59e0b" strokeWidth={2}
                dot={false} connectNulls={false} name="mer" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

const PRESETS = STORE_DATE_PRESETS;                    // from '@/lib/storeDate'
const DEFAULT = PRESETS.find((p) => p.label === '30 days')!.range();

export default function AdvertisingTab() {
  const [view, setView] = useState<'direccion' | 'meta' | 'google'>('direccion');
  const [range, setRange] = useState<{ from: string; to: string }>(DEFAULT);
  const [data, setData] = useState<AdvertisingDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    supabase.rpc('advertising_dashboard', { p_from: range.from, p_to: range.to })
      .then(({ data: res, error: err }) => {
        if (cancelled) return;
        if (err) { setError(err.message); setData(null); }
        else setData(res as AdvertisingDashboard);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  // > 92 days: the 90-day preset stays quiet, 12 months (and anything past it)
  // warns — that range measured ~15s.
  const rangeDays = Math.round(
    (new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000
  );
  const longRange = rangeDays > 92;

  return (
    <div className="space-y-4">
      {/* ── View switch + date controls ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          {([['direccion', 'Dirección'], ['meta', 'Meta'], ['google', 'Google']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={cn('rounded-md px-3 py-1 text-xs font-medium transition-colors',
                view === k ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 flex-wrap">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="ghost"
                size="sm"
                onClick={() => setRange(p.range())}
                className={cn(
                  'h-8 rounded-lg px-2.5 text-xs',
                  p.range().from === range.from && p.range().to === range.to && 'bg-muted text-foreground font-medium'
                )}
              >
                {p.label}
              </Button>
            ))}
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs ml-1"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              max={storeToday()}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            />
          </div>
          <span className="text-[11px] text-muted-foreground/70 whitespace-nowrap">
            {data ? `${data.from} → ${data.to}` : ''}
          </span>
        </div>
      </div>

      {longRange && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Rangos largos tardan (12 meses ≈ 15 s).
        </p>
      )}

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
        </Card>
      )}

      {loading && !data && <p className="text-sm text-muted-foreground animate-pulse">Cargando…</p>}

      {data && (
        <div className={cn('space-y-4', loading && 'opacity-60')}>
          {view === 'direccion' && (
            <div className="space-y-4">
              <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                <StatCard label="MER" value={fmtX(data.blended.mer)} accent="#f59e0b"
                  sub="Ventas netas ÷ gasto total (Meta+Google). No depende de ninguna atribución: es el árbitro." />
                <StatCard label="Gasto total" value={fmtAud(data.blended.spendAud)} accent="#94a3b8"
                  sub="Meta (API) + Google (carga de Juan). AUD." />
                <StatCard label="Ventas netas" value={fmtAud(data.blended.revenueAud)} accent="#3b82f6"
                  sub="Mismo número que el tab E-commerce (net ex tax, AUD, día Brisbane)." />
                <StatCard label="Doble conteo" value={`${data.blended.doubleCountRatio.toFixed(2)}×`} warn accent="#ef4444"
                  sub={`Las plataformas reclaman ${fmtAud(data.blended.claimedTotalAud)} — se pisan entre sí. Reclamado ÷ reconocido.`} />
                <StatCard label="Overlap" value={fmtNum(data.blended.overlapOrders)} accent="#8b5cf6"
                  sub="Órdenes con Meta Y Google pagos en el mismo recorrido — el corazón de la discusión." />
                <StatCard label="CAC blended" value={fmtAud(data.blended.cacBlended)} accent="#10b981"
                  sub={`Gasto ÷ ${fmtNum(data.blended.newCustomerOrders)} clientes nuevos (1ª compra).`} />
              </div>

              <Card className="p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  MER diario · revenue vs spend
                </h3>
                <MerChart series={data.merSeries} />
                <p className="text-[11px] text-muted-foreground/70 mt-2">
                  Los días sin gasto de Google cargado no calculan MER (hueco en la línea) — nunca un cero falso.
                </p>
              </Card>

              <p className="text-[11px] text-muted-foreground/70">
                Regla de lectura: nuestra medición <b>subcuenta</b> (no ve view-through ni cross-device),
                las plataformas <b>sobrecuentan</b> (se pisan). La verdad queda acotada entre ambas.
                {' '}Sin clasificar: {fmtNum(data.blended.unclassifiedOrders)} órdenes (drift de UTM) ·
                sin journey: {fmtNum(data.blended.noJourneyOrders)}.
              </p>
            </div>
          )}

          {view === 'meta' && <ChannelPanel ch={data.channels[0]} />}
          {view === 'google' && (
            <div className="space-y-4">
              <ChannelPanel ch={data.channels[1]} />
              <GoogleBuckets rows={data.googleBuckets} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One paid channel: what it spent, what it claims, what the store recognises.
 *  The two ROAS side by side ARE the product — never show only one. */
function ChannelPanel({ ch }: { ch: ChannelView }) {
  const gap = ch.claimedAud - ch.storeLastAud;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
        <StatCard label="Gasto" value={fmtAud(ch.spendAud)} accent="#94a3b8"
          sub={ch.key === 'google' ? 'Carga manual de Juan hasta que llegue la API.' : 'API de Meta, por campaña.'} />
        <StatCard label={`${ch.label} reclama`} value={fmtAud(ch.claimedAud)} accent="#ef4444"
          sub="Lo que declara el panel de la plataforma (su pixel, sus ventanas, view-through incluido)." />
        <StatCard label="La tienda le reconoce" value={fmtAud(ch.storeLastAud)} accent="#3b82f6"
          sub="Last click no-directo medido en las órdenes reales — la vara común." />
        <StatCard label="Brecha" value={fmtAud(gap)} warn accent="#f59e0b"
          sub="Reclamado − reconocido. No es error: es view-through + pisadas con el otro canal." />
        <StatCard label="Inició" value={fmtAud(ch.storeFirstAud)} accent="#8b5cf6"
          sub="First click: ventas cuyo PRIMER contacto fue este canal, las cierre quien las cierre." />
      </div>

      <Card className="p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Por campaña · dos varas lado a lado
        </h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-medium pb-1.5">Campaña</th>
              <th className="text-right font-medium pb-1.5">Gasto</th>
              <th className="text-right font-medium pb-1.5">Reclama</th>
              <th className="text-right font-medium pb-1.5">ROAS panel</th>
              <th className="text-right font-medium pb-1.5">Tienda (cerró)</th>
              <th className="text-right font-medium pb-1.5">ROAS tienda</th>
              <th className="text-right font-medium pb-1.5">Inició</th>
            </tr>
          </thead>
          <tbody>
            {ch.campaigns.map((c) => (
              <tr key={c.campaign} className="border-t border-border/40">
                <td className="py-1.5">
                  <span className="font-medium">{c.campaign}</span>
                  {c.note && <span className="block text-[10px] text-amber-700 dark:text-amber-400">{c.note}</span>}
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtAud(c.claimedValueAud)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{fmtX(c.claimedValueAud / c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(c.storeLastClickAud)}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtX(c.storeLastClickAud / c.spendAud)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtAud(c.storeFirstClickAud)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Google split by bucket — only meaningful from 6-Aug-2026 (spec date-gate). */
function GoogleBuckets({ rows }: { rows: GoogleBucketRow[] }) {
  return (
    <Card className="p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        Google por bucket · desde el 6-ago
      </h3>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Antes del 6-ago Google pago y orgánico eran un solo bucket (sin UTMs): esa historia se
        muestra aparte como “google mixto”, nunca como orgánico.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium pb-1.5">Bucket</th>
            <th className="text-right font-medium pb-1.5">Órdenes</th>
            <th className="text-right font-medium pb-1.5">Net AUD</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.bucket} className="border-t border-border/40">
              <td className="py-1.5">
                {r.bucket}
                {r.note && <span className="block text-[10px] text-muted-foreground/70">{r.note}</span>}
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmtNum(r.orders)}</td>
              <td className="py-1.5 text-right tabular-nums font-medium">{fmtAud(r.revenueAud)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
