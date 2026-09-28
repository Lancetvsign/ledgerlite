import { describe, expect, it } from 'vitest';

import { assembleRows, consolidationKey, numbersSharedAcrossTypes, type AmountedAccount } from '@/server/reports/consolidation-rows';

/** LL-122 (ADR-047): how member companies' accounts line up as one consolidated row. */
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const members = [{ id: A, legalName: 'Alpha Co' }, { id: B, legalName: 'Beta Co' }];
const acct = (over: Partial<AmountedAccount> & Pick<AmountedAccount, 'companyId' | 'accountId'>): AmountedAccount => ({
  accountNumber: null, accountName: 'X', accountType: 'ASSET', systemAccountType: null, amount: '0.0000', ...over,
});

describe('consolidationKey', () => {
  it('a system role wins over the number; pair accounts are left for elimination', () => {
    expect(consolidationKey(acct({ companyId: A, accountId: '1', accountNumber: '1150', systemAccountType: 'ACCOUNTS_RECEIVABLE' }))).toBe('role:ACCOUNTS_RECEIVABLE');
    expect(consolidationKey(acct({ companyId: A, accountId: '1', accountNumber: '1300', systemAccountType: 'INTERCOMPANY_RECEIVABLE' }))).toBeNull();
    expect(consolidationKey(acct({ companyId: A, accountId: '1', accountNumber: '2300', accountType: 'LIABILITY', systemAccountType: 'INTERCOMPANY_PAYABLE' }))).toBeNull();
  });
  it('by number and type; an unnumbered account per company', () => {
    expect(consolidationKey(acct({ companyId: A, accountId: '1', accountNumber: ' 1000 ' }))).toBe('num:1000:ASSET');
    expect(consolidationKey(acct({ companyId: A, accountId: '1', accountNumber: '1000', accountType: 'EXPENSE' }))).toBe('num:1000:EXPENSE');
    expect(consolidationKey(acct({ companyId: A, accountId: 'x1', accountNumber: '  ' }))).toBe(`acct:${A}:x1`);
  });
});

describe('assembleRows', () => {
  it('combines by key with a column per company, labels from the active company, lists differing names', () => {
    const rows = assembleRows([
      acct({ companyId: B, accountId: 'b1', accountNumber: '1000', accountName: 'Operating account', amount: '100.0000' }),
      acct({ companyId: A, accountId: 'a1', accountNumber: '1000', accountName: 'Checking', amount: '250.5000' }),
      acct({ companyId: B, accountId: 'b2', accountNumber: '1150', accountName: 'Receivables', systemAccountType: 'ACCOUNTS_RECEIVABLE', amount: '10.0000' }),
      acct({ companyId: A, accountId: 'a2', accountNumber: '1100', accountName: 'Accounts Receivable', systemAccountType: 'ACCOUNTS_RECEIVABLE', amount: '5.0000' }),
      acct({ companyId: A, accountId: 'a9', accountNumber: '1300', systemAccountType: 'INTERCOMPANY_RECEIVABLE', amount: '99.0000' }),
    ], members, A);
    expect(rows.map((r) => r.key)).toEqual(['num:1000:ASSET', 'role:ACCOUNTS_RECEIVABLE']);
    expect(rows[0]).toMatchObject({ label: 'Checking', accountNumber: '1000', names: ['Checking', 'Operating account'], byCompany: { [A]: '250.5000', [B]: '100.0000' }, total: '350.5000', elimination: '0.0000', drillAccountId: 'a1' });
    expect(rows[1]).toMatchObject({ label: 'Accounts Receivable', accountNumber: '1100', total: '15.0000', drillAccountId: 'a2' });
  });
  it('an unnumbered account names its company and comes last; a row without the active company does not drill', () => {
    const rows = assembleRows([
      acct({ companyId: B, accountId: 'b3', accountName: 'Petty cash', amount: '7.0000' }),
      acct({ companyId: A, accountId: 'a3', accountName: 'Petty cash', amount: '5.0000' }),
      acct({ companyId: B, accountId: 'b4', accountNumber: '1010', accountName: 'Savings', amount: '1.0000' }),
    ], members, A);
    expect(rows.map((r) => [r.label, r.total, r.drillAccountId])).toEqual([
      ['Savings', '1.0000', null],
      ['Petty cash (Alpha Co)', '5.0000', 'a3'],
      ['Petty cash (Beta Co)', '7.0000', null],
    ]);
  });
  it('flags a number the charts use for another type', () => {
    const shared = numbersSharedAcrossTypes([
      { accountNumber: '6990', accountType: 'ASSET', systemAccountType: null },
      { accountNumber: '6990', accountType: 'EXPENSE', systemAccountType: null },
      { accountNumber: '1000', accountType: 'ASSET', systemAccountType: null },
      { accountNumber: '1000', accountType: 'ASSET', systemAccountType: null },
      { accountNumber: '1300', accountType: 'ASSET', systemAccountType: 'INTERCOMPANY_RECEIVABLE' },
      { accountNumber: '1300', accountType: 'EXPENSE', systemAccountType: null },
    ]);
    expect([...shared]).toEqual(['6990']);
    const rows = assembleRows([acct({ companyId: A, accountId: 'a5', accountNumber: '6990', amount: '10.0000' })], members, A, shared);
    expect(rows[0]!.numberSharedAcrossTypes).toBe(true);
  });
});
