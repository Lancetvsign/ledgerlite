/**
 * A/R aging report — LL-046. Against a real database.
 *
 * The A/R subsidiary ledger: OPEN invoices' open balances bucketed by age. The
 * decisive property is reconciliation — the aging grand total equals the GL A/R
 * control balance (derived from journal lines) — which the release gate also
 * enforces (GL-T018). These tests prove the bucketing, grouping, exclusions, and
 * the reconciliation directly.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { issueCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { receivePayment } from '@/server/payments';
import { getArAging, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput } from '@/validation/payment';
import { writeOffInvoiceInput } from '@/validation/writeoff';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  cashId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `age-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'A',
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
    createCompanyInput.parse({ legalName: 'Aging Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, cashId: cash.id };
}

/** Create + finalize an OPEN invoice for `price`, dated `invoiceDate`, due `dueDate`. */
async function openInvoice(
  c: Ctx,
  price: string,
  dueDate: string | undefined,
  customerId = c.customerId,
  invoiceDate = '2026-01-10',
): Promise<string> {
  const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
    customerId,
    invoiceDate,
    ...(dueDate !== undefined ? { dueDate } : {}),
    lines: [{ accountId: c.revId, unitPrice: price }],
  }));
  await finalizeInvoice(c.userId, c.companyId, invoice.id);
  return invoice.id;
}

async function arControlBalance(c: Ctx, asOf: string): Promise<string> {
  const db = await getTestDb();
  const ar = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_RECEIVABLE' limit 1`,
  );
  const arId = ar.rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
}

beforeEach(async () => {
  await truncateAll();
});

describe('getArAging — bucketing by due date', () => {
  it('places each open invoice in the right bucket as of a date', async () => {
    const c = await setup();
    // As of 2026-06-30, due dates chosen to land one invoice in each bucket.
    await openInvoice(c, '100.00', '2026-06-30'); // 0 days → current
    await openInvoice(c, '200.00', '2026-06-15'); // 15 → 1–30
    await openInvoice(c, '300.00', '2026-05-15'); // 46 → 31–60
    await openInvoice(c, '400.00', '2026-04-15'); // 76 → 61–90
    await openInvoice(c, '500.00', '2026-01-15'); // 166 → 90+

    const aging = await getArAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.customers).toHaveLength(1);
    const b = aging.customers[0]!.buckets;
    expect(b.current).toBe('100.0000');
    expect(b.d1to30).toBe('200.0000');
    expect(b.d31to60).toBe('300.0000');
    expect(b.d61to90).toBe('400.0000');
    expect(b.d90plus).toBe('500.0000');
    expect(aging.customers[0]!.total).toBe('1500.0000');
    expect(aging.totals.total).toBe('1500.0000');
    expect(aging.totals.d1to30).toBe('200.0000');
  });

  it('falls back to the invoice date when there is no due date', async () => {
    const c = await setup();
    // No due date; invoice dated 2026-01-10, aged as of 2026-03-01 → 50 days → 31–60.
    await openInvoice(c, '75.00', undefined, c.customerId, '2026-01-10');
    const aging = await getArAging(c.userId, c.companyId, '2026-03-01');
    expect(aging.customers[0]!.buckets.d31to60).toBe('75.0000');
    expect(aging.totals.total).toBe('75.0000');
  });
});

describe('getArAging — population and grouping', () => {
  it('groups by customer and excludes DRAFT / PAID / VOID invoices', async () => {
    const c = await setup();
    const other = await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'Beta' }));

    await openInvoice(c, '100.00', '2026-06-15'); // Acme, OPEN → aged
    await openInvoice(c, '250.00', '2026-06-15', other.id); // Beta, OPEN → aged
    // A DRAFT (never finalized) is invisible to aging.
    await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: '999.00' }],
    }));
    // A fully-paid invoice (→ PAID) is invisible to aging.
    const paid = await openInvoice(c, '60.00', '2026-06-15');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-06-20', depositAccountId: c.cashId,
      applications: [{ invoiceId: paid, amountApplied: '60.00' }],
    }));

    const aging = await getArAging(c.userId, c.companyId, '2026-06-30');
    const names = aging.customers.map((r) => r.customerName).sort();
    expect(names).toEqual(['Acme', 'Beta']);
    expect(aging.customers.find((r) => r.customerName === 'Acme')?.total).toBe('100.0000'); // 999 draft + 60 paid excluded
    expect(aging.customers.find((r) => r.customerName === 'Beta')?.total).toBe('250.0000');
    expect(aging.totals.total).toBe('350.0000');
  });

  it('a partial payment reduces the bucketed open balance', async () => {
    const c = await setup();
    const inv = await openInvoice(c, '100.00', '2026-06-15');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-06-20', depositAccountId: c.cashId,
      applications: [{ invoiceId: inv, amountApplied: '30.00' }],
    }));
    const aging = await getArAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.customers[0]!.buckets.d1to30).toBe('70.0000'); // 100 − 30
    expect(aging.totals.total).toBe('70.0000');
  });

  it('a bad-debt write-off reduces the bucketed open balance', async () => {
    const c = await setup();
    const inv = await openInvoice(c, '100.00', '2026-06-15');
    const badDebt = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
    await writeOffInvoice(c.userId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: inv, expenseAccountId: badDebt.id, writeoffDate: '2026-06-20', amount: '30.00',
    }));
    const aging = await getArAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.customers[0]!.buckets.d1to30).toBe('70.0000'); // 100 − 30 written off
    expect(aging.totals.total).toBe('70.0000');
  });

  it('a credit memo reduces the bucketed open balance', async () => {
    const c = await setup();
    const inv = await openInvoice(c, '100.00', '2026-06-15');
    const returns = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
    await issueCreditMemo(c.userId, c.companyId, issueCreditMemoInput.parse({
      invoiceId: inv, revenueAccountId: returns.id, creditDate: '2026-06-20', amount: '30.00',
    }));
    const aging = await getArAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.customers[0]!.buckets.d1to30).toBe('70.0000'); // 100 − 30 credited
    expect(aging.totals.total).toBe('70.0000');
  });

  it('is company-scoped — another tenant’s receivables never appear', async () => {
    const a = await setup();
    const b = await setup();
    await openInvoice(a, '100.00', '2026-06-15');
    await openInvoice(b, '999.00', '2026-06-15');
    const aging = await getArAging(a.userId, a.companyId, '2026-06-30');
    expect(aging.totals.total).toBe('100.0000'); // only A's receivable
  });
});

describe('getArAging — reconciles to the GL A/R control balance', () => {
  it('aging grand total equals the derived Accounts Receivable balance', async () => {
    const c = await setup();
    await openInvoice(c, '100.00', '2026-06-15');
    const partial = await openInvoice(c, '200.00', '2026-05-15');
    await openInvoice(c, '50.00', '2026-01-15');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-06-20', depositAccountId: c.cashId,
      applications: [{ invoiceId: partial, amountApplied: '120.00' }],
    }));

    const aging = await getArAging(c.userId, c.companyId, '2026-12-31');
    const arBalance = await arControlBalance(c, '2026-12-31');
    // 100 + (200 − 120) + 50 = 230, and the A/R control agrees exactly.
    expect(aging.totals.total).toBe('230.0000');
    expect(aging.totals.total).toBe(arBalance);

    // The grand total is age-independent (ADR-016): a different asOf only re-buckets.
    const midYear = await getArAging(c.userId, c.companyId, '2026-06-30');
    expect(midYear.totals.total).toBe(aging.totals.total);
  });
});
