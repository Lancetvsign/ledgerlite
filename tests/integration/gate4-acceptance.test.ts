/**
 * Gate 4 — Sprint 5 acceptance scenario. Against a real database.
 *
 * Sprint 5 completes the A/R adjustment surface on top of Sprint 4: bad-debt
 * WRITE-OFFS (LL-050), CREDIT MEMOS (LL-051), and the customer STATEMENT (LL-054),
 * with the A/R control account now STRUCTURALLY locked against manual journal
 * entry (LL-050 PR2) and REVERSED entries frozen (LL-052).
 *
 * This is the gate's narrative: one company, two customers, the full adjustment
 * lifecycle — invoice → partial payment → partial write-off → partial credit memo
 * → void — asserting at EVERY stage the three-way tie that is the whole point of
 * the subsidiary ledger:
 *
 *     GL A/R control  ==  aging subsidiary total  ==  Σ customer-statement closings
 *
 * The first equality is GL-T018/T019/T020 (control⇔subsidiary across every
 * reduction source); the second is GL-T021 (the subsidiary decomposes exactly into
 * per-customer statements). All money is the service's NUMERIC(19,4) string,
 * compared exactly; nothing is a JS number.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import '@/lib/decimal';
import { toMoney } from '@/lib/decimal';
import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { issueCreditMemo, voidCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { assertLedgerIntegrity } from '@/server/ledger';
import { receivePayment } from '@/server/payments';
import { getArAging, getCustomerStatement, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput, voidCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput } from '@/validation/payment';
import { writeOffInvoiceInput } from '@/validation/writeoff';

import { getTestDb, truncateAll } from '../helpers/database';

const ASOF = '2026-12-31';
const PERIOD = { from: '2026-01-01', to: '2026-12-31' } as const;

interface Ctx {
  userId: string;
  companyId: string;
  acmeId: string;
  betaId: string;
  revId: string;
  cashId: string;
  badDebtId: string;
  returnsId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `g4-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'G' },
    returnHeaders: true,
  });
  const u = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return u.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Gate4 Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const acme = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const beta = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Beta' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  const returns = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
  return {
    userId, companyId: company.id, acmeId: acme.id, betaId: beta.id,
    revId: rev.id, cashId: cash.id, badDebtId: badDebt.id, returnsId: returns.id,
  };
}

async function openInvoice(c: Ctx, customerId: string, price: string, invoiceDate = '2026-01-10'): Promise<string> {
  const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
    customerId, invoiceDate, lines: [{ accountId: c.revId, unitPrice: price }],
  }));
  await finalizeInvoice(c.userId, c.companyId, invoice.id);
  return invoice.id;
}

/** The derived GL A/R control balance (from the trial balance). */
async function arControl(c: Ctx): Promise<string> {
  const db = await getTestDb();
  const arId = (await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_RECEIVABLE' limit 1`,
  )).rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, ASOF);
  expect(tb.balanced).toBe(true); // the books balance at every stage
  return tb.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
}

/** Σ of every customer's statement closing balance (the per-customer decomposition). */
async function sumStatementClosings(c: Ctx): Promise<string> {
  let total = toMoney('0');
  for (const customerId of [c.acmeId, c.betaId]) {
    const s = await getCustomerStatement(c.userId, c.companyId, customerId, PERIOD.from, PERIOD.to);
    total = total.plus(toMoney(s!.closingBalance));
  }
  return total.toFixed(4);
}

/** Assert control == aging subsidiary == Σ statements, and equal to `expected`. */
async function assertThreeWayTie(c: Ctx, expected: string): Promise<void> {
  const control = await arControl(c);
  const aging = (await getArAging(c.userId, c.companyId, ASOF)).totals.total;
  const statements = await sumStatementClosings(c);
  expect(control).toBe(expected);
  expect(aging).toBe(expected);
  expect(statements).toBe(expected);
  await assertLedgerIntegrity(c.companyId);
}

beforeEach(async () => {
  await truncateAll();
});

describe('Gate 4 — Sprint 5 A/R adjustment lifecycle reconciles control ⇔ subsidiary ⇔ statements', () => {
  it('holds the three-way tie through invoice, payment, write-off, credit memo, and void', async () => {
    const c = await setup();

    // 1. Acme invoice #1 $1,000 and #2 $500; Beta invoice #3 $300. Control 1,800.
    const inv1 = await openInvoice(c, c.acmeId, '1000.00');
    await openInvoice(c, c.acmeId, '500.00');
    await openInvoice(c, c.betaId, '300.00');
    await assertThreeWayTie(c, '1800.0000');

    // 2. Acme pays $400 against #1. Control 1,400.
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.acmeId, paymentDate: '2026-02-01', depositAccountId: c.cashId,
      applications: [{ invoiceId: inv1, amountApplied: '400.00' }],
    }));
    await assertThreeWayTie(c, '1400.0000');

    // 3. Write off the remaining $600 of #1 (Dr Bad Debt / Cr A/R) → #1 cleared → PAID.
    //    Control 800. (GL-T019: write-offs move control AND subsidiary together.)
    await writeOffInvoice(c.userId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: inv1, expenseAccountId: c.badDebtId, writeoffDate: '2026-02-15', amount: '600.00',
    }));
    await assertThreeWayTie(c, '800.0000');
    const db = await getTestDb();
    const inv1Status = (await db.execute<{ status: string }>(
      sql`select status from invoices where id = ${inv1}`,
    )).rows[0]!.status;
    expect(inv1Status).toBe('PAID'); // 400 paid + 600 written off = 1000 → cleared

    // 4. Credit memo $200 on Acme #2 (Dr Sales Returns / Cr A/R). Control 600.
    //    (GL-T020: credit memos move control AND subsidiary together.)
    const memo = await issueCreditMemo(c.userId, c.companyId, issueCreditMemoInput.parse({
      invoiceId: (await db.execute<{ id: string }>(sql`
        select id from invoices where company_id = ${c.companyId} and customer_id = ${c.acmeId} and total = '500.0000' limit 1`)).rows[0]!.id,
      revenueAccountId: c.returnsId, creditDate: '2026-03-01', amount: '200.00',
    }));
    await assertThreeWayTie(c, '600.0000');

    // 5. Void the credit memo (a reversal, customer-tag preserved). Control back to 800.
    await voidCreditMemo(c.userId, c.companyId, memo.id, voidCreditMemoInput.parse({ reversalDate: '2026-03-10' }));
    await assertThreeWayTie(c, '800.0000');
  });

  it('per-customer statements each equal that customer’s A/R slice', async () => {
    const c = await setup();
    // Acme: 1,000 invoiced, 250 paid, 150 written off → 600. Beta: 300 invoiced → 300.
    const acmeInv = await openInvoice(c, c.acmeId, '1000.00');
    await openInvoice(c, c.betaId, '300.00');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.acmeId, paymentDate: '2026-02-01', depositAccountId: c.cashId,
      applications: [{ invoiceId: acmeInv, amountApplied: '250.00' }],
    }));
    await writeOffInvoice(c.userId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: acmeInv, expenseAccountId: c.badDebtId, writeoffDate: '2026-02-15', amount: '150.00',
    }));

    const acme = (await getCustomerStatement(c.userId, c.companyId, c.acmeId, PERIOD.from, PERIOD.to))!;
    const beta = (await getCustomerStatement(c.userId, c.companyId, c.betaId, PERIOD.from, PERIOD.to))!;
    expect(acme.closingBalance).toBe('600.0000'); // 1000 − 250 − 150
    expect(beta.closingBalance).toBe('300.0000');
    await assertThreeWayTie(c, '900.0000'); // 600 + 300, and control agrees
  });
});
