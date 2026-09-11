/**
 * Model-output normalisation — LL-076 hardening. Common money/date notations become the
 * canonical strings the strict validator accepts; anything unrecognised passes through
 * unchanged so the validator still rejects it. Money stays a string throughout (ADR-004).
 */
import { describe, expect, it } from 'vitest';

import { normalizeAmount, normalizeDate, normalizeExtractedRow } from '@/server/bank-import/normalize';
import { extractedTransactionSchema } from '@/validation/bank-import';

describe('normalizeAmount', () => {
  it.each([
    ['1500.00', '1500.00'],
    ['-120.50', '-120.50'],
    ['$1,500.00', '1500.00'],
    ['-$120.50', '-120.50'],
    ['$-120.50', '-120.50'],
    ['(120.50)', '-120.50'],
    ['($1,200.00)', '-1200.00'],
    ['120.50-', '-120.50'],
    ['+40', '40'],
    ['1,500.00 CR', '1500.00'],
    ['120.50 DR', '-120.50'],
    ['  2,000  ', '2000'],
    ['€99.9', '99.9'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAmount(input)).toBe(expected);
    expect(extractedTransactionSchema.shape.amount.safeParse(expected).success).toBe(true);
  });

  it('leaves unrecognised shapes untouched so the validator rejects them', () => {
    for (const bad of ['', 'abc', '1.2.3', '12.34567', '1 500,00', 'N/A']) {
      expect(normalizeAmount(bad)).toBe(bad);
      expect(extractedTransactionSchema.shape.amount.safeParse(normalizeAmount(bad)).success).toBe(false);
    }
  });
});

describe('normalizeDate', () => {
  it.each([
    ['2026-06-03', '2026-06-03'],
    ['06/03/2026', '2026-06-03'],
    ['6/3/2026', '2026-06-03'],
    ['6-3-2026', '2026-06-03'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it('passes through what it cannot interpret', () => {
    expect(normalizeDate('June 3')).toBe('June 3');
    expect(normalizeDate('03/06/26')).toBe('03/06/26');
  });
});

describe('normalizeExtractedRow', () => {
  it('produces a row the strict validator accepts from typical model output', () => {
    const row = normalizeExtractedRow({ date: '06/03/2026', description: '  OFFICE DEPOT #1234 ', amount: '($120.50)', category: ' Office Supplies ' });
    expect(row).toEqual({ date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50', category: 'Office Supplies' });
    expect(extractedTransactionSchema.safeParse(row).success).toBe(true);
  });
});
