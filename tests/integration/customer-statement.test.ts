/**
 * Customer statement — LL-054. Against a real database.
 *
 * One customer's A/R over a period: opening balance, the activity that moved it,
 * and the closing balance — all derived from the customer-tagged A/R journal lines
 * (no stored balance, invariant 2). The decisive property is reconciliation: a
 * customer's closing balance is that customer's slice of the GL A/R control as of
 * `toDate`, and the sum over all customers equals the control (GL-T021 states this
 * at the release gate; here we prove the mechanics — ordering, running balance,
 * reversal netting, company scoping, decimal exactness).
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { toMoney } from '@/lib/decimal';
import { AuthorizationDenied } from '@/server/authorization';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { issueCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { receivePayment } from '@/server/payments';
import { getCustomerStatement, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput } from '@/validation/payment';
import { writeOffInvoiceInput } from '@/validation/writeoff';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  cashId: string;
  badDebtId: string;
  returnsId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `stmt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'S',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Statement Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  const returns = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
  return {
    userId, companyId: company.id, customerId: customer.id,
    revId: rev.id, cashId: cash.id, badDebtId: badDebt.id, returnsId: returns.id,
  };
}

/** Create + finalize an OPEN invoice for `price`, dated `invoiceDate`. Returns its id. */
async function openInvoice(c: Ctx, price: string, invoiceDate: string, customerId = c.customerId): Promise<string> {
  const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
    customerId, invoiceDate, lines: [{ accountId: c.revId, unitPrice: price }],
  }));
  await finalizeInvoice(c.userId, c.companyId, invoice.id);
  return invoice.id;
}

/** The GL A/R control balance as of a date (from the derived trial balance). */
async function arControlBalance(c: Ctx, asOf: string): Promise<string> {
  const db = await getTestDb();
  const arId = (await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_RECEIVABLE' limit 1`,
  )).rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
}

beforeEach(async () => {
  await truncateAll();
});

describe('getCustomerStatement — opening, activity, closing', () => {
  it('carries an opening balance and a running balance over every A/R event', async () => {
    const c = await setup();
    // Pre-period: a January invoice establishes the Feb-01 opening balance.
    const janInv = await openInvoice(c, '100.00', '2026-01-10');
    // In-period activity across all four A/R-moving document types.
    const febInv = await openInvoice(c, '200.00', '2026-02-05'); // +200 (INVOICE)
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-02-10', depositAccountId: c.cashId,
      applications: [{ invoiceId: janInv, amountApplied: '50.00' }],
    })); // −50 (CUSTOMER_PAYMENT) applied to the January invoice
    await writeOffInvoice(c.userId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: febInv, expenseAccountId: c.badDebtId, writeoffDate: '2026-02-15', amount: '30.00',
    })); // −30 (BAD_DEBT_WRITEOFF) on the February invoice
    await issueCreditMemo(c.userId, c.companyId, issueCreditMemoInput.parse({
      invoiceId: febInv, revenueAccountId: c.returnsId, creditDate: '2026-02-20', amount: '20.00',
    })); // −20 (CREDIT_MEMO) on the February invoice

    const stmt = (await getCustomerStatement(c.userId, c.companyId, c.customerId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.openingBalance).toBe('100.0000'); // the January invoice
    expect(stmt.lines.map((l) => [l.date, l.sourceType, l.charge, l.credit, l.balance])).toEqual([
      ['2026-02-05', 'INVOICE', '200.0000', '0.0000', '300.0000'],
      ['2026-02-10', 'CUSTOMER_PAYMENT', '0.0000', '50.0000', '250.0000'],
      ['2026-02-15', 'BAD_DEBT_WRITEOFF', '0.0000', '30.0000', '220.0000'],
      ['2026-02-20', 'CREDIT_MEMO', '0.0000', '20.0000', '200.0000'],
    ]);
    expect(stmt.closingBalance).toBe('200.0000');
    // Closing == this customer's A/R contribution as of toDate (the only customer here).
    expect(stmt.closingBalance).toBe(await arControlBalance(c, '2026-02-28'));
  });

  it('excludes activity outside the window but reflects it in opening/closing', async () => {
    const c = await setup();
    await openInvoice(c, '100.00', '2026-01-10'); // before window
    await openInvoice(c, '40.00', '2026-02-10'); // inside window
    await openInvoice(c, '7.00', '2026-03-10'); // after window

    const stmt = (await getCustomerStatement(c.userId, c.companyId, c.customerId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.openingBalance).toBe('100.0000'); // Jan only
    expect(stmt.lines).toHaveLength(1);
    expect(stmt.lines[0]!.date).toBe('2026-02-10');
    expect(stmt.closingBalance).toBe('140.0000'); // 100 + 40, March excluded
  });
});

describe('getCustomerStatement — reversal netting (customer tag preserved)', () => {
  it('a void appears as a REVERSAL row and nets its original to zero', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-02-05', lines: [{ accountId: c.revId, unitPrice: '100.00' }],
    }));
    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    // Void with an explicit reversal date inside the window (else it defaults to today).
    await voidInvoice(c.userId, c.companyId, invoice.id, voidInvoiceInput.parse({ reversalDate: '2026-02-10' }));

    const stmt = (await getCustomerStatement(c.userId, c.companyId, c.customerId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.lines.map((l) => [l.date, l.sourceType, l.charge, l.credit, l.balance])).toEqual([
      ['2026-02-05', 'INVOICE', '100.0000', '0.0000', '100.0000'],
      ['2026-02-10', 'REVERSAL', '0.0000', '100.0000', '0.0000'],
    ]);
    expect(stmt.closingBalance).toBe('0.0000'); // the reversal (customer-tagged) nets the original
  });
});

describe('getCustomerStatement — reconciliation, scoping, authorization, validation', () => {
  it('the sum of every customer’s closing balance equals the A/R control', async () => {
    const c = await setup();
    const beta = await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'Beta' }));

    // Acme: 100 invoiced, 40 paid → 60.
    const acmeInv = await openInvoice(c, '100.00', '2026-01-10');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-20', depositAccountId: c.cashId,
      applications: [{ invoiceId: acmeInv, amountApplied: '40.00' }],
    }));
    // Beta: 250 invoiced, 50 credited → 200.
    const betaInv = await openInvoice(c, '250.00', '2026-01-15', beta.id);
    await issueCreditMemo(c.userId, c.companyId, issueCreditMemoInput.parse({
      invoiceId: betaInv, revenueAccountId: c.returnsId, creditDate: '2026-01-25', amount: '50.00',
    }));

    const asOf = '2026-12-31';
    const acme = (await getCustomerStatement(c.userId, c.companyId, c.customerId, '2026-01-01', asOf))!;
    const betaStmt = (await getCustomerStatement(c.userId, c.companyId, beta.id, '2026-01-01', asOf))!;
    expect(acme.closingBalance).toBe('60.0000');
    expect(betaStmt.closingBalance).toBe('200.0000');

    // Sum with decimal.js — never JS `number` for money (ADR-004).
    const sum = toMoney(acme.closingBalance).plus(toMoney(betaStmt.closingBalance));
    expect(sum.toFixed(4)).toBe(await arControlBalance(c, asOf)); // 260.0000
  });

  it('is company-scoped — another tenant’s customer id returns null (no leak)', async () => {
    const a = await setup();
    const b = await setup();
    // b's customer, queried under a → null, exactly as a genuine miss would.
    const cross = await getCustomerStatement(a.userId, a.companyId, b.customerId, '2026-01-01', '2026-12-31');
    expect(cross).toBeNull();
    const missing = await getCustomerStatement(a.userId, a.companyId, '00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-12-31');
    expect(missing).toBeNull();
  });

  it('requires report.view — a non-member is denied', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(getCustomerStatement(outsider, c.companyId, c.customerId, '2026-01-01', '2026-12-31'))
      .rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('rejects an inverted date range', async () => {
    const c = await setup();
    await expect(getCustomerStatement(c.userId, c.companyId, c.customerId, '2026-03-01', '2026-02-01'))
      .rejects.toThrow(/on or before/);
  });

  it('is decimal-exact — fractional cents accumulate without float drift', async () => {
    const c = await setup();
    await openInvoice(c, '0.10', '2026-02-05');
    await openInvoice(c, '0.20', '2026-02-06');
    const stmt = (await getCustomerStatement(c.userId, c.companyId, c.customerId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.lines.map((l) => l.balance)).toEqual(['0.1000', '0.3000']); // not 0.30000000000000004
    expect(stmt.closingBalance).toBe('0.3000');
  });
});
