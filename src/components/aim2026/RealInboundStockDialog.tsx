import { useState, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import {
  format,
  differenceInDays,
  addDays,
  startOfDay,
  parseISO,
  isValid,
} from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
} from 'recharts';
import {
  Calendar as CalendarIcon,
  Maximize2,
  Minimize2,
  TrendingDown,
  Truck,
  PackageCheck,
  RefreshCw,
  Warehouse,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SKURow } from '@/lib/aim2026/types';
import { fetchRecentOrders, type RecentOrder } from '@/lib/aim2026/api';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHART_COLORS = [
  '#3b82f6','#8b5cf6','#f59e0b','#ef4444','#10b981',
  '#ec4899','#06b6d4','#f97316','#84cc16','#6366f1',
];

/**
 * Unleashed purchase order statuses that represent physical inbound shipments.
 * "Placed" is intentionally excluded — it includes production/factory POs that
 * have not yet been assigned to a DHL or Container shipment.
 */
const INBOUND_STATUSES = new Set(['dhl', 'container']);

/** China ships 90 %; 10 % stays as local safety stock */
const CHINA_SHIP_RATIO = 0.9;
/** Minimum units for a China→Main shipment to be worthwhile */
const CHINA_MIN_SHIP_QTY = 20;

const DHL_LEAD_DAYS = 7;
/**
 * China arrives this many days BEFORE the projected stockout.
 * Order is placed 10d before stockout (CHINA_BUFFER_DAYS + DHL_LEAD_DAYS = 3 + 7).
 */
const CHINA_BUFFER_DAYS = 3;

/**
 * If China has no stock on the ideal ship day (e.g. production PO arrives later),
 * scan forward day-by-day until the first day with enough stock to ship (deferred shipment).
 */

/** True when the PO warehouse belongs to the China facility */
function isChinaWarehouse(wh?: string): boolean {
  if (!wh) return false;
  const l = wh.toLowerCase().trim();
  return l === 'china' || l === 'china-w' || l.startsWith('china');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RealInboundStockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filteredData: SKURow[];
  /** Per-SKU demand for the selected warehouse (from Dashboard state) */
  warehouseDemandMap?: Map<string, number> | null;
}

interface InboundRow {
  sku: string;
  product: string;
  orderNumber?: string;
  supplier?: string;
  orderDate: string;
  eta: string;
  etaDay: number;
  quantity: number;
  status: string;
  /** True for auto-computed China WH arrivals, not real PO data */
  isChinaWH?: boolean;
  /** True for production POs that arrive AT China (not shipped to Main) */
  isProductionArrival?: boolean;
  /** For China WH rows: the raw availableChina before the 90% ratio */
  sourceQty?: number;
  /** Day offset when shipment leaves China (etaDay - DHL_LEAD_DAYS) */
  shipDay?: number;
  /** China→Main ship occurs after the ideal window because stock was insufficient earlier */
  isDeferredShip?: boolean;
  /** Planned qty from container-load bridge mode (35d Main cover at anchor) vs 90% cap */
  isContainerBridgeShip?: boolean;
}

interface CurvePoint {
  day: number;
  label: string;
  [sku: string]: number | string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * True when a purchase order represents a physical inbound shipment.
 *
 * - DHL / Container status → always include.
 * - Placed status → include by default, BUT exclude production/factory POs
 *   that belong to the China warehouse (detected via PO warehouse field)
 *   or whose quantity matches `onProduction` (legacy heuristic).
 * - showAllPlaced → override exclusions (for Purchase Orders button).
 */
function isInboundShipment(
  o: RecentOrder,
  row: SKURow,
  showAllPlaced: boolean,
): boolean {
  if (o.orderType !== 'purchase' || !o.deliveryDate) return false;
  const s = (o.status ?? '').toLowerCase();

  if (INBOUND_STATUSES.has(s)) return true;

  if (s === 'placed') {
    if (!showAllPlaced) {
      if (isChinaWarehouse(o.warehouse)) return false;
      if (row.onProduction > 0 && o.quantity === row.onProduction) return false;
    }
    return true;
  }

  return false;
}

function safeParseDate(s: string | undefined): Date | null {
  if (!s) return null;
  try {
    const d = parseISO(s);
    return isValid(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Raw (uncapped) day-by-day stock curve — negative values allowed.
 * Used internally for stockout-day detection.
 */
function buildCurveRaw(
  sohMain: number,
  dailyDemand: number,
  arrivals: { etaDay: number; quantity: number }[],
  daysToTarget: number,
): number[] {
  const curve: number[] = [Math.max(0, sohMain)];
  let stock = Math.max(0, sohMain);
  for (let d = 1; d <= daysToTarget; d++) {
    for (const a of arrivals) {
      if (a.etaDay === d) stock += a.quantity;
    }
    stock -= dailyDemand;
    curve.push(stock);
  }
  return curve;
}

/**
 * Display curve — stock is floored at 0 (no backorder / negative values shown).
 */
function buildCurve(
  sohMain: number,
  dailyDemand: number,
  arrivals: { etaDay: number; quantity: number }[],
  daysToTarget: number,
): number[] {
  return buildCurveRaw(sohMain, dailyDemand, arrivals, daysToTarget).map((v) =>
    Math.max(0, v),
  );
}

/**
 * Returns the LAST zero-crossing day — the final time stock transitions from
 * ≥ 0 to < 0 in an uncapped (raw) curve.  Walking backwards correctly handles
 * temporary dips that recover via scheduled arrivals (e.g., an existing DHL
 * shipment that covers the near-term gap) so that we compute the true final
 * stockout after all known inbounds are exhausted.
 * Returns null when stock never drops below 0.
 */
function findFinalStockoutDay(curve: number[]): number | null {
  for (let i = curve.length - 1; i >= 1; i--) {
    if (curve[i] < 0 && curve[i - 1] >= 0) return i;
  }
  // Whole curve already negative from start — no inbound recovers it
  if (curve[0] < 0) return 0;
  return null;
}

/**
 * Days of Main demand to hold at the anchor date (target) while sea freight from China is in transit.
 * Only used when "Container load bridge" mode is enabled.
 */
const MAIN_CONTAINER_BRIDGE_DAYS = 35;

/**
 * True when Main end-of-horizon stock (raw curve) is at least minEndStock on `daysToTarget`.
 * Used for container-bridge planning (backward from anchor); does not enforce non-negative path.
 */
function mainCurveEndStockAtLeast(
  mainStart: number,
  dailyDemand: number,
  arrivals: { etaDay: number; quantity: number }[],
  daysToTarget: number,
  minEndStock: number,
): boolean {
  const curve = buildCurveRaw(mainStart, dailyDemand, arrivals, daysToTarget);
  return curve[daysToTarget] >= minEndStock;
}

/**
 * Minimum integer Q in [0, maxQ] so that, on the anchor day (daysToTarget), Main stock ≥ bridgeDays × daily demand.
 * Backward from target: only the end-of-horizon constraint (not full path non-negative).
 */
function minChinaQtyForContainerBridge(
  mainStart: number,
  dailyDemand: number,
  baseArrivals: { etaDay: number; quantity: number }[],
  chinaArrivalDay: number,
  daysToTarget: number,
  bridgeDays: number,
  maxQ: number,
): number {
  if (maxQ <= 0) return 0;
  const minEnd = dailyDemand > 0 ? dailyDemand * bridgeDays : 0;

  const withQ = (q: number) => [...baseArrivals, { etaDay: chinaArrivalDay, quantity: q }];

  if (mainCurveEndStockAtLeast(mainStart, dailyDemand, baseArrivals, daysToTarget, minEnd)) {
    return 0;
  }
  if (!mainCurveEndStockAtLeast(mainStart, dailyDemand, withQ(maxQ), daysToTarget, minEnd)) {
    return maxQ;
  }

  let lo = 1;
  let hi = maxQ;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mainCurveEndStockAtLeast(mainStart, dailyDemand, withQ(mid), daysToTarget, minEnd)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

// ─── Custom tooltip ──────────────────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  label,
  skus,
  inbounds,
  chartUsesSoh,
  containerLoadBridge,
  bridgeDays,
  targetLabel,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
  skus: { sku: string; color: string; product: string; dailyDemand?: number }[];
  inbounds: InboundRow[];
  chartUsesSoh: boolean;
  containerLoadBridge?: boolean;
  bridgeDays?: number;
  targetLabel?: string;
}) {
  if (!active || !payload?.length) return null;

  const arrivals   = payload.filter((p) => p.dataKey?.endsWith('_arr') && (p.value ?? 0) > 0);
  const chinaStks  = payload.filter((p) => p.dataKey?.endsWith('_china'));
  const stocks     = payload.filter((p) =>
    !p.dataKey?.endsWith('_arr') &&
    !p.dataKey?.endsWith('_china') &&
    !p.dataKey?.endsWith('_chinaShip') &&
    !p.dataKey?.endsWith('_chinaShipSource')
  );

  // China stock lookup: sku → value
  const chinaMap: Record<string, number> = {};
  for (const c of chinaStks) {
    const skuKey = (c.dataKey as string).replace('_china', '');
    chinaMap[skuKey] = Math.round(c.value ?? 0);
  }

  const showBridgeHint =
    containerLoadBridge && bridgeDays != null && targetLabel && label === targetLabel;

  return (
    <div className="rounded-lg border bg-popover text-popover-foreground shadow-md px-3 py-2 text-xs min-w-[180px]">
      <p className="font-semibold text-[11px] mb-1.5 text-muted-foreground">{label}</p>
      {showBridgeHint && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 mb-2 leading-snug border-l-2 border-amber-400/60 pl-2">
          Container load day (China). Plan Main ≥{' '}
          <span className="font-semibold">{bridgeDays}×</span> daily demand at this date to cover sea
          freight until arrival. China WH below is stock available to load.
        </p>
      )}
      {stocks.map((p) => {
        const meta = skus.find((s) => s.sku === p.dataKey);
        const chinaVal = chinaMap[p.dataKey];
        const bridgeUnits =
          meta?.dailyDemand != null && bridgeDays != null
            ? Math.round(meta.dailyDemand * bridgeDays)
            : null;
        return (
          <div key={p.dataKey} className="mb-0.5">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                <span className="truncate max-w-[140px]">
                  {meta?.product ?? p.dataKey}
                  {chinaVal != null && (
                    <span className="text-muted-foreground font-normal ml-0.5">
                      (Main, {chartUsesSoh ? 'SOH' : 'available'})
                    </span>
                  )}
                </span>
              </span>
            <span className={cn('font-mono font-semibold tabular-nums', (p.value ?? 0) <= 0 ? 'text-red-500' : '')}>
              {Math.round(p.value ?? 0).toLocaleString()} u{(p.value ?? 0) <= 0 ? ' ⚠' : ''}
            </span>
            </div>
            {showBridgeHint && bridgeUnits != null && (
              <div className="ml-3.5 text-[10px] text-amber-700/90 dark:text-amber-400/90 mb-0.5">
                Bridge target at this date: ≥{bridgeUnits.toLocaleString()} u ({bridgeDays}d demand)
              </div>
            )}
            {chinaVal != null && (
              <div className={cn(
                'flex items-center justify-between gap-3 ml-3.5 text-[10px]',
                chinaVal === 0 ? 'text-red-500 font-semibold' : 'text-violet-600'
              )}>
                <span className="flex items-center gap-1">
                  <Warehouse size={9} />
                  <span>
                    China WH ({chartUsesSoh ? 'SOH' : 'available'})
                    {chinaVal === 0 ? ' ⚠' : ''}
                  </span>
                </span>
                <span className="font-mono font-medium tabular-nums">{chinaVal.toLocaleString()} u</span>
              </div>
            )}
            {(() => {
              const shipQty = payload?.find((x) => x.dataKey === `${p.dataKey}_chinaShip`)?.value;
              const shipSource = payload?.find((x) => x.dataKey === `${p.dataKey}_chinaShipSource`)?.value;
              if (!shipQty || shipQty <= 0) return null;
              return (
                <div className="mt-1 ml-3.5 space-y-0.5 text-[10px] text-muted-foreground leading-snug border-t border-border/40 pt-1">
                  <div className="flex items-center gap-1 text-violet-600 font-semibold text-[10px] mb-0.5">
                    <Warehouse size={9} />
                    China ships today
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{chartUsesSoh ? 'SOH before shipment' : 'Available before shipment'}</span>
                    <span className="font-mono font-medium text-foreground">{Math.round(shipSource).toLocaleString()} u</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Sent to Main (90%)</span>
                    <span className="font-mono font-medium text-violet-600">–{Math.round(shipQty).toLocaleString()} u</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Remaining (10%)</span>
                    <span className="font-mono font-medium text-amber-500">{Math.round(shipSource - shipQty).toLocaleString()} u</span>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })}
      {arrivals.map((p) => {
        const skuKey  = (p.dataKey as string).replace('_arr', '');
        const meta    = skus.find((s) => s.sku === skuKey);
        const arrQty  = Math.round(p.value ?? 0);
        const chinaIb = inbounds.find((ib) => ib.sku === skuKey && ib.isChinaWH && !ib.isProductionArrival && ib.quantity === arrQty);
        return (
          <div key={p.dataKey} className="mt-1 pt-1 border-t border-border/40">
            <div className="flex items-center gap-1.5 text-emerald-600 font-semibold">
              <PackageCheck size={10} />
              <span>{meta?.product ?? skuKey}</span>
              <span className="ml-auto font-mono">+{arrQty.toLocaleString()} u</span>
            </div>
            {chinaIb && (
              <div className="ml-3.5 text-[10px] text-emerald-600 font-medium">
                Received from China
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Custom arrival dot ──────────────────────────────────────────────────────

function ArrivalDot(props: any) {
  const { cx, cy, payload, dataKey } = props;
  const arrKey = (dataKey as string) + '_arr';
  const arrQty = payload?.[arrKey];
  if (!arrQty || arrQty <= 0) return null;

  return (
    <g>
      <line x1={cx} y1={cy} x2={cx} y2={cy - 22} stroke={props.stroke} strokeWidth={1.5} strokeDasharray="3 2" />
      <circle cx={cx} cy={cy} r={5} fill={props.stroke} stroke="white" strokeWidth={1.5} />
      <text x={cx} y={cy - 26} textAnchor="middle" fontSize={9} fill={props.stroke} fontWeight={600}>
        +{arrQty >= 1000 ? `${(arrQty / 1000).toFixed(1)}k` : arrQty}
      </text>
    </g>
  );
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function RealInboundStockDialog({
  open,
  onOpenChange,
  filteredData,
  warehouseDemandMap,
}: RealInboundStockDialogProps) {
  const today = startOfDay(new Date());

  // ── State ──────────────────────────────────────────────────────────────────
  const [targetDate, setTargetDate]         = useState<Date>(() => addDays(today, 90));
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [maximized, setMaximized]           = useState(false);
  const [loading, setLoading]               = useState(false);
  const [inboundsMap, setInboundsMap]       = useState<Record<string, RecentOrder[]>>({});
  const [fetchedFor, setFetchedFor]         = useState<string>('');
  const [useChinaWH, setUseChinaWH]         = useState(false);
  /** When true, Main + China starting stock use SOH; when false, use available (sellable) */
  const [chartUsesSoh, setChartUsesSoh]     = useState(false);
  /** When true, override the production-PO heuristic and show ALL Placed orders */
  const [showAllPlaced, setShowAllPlaced]   = useState(false);
  /**
   * When Use China WH is on: anchor date = container load start in China; plan Main to hold
   * MAIN_CONTAINER_BRIDGE_DAYS of demand that day; ship min Q from China (capped at 90% of China stock).
   */
  const [containerLoadBridge, setContainerLoadBridge] = useState(false);

  const daysToTarget = Math.max(1, differenceInDays(startOfDay(targetDate), today));
  const chartSKUs    = useMemo(() => filteredData.slice(0, 10), [filteredData]);
  const chartSkuKey  = useMemo(() => chartSKUs.map((r) => r.sku).join(','), [chartSKUs]);

  /** SKUs whose Main (+ hidden tooltip) series are drawn on the chart */
  const [visibleSkus, setVisibleSkus] = useState<Set<string>>(new Set());

  useLayoutEffect(() => {
    setVisibleSkus(new Set(chartSKUs.map((r) => r.sku)));
  }, [chartSkuKey, chartSKUs]);

  useEffect(() => {
    if (!useChinaWH) setContainerLoadBridge(false);
  }, [useChinaWH]);

  const toggleSkuVisible = useCallback((sku: string) => {
    setVisibleSkus((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  const showAllChartSkus = useCallback(() => {
    setVisibleSkus(new Set(chartSKUs.map((r) => r.sku)));
  }, [chartSKUs]);

  // ── Fetch PO data per SKU ─────────────────────────────────────────────────
  const skuKey = chartSKUs.map((r) => r.sku).join(',');

  const doFetch = useCallback(() => {
    if (!open || !chartSKUs.length) return;
    setLoading(true);
    Promise.all(chartSKUs.map((r) => fetchRecentOrders(r.sku)))
      .then((results) => {
        const map: Record<string, RecentOrder[]> = {};
        chartSKUs.forEach((r, i) => { map[r.sku] = results[i] ?? []; });
        setInboundsMap(map);
        setFetchedFor(skuKey);
      })
      .finally(() => setLoading(false));
  }, [open, skuKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && skuKey !== fetchedFor) doFetch();
  }, [open, skuKey, fetchedFor, doFetch]);

  // ── Raw inbound rows from PO data ─────────────────────────────────────────
  const poInbounds: InboundRow[] = useMemo(() => {
    const out: InboundRow[] = [];
    for (const row of chartSKUs) {
      const orders = inboundsMap[row.sku] ?? [];
      for (const o of orders) {
        if (!isInboundShipment(o, row, showAllPlaced)) continue;
        const etaDate = safeParseDate(o.deliveryDate);
        if (!etaDate) continue;
        const etaDay = differenceInDays(startOfDay(etaDate), today);

        const s = (o.status ?? '').toLowerCase();
        const isProductionPO = s === 'placed' && (
          isChinaWarehouse(o.warehouse) ||
          (row.onProduction > 0 && o.quantity === row.onProduction)
        );

        if (isProductionPO) {
          // Production PO: arrives at China warehouse on etaDay with FULL qty.
          // China→Main shipping is handled separately in chinaArrivals.
          out.push({
            sku: row.sku,
            product: row.product,
            orderNumber: o.orderNumber,
            supplier: o.supplier,
            orderDate: o.date,
            eta: o.deliveryDate!,
            etaDay,
            quantity: o.quantity,
            status: o.status,
            isChinaWH: true,
            isProductionArrival: true,
            sourceQty: o.quantity,
          });
        } else {
          out.push({
            sku: row.sku,
            product: row.product,
            orderNumber: o.orderNumber,
            supplier: o.supplier,
            orderDate: o.date,
            eta: o.deliveryDate!,
            etaDay,
            quantity: o.quantity,
            status: o.status,
          });
        }
      }
    }
    return out.sort((a, b) => a.etaDay - b.etaDay);
  }, [inboundsMap, chartSKUs, today, showAllPlaced]);

  // ── China WH planned arrivals (when toggle is on) ─────────────────────────
  // Iterative: find stockout → ship from China → recalculate → repeat
  const chinaArrivals: InboundRow[] = useMemo(() => {
    if (!useChinaWH) return [];
    const out: InboundRow[] = [];
    const MAX_WAVES = 5;

    for (const row of chartSKUs) {
      const dailyDemand = row.projectedDemand > 0 ? row.projectedDemand / 30 : 0;
      if (dailyDemand <= 0) continue;

      const regularArrivals = poInbounds
        .filter((ib) => ib.sku === row.sku && !ib.isProductionArrival)
        .map((ib) => ({ etaDay: ib.etaDay, quantity: ib.quantity }));
      const prodPOs = poInbounds.filter((ib) => ib.sku === row.sku && ib.isProductionArrival);
      const chinaDailyDemand = warehouseDemandMap?.get(row.sku)
        ? (warehouseDemandMap.get(row.sku)! / 30)
        : 0;

      const planned: { etaDay: number; quantity: number; shipDay: number }[] = [];
      let prevStockoutDay = -1;

      for (let wave = 0; wave < MAX_WAVES; wave++) {
        const allMainArrivals = [
          ...regularArrivals,
          ...planned.map((s) => ({ etaDay: s.etaDay, quantity: s.quantity })),
        ];
        const mainStart = chartUsesSoh ? row.sohMainWH : row.availableMainWH;
        const rawCurve = buildCurveRaw(mainStart, dailyDemand, allMainArrivals, daysToTarget);
        const stockoutDay = findFinalStockoutDay(rawCurve);

        if (stockoutDay === null || stockoutDay <= prevStockoutDay) break;
        prevStockoutDay = stockoutDay;

        const idealArrivalDay = Math.max(DHL_LEAD_DAYS, stockoutDay - CHINA_BUFFER_DAYS);
        const idealShipDay    = Math.max(0, idealArrivalDay - DHL_LEAD_DAYS);

        const getChinaStockAtShipDay = (shipDay: number): number => {
          let chinaStockAtShip = chartUsesSoh ? (row.sohChina ?? 0) : (row.availableChina ?? 0);
          for (const po of prodPOs) {
            if (po.etaDay <= shipDay) chinaStockAtShip += po.quantity;
          }
          chinaStockAtShip -= chinaDailyDemand * shipDay;
          for (const prev of planned) {
            if (prev.shipDay <= shipDay) chinaStockAtShip -= prev.quantity;
          }
          return chinaStockAtShip;
        };

        const baseArrivalsForNeed = [
          ...regularArrivals,
          ...planned.map((s) => ({ etaDay: s.etaDay, quantity: s.quantity })),
        ];

        let chosenShipDay = -1;
        let chosenSource  = 0;
        let chosenQty     = 0;

        for (let d = idealShipDay; d <= daysToTarget; d++) {
          const stock = getChinaStockAtShipDay(d);
          if (stock <= 0) continue;
          const maxShip = Math.floor(stock * CHINA_SHIP_RATIO);
          if (maxShip <= 0) continue;

          const chinaArrivalDayCand = d + DHL_LEAD_DAYS;

          if (containerLoadBridge) {
            const needQ = minChinaQtyForContainerBridge(
              mainStart,
              dailyDemand,
              baseArrivalsForNeed,
              chinaArrivalDayCand,
              daysToTarget,
              MAIN_CONTAINER_BRIDGE_DAYS,
              maxShip,
            );
            if (needQ === 0) {
              break;
            }
            chosenShipDay = d;
            chosenSource  = stock;
            chosenQty     = needQ;
            break;
          }

          if (maxShip < CHINA_MIN_SHIP_QTY) continue;
          chosenShipDay = d;
          chosenSource  = stock;
          chosenQty     = maxShip;
          break;
        }

        if (chosenShipDay < 0) break;

        const chinaArrivalDay = chosenShipDay + DHL_LEAD_DAYS;
        const isDeferredShip  = chosenShipDay > idealShipDay;

        planned.push({ etaDay: chinaArrivalDay, quantity: chosenQty, shipDay: chosenShipDay });

        out.push({
          sku:         row.sku,
          product:     row.product,
          orderNumber: undefined,
          supplier:    'China WH (planned)',
          orderDate:   format(addDays(today, chosenShipDay), 'yyyy-MM-dd'),
          eta:         format(addDays(today, chinaArrivalDay), 'yyyy-MM-dd'),
          etaDay:      chinaArrivalDay,
          quantity:    chosenQty,
          status:      'China WH',
          isChinaWH:   true,
          sourceQty:   Math.round(chosenSource),
          shipDay:     chosenShipDay,
          isDeferredShip,
          isContainerBridgeShip: containerLoadBridge,
        });
      }
    }
    return out;
  }, [useChinaWH, containerLoadBridge, chartUsesSoh, warehouseDemandMap, chartSKUs, poInbounds, daysToTarget, today]);

  // ── Combined inbound list (PO + optional China) ────────────────────────────
  const allInbounds: InboundRow[] = useMemo(
    () => [...poInbounds, ...chinaArrivals].sort((a, b) => a.etaDay - b.etaDay),
    [poInbounds, chinaArrivals]
  );

  // ── Build chart data ──────────────────────────────────────────────────────
  const chartData: CurvePoint[] = useMemo(() => {
    if (!chartSKUs.length) return [];

    const curves: Record<string, number[]> = {};
    const chinaCurves: Record<string, number[]> = {};

    for (const row of chartSKUs) {
      const dailyDemand = row.projectedDemand > 0 ? row.projectedDemand / 30 : 0;
      // Main curve: only regular POs + China→Main shipments (NOT production arrivals at China)
      const arrivals = allInbounds
        .filter((ib) => ib.sku === row.sku && !ib.isProductionArrival)
        .map((ib) => ({ etaDay: ib.etaDay, quantity: ib.quantity }));
      const mainStart = chartUsesSoh ? row.sohMainWH : row.availableMainWH;
      curves[row.sku] = buildCurve(mainStart, dailyDemand, arrivals, daysToTarget);

      // China stock curve: starts at availableChina or SOH China
      //   + production PO arrivals on their etaDay
      //   − China→Main shipments on their shipDay
      //   − China daily demand
      const chinaAvail = chartUsesSoh ? (row.sohChina ?? 0) : (row.availableChina ?? 0);
      const chinaDailyDemand = warehouseDemandMap?.get(row.sku)
        ? (warehouseDemandMap.get(row.sku)! / 30)
        : 0;
      const chinaShipments = allInbounds
        .filter((ib) => ib.sku === row.sku && ib.isChinaWH && !ib.isProductionArrival)
        .map((ib) => ({
          shipDay: ib.shipDay ?? Math.max(0, ib.etaDay - DHL_LEAD_DAYS),
          quantity: ib.quantity,
        }));
      const productionArrivals = allInbounds
        .filter((ib) => ib.sku === row.sku && ib.isProductionArrival)
        .map((ib) => ({ day: ib.etaDay, quantity: ib.quantity }));

      const cCurve: number[] = [];
      let cStock = chinaAvail;
      for (const s of chinaShipments) {
        if (s.shipDay <= 0) cStock -= s.quantity;
      }
      for (const p of productionArrivals) {
        if (p.day <= 0) cStock += p.quantity;
      }
      cCurve.push(Math.max(0, Math.round(cStock)));
      for (let d = 1; d <= daysToTarget; d++) {
        for (const s of chinaShipments) {
          if (s.shipDay === d) cStock -= s.quantity;
        }
        for (const p of productionArrivals) {
          if (p.day === d) cStock += p.quantity;
        }
        cStock -= chinaDailyDemand;
        cCurve.push(Math.max(0, Math.round(cStock)));
      }
      chinaCurves[row.sku] = cCurve;
    }

    // Arrival lookup: sku → day → total quantity (only Main arrivals)
    const arrMap: Record<string, Record<number, number>> = {};
    for (const ib of allInbounds) {
      if (ib.isProductionArrival) continue;
      if (!arrMap[ib.sku]) arrMap[ib.sku] = {};
      arrMap[ib.sku][ib.etaDay] = (arrMap[ib.sku][ib.etaDay] ?? 0) + ib.quantity;
    }

    // Ship-day lookup for China→Main shipments (not production arrivals)
    const shipDayMap: Record<string, Record<number, { quantity: number; sourceQty: number }>> = {};
    for (const ib of allInbounds) {
      if (ib.isChinaWH && !ib.isProductionArrival) {
        const shipDay = ib.shipDay ?? Math.max(0, ib.etaDay - DHL_LEAD_DAYS);
        if (!shipDayMap[ib.sku]) shipDayMap[ib.sku] = {};
        if (!shipDayMap[ib.sku][shipDay]) {
          shipDayMap[ib.sku][shipDay] = { quantity: 0, sourceQty: 0 };
        }
        shipDayMap[ib.sku][shipDay].quantity += ib.quantity;
        shipDayMap[ib.sku][shipDay].sourceQty += ib.sourceQty ?? 0;
      }
    }

    // Build the set of days to render — regular steps PLUS important days
    // (arrivals and ship days) so dots and tooltips always have a chart point.
    const step = daysToTarget > 120 ? 2 : 1;
    const daySet = new Set<number>();
    daySet.add(0);
    for (let d = 0; d <= daysToTarget; d += step) daySet.add(d);
    for (const ib of allInbounds) {
      if (!ib.isProductionArrival && ib.etaDay > 0 && ib.etaDay <= daysToTarget) {
        daySet.add(ib.etaDay);
      }
      if (ib.isChinaWH && !ib.isProductionArrival && ib.shipDay != null && ib.shipDay > 0 && ib.shipDay <= daysToTarget) {
        daySet.add(ib.shipDay);
      }
    }
    const sortedDays = Array.from(daySet).sort((a, b) => a - b);

    const points: CurvePoint[] = [];
    for (const d of sortedDays) {
      const pt: CurvePoint = {
        day:   d,
        label: d === 0 ? 'Today' : format(addDays(today, d), 'dd MMM'),
      };
      for (const row of chartSKUs) {
        pt[row.sku]                = curves[row.sku][d] ?? 0;
        pt[`${row.sku}_arr`]       = arrMap[row.sku]?.[d] ?? 0;
        pt[`${row.sku}_china`]     = chinaCurves[row.sku]?.[d] ?? 0;
        const shipInfo = shipDayMap[row.sku]?.[d];
        if (shipInfo) {
          pt[`${row.sku}_chinaShip`] = shipInfo.quantity;
          pt[`${row.sku}_chinaShipSource`] = shipInfo.sourceQty ?? 0;
        }
      }
      points.push(pt);
    }
    return points;
  }, [chartSKUs, allInbounds, chinaArrivals, warehouseDemandMap, daysToTarget, today, chartUsesSoh]);

  // ── Stockout markers (red dots) ───────────────────────────────────────────
  type StockoutMarker = { sku: string; label: string; y: number; type: 'main' | 'china' };
  const stockoutMarkers: StockoutMarker[] = useMemo(() => {
    if (chartData.length < 2) return [];
    const markers: StockoutMarker[] = [];

    for (const row of chartSKUs) {
      if (!visibleSkus.has(row.sku)) continue;
      let prevMain = -1;
      let prevChina = -1;
      for (const pt of chartData) {
        const mainVal  = (pt[row.sku] as number) ?? 0;
        const chinaVal = (pt[`${row.sku}_china`] as number) ?? 0;

        // Main WH stockout: transitions from >0 to 0
        if (prevMain > 0 && mainVal === 0) {
          markers.push({ sku: row.sku, label: pt.label as string, y: 0, type: 'main' });
        }
        // China WH stockout: transitions from >0 to 0
        if (prevChina > 0 && chinaVal === 0) {
          markers.push({ sku: row.sku, label: pt.label as string, y: chinaVal, type: 'china' });
        }
        prevMain  = mainVal;
        prevChina = chinaVal;
      }
    }
    return markers;
  }, [chartData, chartSKUs, visibleSkus]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const quickDays  = [30, 60, 90, 180];
  const skuMeta    = chartSKUs.map((r, i) => ({
    sku:         r.sku,
    product:     r.product,
    color:       CHART_COLORS[i % CHART_COLORS.length],
    dailyDemand: r.projectedDemand > 0 ? r.projectedDemand / 30 : 0,
    chinaDailyDemand: warehouseDemandMap?.get(r.sku)
      ? (warehouseDemandMap.get(r.sku)! / 30)
      : 0,
  }));
  const skuMetaVisible = useMemo(
    () => skuMeta.filter((m) => visibleSkus.has(m.sku)),
    [skuMeta, visibleSkus]
  );
  const chartHasVisibleSeries = visibleSkus.size > 0;
  const targetLabel   = format(targetDate, 'dd MMM');
  const chartHeightPx = maximized ? 580 : 320;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex flex-col overflow-hidden transition-all duration-200',
          maximized
            ? 'max-w-[99vw] w-[99vw] h-[98vh] max-h-[98vh]'
            : 'max-w-[96vw] w-[1100px] max-h-[90vh]'
        )}
      >
        {/* ── Header ───────────────────────────────────────────────────────── */}
        <DialogHeader className="shrink-0">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <Truck size={16} className="text-primary" />
                Real Inbound Stock Curve
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
                SOH Main + actual PO inbound ETAs &mdash;{' '}
                <span className="font-medium text-foreground">
                  {filteredData.length} SKU{filteredData.length !== 1 ? 's' : ''}
                </span>{' '}filtered
              </DialogDescription>
            </div>

            {/* Controls row — note: Popover needs modal={true} to work inside Dialog */}
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              {/* Target date picker */}
              <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen} modal>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                    <CalendarIcon size={13} />
                    {format(targetDate, 'dd MMM yyyy')} ({daysToTarget}d)
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="single"
                    selected={targetDate}
                    onSelect={(d) => {
                      if (d) { setTargetDate(d); setDatePickerOpen(false); }
                    }}
                    disabled={(d) => d <= today}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>

              {/* Quick-select */}
              <div className="flex items-center gap-1">
                {quickDays.map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={daysToTarget === d ? 'default' : 'outline'}
                    className="h-8 px-2.5 text-xs"
                    onClick={() => setTargetDate(addDays(today, d))}
                  >
                    {d}d
                  </Button>
                ))}
              </div>

              {/* China WH toggle */}
              <Button
                size="sm"
                variant={useChinaWH ? 'default' : 'outline'}
                className={cn('h-8 gap-1.5 text-xs', useChinaWH && 'bg-violet-600 hover:bg-violet-700')}
                onClick={() => setUseChinaWH((v) => !v)}
                title="Add China WH stock to the curve (7d before stockout, 90% shipped)"
              >
                <Warehouse size={13} />
                Use China WH
              </Button>

              <div
                className={cn(
                  'flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1',
                  !useChinaWH && 'opacity-45 pointer-events-none'
                )}
              >
                <Checkbox
                  id="real-inbound-container-bridge"
                  checked={containerLoadBridge}
                  disabled={!useChinaWH}
                  onCheckedChange={(v) => setContainerLoadBridge(v === true)}
                />
                <Label
                  htmlFor="real-inbound-container-bridge"
                  className="text-xs font-normal cursor-pointer leading-none max-w-[220px]"
                  title="Target date = container load start in China. Plan Main to hold 35 days of demand that day (sea-freight bridge). Planned China shipment is the minimum quantity (backward from that anchor) to reach that Main level, capped by 90% of China stock at ship day."
                >
                  Container load bridge
                </Label>
              </div>

              {/* Show-all override — includes production POs */}
              <Button
                size="sm"
                variant={showAllPlaced ? 'default' : 'outline'}
                className={cn('h-8 gap-1.5 text-xs', showAllPlaced && 'bg-amber-600 hover:bg-amber-700')}
                onClick={() => setShowAllPlaced((v) => !v)}
                title="Show purchase orders arriving at China warehouse"
              >
                Purchase Orders
              </Button>

              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1">
                <Checkbox
                  id="real-inbound-use-soh"
                  checked={chartUsesSoh}
                  onCheckedChange={(v) => setChartUsesSoh(v === true)}
                />
                <Label
                  htmlFor="real-inbound-use-soh"
                  className="text-xs font-normal cursor-pointer leading-none"
                  title="On: warehouse on hand (SOH) for Main and China starting balances. Off: available (sellable) stock—day-one differences vs SOH often reflect production covering allocated orders in Unleashed."
                >
                  Use SOH
                </Label>
              </div>

              {/* Refresh */}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={doFetch}
                disabled={loading}
                title="Refresh inbound data"
              >
                <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
              </Button>

              {/* Maximize */}
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8"
                onClick={() => setMaximized((m) => !m)}
                title={maximized ? 'Restore' : 'Maximize'}
              >
                {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* ── Body ─────────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1">

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
              <RefreshCw size={14} className="animate-spin" />
              Loading inbound data…
            </div>
          )}

          {!loading && (
            <>
              {/* ── Stock Curve ─────────────────────────────────────────────── */}
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                      <TrendingDown size={14} className="text-primary" />
                      Stock Projection
                      {chartUsesSoh && (
                        <span className="ml-1 text-[10px] font-normal text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5 rounded-full border border-amber-200 dark:border-amber-800">
                          SOH
                        </span>
                      )}
                      {useChinaWH && (
                        <span className="ml-1 text-[10px] font-normal text-violet-600 bg-violet-50 dark:bg-violet-950/30 px-1.5 py-0.5 rounded-full border border-violet-200 dark:border-violet-800">
                          + China WH (90%)
                        </span>
                      )}
                      {useChinaWH && containerLoadBridge && (
                        <span className="ml-1 text-[10px] font-normal text-primary bg-primary/10 px-1.5 py-0.5 rounded-full border border-primary/25">
                          {MAIN_CONTAINER_BRIDGE_DAYS}d bridge
                        </span>
                      )}
                    </h3>
                    {chartSKUs.length > 1 && visibleSkus.size < chartSKUs.length && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs shrink-0"
                        onClick={showAllChartSkus}
                      >
                        Show all
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {skuMeta.map((m) => (
                      <div
                        key={m.sku}
                        className={cn(
                          'flex items-center gap-2',
                          !visibleSkus.has(m.sku) && 'opacity-45'
                        )}
                      >
                        <Checkbox
                          id={`real-inbound-legend-${m.sku}`}
                          checked={visibleSkus.has(m.sku)}
                          onCheckedChange={() => toggleSkuVisible(m.sku)}
                          className="shrink-0"
                        />
                        <Label
                          htmlFor={`real-inbound-legend-${m.sku}`}
                          className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer font-normal"
                        >
                          <span className="w-3 h-0.5 inline-block rounded shrink-0" style={{ backgroundColor: m.color }} />
                          {m.product}
                        </Label>
                        {/* Daily demand chip (Main) */}
                        {m.dailyDemand > 0 && (
                          <span
                            className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border"
                            style={{
                              backgroundColor: m.color + '18',
                              borderColor:     m.color + '55',
                              color:           m.color,
                            }}
                            title="Daily demand (monthly avg ÷ 30)"
                          >
                            <TrendingDown size={9} />
                            {m.dailyDemand < 1
                              ? m.dailyDemand.toFixed(2)
                              : m.dailyDemand < 10
                              ? m.dailyDemand.toFixed(1)
                              : Math.round(m.dailyDemand).toLocaleString()}{' '}
                            u/day
                          </span>
                        )}
                        {/* China daily demand chip */}
                        {m.chinaDailyDemand > 0 && (
                          <span
                            className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-violet-50/50 dark:bg-violet-950/30 border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400"
                            title="China WH daily demand (monthly avg ÷ 30)"
                          >
                            <Warehouse size={8} />
                            {m.chinaDailyDemand < 1
                              ? m.chinaDailyDemand.toFixed(2)
                              : m.chinaDailyDemand < 10
                              ? m.chinaDailyDemand.toFixed(1)
                              : Math.round(m.chinaDailyDemand).toLocaleString()}{' '}
                            u/day China
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {chartUsesSoh ? (
                  <p className="text-[11px] text-muted-foreground mb-2 leading-snug border-l-2 border-amber-400/60 pl-2">
                    Starting balances for <span className="font-medium text-foreground">Main</span>
                    {useChinaWH && (
                      <>
                        {' '}
                        and <span className="font-medium text-foreground">China WH</span>
                      </>
                    )}{' '}
                    use <span className="font-medium text-foreground">SOH</span> (warehouse on hand). Uncheck{' '}
                    <span className="font-medium text-foreground">Use SOH</span> to chart{' '}
                    <span className="font-medium text-foreground">available</span> (sellable) units.
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground mb-2 leading-snug border-l-2 border-slate-400/50 dark:border-slate-500/40 pl-2">
                      With <span className="font-medium text-foreground">Use SOH</span> off, curves use{' '}
                      <span className="font-medium text-foreground">available</span> (sellable) starting stock. Variation
                      at &quot;Today&quot; versus full SOH is often because{' '}
                      <span className="font-medium text-foreground">production</span> is applied to cover{' '}
                      <span className="font-medium text-foreground">allocated</span> orders in Unleashed.
                    </p>
                    {useChinaWH && (
                      <p className="text-[11px] text-muted-foreground mb-2 leading-snug border-l-2 border-violet-400/60 pl-2">
                        China WH series uses <span className="font-medium text-foreground">available</span> stock
                        (sellable units), not total SOH. It can show 0 while SOH China is still positive if units are
                        allocated or reserved.
                      </p>
                    )}
                  </>
                )}
                {containerLoadBridge && useChinaWH && (
                  <p className="text-[11px] text-muted-foreground mb-2 leading-snug border-l-2 border-primary/50 pl-2">
                    <span className="font-medium text-foreground">Container load bridge:</span> the vertical line marks
                    container load start in China. Planned shipments are sized{' '}
                    <span className="font-medium text-foreground">backward</span> so Main reaches at least{' '}
                    <span className="font-medium text-foreground">{MAIN_CONTAINER_BRIDGE_DAYS} days</span> of demand on
                    that date (sea-freight cover), capped by 90% of China stock at ship day.
                  </p>
                )}
                {chartData.length === 0 ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                    No data available.
                  </div>
                ) : !chartHasVisibleSeries ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground text-sm text-center px-4">
                    Select at least one product in the legend to show the chart.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={chartHeightPx}>
                    <ComposedChart data={chartData} margin={{ top: 28, right: 16, left: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        interval={Math.max(0, Math.floor(chartData.length / 12) - 1)}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))}
                        width={52}
                      />
                      <RechartsTooltip
                        content={
                          <CustomTooltip
                            skus={skuMeta}
                            inbounds={allInbounds}
                            chartUsesSoh={chartUsesSoh}
                            containerLoadBridge={containerLoadBridge}
                            bridgeDays={MAIN_CONTAINER_BRIDGE_DAYS}
                            targetLabel={targetLabel}
                          />
                        }
                        cursor={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }}
                      />

                      {/* Zero / stockout line */}
                      <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeOpacity={0.5} strokeWidth={1} />

                      {/* Target date */}
                      <ReferenceLine
                        x={targetLabel}
                        stroke="hsl(var(--primary))"
                        strokeDasharray="4 4"
                        strokeOpacity={0.7}
                        label={{
                          value: containerLoadBridge ? 'Load' : 'Target',
                          position: 'insideTopRight',
                          fontSize: 10,
                          fill: 'hsl(var(--primary))',
                        }}
                      />

                      {/* Arrival vertical markers (Main arrivals only) */}
                      {allInbounds
                        .filter(
                          (ib) =>
                            visibleSkus.has(ib.sku) &&
                            ib.etaDay > 0 &&
                            ib.etaDay <= daysToTarget &&
                            !ib.isProductionArrival
                        )
                        .map((ib, idx) => (
                          <ReferenceLine
                            key={`vline-${idx}`}
                            x={format(addDays(today, ib.etaDay), 'dd MMM')}
                            stroke={ib.isChinaWH ? '#8b5cf6' : (skuMeta.find((m) => m.sku === ib.sku)?.color ?? '#6366f1')}
                            strokeOpacity={ib.isChinaWH ? 0.5 : 0.25}
                            strokeWidth={ib.isChinaWH ? 1.5 : 1}
                            strokeDasharray={ib.isChinaWH ? '4 3' : '2 3'}
                          />
                        ))}

                      {/* Stock curve lines */}
                      {skuMetaVisible.map((m) => (
                        <Line
                          key={m.sku}
                          type="monotone"
                          dataKey={m.sku}
                          stroke={m.color}
                          strokeWidth={2}
                          dot={<ArrivalDot stroke={m.color} />}
                          activeDot={{ r: 4, stroke: m.color, strokeWidth: 2, fill: 'white' }}
                          isAnimationActive={false}
                        />
                      ))}

                      {/* Hidden series for arrival qty (tooltip only) */}
                      {skuMetaVisible.map((m) => (
                        <Line
                          key={`${m.sku}_arr`}
                          dataKey={`${m.sku}_arr`}
                          stroke="transparent"
                          dot={false}
                          activeDot={false}
                          legendType="none"
                          isAnimationActive={false}
                        />
                      ))}

                      {/* Hidden series for China stock (tooltip only) */}
                      {skuMetaVisible.map((m) => (
                        <Line
                          key={`${m.sku}_china`}
                          dataKey={`${m.sku}_china`}
                          stroke="transparent"
                          dot={false}
                          activeDot={false}
                          legendType="none"
                          isAnimationActive={false}
                        />
                      ))}

                      {/* Hidden series for China ship-day tooltip details */}
                      {skuMetaVisible.map((m) => (
                        <Line
                          key={`${m.sku}_chinaShip`}
                          dataKey={`${m.sku}_chinaShip`}
                          stroke="transparent"
                          dot={false}
                          activeDot={false}
                          legendType="none"
                          isAnimationActive={false}
                        />
                      ))}
                      {skuMetaVisible.map((m) => (
                        <Line
                          key={`${m.sku}_chinaShipSource`}
                          dataKey={`${m.sku}_chinaShipSource`}
                          stroke="transparent"
                          dot={false}
                          activeDot={false}
                          legendType="none"
                          isAnimationActive={false}
                        />
                      ))}

                      {/* Arrival marker dots on the Main curve (exclude production arrivals at China) */}
                      {allInbounds
                        .filter(
                          (ib) =>
                            visibleSkus.has(ib.sku) &&
                            ib.etaDay > 0 &&
                            ib.etaDay <= daysToTarget &&
                            !ib.isProductionArrival
                        )
                        .map((ib, idx) => {
                          const dayLabel = format(addDays(today, ib.etaDay), 'dd MMM');
                          const point = chartData.find((p) => p.label === dayLabel);
                          if (!point) return null;
                          const stockVal = point[ib.sku];
                          if (typeof stockVal !== 'number') return null;
                          const color = ib.isChinaWH
                            ? '#8b5cf6'
                            : (skuMeta.find((m) => m.sku === ib.sku)?.color ?? '#6366f1');
                          return (
                            <ReferenceDot
                              key={`dot-${idx}`}
                              x={dayLabel}
                              y={stockVal}
                              r={6}
                              fill={color}
                              stroke="white"
                              strokeWidth={2}
                              label={{
                                value: `+${ib.quantity >= 1000 ? `${(ib.quantity / 1000).toFixed(1)}k` : ib.quantity}`,
                                position: 'top',
                                fontSize: 9,
                                fill: color,
                                fontWeight: 600,
                              }}
                            />
                          );
                        })}

                      {/* Green dots on China ship days */}
                      {allInbounds
                        .filter(
                          (ib) =>
                            visibleSkus.has(ib.sku) &&
                            ib.isChinaWH &&
                            !ib.isProductionArrival &&
                            ib.shipDay != null &&
                            ib.shipDay > 0 &&
                            ib.shipDay <= daysToTarget
                        )
                        .map((ib, idx) => {
                          const dayLabel = format(addDays(today, ib.shipDay!), 'dd MMM');
                          const point = chartData.find((p) => p.label === dayLabel);
                          if (!point) return null;
                          const stockVal = point[ib.sku];
                          if (typeof stockVal !== 'number') return null;
                          return (
                            <ReferenceDot
                              key={`ship-${idx}`}
                              x={dayLabel}
                              y={stockVal}
                              r={5}
                              fill="#22c55e"
                              stroke="white"
                              strokeWidth={2}
                            />
                          );
                        })}

                      {/* Stockout markers (red circles) */}
                      {stockoutMarkers.map((m, idx) => (
                        <ReferenceDot
                          key={`stockout-${idx}`}
                          x={m.label}
                          y={m.y}
                          r={7}
                          fill="hsl(var(--destructive))"
                          stroke="white"
                          strokeWidth={2}
                          label={{
                            value: m.type === 'china' ? '⚠ China' : '⚠ Stockout',
                            position: 'top',
                            fontSize: 9,
                            fill: 'hsl(var(--destructive))',
                            fontWeight: 700,
                          }}
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* ── Inbound Orders Table ─────────────────────────────────────── */}
              <div className="rounded-lg border bg-card">
                <div className="px-4 py-2.5 border-b flex items-center gap-2">
                  <Truck size={13} className="text-amber-500" />
                  <h3 className="text-sm font-semibold">Inbound Orders</h3>
                  {useChinaWH && chinaArrivals.length > 0 && (
                    <span className="text-[10px] text-violet-600 bg-violet-50 dark:bg-violet-950/30 px-1.5 py-0.5 rounded-full border border-violet-200 dark:border-violet-800">
                      includes China WH planned orders
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {allInbounds.length} shipment{allInbounds.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {allInbounds.length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
                    <Truck size={16} className="opacity-40" />
                    {loading
                      ? 'Loading…'
                      : 'No inbound purchase orders with ETA found for the filtered SKUs.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">SKU</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Product</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Supplier</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">PO #</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Order Date</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">ETA</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Qty</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Days Until ETA</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allInbounds.map((ib, i) => {
                          const isPast  = ib.etaDay < 0;
                          const isToday = ib.etaDay === 0;
                          const isSoon  = ib.etaDay > 0 && ib.etaDay <= 7;
                          const color   = ib.isChinaWH
                            ? '#8b5cf6'
                            : skuMeta.find((m) => m.sku === ib.sku)?.color;
                          return (
                            <tr
                              key={i}
                              className={cn(
                                'border-t border-border/40 hover:bg-muted/20 transition-colors',
                                isPast && 'opacity-50',
                                ib.isChinaWH && 'bg-violet-50/40 dark:bg-violet-950/10'
                              )}
                            >
                              <td className="px-4 py-2 font-mono font-semibold text-primary">
                                <span
                                  className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                                  style={{ backgroundColor: color }}
                                />
                                {ib.sku}
                              </td>
                              <td className="px-3 py-2 truncate max-w-[160px]" title={ib.product}>
                                {ib.product}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px]">
                                {ib.supplier ?? '—'}
                              </td>
                              <td className="px-3 py-2 font-mono text-blue-600 dark:text-blue-400">
                                {ib.isChinaWH && !ib.isProductionArrival
                                  ? <span className="text-violet-500 italic">planned</span>
                                  : (ib.orderNumber ?? '—')}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                                {safeParseDate(ib.orderDate)
                                  ? format(safeParseDate(ib.orderDate)!, 'dd MMM yyyy')
                                  : ib.orderDate}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap font-medium">
                                {safeParseDate(ib.eta)
                                  ? format(safeParseDate(ib.eta)!, 'dd MMM yyyy')
                                  : ib.eta}
                              </td>
                              <td className="px-3 py-2">
                                <span className={cn(
                                  'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
                                  ib.isChinaWH
                                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                                    : 'bg-muted text-muted-foreground'
                                )}>
                                  {ib.isChinaWH && !ib.isProductionArrival
                                    ? ib.isContainerBridgeShip
                                      ? ib.isDeferredShip
                                        ? 'China WH (bridge, deferred)'
                                        : 'China WH (bridge)'
                                      : ib.isDeferredShip
                                        ? 'China WH (deferred)'
                                        : ib.status
                                    : ib.status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                                {ib.quantity.toLocaleString()}
                              </td>
                              <td className={cn(
                                'px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap',
                                isPast  ? 'text-muted-foreground' :
                                isToday ? 'text-emerald-500' :
                                isSoon  ? 'text-amber-500' :
                                          'text-foreground'
                              )}>
                                {isPast  ? `${Math.abs(ib.etaDay)}d ago` :
                                 isToday ? 'Today' :
                                           `${ib.etaDay}d`}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Footer */}
              <p className="text-[10px] text-muted-foreground px-1 pb-1">
                Showing <strong>DHL + Container</strong> status orders, plus <strong>Purchase Orders</strong> (auto-excluding any whose qty matches the SKU&apos;s onProduction value).
                {showAllPlaced && ' Override active: all purchase orders shown, including production POs (arriving at China warehouse).'}
                {useChinaWH &&
                  (containerLoadBridge
                    ? ` China WH (container load bridge): target date is container load start in China; Main should hold ${MAIN_CONTAINER_BRIDGE_DAYS} days of demand that day. Planned ship qty is the minimum from China (backward from that anchor) to reach that Main level, capped by 90% of China stock at ship day.`
                    : chartUsesSoh
                    ? ' China WH orders are planned (90% of China stock at ship day; if empty on the ideal ship date, deferred to the first day stock is available).'
                    : ' China WH orders are planned (90% of available China stock at ship day; if empty on the ideal ship date, deferred to the first day stock is available).')}
                {' '}Daily demand = monthly avg ÷ 30.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
