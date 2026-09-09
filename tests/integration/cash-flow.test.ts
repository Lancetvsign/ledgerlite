/**
 * Cash-Flow Statement (indirect) — LL-074. Against a real DB.
 *
 * The load-bearing assertion is reconciliation: net change in cash (net income + working-
 * capital / investing / financing adjustments) equals ending minus beginning cash. Also
 * checks the section splits, the Uncategorized bucket, and that a year-end close in the
 * period does not disturb the statement.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { postJournalEntry } from '@/server/ledger';
import { getCashFlowStatement } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { closeFiscalYear } from '@/server/year-end';
import { STANDARD_CHART } from '@/server/accounts/default-coa';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';
import { closeFiscalYearInput } from '@/validation/year-end';

import { truncateAll } from '../helpers/database';

const FROM = '2026-01-01';
const TO = '2026-12-31';
const D = '2026-06-30';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  salesId: string;
  rentId: string;
  receivableId: string;
  payableId: string;
  equipmentId: string;
  ownerId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `cf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'C' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'CF Co', timezone: 'America/Chicago' }), 'standard');
  const mk = (name: string, accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE', cashFlowCategory?: 'OPERATING' | 'INVESTING' | 'FINANCING' | 'CASH') =>
    createAccount(userId, company.id, createAccountInput.parse({ name, accountType, ...(cashFlowCategory ? { cashFlowCategory } : {}) }));
  const cash = await mk('Cash', 'ASSET', 'CASH');
  const sales = await mk('Sales', 'REVENUE');
  const rent = await mk('Rent', 'EXPENSE');
  const receivable = await mk('Other Receivable', 'ASSET', 'OPERATING');
  const payable = await mk('Other Payable', 'LIABILITY', 'OPERATING');
  const equipment = await mk('Equipment', 'ASSET', 'INVESTING');
  const owner = await mk('Owner Capital', 'EQUITY', 'FINANCING');
  return {
    userId, companyId: company.id,
    cashId: cash.id, salesId: sales.id, rentId: rent.id,
    receivableId: receivable.id, payableId: payable.id, equipmentId: equipment.id, ownerId: owner.id,
  };
}

function post(c: Ctx, lines: { accountId: string; debit?: string; credit?: string }[], date = D) {
  return postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: date, sourceType: 'JOURNAL_ENTRY', lines,
  }));
}

beforeEach(async () => {
  await truncateAll();
});

describe('the seeded chart carries cash-flow categories (LL-074)', () => {
  it('marks cash, operating, and financing accounts', () => {
    const byNumber = (n: string) => STANDARD_CHART.find((a) => a.accountNumber === n);
    expect(byNumber('1000')?.cashFlowCategory).toBe('CASH'); // Checking
    expect(byNumber('1100')?.cashFlowCategory).toBe('OPERATING'); // A/R
    expect(byNumber('2000')?.cashFlowCategory).toBe('OPERATING'); // A/P
    expect(byNumber('3100')?.cashFlowCategory).toBe('FINANCING'); // Owner Contributions
    expect(byNumber('4000')?.cashFlowCategory).toBeUndefined(); // Sales Revenue — income statement
  });
});

describe('getCashFlowStatement — reconciles net income to the change in cash', () => {
  it('splits operating / investing / financing and reconciles', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }]); // cash sale
    await post(c, [{ accountId: c.receivableId, debit: '500.00' }, { accountId: c.salesId, credit: '500.00' }]); // credit sale (Δ operating asset)
    await post(c, [{ accountId: c.rentId, debit: '300.00' }, { accountId: c.payableId, credit: '300.00' }]); // expense on credit (Δ operating liability)
    await post(c, [{ accountId: c.equipmentId, debit: '2000.00' }, { accountId: c.cashId, credit: '2000.00' }]); // equipment purchase (investing)
    await post(c, [{ accountId: c.cashId, debit: '5000.00' }, { accountId: c.ownerId, credit: '5000.00' }]); // owner contribution (financing)

    const cf = await getCashFlowStatement(c.userId, c.companyId, FROM, TO);

    expect(cf.netIncome).toBe('1200.0000'); // sales 1500 − rent 300
    // Operating = net income − Δ receivable (500) + Δ payable (300) = 1000.
    expect(cf.operatingTotal).toBe('1000.0000');
    expect(cf.operatingAdjustments.find((l) => l.accountId === c.receivableId)?.amount).toBe('-500.0000');
    expect(cf.operatingAdjustments.find((l) => l.accountId === c.payableId)?.amount).toBe('300.0000');
    expect(cf.investing.total).toBe('-2000.0000');
    expect(cf.financing.total).toBe('5000.0000');
    expect(cf.netChangeInCash).toBe('4000.0000');
    expect(cf.beginningCash).toBe('0.0000');
    expect(cf.endingCash).toBe('4000.0000');
    expect(cf.reconciled).toBe(true);
    expect(cf.uncategorized.rows).toHaveLength(0);
  });

  it('reports an uncategorized balance-sheet account in its own bucket and still reconciles', async () => {
    const c = await setup();
    const mystery = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Mystery Liability', accountType: 'LIABILITY' }));
    await post(c, [{ accountId: c.cashId, debit: '50.00' }, { accountId: mystery.id, credit: '50.00' }]);

    const cf = await getCashFlowStatement(c.userId, c.companyId, FROM, TO);
    expect(cf.uncategorized.rows.find((l) => l.accountId === mystery.id)?.amount).toBe('50.0000');
    expect(cf.netChangeInCash).toBe('50.0000');
    expect(cf.endingCash).toBe('50.0000');
    expect(cf.reconciled).toBe(true);
  });

  it('a year-end close in the period does not disturb the cash-flow statement', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '1000.00' }, { accountId: c.salesId, credit: '1000.00' }]);
    await post(c, [{ accountId: c.rentId, debit: '300.00' }, { accountId: c.cashId, credit: '300.00' }]);
    await closeFiscalYear(c.userId, c.companyId, closeFiscalYearInput.parse({ fiscalYearStart: FROM }));

    const cf = await getCashFlowStatement(c.userId, c.companyId, FROM, TO);
    // Closing touches revenue/expense/RE, never cash — the statement is unchanged.
    expect(cf.netIncome).toBe('700.0000'); // 1000 − 300, closing excluded
    expect(cf.netChangeInCash).toBe('700.0000');
    expect(cf.endingCash).toBe('700.0000');
    expect(cf.reconciled).toBe(true);
  });

  it('rejects a from date after the to date', async () => {
    const c = await setup();
    await expect(getCashFlowStatement(c.userId, c.companyId, TO, FROM)).rejects.toThrow(/on or before/i);
  });

  it('denies a non-member', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(getCashFlowStatement(outsider, c.companyId, FROM, TO)).rejects.toThrow();
  });
});
