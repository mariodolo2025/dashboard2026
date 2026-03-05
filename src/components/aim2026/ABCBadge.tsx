import { cn } from '@/lib/utils';
import type { ABCClass } from '@/lib/aim2026/types';

const ABC_STYLES: Record<ABCClass, string> = {
  A: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800',
  B: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  C: 'bg-gray-100 text-gray-600 border-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700',
};

export function ABCBadge({ abcClass, className }: { abcClass: ABCClass; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded border text-[11px] font-bold leading-none',
        ABC_STYLES[abcClass],
        className
      )}
    >
      {abcClass}
    </span>
  );
}
