// =============================================================================
// Store calendar dates
// =============================================================================
// Every date this dashboard sends to the database is a calendar day in the
// STORE's timezone, because that is what the data means: Shopify writes
// order_date in store time and reports its analytics in store time.
//
// Two ways of deriving "today" from the browser were in use, and both are wrong
// somewhere:
//
//   new Date().toISOString().slice(0,10)   -> the UTC day. Brisbane is UTC+10,
//       so between midnight and 10am the dashboard asked for the previous day.
//       That is what made the B2C explorer show 1 Aug beside Shopify's 2 Aug.
//
//   format(new Date(), 'yyyy-MM-dd')       -> the BROWSER's day. Correct only
//       while the browser happens to sit in store time; wrong on a laptop that
//       travelled, or for anyone reading the dashboard from another country.
//
// Resolving the store's timezone explicitly removes both failure modes.

const STORE_TZ = 'Australia/Brisbane';

// 'en-CA' formats as YYYY-MM-DD, which is the shape the API wants.
const storeDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's calendar date in the store's timezone, as YYYY-MM-DD. */
export function storeToday(): string {
  return storeDateFmt.format(new Date());
}

/** The calendar date of an instant in the store's timezone, as YYYY-MM-DD. */
export function storeDateOf(d: Date): string {
  return storeDateFmt.format(d);
}

/** YYYY-MM-DD of a Date that represents UTC midnight. */
export const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * A calendar date as a Date pinned to UTC midnight.
 *
 * Day arithmetic runs on this rather than on a local Date so that adding or
 * subtracting days is plain counting: no offset, DST change or hour-of-day can
 * push a result onto the neighbouring day.
 */
export function storeDay(date: string = storeToday()): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** n days from today in store time (negative for the past), as YYYY-MM-DD. */
export function shiftDays(n: number): string {
  const d = storeDay();
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** Monday-to-Sunday of the week before the current one, in store time. */
export function lastWeek(): { from: string; to: string } {
  const now = storeDay();
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
  const thisMonday = new Date(now);
  thisMonday.setUTCDate(now.getUTCDate() - dow);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setUTCDate(thisMonday.getUTCDate() - 1);
  return { from: ymd(lastMonday), to: ymd(lastSunday) };
}

/** Yesterday in store time, as a single-day range. */
export function yesterday(): { from: string; to: string } {
  const d = shiftDays(-1);
  return { from: d, to: d };
}

/**
 * The date presets shared by every surface that picks a sales window, so
 * "Last week" means the same thing in the B2C explorer and the Web Upgrade
 * panel. `from`/`to` are inclusive.
 */
export const STORE_DATE_PRESETS: {
  label: string;
  range: () => { from: string; to: string };
}[] = [
  { label: 'Yesterday', range: yesterday },
  { label: 'Last week', range: lastWeek },
  { label: '30 days', range: () => ({ from: shiftDays(-29), to: storeToday() }) },
  { label: '90 days', range: () => ({ from: shiftDays(-89), to: storeToday() }) },
  { label: '12 months', range: () => ({ from: shiftDays(-364), to: storeToday() }) },
];
