import { describe, expect, it } from 'vitest';

import { endOfMonth, fiscalYearStart, isCalendarDate, startOfMonth } from '@/lib/dates';

describe('isCalendarDate', () => {
  it.each(['2026-01-01', '2026-12-31', '2024-02-29'])('accepts %s', (d) => {
    expect(isCalendarDate(d)).toBe(true);
  });
  it.each(['2026-02-30', '2026-13-01', '2026-00-10', 'not-a-date', '2026-1-1', '2026-01-32'])(
    'rejects %s',
    (d) => {
      expect(isCalendarDate(d)).toBe(false);
    },
  );
});

describe('month boundaries', () => {
  it.each([
    ['2026-01-15', '2026-01-01', '2026-01-31'],
    ['2026-02-10', '2026-02-01', '2026-02-28'],
    ['2024-02-10', '2024-02-01', '2024-02-29'], // leap year
    ['2026-12-25', '2026-12-01', '2026-12-31'],
  ])('for %s → [%s, %s]', (date, start, end) => {
    expect(startOfMonth(date)).toBe(start);
    expect(endOfMonth(date)).toBe(end);
  });
});

describe('fiscalYearStart', () => {
  it('January fiscal start: calendar year is the fiscal year', () => {
    expect(fiscalYearStart('2026-06-15', 1)).toEqual({ year: 2026, month: 1 });
  });
  it('July fiscal start: a June date belongs to the PRIOR fiscal year', () => {
    // FY starting July 2025 runs Jul 2025 .. Jun 2026, so June 2026 is FY2025.
    expect(fiscalYearStart('2026-06-15', 7)).toEqual({ year: 2025, month: 7 });
  });
  it('July fiscal start: a July date starts the new fiscal year', () => {
    expect(fiscalYearStart('2026-07-01', 7)).toEqual({ year: 2026, month: 7 });
  });
});
