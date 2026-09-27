import { describe, expect, it } from 'vitest';

import { amendImportLineInput } from '@/validation/bank-import';

describe('LL-107 amend input', () => {
  it('takes a signed money string up to four decimals, never zero, never a number', () => {
    expect(amendImportLineInput.parse({ amount: '-2000.00' }).amount).toBe('-2000.00');
    expect(amendImportLineInput.parse({ amount: '1500' }).amount).toBe('1500');
    expect(amendImportLineInput.parse({ amount: '0.0001' }).amount).toBe('0.0001');
    for (const bad of ['0', '0.00', '-0', '1,500.00', '12.34567', 'abc', '', '$5']) {
      expect(amendImportLineInput.safeParse({ amount: bad }).success, bad).toBe(false);
    }
    expect(amendImportLineInput.safeParse({ amount: 1500 }).success).toBe(false);
  });

  it('LL-112: a date and description are optional, under the extractor\'s rules', () => {
    expect(amendImportLineInput.parse({ amount: '-1.00' })).toEqual({ amount: '-1.00' });
    expect(amendImportLineInput.parse({ amount: '-1.00', txnDate: '2026-06-12', description: '  OFFICE DEPOT #4471 ' })).toEqual({
      amount: '-1.00', txnDate: '2026-06-12', description: 'OFFICE DEPOT #4471',
    });
    for (const bad of ['', '2026-13-01', '2026-02-30', '06/12/2026', 'yesterday']) {
      expect(amendImportLineInput.safeParse({ amount: '-1.00', txnDate: bad }).success, bad).toBe(false);
    }
    for (const bad of ['', '   ', 'x'.repeat(501)]) {
      expect(amendImportLineInput.safeParse({ amount: '-1.00', description: bad }).success, `${String(bad.length)} chars`).toBe(false);
    }
    expect(amendImportLineInput.parse({ amount: '-1.00', description: 'x'.repeat(500) }).description).toHaveLength(500);
  });
});
