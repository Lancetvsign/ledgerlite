/**
 * Year-end closing entries — LL-073. Against a real DB.
 *
 * The load-bearing assertions: a close zeroes the fiscal year's P&L accounts into Retained
 * Earnings; the Balance Sheet equity TOTAL is unchanged by closing (the amount moves from
 * derived current-year net income into the RE account); the Income Statement for a
 * closed — or reopened — year still reports its REAL revenue/expense (closing entries and
 * their reversals excluded); and set-once / reopen behave.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { getBalanceSheet, getIncomeStatement, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { closeFiscalYear, reopenFiscalYear, YearEndError } from '@/server/year-end';
import { postJournalEntry } from '@/server/ledger';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';
import { closeFiscalYearInput, reopenFiscalYearInput } from '@/validation/year-end';

import { getTestDb, truncateAll } from '../helpers/database';

const FY = '2025-01-01'; // fiscalYearStartMonth defaults to 1 → fiscal year = calendar 2025
const YE = '2025-12-31';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  salesId: string;
  rentId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `ye-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'Y' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'YE Co', timezone: 'America/Chicago' }), 'standard');
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales', accountType: 'REVENUE' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, salesId: sales.id, rentId: rent.id };
}

function post(c: Ctx, lines: { accountId: string; debit?: string; credit?: string }[], date: string) {
  return postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: date, sourceType: 'JOURNAL_ENTRY', lines,
  }));
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`)).rows[0]!.id;
}

async function tbBalance(c: Ctx, accountId: string, asOf: string): Promise<string> {
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}

const errOf = async (p: Promise<unknown>): Promise<YearEndError> => {
  try {
    await p;
    throw new Error('expected YearEndError');
  } catch (e) {
    expect(e).toBeInstanceOf(YearEndError);
    return e as YearEndError;
  }
};

/** A year with $1000 revenue and $300 expense → net income $700. */
async function postYearActivity(c: Ctx): Promise<void> {
  await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }], '2025-06-30');
  await post(c, [{ accountId: c.rentId, debit: '300.00' }, { accountId: c.cashId, credit: '300.00' }], '2025-06-30');
}

beforeEach(async () => {
  await truncateAll();
});

describe('closeFiscalYear — zeroes P&L into Retained Earnings', () => {
  it('moves net income to RE, leaves the balance sheet equity total unchanged, keeps the P&L report real', async () => {
    const c = await setup();
    await postYearActivity(c);
    const reId = await sysAccount(c.companyId, 'RETAINED_EARNINGS');

    const equityBefore = (await getBalanceSheet(c.userId, c.companyId, YE)).equity.total;

    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY }));

    // P&L accounts are zeroed as of year-end; Retained Earnings carries the $700.
    expect(await tbBalance(c, c.salesId, YE)).toBe('0.0000');
    expect(await tbBalance(c, c.rentId, YE)).toBe('0.0000');
    expect(await tbBalance(c, reId, YE)).toBe('700.0000');

    // The Balance Sheet still balances and its equity TOTAL is unchanged — the amount
    // moved from derived current-year net income into the RE account row.
    const bs = await getBalanceSheet(c.userId, c.companyId, YE);
    expect(bs.balanced).toBe(true);
    expect(bs.equity.total).toBe(equityBefore);
    expect(bs.equity.currentNetIncome).toBe('0.0000'); // no longer derived — it's in RE now
    expect(bs.equity.accountRows.find((r) => r.accountId === reId)?.balance).toBe('700.0000');

    // The Income Statement for the closed year STILL shows the real figures.
    const is = await getIncomeStatement(c.userId, c.companyId, FY, YE);
    expect(is.revenue.total).toBe('1000.0000');
    expect(is.expenses.total).toBe('300.0000');
    expect(is.netIncome).toBe('700.0000');
  });

  it('a net loss debits Retained Earnings', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '100.00' }, { accountId: c.salesId, credit: '100.00' }], '2025-06-30');
    await post(c, [{ accountId: c.rentId, debit: '400.00' }, { accountId: c.cashId, credit: '400.00' }], '2025-06-30');
    const reId = await sysAccount(c.companyId, 'RETAINED_EARNINGS');

    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY }));
    // RE is EQUITY (credit-natural); a $300 net loss is a debit → negative natural balance.
    expect(await tbBalance(c, reId, YE)).toBe('-300.0000');
  });

  it('rejects a year with no P&L activity (NOTHING_TO_CLOSE)', async () => {
    const c = await setup();
    const err = await errOf(closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY })));
    expect(err.code).toBe('NOTHING_TO_CLOSE');
  });

  it('is set-once per fiscal year', async () => {
    const c = await setup();
    await postYearActivity(c);
    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY }));
    const err = await errOf(closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY })));
    expect(err.code).toBe('YEAR_ALREADY_CLOSED');
  });

  it('normalises any in-year date to the same fiscal year', async () => {
    const c = await setup();
    await postYearActivity(c);
    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: '2025-07-15' }));
    // A second close of the same year via its start date is still a duplicate.
    const err = await errOf(closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY })));
    expect(err.code).toBe('YEAR_ALREADY_CLOSED');
  });
});

describe('reopenFiscalYear — reverses the closing entry', () => {
  it('reopening restores derived earnings and allows a re-close; the P&L report stays real', async () => {
    const c = await setup();
    await postYearActivity(c);
    const reId = await sysAccount(c.companyId, 'RETAINED_EARNINGS');
    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY }));

    // Default reopen — reverses AT the fiscal-year end (the closing entry's own period),
    // so closing and reversal cancel at the year-end snapshot and a re-close is correct.
    await reopenFiscalYear(c.userId, c.companyId, reopenFiscalYearInput.parse({ fiscalYearStart: FY }));

    // Closing entry + its reversal cancel → RE back to zero, P&L accounts restored.
    expect(await tbBalance(c, reId, YE)).toBe('0.0000');
    expect(await tbBalance(c, c.salesId, YE)).toBe('1000.0000');

    // The Income Statement excludes BOTH the closing and its reversal → still real.
    const is = await getIncomeStatement(c.userId, c.companyId, FY, YE);
    expect(is.revenue.total).toBe('1000.0000');
    expect(is.netIncome).toBe('700.0000');

    // The balance sheet is back to deriving current-year net income, and still balances.
    const bs = await getBalanceSheet(c.userId, c.companyId, YE);
    expect(bs.balanced).toBe(true);
    expect(bs.equity.currentNetIncome).toBe('700.0000');

    // Re-close is allowed once reopened.
    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY }));
    expect(await tbBalance(c, reId, YE)).toBe('700.0000');
  });

  it('reopening a year that is not closed fails', async () => {
    const c = await setup();
    const err = await errOf(reopenFiscalYear(c.userId, c.companyId, reopenFiscalYearInput.parse({ fiscalYearStart: FY })));
    expect(err.code).toBe('YEAR_NOT_CLOSED');
  });
});

describe('authorization', () => {
  it('denies a non-member (period.close fails closed)', async () => {
    const c = await setup();
    await postYearActivity(c);
    const outsider = await makeUser();
    await expect(closeFiscalYear(outsider, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FY }))).rejects.toThrow();
  });
});
