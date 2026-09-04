/**
 * Customer payments — LL-043. Against a real database.
 *
 * Receiving a payment applies it to one or more of a customer's OPEN invoices and
 * posts Dr deposit / Cr Accounts Receivable; a fully-paid invoice becomes PAID.
 * Voiding a payment reverses the entry (netting every account to zero) and reverts
 * the invoices. These tests prove the accounting is exact, the application rules
 * hold, authorization honors "a bookkeeper works documents", and tenancy is safe.
 */
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { InvoiceError, createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { LedgerError, assertLedgerIntegrity } from '@/server/ledger';
import { PaymentError, computePaymentAmount, getPayment, listPayments, receivePayment, voidPayment } from '@/server/payments';
import { closePeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, assertReversalNetsToZero } from '../helpers/ledger-invariants';

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
      email: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'P',
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
    createCompanyInput.parse({ legalName: 'Pay Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, cashId: cash.id };
}

/** Create and finalize an invoice for `unitPrice`; returns its id (OPEN). */
async function openInvoice(c: Ctx, unitPrice: string, customerId = c.customerId): Promise<string> {
  const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
    customerId,
    invoiceDate: '2026-01-10',
    lines: [{ accountId: c.revId, quantity: '1', unitPrice }],
  }));
  await finalizeInvoice(c.userId, c.companyId, invoice.id);
  return invoice.id;
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]!.id;
}

type EntryRow = { id: string; status: string; source_type: string; reversal_of_id: string | null };
async function paymentEntries(companyId: string, paymentId: string): Promise<EntryRow[]> {
  const db = await getTestDb();
  const r = await db.execute<EntryRow>(sql`
    select id, status, source_type, reversal_of_id
    from journal_entries
    where company_id = ${companyId}
      and (source_id = ${paymentId}
           or reversal_of_id in (select id from journal_entries where company_id = ${companyId} and source_id = ${paymentId}))
    order by entry_number`);
  return r.rows;
}

async function linesOf(entryId: string): Promise<{ account_id: string; debit: string; credit: string; customer_id: string | null }[]> {
  const db = await getTestDb();
  const r = await db.execute<{ account_id: string; debit: string; credit: string; customer_id: string | null }>(
    sql`select account_id, debit, credit, customer_id from journal_lines where journal_entry_id = ${entryId} order by line_number`,
  );
  return r.rows;
}

async function invoiceStatus(companyId: string, invoiceId: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ status: string }>(
    sql`select status from invoices where company_id = ${companyId} and id = ${invoiceId}`,
  );
  return r.rows[0]!.status;
}

async function arBalance(c: Ctx): Promise<string> {
  const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  return tb.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
}

async function auditCount(companyId: string, action: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from audit_events where company_id = ${companyId} and action = ${action}`,
  );
  return Number(r.rows[0]?.n);
}

const payErr = async (p: Promise<unknown>): Promise<PaymentError> => {
  try {
    await p;
    throw new Error('expected PaymentError');
  } catch (e) {
    expect(e).toBeInstanceOf(PaymentError);
    return e as PaymentError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('computePaymentAmount (pure, decimal.js)', () => {
  it('sums applications exactly at four places', () => {
    expect(computePaymentAmount([{ amountApplied: '100.0000' }, { amountApplied: '49.9900' }])).toBe('149.9900');
    // Sum with decimal.js, never JS floats.
    const sum = [{ amountApplied: '0.1000' }, { amountApplied: '0.2000' }]
      .reduce((s, a) => s.plus(a.amountApplied), new Decimal(0));
    expect(computePaymentAmount([{ amountApplied: '0.1000' }, { amountApplied: '0.2000' }])).toBe(sum.toFixed(4));
  });
});

describe('receive — posts Dr deposit / Cr A/R and settles invoices', () => {
  it('a full payment posts the entry, marks the invoice PAID, and clears A/R', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    expect(await arBalance(c)).toBe('100.0000'); // A/R after finalize

    const { payment, applications } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId, reference: 'CHK-1',
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    }));
    expect(payment.amount).toBe('100.0000');
    expect(payment.status).toBe('POSTED');
    expect(applications).toHaveLength(1);

    const entries = await paymentEntries(c.companyId, payment.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_type).toBe('CUSTOMER_PAYMENT');
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const lines = await linesOf(entries[0]!.id);
    expect(lines.find((l) => l.account_id === c.cashId)?.debit).toBe('100.0000');
    const ar = lines.find((l) => l.account_id === arId);
    expect(ar?.credit).toBe('100.0000');
    expect(ar?.customer_id).toBe(c.customerId); // A/R line is customer-tagged

    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');
    expect(await arBalance(c)).toBe('0.0000'); // receivable settled
    expect(await auditCount(c.companyId, 'PAYMENT_RECEIVED')).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a partial payment leaves the invoice OPEN and reduces its open balance', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '40.00' }],
    }));
    expect(await invoiceStatus(c.companyId, invId)).toBe('OPEN');
    expect(await arBalance(c)).toBe('60.0000'); // 100 − 40
    // A second payment can only apply the remaining 60; 61 over-applies.
    expect((await payErr(receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-16', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '61.00' }],
    })))).code).toBe('OVERAPPLIED');
    // Applying exactly 60 settles it.
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-16', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '60.00' }],
    }));
    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');
    await assertLedgerIntegrity(c.companyId);
  });

  it('one payment settles multiple invoices; amount is the sum of applications', async () => {
    const c = await setup();
    const a = await openInvoice(c, '30.00');
    const b = await openInvoice(c, '70.00');
    const { payment } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: a, amountApplied: '30.00' }, { invoiceId: b, amountApplied: '70.00' }],
    }));
    expect(payment.amount).toBe('100.0000');
    expect(await invoiceStatus(c.companyId, a)).toBe('PAID');
    expect(await invoiceStatus(c.companyId, b)).toBe('PAID');
    expect(await arBalance(c)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('one payment can partially pay one invoice and fully pay another', async () => {
    const c = await setup();
    const a = await openInvoice(c, '100.00'); // will be partially paid → OPEN
    const b = await openInvoice(c, '30.00'); // will be fully paid → PAID
    const { payment } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: a, amountApplied: '40.00' }, { invoiceId: b, amountApplied: '30.00' }],
    }));
    expect(payment.amount).toBe('70.0000');
    expect(await invoiceStatus(c.companyId, a)).toBe('OPEN'); // only 40 of 100
    expect(await invoiceStatus(c.companyId, b)).toBe('PAID');
    expect(await arBalance(c)).toBe('60.0000'); // 130 invoiced − 70 paid
    await assertLedgerIntegrity(c.companyId);
  });

  it('getPayment returns the payment with its applications; listPayments lists it', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const { payment } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    }));
    const view = await getPayment(c.userId, c.companyId, payment.id);
    expect(view?.payment.id).toBe(payment.id);
    expect(view?.applications).toHaveLength(1);
    expect(view?.applications[0]?.invoiceId).toBe(invId);
    const listed = await listPayments(c.userId, c.companyId);
    expect(listed.map((p) => p.id)).toContain(payment.id);
    // A cross-company id reads as a genuine miss.
    const other = await setup();
    expect(await getPayment(other.userId, other.companyId, payment.id)).toBeNull();
  });
});

describe('receive — application and precondition rules', () => {
  it('rejects applying to a DRAFT invoice (INVOICE_NOT_OPEN)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: '100.00' }],
    }));
    expect((await payErr(receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invoice.id, amountApplied: '100.00' }],
    })))).code).toBe('INVOICE_NOT_OPEN');
  });

  it("rejects applying to another customer's invoice (INVOICE_WRONG_CUSTOMER)", async () => {
    const c = await setup();
    const other = await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'Other' }));
    const invId = await openInvoice(c, '100.00'); // belongs to c.customerId
    expect((await payErr(receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: other.id, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    })))).code).toBe('INVOICE_WRONG_CUSTOMER');
  });

  it('rejects a non-asset deposit account (DEPOSIT_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const expense = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
    expect((await payErr(receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: expense.id,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    })))).code).toBe('DEPOSIT_ACCOUNT_INVALID');
  });

  it('rejects depositing into Accounts Receivable (DEPOSIT_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE'); // an ASSET, but not a valid deposit
    expect((await payErr(receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: arId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    })))).code).toBe('DEPOSIT_ACCOUNT_INVALID');
  });

  it('rejects the same invoice twice in one payment (DUPLICATE_INVOICE_APPLICATION)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    expect((await payErr(receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '40.00' }, { invoiceId: invId, amountApplied: '60.00' }],
    })))).code).toBe('DUPLICATE_INVOICE_APPLICATION');
  });

  it('refuses to receive into a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const db = await getTestDb();
    const p = await db.execute<{ id: string }>(sql`
      select id from accounting_periods where company_id = ${c.companyId} and '2026-01-15' between start_date and end_date limit 1`);
    await closePeriod(c.userId, c.companyId, p.rows[0]!.id);
    const err = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('PERIOD_CLOSED');
  });

  it('a BOOKKEEPER (payment.create, not journal.post) can receive a payment', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const { payment } = await receivePayment(bookkeeper, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    }));
    expect(payment.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('void — reverses the entry and reverts the invoices', () => {
  it('voids a payment: reversal nets to zero, payment VOID, PAID invoice back to OPEN', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const { payment } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    }));
    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');

    const { payment: voided } = await voidPayment(c.userId, c.companyId, payment.id, voidPaymentInput.parse({ reason: 'bounced' }));
    expect(voided.status).toBe('VOID');

    const entries = await paymentEntries(c.companyId, payment.id);
    const original = entries.find((e) => e.source_type === 'CUSTOMER_PAYMENT')!;
    const reversal = entries.find((e) => e.source_type === 'REVERSAL')!;
    expect(original.status).toBe('REVERSED');
    await assertReversalNetsToZero(original.id, reversal.id);

    expect(await invoiceStatus(c.companyId, invId)).toBe('OPEN'); // reverted
    expect(await arBalance(c)).toBe('100.0000'); // receivable is owed again
    expect(await auditCount(c.companyId, 'PAYMENT_VOIDED')).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (PAYMENT_NOT_POSTED)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const { payment } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    }));
    await voidPayment(c.userId, c.companyId, payment.id, voidPaymentInput.parse({}));
    expect((await payErr(voidPayment(c.userId, c.companyId, payment.id, voidPaymentInput.parse({})))).code).toBe('PAYMENT_NOT_POSTED');
  });
});

describe('interaction with invoice void', () => {
  it('an invoice with a live payment cannot be voided; after the payment is voided it can', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const { payment } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '40.00' }], // partial → invoice still OPEN
    }));
    // OPEN, but has a live payment → void blocked.
    const err = await voidInvoice(c.userId, c.companyId, invId, voidInvoiceInput.parse({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect((err as InvoiceError).code).toBe('INVOICE_HAS_PAYMENTS');
    // Void the payment, then the invoice voids fine.
    await voidPayment(c.userId, c.companyId, payment.id, voidPaymentInput.parse({}));
    const { invoice } = await voidInvoice(c.userId, c.companyId, invId, voidInvoiceInput.parse({}));
    expect(invoice.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('tenancy', () => {
  it("cross-company payment id reads/voids as a genuine miss (PAYMENT_NOT_FOUND)", async () => {
    const a = await setup();
    const b = await setup();
    const invId = await openInvoice(a, '100.00');
    const { payment } = await receivePayment(a.userId, a.companyId, receivePaymentInput.parse({
      customerId: a.customerId, paymentDate: '2026-01-15', depositAccountId: a.cashId,
      applications: [{ invoiceId: invId, amountApplied: '100.00' }],
    }));
    expect((await payErr(voidPayment(b.userId, b.companyId, payment.id, voidPaymentInput.parse({})))).code).toBe('PAYMENT_NOT_FOUND');
  });
});
