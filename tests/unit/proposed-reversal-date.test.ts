import { describe, expect, it } from 'vitest';

import { proposedReversalDate } from '@/server/periods';

/** LL-116 / LL-119: a correction is proposed in the period of the mistake while that period is open. */
describe('proposedReversalDate', () => {
  const today = '2026-09-28';
  it('proposes the entry\'s own date while its period is open', () => {
    expect(proposedReversalDate('2026-02-10', today, new Set())).toBe('2026-02-10');
    expect(proposedReversalDate(today, today, new Set())).toBe(today);
  });
  it('proposes today when the entry\'s period is closed', () => {
    expect(proposedReversalDate('2026-02-10', today, new Set(['2026-02-10']))).toBe(today);
  });
  it('LL-121: a future-dated entry proposes its own date — a reversal is never dated before its original', () => {
    expect(proposedReversalDate('2026-10-01', today, new Set())).toBe('2026-10-01');
    expect(proposedReversalDate('2026-10-01', today, new Set(['2026-10-01']))).toBe('2026-10-01');
  });
});
