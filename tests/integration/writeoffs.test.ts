/**
 * Bad-debt write-offs — LL-050. Against a real database.
 *
 * Writing off an OPEN invoice (whole or part) posts Dr Bad Debt Expense / Cr
 * Accounts Receivable (customer-tagged) and reduces that invoice's open balance in
 * the A/R subsidiary — so the aging⇔control reconciliation keeps holding (GL-T018).
 * A write-off that clears the invoice marks it PAID; voiding reverses the entry and
 * reopens the invoice. These tests prove the accounting is exact, the guards hold,
 * the subsidiary reflects the write-off, and tenancy is safe.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { LedgerError, assertLedgerIntegrity } from '@/server/ledger';
import { listOpenInvoices, receivePayment } from '@/server/payments';
import { closePeriod } from '@/server/periods';
import { getArAging, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { WriteoffError, getWriteoff, listWriteoffs, voidWriteoff, writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput } from '@/validation/payment';
import { voidWriteoffInput, writeOffInvoiceInput } from '@/validation/writeoff';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, assertReversalNetsToZero } from '../helpers/ledger-invariants';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  cashId: string;
  badDebtId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `wo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'W',
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
    createCompanyInput.parse({ legalName: 'Writeoff Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, cashId: cash.id, badDebtId: badDebt.id };
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
async function writeoffEntries(companyId: string, writeoffId: string): Promise<EntryRow[]> {
  const db = await getTestDb();
  const r = await db.execute<EntryRow>(sql`
    select id, status, source_type, reversal_of_id
    from journal_entries
    where company_id = ${companyId}
      and (source_id = ${writeoffId}
           or reversal_of_id in (select id from journal_entries where company_id = ${companyId} and source_id = ${writeoffId}))
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

const woErr = async (p: Promise<unknown>): Promise<WriteoffError> => {
  try {
    await p;
    throw new Error('expected WriteoffError');
  } catch (e) {
    expect(e).toBeInstanceOf(WriteoffError);
    return e as WriteoffError;
  }
};

const wo = (c: Ctx, invoiceId: string, amount: string, extra: Record<string, unknown> = {}) =>
  writeOffInvoiceInput.parse({ invoiceId, expenseAccountId: c.badDebtId, writeoffDate: '2026-02-01', amount, ...extra });

beforeEach(async () => {
  await truncateAll();
});

describe('writeOffInvoice — posts Dr Bad Debt Expense / Cr A/R and reduces the subsidiary', () => {
  it('a full write-off posts the entry, marks the invoice PAID, and clears A/R', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    expect(await arBalance(c)).toBe('100.0000');

    const writeoff = await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '100.00', { reason: 'insolvent' }));
    expect(writeoff.amount).toBe('100.0000');
    expect(writeoff.status).toBe('POSTED');
    expect(writeoff.customerId).toBe(c.customerId); // derived from the invoice

    const entries = await writeoffEntries(c.companyId, writeoff.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_type).toBe('BAD_DEBT_WRITEOFF');
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const lines = await linesOf(entries[0]!.id);
    expect(lines.find((l) => l.account_id === c.badDebtId)?.debit).toBe('100.0000');
    const ar = lines.find((l) => l.account_id === arId);
    expect(ar?.credit).toBe('100.0000');
    expect(ar?.customer_id).toBe(c.customerId); // A/R line is customer-tagged (subsidiary sees it)

    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID'); // settled
    expect(await arBalance(c)).toBe('0.0000');
    expect(await auditCount(c.companyId, 'WRITEOFF_POSTED')).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a partial write-off leaves the invoice OPEN and reduces its open balance and aging', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '30.00'));

    expect(await invoiceStatus(c.companyId, invId)).toBe('OPEN');
    expect(await arBalance(c)).toBe('70.0000'); // 100 − 30
    // The subsidiary (aging and listOpenInvoices) reflects the write-off.
    expect((await getArAging(c.userId, c.companyId, '2026-12-31')).totals.total).toBe('70.0000');
    const open = await listOpenInvoices(c.userId, c.companyId);
    expect(open.find((o) => o.id === invId)?.openBalance).toBe('70.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a payment and a write-off together clear one invoice; the open balance respects both', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    // Pay 60, write off the remaining 40.
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invId, amountApplied: '60.00' }],
    }));
    expect(await arBalance(c)).toBe('40.0000');
    // Writing off 41 would exceed the remaining open balance.
    expect((await woErr(writeOffInvoice(c.userId, c.companyId, wo(c, invId, '41.00')))).code).toBe('WRITEOFF_EXCEEDS_BALANCE');
    // Writing off exactly 40 settles it.
    await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '40.00'));
    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');
    expect(await arBalance(c)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('getWriteoff returns it; listWriteoffs lists it; a cross-company id is a genuine miss', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '50.00');
    const writeoff = await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '50.00'));
    expect((await getWriteoff(c.userId, c.companyId, writeoff.id))?.id).toBe(writeoff.id);
    expect((await listWriteoffs(c.userId, c.companyId)).map((w) => w.id)).toContain(writeoff.id);
    const other = await setup();
    expect(await getWriteoff(other.userId, other.companyId, writeoff.id)).toBeNull();
  });

  it('a BOOKKEEPER (writeoff.create) can write off an invoice', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const writeoff = await writeOffInvoice(bookkeeper, c.companyId, wo(c, invId, '100.00'));
    expect(writeoff.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('writeOffInvoice — guards', () => {
  it('rejects writing off a DRAFT invoice (INVOICE_NOT_OPEN)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: '100.00' }],
    }));
    expect((await woErr(writeOffInvoice(c.userId, c.companyId, wo(c, invoice.id, '100.00')))).code).toBe('INVOICE_NOT_OPEN');
  });

  it('rejects amount exceeding the open balance (WRITEOFF_EXCEEDS_BALANCE)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    expect((await woErr(writeOffInvoice(c.userId, c.companyId, wo(c, invId, '100.01')))).code).toBe('WRITEOFF_EXCEEDS_BALANCE');
  });

  it('rejects a non-expense account (WRITEOFF_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    // Cash is an ASSET, not an expense — cannot be the write-off's debit.
    expect((await woErr(writeOffInvoice(c.userId, c.companyId,
      writeOffInvoiceInput.parse({ invoiceId: invId, expenseAccountId: c.cashId, writeoffDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('WRITEOFF_ACCOUNT_INVALID');
  });

  it('rejects Accounts Receivable as the expense account (WRITEOFF_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE'); // an ASSET control account
    expect((await woErr(writeOffInvoice(c.userId, c.companyId,
      writeOffInvoiceInput.parse({ invoiceId: invId, expenseAccountId: arId, writeoffDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('WRITEOFF_ACCOUNT_INVALID');
  });

  it('refuses to write off into a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00'); // finalize at 2026-01-10 creates the Jan period
    const db = await getTestDb();
    const p = await db.execute<{ id: string }>(sql`
      select id from accounting_periods where company_id = ${c.companyId} and '2026-01-15' between start_date and end_date limit 1`);
    await closePeriod(c.userId, c.companyId, p.rows[0]!.id);
    const err = await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '100.00', { writeoffDate: '2026-01-15' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('PERIOD_CLOSED');
  });

  it('a cross-company invoice id is a genuine miss (INVOICE_NOT_FOUND)', async () => {
    const a = await setup();
    const b = await setup();
    const invId = await openInvoice(a, '100.00');
    // b, scoped to its own company, cannot see a's invoice.
    expect((await woErr(writeOffInvoice(b.userId, b.companyId,
      writeOffInvoiceInput.parse({ invoiceId: invId, expenseAccountId: b.badDebtId, writeoffDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('INVOICE_NOT_FOUND');
  });
});

describe('voidWriteoff — reverses the entry and reopens the invoice', () => {
  it('voids a write-off: reversal nets to zero, write-off VOID, PAID invoice back to OPEN, A/R restored', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const writeoff = await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '100.00'));
    expect(await invoiceStatus(c.companyId, invId)).toBe('PAID');

    const voided = await voidWriteoff(c.userId, c.companyId, writeoff.id, voidWriteoffInput.parse({ reason: 'recovered' }));
    expect(voided.status).toBe('VOID');

    const entries = await writeoffEntries(c.companyId, writeoff.id);
    const original = entries.find((e) => e.source_type === 'BAD_DEBT_WRITEOFF')!;
    const reversal = entries.find((e) => e.source_type === 'REVERSAL')!;
    expect(original.status).toBe('REVERSED');
    await assertReversalNetsToZero(original.id, reversal.id);

    expect(await invoiceStatus(c.companyId, invId)).toBe('OPEN'); // reopened
    expect(await arBalance(c)).toBe('100.0000'); // receivable is owed again
    expect((await getArAging(c.userId, c.companyId, '2026-12-31')).totals.total).toBe('100.0000');
    expect(await auditCount(c.companyId, 'WRITEOFF_VOIDED')).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (WRITEOFF_NOT_POSTED)', async () => {
    const c = await setup();
    const invId = await openInvoice(c, '100.00');
    const writeoff = await writeOffInvoice(c.userId, c.companyId, wo(c, invId, '40.00'));
    await voidWriteoff(c.userId, c.companyId, writeoff.id, voidWriteoffInput.parse({}));
    expect((await woErr(voidWriteoff(c.userId, c.companyId, writeoff.id, voidWriteoffInput.parse({})))).code).toBe('WRITEOFF_NOT_POSTED');
  });

  it('a cross-company write-off id is a genuine miss (WRITEOFF_NOT_FOUND)', async () => {
    const a = await setup();
    const b = await setup();
    const invId = await openInvoice(a, '100.00');
    const writeoff = await writeOffInvoice(a.userId, a.companyId, wo(a, invId, '100.00'));
    expect((await woErr(voidWriteoff(b.userId, b.companyId, writeoff.id, voidWriteoffInput.parse({})))).code).toBe('WRITEOFF_NOT_FOUND');
  });
});
