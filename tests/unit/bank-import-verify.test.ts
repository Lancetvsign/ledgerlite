import { describe, expect, it } from 'vitest';

import { summaryOf, verifyStatementTotals } from '@/server/bank-import/verify';

const LINES = ['1500.00', '-120.50', '-2000.00']; // credits 1500, debits 2120.50

describe('verifyStatementTotals (LL-109)', () => {
  it('verifies when the lines add up to the printed totals and the balance arithmetic holds', () => {
    const v = verifyStatementTotals(LINES, { beginningBalance: '5000.00', totalCredits: '1500', totalDebits: '2120.5', endingBalance: '4379.50' });
    expect(v.status).toBe('verified');
    expect(v.lineCredits).toBe('1500.0000');
    expect(v.lineDebits).toBe('2120.5000');
    expect(v.checks.map((c) => [c.name, c.ok, c.difference])).toEqual([
      ['credits', true, '0.0000'],
      ['debits', true, '0.0000'],
      ['ending_balance', true, '0.0000'],
    ]);
  });

  it('reports each failing check with the statement figure, the lines figure and the exact difference', () => {
    // The deposit misread as 1050: credits short by 450, so the ending balance is short by 450 too.
    const v = verifyStatementTotals(['1050.00', '-120.50', '-2000.00'], { beginningBalance: '5000.00', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '4379.50' });
    expect(v.status).toBe('mismatch');
    expect(v.checks.find((c) => c.name === 'credits')).toMatchObject({ expected: '1500.0000', actual: '1050.0000', difference: '-450.0000', ok: false });
    expect(v.checks.find((c) => c.name === 'debits')).toMatchObject({ ok: true });
    expect(v.checks.find((c) => c.name === 'ending_balance')).toMatchObject({ expected: '4379.5000', actual: '3929.5000', difference: '-450.0000', ok: false });
  });

  it('runs only the checks whose figures are printed; none printed → not stated, never a mismatch', () => {
    expect(verifyStatementTotals(LINES, null).status).toBe('not_stated');
    expect(verifyStatementTotals(LINES, {}).status).toBe('not_stated');
    const creditsOnly = verifyStatementTotals(LINES, { totalCredits: '1500.00' });
    expect(creditsOnly.status).toBe('verified');
    expect(creditsOnly.checks.map((c) => c.name)).toEqual(['credits']);
    // A beginning balance without an ending one (or vice versa) cannot be checked.
    expect(verifyStatementTotals(LINES, { beginningBalance: '5000.00' }).status).toBe('not_stated');
    expect(verifyStatementTotals(LINES, { endingBalance: '4379.50' }).status).toBe('not_stated');
  });

  it('serves a credit card in the same sign convention: a balance owed is negative', () => {
    // Previous balance owed 1,834.50; payment 2,000 (credit); charges 165.50 (debits); new balance 0.
    const v = verifyStatementTotals(['-120.50', '-45.00', '2000.00'], { beginningBalance: '-1834.50', totalCredits: '2000.00', totalDebits: '165.50', endingBalance: '0.00' });
    expect(v.status).toBe('verified');
  });

  it('is exact at four decimals and never holds money in a number', () => {
    const v = verifyStatementTotals(['0.1', '0.2'], { totalCredits: '0.3' });
    expect(v.status).toBe('verified'); // 0.1 + 0.2 = 0.3 in Decimal, not in floating point
    expect(typeof v.lineCredits).toBe('string');
    const off = verifyStatementTotals(['0.1', '0.2'], { totalCredits: '0.3001' });
    expect(off.checks[0]).toMatchObject({ ok: false, difference: '-0.0001' });
  });
});

describe('summaryOf', () => {
  it('turns a batch\'s stored figures into a summary, or null when none were stored', () => {
    expect(summaryOf({ statedBeginningBalance: null, statedTotalCredits: null, statedTotalDebits: null, statedEndingBalance: null })).toBeNull();
    expect(summaryOf({ statedBeginningBalance: '5000.0000', statedTotalCredits: '1500.0000', statedTotalDebits: null, statedEndingBalance: null })).toEqual({ beginningBalance: '5000.0000', totalCredits: '1500.0000' });
  });
});
