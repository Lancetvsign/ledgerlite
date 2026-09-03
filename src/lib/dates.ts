/**
 * Calendar-date helpers — ADR-005.
 *
 * Dates are 'YYYY-MM-DD' strings, never JS Date objects, so no timezone can
 * shift a boundary. These functions do pure string/calendar arithmetic and
 * never call `new Date()` on the current time.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Reject impossible days (e.g. 2026-02-30) by round-tripping through UTC.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** First calendar day of the month containing `date`. */
export function startOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${String(y)}-${pad(m)}-01`;
}

/** Last calendar day of the month containing `date`. */
export function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  // Day 0 of next month is the last day of this one (UTC, no local time).
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y)}-${pad(m)}-${pad(last)}`;
}

/**
 * Today's calendar date in a company's timezone, as 'YYYY-MM-DD' (ADR-005).
 *
 * This is the ONE place the current instant enters the date layer, and it does
 * so through the company's zone, never the server's. A reversal defaults its
 * date to the company's today (ADR-007), and "today" in Honolulu is not "today"
 * in Auckland — resolving it against the server clock would land a correction in
 * the wrong day, and near midnight the wrong month and period.
 *
 * `en-CA` formats as YYYY-MM-DD, but we assemble from parts rather than trust the
 * locale string, so a locale change can never reshape the output.
 */
export function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) throw new Error(`missing ${type} for timezone ${timeZone}`);
    return part.value;
  };
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The fiscal year a date belongs to, given the fiscal year's start month.
 * A fiscal year starting in month M runs M..(M+11). Returned as the START
 * month/year of that fiscal year — used only for labelling; monthly periods
 * themselves are plain calendar months, which is what postings resolve against.
 */
export function fiscalYearStart(date: string, fiscalStartMonth: number): { year: number; month: number } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  // If the calendar month is before the fiscal start, the fiscal year began the
  // previous calendar year.
  const year = m >= fiscalStartMonth ? y : y - 1;
  return { year, month: fiscalStartMonth };
}
