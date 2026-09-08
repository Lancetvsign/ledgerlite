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
import { payBill, voidBillPayment } from '@/server/bill-payments';
import { createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { issueCreditMemo, voidCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { assertLedgerIntegrity } from '@/server/ledger';
import { receivePayment, voidPayment } from '@/server/payments';
import { issueVendorCredit, voidVendorCredit } from '@/server/vendor-credits';
import { createVendor } from '@/server/vendors';
import { voidWriteoff, writeOffInvoice } from '@/server/writeoffs';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { payBillInput, voidBillPaymentInput } from '@/validation/bill-payment';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput, voidCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';
import { createVendorInput } from '@/validation/vendor';
import { issueVendorCreditInput, voidVendorCreditInput } from '@/validation/vendor-credit';
import { voidWriteoffInput, writeOffInvoiceInput } from '@/validation/writeoff';

import { truncateAll } from '../helpers/database';

interface Ctx {
  ownerId: string;
  bookkeeperId: string;
  accountantId: string;
  readOnlyId: string;
  companyId: string;
  customerId: string;
  vendorId: string;
  revId: string;
  cashId: string;
  badDebtId: string;
  returnsId: string;
  suppliesId: string;
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
  const readOnlyId = await makeUser();
  await insertMembership(company.id, bookkeeperId, 'BOOKKEEPER');
  await insertMembership(company.id, accountantId, 'ACCOUNTANT');
  await insertMembership(company.id, readOnlyId, 'READ_ONLY');
  const customer = await createCustomer(ownerId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const vendor = await createVendor(ownerId, company.id, createVendorInput.parse({ name: 'Globex' }));
  const rev = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  const returns = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
  const supplies = await createAccount(ownerId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  return {
    ownerId, bookkeeperId, accountantId, readOnlyId, companyId: company.id, customerId: customer.id,
    vendorId: vendor.id, revId: rev.id, cashId: cash.id, badDebtId: badDebt.id, returnsId: returns.id,
    suppliesId: supplies.id,
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

/** Create + finalize a bill for `price` as `actor` (defaults to OWNER). Returns its id (OPEN). */
async function openBill(c: Ctx, price: string, actor = c.ownerId): Promise<string> {
  const { bill } = await createBill(actor, c.companyId, createBillInput.parse({
    vendorId: c.vendorId, billDate: '2026-01-10', lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(actor, c.companyId, bill.id);
  return bill.id;
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

describe('the A/P void split mirrors A/R — *.void is LEDGER_WRITERS, create is ALL_WRITERS', () => {
  it('bill.void — a BOOKKEEPER can finalize a bill but not void it; an ACCOUNTANT can', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00', c.bookkeeperId); // BOOKKEEPER finalizes (expense.create)
    await expect(voidBill(c.bookkeeperId, c.companyId, billId, voidBillInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    const { bill: voided } = await voidBill(c.accountantId, c.companyId, billId, voidBillInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });

  it('bill_payment.void — a BOOKKEEPER cannot void a bill payment; an ACCOUNTANT can', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const { payment } = await payBill(c.bookkeeperId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-15', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '100.00' }],
    })); // BOOKKEEPER can pay (ALL_WRITERS)
    await expect(voidBillPayment(c.bookkeeperId, c.companyId, payment.id, voidBillPaymentInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    const { payment: voided } = await voidBillPayment(c.accountantId, c.companyId, payment.id, voidBillPaymentInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });

  it('vendor_credit.void — a BOOKKEEPER cannot void a vendor credit; an ACCOUNTANT can', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const credit = await issueVendorCredit(c.bookkeeperId, c.companyId, issueVendorCreditInput.parse({
      billId, expenseAccountId: c.suppliesId, creditDate: '2026-01-15', amount: '100.00',
    })); // BOOKKEEPER can issue (ALL_WRITERS)
    await expect(voidVendorCredit(c.bookkeeperId, c.companyId, credit.id, voidVendorCreditInput.parse({})))
      .rejects.toBeInstanceOf(AuthorizationDenied);
    const voided = await voidVendorCredit(c.accountantId, c.companyId, credit.id, voidVendorCreditInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('a READ_ONLY member cannot create any A/P document', () => {
  it('createBill / payBill / issueVendorCredit are all denied for READ_ONLY', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00'); // OWNER seeds an open bill to pay / credit

    await expect(createBill(c.readOnlyId, c.companyId, createBillInput.parse({
      vendorId: c.vendorId, billDate: '2026-01-10', lines: [{ accountId: c.suppliesId, unitPrice: '50.00' }],
    }))).rejects.toBeInstanceOf(AuthorizationDenied);

    await expect(payBill(c.readOnlyId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-15', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '10.00' }],
    }))).rejects.toBeInstanceOf(AuthorizationDenied);

    await expect(issueVendorCredit(c.readOnlyId, c.companyId, issueVendorCreditInput.parse({
      billId, expenseAccountId: c.suppliesId, creditDate: '2026-01-15', amount: '10.00',
    }))).rejects.toBeInstanceOf(AuthorizationDenied);

    await assertLedgerIntegrity(c.companyId);
  });
});
