import { motion } from 'framer-motion';
import { Package, AlertTriangle, RotateCcw, TrendingUp, Percent, CalendarClock, Brain, Sparkles, HelpCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TrendIndicator } from './TrendIndicator';
import type { KPISummary } from '@/lib/aim2026/types';

// ─── Mini Sparkline (SVG) ────────────────────────────────────────────────────

function Sparkline({ data, color = '#3b82f6' }: { data: number[]; color?: string }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 80;
  const h = 28;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');

  return (
    <svg width={w} height={h} className="opacity-60">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Skeleton Card ───────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <Card className="relative overflow-hidden p-4">
      <div className="animate-pulse space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
        <div className="h-7 w-20 rounded bg-muted" />
        <div className="h-3 w-16 rounded bg-muted" />
      </div>
    </Card>
  );
}

// ─── Card Component ──────────────────────────────────────────────────────────

interface KPICardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtitle?: string;
  helpText?: string;
  trend?: { direction: 'up' | 'down' | 'stable'; percent?: number };
  sparkData?: number[];
  sparkColor?: string;
  accent?: string;
  badge?: { text: string; color: string };
  delay?: number;
  onClick?: () => void;
}

function KPICard({
  icon,
  label,
  value,
  subtitle,
  helpText,
  trend,
  sparkData,
  sparkColor,
  accent,
  badge,
  delay = 0,
  onClick,
}: KPICardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <Card
        className={`
          relative overflow-hidden p-4 cursor-pointer group
          transition-all duration-200
          hover:shadow-md hover:shadow-black/5 dark:hover:shadow-black/20
          hover:-translate-y-0.5
          border border-border/60
          bg-gradient-to-br from-card to-card/80
        `}
        onClick={onClick}
      >
        {/* Accent gradient stripe at top */}
        {accent && (
          <div
            className="absolute inset-x-0 top-0 h-[2px] opacity-70"
            style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }}
          />
        )}

        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <span className="opacity-60">{icon}</span>
              <span className="text-xs font-medium tracking-wide uppercase truncate">{label}</span>
              {helpText && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <span className="ml-auto cursor-help opacity-40 hover:opacity-80 transition-opacity">
                        <HelpCircle size={11} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      className="max-w-[220px] text-[11px] leading-snug"
                    >
                      {helpText}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>

            {/* Value row */}
            <div className="flex items-end gap-2">
              <span className="text-2xl font-semibold tracking-tight tabular-nums leading-none">
                {value}
              </span>
              {trend && (
                <TrendIndicator
                  direction={trend.direction}
                  percent={trend.percent}
                  showPercent={!!trend.percent}
                  size="sm"
                />
              )}
              {badge && (
                <span
                  className={`ml-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${badge.color}`}
                >
                  {badge.text}
                </span>
              )}
            </div>

            {/* Subtitle — fixed height, no hover expansion */}
            {subtitle && (
              <p className="text-[11px] text-muted-foreground/70 leading-tight">{subtitle}</p>
            )}
          </div>

          {/* Sparkline */}
          {sparkData && sparkData.length > 1 && (
            <div className="flex-shrink-0 ml-2 mt-2">
              <Sparkline data={sparkData} color={sparkColor} />
            </div>
          )}
        </div>
      </Card>
    </motion.div>
  );
}

// ─── KPI Summary Strip ───────────────────────────────────────────────────────

interface FilteredKPIOverrides {
  avgMarginPercent: number;
  avgTurnover: number;
  avgGMROI: number;
  avgDaysOfCover: number;
  itemsAtRisk: number;
  totalProducts: number;
}

interface KPISummaryCardsProps {
  data: KPISummary | null;
  filteredOverrides?: FilteredKPIOverrides | null;
  loading: boolean;
  onValuationClick?: () => void;
  onAIInsightsClick?: () => void;
}

export function KPISummaryCards({ data, filteredOverrides, loading, onValuationClick, onAIInsightsClick }: KPISummaryCardsProps) {
  if (loading || !data) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  const formatCurrencyAUD = (v: number): string => {
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      // Show 2 decimals for < 10M, 1 decimal for >= 10M
      return `AUD ${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
    }
    if (v >= 1_000) return `AUD ${Math.round(v / 1_000)}K`;
    return `AUD ${v.toFixed(0)}`;
  };

  const formatCurrencyUSD = (v: number): string => {
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return `USD ${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
    }
    if (v >= 1_000) return `USD ${Math.round(v / 1_000)}K`;
    return `USD ${v.toFixed(0)}`;
  };

  const fo = filteredOverrides;
  const itemsAtRisk = fo?.itemsAtRisk ?? data.itemsAtRisk;
  const totalProducts = fo?.totalProducts ?? data.totalProducts;
  const avgMarginPercent = fo?.avgMarginPercent ?? data.avgMarginPercent;
  const avgTurnover = fo?.avgTurnover ?? data.avgTurnover;
  const avgGMROI = fo?.avgGMROI ?? data.avgGMROI;
  const avgDaysOfCover = fo?.avgDaysOfCover ?? data.avgDaysOfCover;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
      <KPICard
        icon={<Package size={15} />}
        label="Inventory Value"
        value={formatCurrencyAUD(data.totalInventoryValueAUD)}
        subtitle={`${formatCurrencyUSD(data.totalInventoryValueUSD)} · Click for details`}
        // The history arrives newest-first from the API. Drawn as-is the line reads
        // backwards — an 18% fall rendered as a rise. The valuation dialog and panel
        // already reverse their own copy; this one did not.
        sparkData={[...data.inventoryValueHistory].reverse().map((h) => h.value)}
        sparkColor="#3b82f6"
        accent="#3b82f6"
        delay={0}
        onClick={onValuationClick}
      />
      <KPICard
        icon={<AlertTriangle size={15} />}
        label="Items at Risk"
        value={String(itemsAtRisk)}
        subtitle={`of ${totalProducts} products`}
        helpText="Products with CRITICAL or LOW STOCK status that need urgent attention."
        accent="#ef4444"
        badge={
          itemsAtRisk > 0
            ? { text: `${itemsAtRisk}`, color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' }
            : undefined
        }
        delay={0.05}
      />
      <KPICard
        icon={<RotateCcw size={15} />}
        label="Avg Turnover"
        value={avgTurnover.toFixed(1)}
        subtitle="times per period"
        helpText="How many times inventory is sold and replaced. Higher = better capital efficiency."
        trend={{ direction: data.avgTurnoverTrend }}
        accent="#8b5cf6"
        delay={0.1}
      />
      <KPICard
        icon={<TrendingUp size={15} />}
        label="Avg GMROI"
        value={avgGMROI > 100 ? '>100' : avgGMROI.toFixed(1)}
        subtitle="return on inventory $"
        helpText="Gross Margin Return on Investment: annual gross profit per AUD invested in inventory. High values (>100) indicate very low stock relative to sales. Target: > 3.0."
        accent={avgGMROI >= 3 ? '#10b981' : avgGMROI >= 1 ? '#f59e0b' : '#ef4444'}
        delay={0.15}
      />
      <KPICard
        icon={<Percent size={15} />}
        label="Avg Margin"
        value={`${avgMarginPercent.toFixed(1)}%`}
        subtitle="gross profit"
        helpText="Gross profit margin: (Selling Price − Landed Cost) ÷ Selling Price × 100."
        trend={{ direction: data.avgMarginTrend }}
        accent="#f59e0b"
        delay={0.2}
      />
      <KPICard
        icon={<CalendarClock size={15} />}
        label="Avg Coverage"
        value={`${Math.round(avgDaysOfCover)}d`}
        subtitle="days of cover"
        helpText="Average days current stock will last at current demand. Red < 30, Yellow < 60, Green ≥ 60."
        accent="#06b6d4"
        delay={0.25}
      />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <Card
          className="relative overflow-hidden p-4 cursor-pointer group transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 border border-purple-500/30 bg-gradient-to-br from-slate-900 to-slate-950 text-white"
          onClick={onAIInsightsClick}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 via-purple-600/10 to-transparent pointer-events-none" />
          <div className="absolute inset-x-0 top-0 h-[2px] opacity-70" style={{ background: 'linear-gradient(90deg, #8b5cf6, #3b82f6, transparent)' }} />
          <div className="relative space-y-2">
            <div className="flex items-center gap-1.5 text-slate-400">
              <Brain size={15} className="opacity-80" />
              <span className="text-xs font-medium tracking-wide uppercase">AI Insights</span>
              <Sparkles size={10} className="text-amber-400 ml-auto" />
            </div>
            <span className="text-lg font-semibold tracking-tight leading-none block bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              Analyze
            </span>
            <p className="text-[11px] text-slate-400/70 leading-tight">
              AI-powered recommendations
            </p>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}
