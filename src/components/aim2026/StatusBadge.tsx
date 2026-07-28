import { cn } from '@/lib/utils';
import type { StockStatus, StockoutRisk } from '@/lib/aim2026/types';

// ─── Status Badge ────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<StockStatus, string> = {
  CRITICAL:
    'bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800 animate-pulse',
  'LOW STOCK':
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-900',
  WARNING:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-900',
  OK: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-900',
  OVERSTOCK:
    'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-400 dark:border-violet-900',
  'NO DEMAND': 'bg-transparent text-muted-foreground border-transparent',
};

export function StatusBadge({ status, className }: { status: StockStatus; className?: string }) {
  // Stock is not held per channel, so with a channel filter on, "no demand here"
  // is not a stock verdict. It renders as a plain dash rather than a coloured
  // badge that would read as an instruction.
  if (status === 'NO DEMAND') {
    return (
      <span
        className={cn('text-[13px] text-muted-foreground', className)}
        title="No demand for the selected channel — stock status does not apply"
      >
        —
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-tight tracking-wide uppercase whitespace-nowrap',
        STATUS_STYLES[status],
        className
      )}
    >
      {status === 'CRITICAL' && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-red-500 animate-ping" />
      )}
      {status}
    </span>
  );
}

// ─── Stockout Risk Badge ─────────────────────────────────────────────────────

const RISK_STYLES: Record<StockoutRisk, string> = {
  critical: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  low: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
};

export function StockoutRiskBadge({ risk, className }: { risk: StockoutRisk; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight capitalize',
        RISK_STYLES[risk],
        className
      )}
    >
      {risk}
    </span>
  );
}
