// =============================================================================
// RangeCalendar — a two-click date range picker that actually lets you pick
// =============================================================================
// react-day-picker's built-in range mode EXTENDS the existing selection instead
// of starting a new one. With a range already set — and every one of these
// pickers opens with one — clicking a day only ever moved the END date. The
// start looked frozen and unclickable, so a custom range was impossible: the
// only way to change the start was to pick a preset first.
//
// The fix is to hold a DRAFT while the popover is open and drive it explicitly:
//
//   click 1 -> always starts a fresh range (from = day, to = undefined)
//   click 2 -> closes it, ordering the pair so a backwards pick still works
//   click 3 -> starts fresh again
//
// The committed range is only touched on the second click, so a half-finished
// pick never refetches or leaks out to the rest of the dashboard.
//
// This lived inline in WebUpgradeTab while five other pickers kept the broken
// version. It is a component now so the behaviour cannot drift apart again.

import { useState } from 'react';
import { Calendar } from '@/components/ui/calendar';

// Two DateRange types are in play — the app's (both ends optional) and
// react-day-picker's (from required). This structural shape is assignable to
// either, so callers can keep whichever they already use.
type Range = { from?: Date; to?: Date };
/** A finished pick always has both ends. */
type CompleteRange = { from: Date; to: Date };

interface RangeCalendarProps {
  /** The committed range, shown when no pick is in progress. */
  value: Range | undefined;
  /** Called once, on the click that completes a range. */
  onChange: (range: CompleteRange) => void;
  /** Fired after a completed pick — used by callers that close on selection. */
  onComplete?: (range: CompleteRange) => void;
  numberOfMonths?: number;
}

export function RangeCalendar({
  value,
  onChange,
  onComplete,
  numberOfMonths = 2,
}: RangeCalendarProps) {
  const [draft, setDraft] = useState<Range | undefined>(undefined);

  return (
    <Calendar
      initialFocus
      mode="range"
      defaultMonth={value?.from}
      // While picking, show the draft: the user needs to see the new start they
      // just clicked, not the range they are replacing.
      selected={(draft ?? value) as never}
      onSelect={(_sel: unknown, day: Date) => {
        // `day` is the clicked date. The first argument is day-picker's own
        // idea of the new range, which is exactly the extend-only behaviour
        // being replaced, so it is ignored.
        if (!draft?.from || draft.to) {
          setDraft({ from: day, to: undefined });
          return;
        }
        const start = draft.from;
        const range: CompleteRange =
          day < start ? { from: day, to: start } : { from: start, to: day };
        setDraft(range);
        onChange(range);
        onComplete?.(range);
      }}
      numberOfMonths={numberOfMonths}
      weekStartsOn={1}
    />
  );
}

export default RangeCalendar;
