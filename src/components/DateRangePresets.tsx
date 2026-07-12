import { startOfWeek, endOfWeek, subWeeks, startOfMonth, endOfMonth, subMonths, subDays } from 'date-fns';
import { Button } from '@/components/ui/button';

interface DateRange { from?: Date; to?: Date; }

// Quick presets shown alongside the calendar. Dolo's fiscal year runs Jul 1 – Jun 30.
export function DateRangePresets({ onSelect }: { onSelect: (r: DateRange) => void }) {
  const today = new Date();
  // Current FY starts this year's July if we're past July, else last year's July.
  const curFyStartYear = today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1;
  const lastFyFrom = new Date(curFyStartYear - 1, 6, 1);   // Jul 1 (previous FY)
  const lastFyTo = new Date(curFyStartYear, 5, 30);        // Jun 30

  const presets: { label: string; range: DateRange }[] = [
    { label: 'Last week', range: { from: startOfWeek(subWeeks(today, 1), { weekStartsOn: 1 }), to: endOfWeek(subWeeks(today, 1), { weekStartsOn: 1 }) } },
    { label: 'Last month', range: { from: startOfMonth(subMonths(today, 1)), to: endOfMonth(subMonths(today, 1)) } },
    { label: 'Last 30 days', range: { from: subDays(today, 29), to: today } },
    { label: 'Last FY', range: { from: lastFyFrom, to: lastFyTo } },
  ];

  return (
    <div className="flex flex-col gap-0.5 p-2 border-r min-w-[132px]">
      <span className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Quick ranges</span>
      {presets.map((p) => (
        <Button
          key={p.label}
          variant="ghost"
          size="sm"
          className="h-7 justify-start px-2 text-xs font-normal"
          onClick={() => onSelect(p.range)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
}
