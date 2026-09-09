/**
 * Financial statements — LL-072. Balance Sheet + Income Statement, derived entirely from
 * journal_lines, against a real DB.
 *
 * The load-bearing assertions: the Income Statement's Revenue − COGS − Expenses = Net
 * income, the Balance Sheet's Assets = Liabilities + Equity (with net income derived into
 * equity because close posts no entry), and that the Balance Sheet's current-year net
 * income equals the Income Statement's net income for the fiscal year.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { postJournalEntry } from '@/server/ledger';
import { getBalanceSheet, getIncomeStatement } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';

import { truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  salesId: string;
  cogsId: string;
  rentId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'F' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'FS Co', timezone: 'America/Chicago' }), 'standard');
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales', accountType: 'REVENUE' }));
  const cogs = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cost of Sales', accountType: 'COGS' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, salesId: sales.id, cogsId: cogs.id, rentId: rent.id };
}

function post(c: Ctx, lines: { accountId: string; debit?: string; credit?: string }[], date = '2026-01-10') {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: date, sourceType: 'JOURNAL_ENTRY', lines,
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
});

describe('Income Statement — Revenue − COGS − Expenses = Net income', () => {
  it('groups accounts and computes the subtotals over the period', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }]);
    await post(c, [{ accountId: c.cogsId, debit: '300.00' }, { accountId: c.cashId, credit: '300.00' }]);
    await post(c, [{ accountId: c.rentId, debit: '200.00' }, { accountId: c.cashId, credit: '200.00' }]);

    const is = await getIncomeStatement(c.userId, c.companyId, '2026-01-01', '2026-12-31');
    expect(is.revenue.total).toBe('1000.0000');
    expect(is.cogs.total).toBe('300.0000');
    expect(is.grossProfit).toBe('700.0000');
    expect(is.expenses.total).toBe('200.0000');
    expect(is.netIncome).toBe('500.0000');
    expect(is.revenue.rows.find((r) => r.accountId === c.salesId)?.amount).toBe('1000.0000');
  });

  it('excludes activity outside the period', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }], '2025-06-30');
    const is = await getIncomeStatement(c.userId, c.companyId, '2026-01-01', '2026-12-31');
    expect(is.revenue.total).toBe('0.0000'); // the 2025 sale is out of range
    expect(is.netIncome).toBe('0.0000');
  });

  it('rejects a from date after the to date', async () => {
    const c = await setup();
    await expect(getIncomeStatement(c.userId, c.companyId, '2026-12-31', '2026-01-01')).rejects.toThrow(/on or before/i);
  });
});

describe('Balance Sheet — Assets = Liabilities + Equity, net income derived into equity', () => {
  it('balances with current-year net income in equity', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }]);
    await post(c, [{ accountId: c.cogsId, debit: '300.00' }, { accountId: c.cashId, credit: '300.00' }]);
    await post(c, [{ accountId: c.rentId, debit: '200.00' }, { accountId: c.cashId, credit: '200.00' }]);

    const bs = await getBalanceSheet(c.userId, c.companyId, '2026-12-31');
    expect(bs.assets.total).toBe('500.0000'); // cash 1000 − 300 − 200
    expect(bs.liabilities.total).toBe('0.0000');
    expect(bs.equity.priorRetainedEarnings).toBe('0.0000');
    expect(bs.equity.currentNetIncome).toBe('500.0000');
    expect(bs.equity.total).toBe('500.0000');
    expect(bs.liabilitiesAndEquityTotal).toBe('500.0000');
    expect(bs.balanced).toBe(true);

    // Cross-check: the Balance Sheet's current-year net income equals the Income
    // Statement's net income for the fiscal year through the as-of date.
    const is = await getIncomeStatement(c.userId, c.companyId, bs.fiscalYearStart, '2026-12-31');
    expect(bs.equity.currentNetIncome).toBe(is.netIncome);
  });

  it('splits prior retained earnings from current-year net income at the fiscal-year start', async () => {
    const c = await setup(); // fiscalYearStartMonth defaults to 1 → fiscal year = calendar year
    await post(c, [{ accountId: c.cashId, debit: '400.00' }, { accountId: c.salesId, credit: '400.00' }], '2025-06-30');
    await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }], '2026-03-15');

    const bs = await getBalanceSheet(c.userId, c.companyId, '2026-12-31');
    expect(bs.fiscalYearStart).toBe('2026-01-01');
    expect(bs.equity.priorRetainedEarnings).toBe('400.0000'); // the 2025 net income
    expect(bs.equity.currentNetIncome).toBe('1000.0000'); // the 2026 net income
    expect(bs.assets.total).toBe('1400.0000');
    expect(bs.balanced).toBe(true);
  });

  it('an empty company balances at zero', async () => {
    const c = await setup();
    const bs = await getBalanceSheet(c.userId, c.companyId, '2026-12-31');
    expect(bs.assets.total).toBe('0.0000');
    expect(bs.equity.total).toBe('0.0000');
    expect(bs.balanced).toBe(true);
  });
});

describe('authorization', () => {
  it('denies a non-member (report.view fails closed)', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(getBalanceSheet(outsider, c.companyId, '2026-12-31')).rejects.toThrow();
    await expect(getIncomeStatement(outsider, c.companyId, '2026-01-01', '2026-12-31')).rejects.toThrow();
  });
});
