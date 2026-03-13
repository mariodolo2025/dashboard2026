import { useState } from 'react';
import { format } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';

interface DateRange {
  from?: Date;
  to?: Date;
}

interface ModalDateRangePickerProps {
  dateRange?: DateRange;
  setDateRange?: (range: DateRange) => void;
  className?: string;
}

export default function ModalDateRangePicker({ dateRange, setDateRange, className }: ModalDateRangePickerProps) {
  const [open, setOpen] = useState(false);

  if (!setDateRange || !dateRange) return null;

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-1.5 text-xs font-normal",
            !dateRange?.from && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {dateRange?.from ? (
            dateRange.to ? (
              `${format(dateRange.from, "MMM d")} – ${format(dateRange.to, "MMM d")}`
            ) : (
              format(dateRange.from, "MMM d")
            )
          ) : (
            "Date range"
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" side="bottom">
        <Calendar
          initialFocus
          mode="range"
          defaultMonth={dateRange?.from}
          selected={dateRange as never}
          onSelect={(range) => setDateRange(range || {})}
          numberOfMonths={2}
          weekStartsOn={1}
        />
        <div className="p-2 border-t flex justify-end">
          <Button size="sm" onClick={() => setOpen(false)}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
