import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Brain,
  AlertTriangle,
  TrendingUp,
  Package,
  Zap,
  RefreshCw,
  Loader2,
  ThumbsUp,
  ThumbsDown,
  Sparkles,
  Clock,
  ShieldAlert,
  DollarSign,
  BarChart3,
  Download,
  Table2,
} from 'lucide-react';
import { cn, downloadCSV, type CSVColumn } from '@/lib/utils';
import type { InsightCard, InsightCategory, InsightSeverity, SKURow, KPISummary } from '@/lib/aim2026/types';
import { fetchAIInsights } from '@/lib/aim2026/api';

// ─── Config ────────────────────────────────────────────────────────────────

const CATEGORY_CONFIG: Record<InsightCategory, { icon: typeof Brain; label: string; gradient: string; border: string }> = {
  inventory: {
    icon: Package,
    label: 'Inventory Alert',
    gradient: 'from-amber-500/20 via-amber-500/5 to-transparent',
    border: 'border-amber-500/30',
  },
  demand: {
    icon: BarChart3,
    label: 'Demand Insight',
    gradient: 'from-blue-500/20 via-blue-500/5 to-transparent',
    border: 'border-blue-500/30',
  },
  financial: {
    icon: DollarSign,
    label: 'Financial Insight',
    gradient: 'from-emerald-500/20 via-emerald-500/5 to-transparent',
    border: 'border-emerald-500/30',
  },
  action: {
    icon: Zap,
    label: 'Actionable',
    gradient: 'from-purple-500/20 via-purple-500/5 to-transparent',
    border: 'border-purple-500/30',
  },
};

const SEVERITY_COLOR: Record<InsightSeverity, string> = {
  critical: 'text-red-400',
  warning: 'text-amber-400',
  info: 'text-blue-400',
  positive: 'text-emerald-400',
};

const SEVERITY_BADGE: Record<InsightSeverity, { bg: string; text: string }> = {
  critical: { bg: 'bg-red-500/20', text: 'text-red-300' },
  warning: { bg: 'bg-amber-500/20', text: 'text-amber-300' },
  info: { bg: 'bg-blue-500/20', text: 'text-blue-300' },
  positive: { bg: 'bg-emerald-500/20', text: 'text-emerald-300' },
};

// ─── Confidence Ring ───────────────────────────────────────────────────────

function ConfidenceRing({ value, size = 40 }: { value: number; size?: number }) {
  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (value / 100) * circumference;
  const color = value >= 90 ? '#10b981' : value >= 80 ? '#3b82f6' : '#f59e0b';

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          className="text-white/10"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[9px] font-bold text-white/80">{value}%</span>
      </div>
    </div>
  );
}

// ─── CSV columns for insight product lists ──────────────────────────────────

const INSIGHT_CSV_COLUMNS: CSVColumn[] = [
  { header: 'SKU', key: 'sku' },
  { header: 'Product', key: 'product' },
  { header: 'ABC', key: 'abcClass' },
  { header: 'SOH', key: 'sohMainWH' },
  { header: 'Demand/mo', key: 'projectedDemand' },
  { header: 'Days Cover', key: 'daysOfCover' },
  { header: 'Status', key: 'status' },
  { header: 'Margin %', key: 'marginPercent' },
  { header: 'GMROI', key: 'gmroi' },
  { header: 'ASP', key: 'avgSellingPrice' },
];

// ─── Insight Card Component ────────────────────────────────────────────────

function InsightCardUI({
  insight,
  index,
  skuData,
  onDownloadCSV,
  onApplyFilter,
}: {
  insight: InsightCard;
  index: number;
  skuData: SKURow[];
  onDownloadCSV?: (skus: string[], label: string) => void;
  onApplyFilter?: (skus: string[]) => void;
}) {
  const config = CATEGORY_CONFIG[insight.category] || CATEGORY_CONFIG.action;
  const Icon = config.icon;
  const sevBadge = SEVERITY_BADGE[insight.severity] || SEVERITY_BADGE.info;
  const hasRelatedSKUs = insight.relatedSKUs && insight.relatedSKUs.length > 0;

  const handleDownload = () => {
    if (!hasRelatedSKUs || !onDownloadCSV) return;
    onDownloadCSV(insight.relatedSKUs!, insight.title.replace(/\s+/g, '_').slice(0, 40));
  };

  const handleViewInTable = () => {
    if (!hasRelatedSKUs || !onApplyFilter) return;
    onApplyFilter(insight.relatedSKUs!);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1, duration: 0.4 }}
      className={cn(
        'relative rounded-xl border p-4 overflow-hidden',
        'bg-gradient-to-br from-slate-900 to-slate-950',
        config.border
      )}
    >
      {/* Background gradient glow */}
      <div className={cn('absolute inset-0 bg-gradient-to-br opacity-60 pointer-events-none', config.gradient)} />

      <div className="relative z-10 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={cn('text-xs font-semibold uppercase tracking-wider', SEVERITY_COLOR[insight.severity])}>
                {config.label}
              </span>
              {insight.severity === 'critical' && (
                <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded-full', sevBadge.bg, sevBadge.text)}>
                  URGENT
                </span>
              )}
            </div>
            <h3 className="text-white font-bold text-[15px] leading-snug">{insight.title}</h3>
          </div>

          <ConfidenceRing value={insight.confidence} />
        </div>

        {/* Description */}
        <p className="text-[12px] text-slate-300 leading-relaxed">{insight.description}</p>

        {/* Related SKUs */}
        {insight.relatedSKUs && insight.relatedSKUs.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {insight.relatedSKUs.map((sku) => (
              <span
                key={sku}
                className="text-[10px] font-mono bg-white/10 text-slate-300 px-1.5 py-0.5 rounded"
              >
                {sku}
              </span>
            ))}
          </div>
        )}

        {/* Footer: action buttons + feedback */}
        <div className="flex items-center justify-between pt-1 flex-wrap gap-2">
          {hasRelatedSKUs && (onDownloadCSV || onApplyFilter) && (
            <div className="flex items-center gap-1.5">
              {onDownloadCSV && (
                <button
                  onClick={handleDownload}
                  className="text-[11px] font-semibold text-white bg-white/10 hover:bg-white/20 rounded-lg px-2.5 py-1.5 transition-colors border border-white/10 flex items-center gap-1"
                >
                  <Download size={10} />
                  Download CSV
                </button>
              )}
              {onApplyFilter && (
                <button
                  onClick={handleViewInTable}
                  className="text-[11px] font-semibold text-white bg-white/10 hover:bg-white/20 rounded-lg px-2.5 py-1.5 transition-colors border border-white/10 flex items-center gap-1"
                >
                  <Table2 size={10} />
                  View in Table
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[9px] text-slate-500 mr-1">Confidence Score</span>
            <button className="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-emerald-400 transition-colors">
              <ThumbsUp size={12} />
            </button>
            <button className="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-red-400 transition-colors">
              <ThumbsDown size={12} />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Dialog ───────────────────────────────────────────────────────────

interface AIInsightsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skuData: SKURow[];
  kpiSummary: KPISummary | null;
  assembledProductSKUs?: Set<string>;
  config?: { aiInsightsPrompt?: string; aiInsightsExcludedSKUs?: string };
  onApplyFilter?: (skus: string[]) => void;
}

export function AIInsightsDialog({
  open,
  onOpenChange,
  skuData,
  kpiSummary,
  assembledProductSKUs = new Set(),
  config,
  onApplyFilter,
}: AIInsightsDialogProps) {
  const [insights, setInsights] = useState<InsightCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const generateInsights = useCallback(async () => {
    if (!kpiSummary || skuData.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const excludedList = (config?.aiInsightsExcludedSKUs ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await fetchAIInsights(
        skuData
          .filter((s) => !excludedList.some((ex) => s.sku.includes(ex) || s.product.includes(ex)))
          .map((s) => ({
          sku: s.sku,
          product: s.product,
          abcClass: s.abcClass,
          sohMainWH: s.sohMainWH,
          sohChina: s.sohChina,
          container: s.container,
          dhl: s.dhl,
          onProduction: s.onProduction,
          pipeline: s.pipeline,
          projectedDemand: s.projectedDemand,
          demandTrend: s.demandTrend,
          demandTrendPercent: s.demandTrendPercent,
          reorderPoint: s.reorderPoint,
          suggestedQty: s.suggestedQty,
          daysOfCover: s.daysOfCover,
          turnover: s.turnover,
          marginPercent: s.marginPercent,
          gmroi: s.gmroi,
          status: s.status,
          stockoutRisk: s.stockoutRisk,
          leadTimeDays: s.leadTimeDays,
          productCostChina: s.productCostChina,
          landedCostAUD: s.landedCostAUD,
          avgSellingPrice: s.avgSellingPrice,
          isAssembled: assembledProductSKUs.has(s.sku),
        })),
        kpiSummary as unknown as Record<string, unknown>,
        {
          assembledProductSKUs: [...assembledProductSKUs],
          customPrompt: config?.aiInsightsPrompt || undefined,
          excludedSKUs: excludedList,
        }
      );

      if (result.success) {
        setInsights(result.insights as InsightCard[]);
        setGeneratedAt(result.generatedAt ?? new Date().toISOString());
        setModel(result.model ?? null);
      } else {
        setError(result.message ?? 'Failed to generate insights');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to AI service');
    } finally {
      setLoading(false);
    }
  }, [skuData, kpiSummary, assembledProductSKUs, config]);

  // Auto-generate on first open if no insights
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen && insights.length === 0 && !loading && !error) {
        generateInsights();
      }
      onOpenChange(isOpen);
    },
    [insights.length, loading, error, generateInsights, onOpenChange]
  );

  const timeSince = generatedAt
    ? (() => {
        const diff = Date.now() - new Date(generatedAt).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins}m ago`;
        return `${Math.floor(mins / 60)}h ago`;
      })()
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden bg-slate-950 border-slate-800 text-white">
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4">
          <div className="absolute inset-0 bg-gradient-to-b from-blue-600/10 via-purple-600/5 to-transparent pointer-events-none" />
          <div className="relative flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                <Brain size={20} className="text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  Intelligent Growth Insights
                  <Sparkles size={14} className="text-amber-400" />
                </h2>
                <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                  {timeSince && (
                    <>
                      <Clock size={10} />
                      Last updated: {timeSince}
                    </>
                  )}
                  {model && <span className="text-slate-600">· {model}</span>}
                </p>
              </div>
            </div>

            <Button
              size="sm"
              variant="ghost"
              onClick={generateInsights}
              disabled={loading}
              className="text-slate-400 hover:text-white hover:bg-white/10 h-8 gap-1.5 text-xs"
            >
              {loading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              {loading ? 'Analyzing...' : 'Refresh'}
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pb-6 space-y-3 max-h-[65vh] overflow-y-auto">
          {loading && insights.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="relative">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center">
                  <Brain size={28} className="text-blue-400 animate-pulse" />
                </div>
                <div className="absolute -inset-2 rounded-full border border-blue-500/20 animate-ping" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-slate-300">Analyzing your inventory data...</p>
                <p className="text-[11px] text-slate-500">
                  Processing {skuData.length} SKUs with Claude AI
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3 flex items-start gap-3">
              <ShieldAlert size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-300">Analysis Failed</p>
                <p className="text-xs text-red-400/80 mt-0.5">{error}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={generateInsights}
                  className="text-red-300 hover:text-white mt-2 h-7 text-xs"
                >
                  Try Again
                </Button>
              </div>
            </div>
          )}

          <AnimatePresence>
            {insights.map((insight, i) => (
              <InsightCardUI
                key={`${insight.title}-${i}`}
                insight={insight}
                index={i}
                skuData={skuData}
                onDownloadCSV={(skus, label) => {
                  const set = new Set(skus);
                  const rows = skuData.filter((r) => set.has(r.sku));
                  if (rows.length > 0) {
                    downloadCSV(rows, `AI_Insight_${label}.csv`, INSIGHT_CSV_COLUMNS);
                  }
                }}
                onApplyFilter={onApplyFilter}
              />
            ))}
          </AnimatePresence>

          {/* Footer note */}
          {insights.length > 0 && (
            <p className="text-[10px] text-slate-600 text-center pt-2">
              AI-generated insights based on current KPI data. Always verify recommendations before acting.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
