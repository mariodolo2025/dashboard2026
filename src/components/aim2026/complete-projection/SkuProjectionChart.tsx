// =============================================================================
// AIM 2026 — Complete Projection: per-SKU on-hand forecast chart (hand-rolled SVG)
// =============================================================================

import { format } from 'date-fns';
import type { ChartSeries } from './projection';
import { addDays, daysBetween } from './projection';

const W = 420;
const H = 180;
const padL = 34;
const padR = 12;
const padT = 12;
const padB = 22;
const plotW = W - padL - padR;
const plotH = H - padT - padB;

interface SkuProjectionChartProps {
  series: ChartSeries;
  today: Date;
  projectionDate: Date;
  onSetProjectionDate: (d: Date) => void;
}

export function SkuProjectionChart({
  series,
  today,
  projectionDate,
  onSetProjectionDate,
}: SkuProjectionChartProps) {
  const { points, horizonDays, safety, stockoutDay, maxY } = series;

  const xFromDay = (d: number) => padL + (d / horizonDays) * plotW;
  const yFromVal = (v: number) => padT + plotH - (Math.min(Math.max(v, 0), maxY) / maxY) * plotH;
  const dayFromX = (px: number) =>
    Math.min(Math.max(Math.round(((px - padL) / plotW) * horizonDays), 0), horizonDays);
  const baseY = yFromVal(0);

  const linePts = (key: 'withPipeline' | 'demandOnly') =>
    points.map((p) => `${xFromDay(p.day).toFixed(1)},${yFromVal(p[key]).toFixed(1)}`).join(' ');

  const areaPath = `M ${xFromDay(0).toFixed(1)},${baseY.toFixed(1)} L ${points
    .map((p) => `${xFromDay(p.day).toFixed(1)},${yFromVal(p.withPipeline).toFixed(1)}`)
    .join(' L ')} L ${xFromDay(horizonDays).toFixed(1)},${baseY.toFixed(1)} Z`;

  const t = Math.min(Math.max(daysBetween(today, projectionDate), 0), horizonDays);
  const markVal = points[t]?.withPipeline ?? 0;
  const markX = xFromDay(t);
  const markY = yFromVal(markVal);

  // Month ticks every ~30 days
  const monthTicks: number[] = [];
  for (let d = 0; d <= horizonDays; d += 30) monthTicks.push(d);

  // Label tag position (clamp so it stays inside)
  const tagW = 78;
  const tagX = Math.min(Math.max(markX - tagW / 2, padL), W - padR - tagW);

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (W / rect.width);
    onSetProjectionDate(addDays(today, dayFromX(px)));
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full cursor-crosshair select-none"
      onClick={handleClick}
    >
      <defs>
        <linearGradient id="cp-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Y gridlines + labels */}
      {[0, 0.5, 1].map((f) => {
        const v = maxY * f;
        const y = yFromVal(v);
        return (
          <g key={f}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#f0f0ec" strokeWidth={1} />
            <text
              x={padL - 4}
              y={y + 3}
              textAnchor="end"
              className="font-mono"
              fontSize={8}
              fill="#b6bcc7"
            >
              {Math.round(v)}
            </text>
          </g>
        );
      })}

      {/* X month ticks */}
      {monthTicks.map((d) => (
        <text
          key={d}
          x={xFromDay(d)}
          y={H - 6}
          textAnchor="middle"
          fontSize={8}
          fill="#b6bcc7"
        >
          {d === 0 ? 'Now' : format(addDays(today, d), 'MMM')}
        </text>
      ))}

      {/* Area + projection line */}
      <path d={areaPath} fill="url(#cp-area)" />
      <polyline points={linePts('withPipeline')} fill="none" stroke="#7c3aed" strokeWidth={1.6} />

      {/* Demand-only dashed grey */}
      <polyline
        points={linePts('demandOnly')}
        fill="none"
        stroke="#828a98"
        strokeWidth={1.2}
        strokeDasharray="4 3"
      />

      {/* Safety line */}
      {safety > 0 && safety <= maxY && (
        <>
          <line
            x1={padL}
            y1={yFromVal(safety)}
            x2={W - padR}
            y2={yFromVal(safety)}
            stroke="#dc2626"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text x={W - padR} y={yFromVal(safety) - 3} textAnchor="end" fontSize={8} fill="#dc2626">
            safety {Math.round(safety)}
          </text>
        </>
      )}

      {/* Today vertical */}
      <line x1={padL} y1={padT} x2={padL} y2={baseY} stroke="#0f1115" strokeWidth={1} />

      {/* Stockout marker */}
      {stockoutDay != null && (
        <>
          <line
            x1={xFromDay(stockoutDay)}
            y1={padT}
            x2={xFromDay(stockoutDay)}
            y2={baseY}
            stroke="#dc2626"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
          <circle cx={xFromDay(stockoutDay)} cy={baseY} r={3} fill="#dc2626" />
        </>
      )}

      {/* Projection-date marker */}
      <line x1={markX} y1={padT} x2={markX} y2={baseY} stroke="#f59e0b" strokeWidth={1.4} />
      <circle cx={markX} cy={markY} r={3.5} fill="#f59e0b" stroke="#fff" strokeWidth={1} />
      <g>
        <rect x={tagX} y={2} width={tagW} height={15} rx={3} fill="#f59e0b" />
        <text x={tagX + tagW / 2} y={12} textAnchor="middle" fontSize={8} fill="#3b1f00" className="font-mono">
          {format(projectionDate, 'd MMM')} · {Math.round(markVal)}u
        </text>
      </g>
    </svg>
  );
}
