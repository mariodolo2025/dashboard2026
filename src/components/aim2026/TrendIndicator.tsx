import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TrendDirection } from '@/lib/aim2026/types';

interface TrendIndicatorProps {
  direction: TrendDirection;
  percent?: number;
  showPercent?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const TREND_CONFIG: Record<TrendDirection, { icon: typeof TrendingUp; color: string; label: string }> = {
  up: { icon: TrendingUp, color: 'text-emerald-600 dark:text-emerald-400', label: 'Increasing' },
  down: { icon: TrendingDown, color: 'text-red-500 dark:text-red-400', label: 'Decreasing' },
  stable: { icon: Minus, color: 'text-gray-400 dark:text-gray-500', label: 'Stable' },
};

export function TrendIndicator({
  direction,
  percent,
  showPercent = false,
  size = 'sm',
  className,
}: TrendIndicatorProps) {
  const config = TREND_CONFIG[direction];
  const Icon = config.icon;
  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <span
      className={cn('inline-flex items-center gap-0.5', config.color, className)}
      title={`${config.label}${percent !== undefined ? ` (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)` : ''}`}
    >
      <Icon size={iconSize} strokeWidth={2.5} />
      {showPercent && percent !== undefined && (
        <span className={cn('font-medium tabular-nums', size === 'sm' ? 'text-[11px]' : 'text-xs')}>
          {percent > 0 ? '+' : ''}
          {percent.toFixed(1)}%
        </span>
      )}
    </span>
  );
}
