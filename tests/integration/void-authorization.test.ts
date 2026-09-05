/**
 * Void authorization — LL-053 (Gate 3 item 4).
 *
 * Voiding a posted document is a reversal (a ledger correction), so it now requires a
 * distinct *.void capability granted to LEDGER_WRITERS (OWNER/ADMIN/ACCOUNTANT), not the
 * ALL_WRITERS create/post capability. A BOOKKEEPER can still create and post documents but
 * can no longer void them; an ACCOUNTANT can. These tests prove the split for each of the
 * four document types.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { issueCreditMemo, voidCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { assertLedgerIntegrity } from '@/server/ledger';
import { receivePayment, voidPayment } from '@/server/payments';
import { voidWriteoff, writeOffInvoice } from '@/server/writeoffs';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput, voidCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';
import { voidWriteoffInput, writeOffInvoiceInput } from '@/validation/writeoff';

import { truncateAll } from '../helpers/database';

interface Ctx {
  ownerId: string;
  bookkeeperId: string;
  accountantId: string;
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
      email: `va-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'V',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const ownerId = await makeUser();
  const { company } = await createCompanyWithOwner(
    ownerId,
    createCompanyInput.parse({ legalName: 'Void Authz Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const bookkeeperId = await makeUser();
  const accountantId = await makeUser();
  await insertMembership(company.id, bookkeeperId, 'BOOKKEEPER');
  await insertMembership(company.id, accountantId, 'ACCOUNTANT');
  const customer = await createCustomer(ownerId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  const returns = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
  return {
    ownerId, bookkeeperId, accountantId, companyId: company.id, customerId: customer.id,
    revId: rev.id, cashId: cash.id, badDebtId: badDebt.id, returnsId: returns.id,
  };
}

/** Create + finalize an invoice for `price` (as the OWNER). Returns its id (OPEN). */
async function openInvoice(c: Ctx, price: string): Promise<string> {
  const { invoice } = await createInvoice(c.ownerId, c.companyId, createInvoiceInput.parse({
    customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: price }],
  }));
  await finalizeInvoice(c.ownerId, c.companyId, invoice.id);
  return invoice.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe('void requires the *.void capability (LEDGER_WRITERS), not create/post (ALL_WRITERS)', () => {
  it('invoice.void — a BOOKKEEPER can finalize but not void; an ACCOUNTANT can void', async () => {
    const c = await setup();
    // A BOOKKEEPER can create + finalize (ALL_WRITERS) — the change is only about voiding.
    const { invoice } = await createInvoice(c.bookkeeperId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: '100.00' }],
    }));
    await finalizeInvoice(c.bookkeeperId, c.companyId, invoice.id);
    // …but cannot void it.
    await expect(voidInvoice(c.bookkeeperId, c.companyId, invoice.id, voidInvoiceInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    // An ACCOUNTANT can.
    const { invoice: voided } = await voidInvoice(c.accountantId, c.companyId, invoice.id, voidInvoiceInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });

  it('payment.void — a BOOKKEEPER cannot void a payment; an ACCOUNTANT can', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const { payment } = await receivePayment(c.bookkeeperId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    })); // BOOKKEEPER can receive (ALL_WRITERS)
    await expect(voidPayment(c.bookkeeperId, c.companyId, payment.id, voidPaymentInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    const { payment: voided } = await voidPayment(c.accountantId, c.companyId, payment.id, voidPaymentInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });

  it('writeoff.void — a BOOKKEEPER cannot void a write-off; an ACCOUNTANT can', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const writeoff = await writeOffInvoice(c.bookkeeperId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: invId, expenseAccountId: c.badDebtId, writeoffDate: '2026-01-15', amount: '100.00',
    }));
    await expect(voidWriteoff(c.bookkeeperId, c.companyId, writeoff.id, voidWriteoffInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    const voided = await voidWriteoff(c.accountantId, c.companyId, writeoff.id, voidWriteoffInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });

  it('credit_memo.void — a BOOKKEEPER cannot void a credit memo; an ACCOUNTANT can', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const memo = await issueCreditMemo(c.bookkeeperId, c.companyId, issueCreditMemoInput.parse({
      invoiceId: invId, revenueAccountId: c.returnsId, creditDate: '2026-01-15', amount: '100.00',
    }));
    await expect(voidCreditMemo(c.bookkeeperId, c.companyId, memo.id, voidCreditMemoInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    const voided = await voidCreditMemo(c.accountantId, c.companyId, memo.id, voidCreditMemoInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });
});
