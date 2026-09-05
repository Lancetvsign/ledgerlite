/**
 * Customer credit memos — LL-051. Against a real database.
 *
 * A credit memo against an OPEN invoice (whole or part) posts Dr Sales Returns &
 * Allowances (a revenue account) / Cr Accounts Receivable (customer-tagged) and
 * reduces that invoice's open balance in the A/R subsidiary — so the aging⇔control
 * reconciliation keeps holding (GL-T018/T020). A credit memo that clears the invoice
 * marks it PAID; voiding reverses the entry and reopens the invoice. These tests prove
 * the accounting is exact, the guards hold, the subsidiary reflects the credit, and
 * tenancy is safe.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { CreditMemoError, getCreditMemo, issueCreditMemo, listCreditMemos, voidCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { LedgerError, assertLedgerIntegrity } from '@/server/ledger';
import { listOpenInvoices, receivePayment } from '@/server/payments';
import { closePeriod } from '@/server/periods';
import { getArAging, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput, voidCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput } from '@/validation/payment';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, assertReversalNetsToZero } from '../helpers/ledger-invariants';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  cashId: string;
  returnsId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'M',
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
    createCompanyInput.parse({ legalName: 'Credit Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const returns = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Returns & Allowances', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, cashId: cash.id, returnsId: returns.id };
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
async function memoEntries(companyId: string, memoId: string): Promise<EntryRow[]> {
  const db = await getTestDb();
  const r = await db.execute<EntryRow>(sql`
    select id, status, source_type, reversal_of_id
    from journal_entries
    where company_id = ${companyId}
      and (source_id = ${memoId}
           or reversal_of_id in (select id from journal_entries where company_id = ${companyId} and source_id = ${memoId}))
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

const cmErr = async (p: Promise<unknown>): Promise<CreditMemoError> => {
  try {
    await p;
    throw new Error('expected CreditMemoError');
  } catch (e) {
    expect(e).toBeInstanceOf(CreditMemoError);
    return e as CreditMemoError;
  }
};

const cm = (c: Ctx, invoiceId: string, amount: string, extra: Record<string, unknown> = {}) =>
  issueCreditMemoInput.parse({ invoiceId, revenueAccountId: c.returnsId, creditDate: '2026-02-01', amount, ...extra });

beforeEach(async () => {
  await truncateAll();
});

describe('issueCreditMemo — posts Dr Sales Returns / Cr A/R and reduces the subsidiary', () => {
  it('a full credit memo posts the entry, marks the invoice PAID, and clears A/R', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    expect(await arBalance(c)).toBe('100.0000');

    const memo = await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '100.00', { reason: 'returned goods' }));
    expect(memo.amount).toBe('100.0000');
    expect(memo.status).toBe('POSTED');
    expect(memo.customerId).toBe(c.customerId); // derived from the invoice

    const entries = await memoEntries(c.companyId, memo.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_type).toBe('CREDIT_MEMO');
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const lines = await linesOf(entries[0]!.id);
    expect(lines.find((l) => l.account_id === c.returnsId)?.debit).toBe('100.0000');
    const ar = lines.find((l) => l.account_id === arId);
    expect(ar?.credit).toBe('100.0000');
    expect(ar?.customer_id).toBe(c.customerId); // A/R line is customer-tagged (subsidiary sees it)

    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID'); // settled
    expect(await arBalance(c)).toBe('0.0000');
    expect(await auditCount(c.companyId, 'CREDIT_MEMO_ISSUED')).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a partial credit memo leaves the invoice OPEN and reduces its open balance and aging', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '30.00'));

    expect(await invoiceStatus(c.companyId, invId)).toBe('OPEN');
    expect(await arBalance(c)).toBe('70.0000'); // 100 − 30
    expect((await getArAging(c.userId, c.companyId, '2026-12-31')).totals.total).toBe('70.0000');
    const open = await listOpenInvoices(c.userId, c.companyId);
    expect(open.find((o) => o.id === invId)?.openBalance).toBe('70.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a payment and a credit memo together clear one invoice; the open balance respects both', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '60.00' }],
    }));
    expect(await arBalance(c)).toBe('40.0000');
    // Crediting 41 would exceed the remaining open balance.
    expect((await cmErr(issueCreditMemo(c.userId, c.companyId, cm(c, invId, '41.00')))).code).toBe('CREDIT_EXCEEDS_BALANCE');
    // Crediting exactly 40 settles it.
    await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '40.00'));
    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');
    expect(await arBalance(c)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('getCreditMemo returns it; listCreditMemos lists it; a cross-company id is a genuine miss', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '50.00');
    const memo = await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '50.00'));
    expect((await getCreditMemo(c.userId, c.companyId, memo.id))?.id).toBe(memo.id);
    expect((await listCreditMemos(c.userId, c.companyId)).map((m) => m.id)).toContain(memo.id);
    const other = await setup();
    expect(await getCreditMemo(other.userId, other.companyId, memo.id)).toBeNull();
  });

  it('a BOOKKEEPER (credit_memo.create) can issue a credit memo', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const memo = await issueCreditMemo(bookkeeper, c.companyId, cm(c, invId, '100.00'));
    expect(memo.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('issueCreditMemo — guards', () => {
  it('rejects crediting a DRAFT invoice (INVOICE_NOT_OPEN)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: '100.00' }],
    }));
    expect((await cmErr(issueCreditMemo(c.userId, c.companyId, cm(c, invoice.id, '100.00')))).code).toBe('INVOICE_NOT_OPEN');
  });

  it('rejects amount exceeding the open balance (CREDIT_EXCEEDS_BALANCE)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    expect((await cmErr(issueCreditMemo(c.userId, c.companyId, cm(c, invId, '100.01')))).code).toBe('CREDIT_EXCEEDS_BALANCE');
  });

  it('rejects a non-revenue account (CREDIT_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    // Cash is an ASSET, not a revenue account — cannot be the credit memo's debit.
    expect((await cmErr(issueCreditMemo(c.userId, c.companyId,
      issueCreditMemoInput.parse({ invoiceId: invId, revenueAccountId: c.cashId, creditDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('CREDIT_ACCOUNT_INVALID');
  });

  it('refuses to credit into a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00'); // finalize at 2026-01-10 creates the Jan period
    const db = await getTestDb();
    const p = await db.execute<{ id: string }>(sql`
      select id from accounting_periods where company_id = ${c.companyId} and '2026-01-15' between start_date and end_date limit 1`);
    await closePeriod(c.userId, c.companyId, p.rows[0]!.id);
    const err = await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '100.00', { creditDate: '2026-01-15' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('PERIOD_CLOSED');
  });

  it('a cross-company invoice id is a genuine miss (INVOICE_NOT_FOUND)', async () => {
    const a = await setup();
    const b = await setup();
    const invId = await openInvoice(a, '100.00');
    expect((await cmErr(issueCreditMemo(b.userId, b.companyId,
      issueCreditMemoInput.parse({ invoiceId: invId, revenueAccountId: b.returnsId, creditDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('INVOICE_NOT_FOUND');
  });
});

describe('voidCreditMemo — reverses the entry and reopens the invoice', () => {
  it('voids a credit memo: reversal nets to zero, memo VOID, PAID invoice back to OPEN, A/R restored', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const memo = await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '100.00'));
    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');

    const voided = await voidCreditMemo(c.userId, c.companyId, memo.id, voidCreditMemoInput.parse({ reason: 'issued in error' }));
    expect(voided.status).toBe('VOID');

    const entries = await memoEntries(c.companyId, memo.id);
    const original = entries.find((e) => e.source_type === 'CREDIT_MEMO')!;
    const reversal = entries.find((e) => e.source_type === 'REVERSAL')!;
    expect(original.status).toBe('REVERSED');
    await assertReversalNetsToZero(original.id, reversal.id);

    expect(await invoiceStatus(c.companyId, invId)).toBe('OPEN'); // reopened
    expect(await arBalance(c)).toBe('100.0000'); // receivable is owed again
    expect((await getArAging(c.userId, c.companyId, '2026-12-31')).totals.total).toBe('100.0000');
    expect(await auditCount(c.companyId, 'CREDIT_MEMO_VOIDED')).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (CREDIT_MEMO_NOT_POSTED)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const memo = await issueCreditMemo(c.userId, c.companyId, cm(c, invId, '40.00'));
    await voidCreditMemo(c.userId, c.companyId, memo.id, voidCreditMemoInput.parse({}));
    expect((await cmErr(voidCreditMemo(c.userId, c.companyId, memo.id, voidCreditMemoInput.parse({})))).code).toBe('CREDIT_MEMO_NOT_POSTED');
  });
});
