import { describe, expect, it } from 'vitest';

import { moneyValuesIn, readSummaryFigures, roleFromLabel } from '@/server/bank-import/summary-figures';

/**
 * LL-123: summary figures are read by their printed labels. The owner's statement_05312025.pdf:
 * Previous Balance 3,814.15 · Total Deposits 9,800.00 · Total Checks and Debits 9,554.08 ·
 * Balance This Statement 4,087.07 — which the model had stored as credits 3,814.15, debits 4,087.07,
 * ending 9,554.08. The four figures leave 27.00 unexplained, i.e. another money-in line.
 */
const OWNER_TEXT = `ACCOUNT SUMMARY  Previous Balance $3,814.15  Total Deposits 9,800.00  Total Checks and Debits 9,554.08
Other Credits 27.00  Balance This Statement $4,087.07  05/01 DEPOSIT 2,500.00 ...`;

describe('roleFromLabel', () => {
  it('reads balances and totals from their labels', () => {
    expect(roleFromLabel('Previous Balance')).toBe('beginning');
    expect(roleFromLabel('Beginning balance on May 1')).toBe('beginning');
    expect(roleFromLabel('Balance Forward')).toBe('beginning');
    expect(roleFromLabel('Balance This Statement')).toBe('ending');
    expect(roleFromLabel('New Balance')).toBe('ending');
    expect(roleFromLabel('Ending balance on May 31')).toBe('ending');
    expect(roleFromLabel('Total Deposits')).toBe('money_in');
    expect(roleFromLabel('Deposits and other credits')).toBe('money_in');
    expect(roleFromLabel('Interest Paid')).toBe('money_in');
    expect(roleFromLabel('Payments, Credits')).toBe('money_in');
    expect(roleFromLabel('Total Checks and Debits')).toBe('money_out');
    expect(roleFromLabel('ATM & Debit Card Withdrawals')).toBe('money_out');
    expect(roleFromLabel('Service Fees')).toBe('money_out');
    expect(roleFromLabel('Interest Charged')).toBe('money_out');
  });
  it('leaves an ambiguous label to the model', () => {
    expect(roleFromLabel('Credits and debits')).toBeNull();
    expect(roleFromLabel('Account balance')).toBeNull();
    expect(roleFromLabel('Adjustments')).toBeNull();
  });
});

describe('readSummaryFigures', () => {
  it('the owner\'s statement: the labels override the model\'s swapped roles; with Other Credits the math ties', () => {
    const { summary, figures } = readSummaryFigures([
      { label: 'Previous Balance', amount: '3,814.15', role: 'money_in' },
      { label: 'Total Deposits', amount: '9,800.00', role: 'beginning' },
      { label: 'Total Checks and Debits', amount: '9,554.08', role: 'ending' },
      { label: 'Other Credits', amount: '27.00', role: 'money_in' },
      { label: 'Balance This Statement', amount: '$4,087.07', role: 'money_out' },
    ], OWNER_TEXT, 'bank');
    expect(summary).toEqual({ beginningBalance: '3814.1500', totalCredits: '9827.0000', totalDebits: '9554.0800', endingBalance: '4087.0700' });
    expect(figures.map((f) => [f.label, f.role, f.source, f.found])).toEqual([
      ['Previous Balance', 'beginning', 'label', true],
      ['Total Deposits', 'money_in', 'label', true],
      ['Total Checks and Debits', 'money_out', 'label', true],
      ['Other Credits', 'money_in', 'label', true],
      ['Balance This Statement', 'ending', 'label', true],
    ]);
  });

  it('a figure not on the statement (computed or invented) is not found and not counted', () => {
    const { summary, figures } = readSummaryFigures([
      { label: 'Previous Balance', amount: '3,814.15' },
      { label: 'Total Deposits', amount: '9,827.00' }, // the model's own sum — not printed
      { label: 'Total Withdrawals', amount: '9,554.08' }, // amount printed, label not
    ], OWNER_TEXT, 'bank');
    expect(figures.map((f) => f.found)).toEqual([true, false, false]);
    expect(summary).toEqual({ beginningBalance: '3814.1500' });
  });

  it('an ambiguous label keeps the model\'s role', () => {
    const { summary, figures } = readSummaryFigures([{ label: 'Adjustments', amount: '12.00', role: 'money_out' }], 'Adjustments 12.00', 'bank');
    expect(figures[0]).toMatchObject({ role: 'money_out', source: 'model', found: true });
    expect(summary).toEqual({ totalDebits: '12.0000' });
  });

  it('a card statement: the balance owed is made negative by the app; a credit balance stays positive', () => {
    const text = 'Previous Balance 1,200.00 Payments, Credits 1,200.00 Purchases 345.67 New Balance 345.67';
    const { summary } = readSummaryFigures([
      { label: 'Previous Balance', amount: '1,200.00' },
      { label: 'Payments, Credits', amount: '1,200.00' },
      { label: 'Purchases', amount: '345.67' },
      { label: 'New Balance', amount: '345.67' },
    ], text, 'credit_card');
    expect(summary).toEqual({ beginningBalance: '-1200.0000', totalCredits: '1200.0000', totalDebits: '345.6700', endingBalance: '-345.6700' });
    expect(readSummaryFigures([{ label: 'New Balance', amount: '50.00 CR' }], 'New Balance 50.00 CR', 'credit_card').summary).toEqual({ endingBalance: '50.0000' });
  });

  it('finds the printed forms of an amount', () => {
    const values = moneyValuesIn('A $1,234.56 B (98.10) C 7.00 CR D 1,000,000.00 E 42');
    for (const v of ['1234.5600', '98.1000', '7.0000', '1000000.0000']) expect(values.has(v), v).toBe(true);
    expect(values.has('42.0000')).toBe(false); // a bare integer is not a money figure (page numbers, dates)
    expect(readSummaryFigures([{ label: 'Service Fees', amount: '(98.10)' }], 'Service Fees (98.10)', 'bank').summary).toEqual({ totalDebits: '98.1000' });
  });
});
