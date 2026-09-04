/**
 * Invoice finalize → post → void — LL-042. Against a real database.
 *
 * Finalizing a DRAFT invoice assigns its number, transitions it to OPEN, and
 * posts the balanced entry (Dr Accounts Receivable / Cr Revenue by account / Cr
 * Sales Tax Payable) through the ledger — atomically and source-once. Voiding an
 * OPEN invoice reverses that entry (netting every account to zero) and marks the
 * invoice VOID. These tests prove the accounting is exact, the authorization
 * honors the documented "a bookkeeper posts invoices" intent, and the tenancy
 * and period rules hold.
 */
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { assertLedgerIntegrity } from '@/server/ledger';
import { LedgerError } from '@/server/ledger';
import {
  InvoiceError,
  computeInvoicePosting,
  createInvoice,
  finalizeInvoice,
  voidInvoice,
} from '@/server/invoices';
import { closePeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, assertReversalNetsToZero } from '../helpers/ledger-invariants';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  serviceRevId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `invp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'P',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(chart: 'standard' | 'system-only' = 'standard'): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Inv Co', timezone: 'America/Chicago' }),
    chart,
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const rev2 = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Service Revenue', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, serviceRevId: rev2.id };
}

function draft(c: Ctx, lines: { accountId: string; quantity?: string; unitPrice: string; taxRate?: string }[]) {
  return createInvoiceInput.parse({ customerId: c.customerId, invoiceDate: '2026-01-10', lines });
}

async function sysAccount(companyId: string, type: string): Promise<string | null> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]?.id ?? null;
}

type EntryRow = {
  id: string;
  status: string;
  source_type: string;
  source_id: string | null;
  reversal_of_id: string | null;
};
async function invoiceEntries(companyId: string, invoiceId: string): Promise<EntryRow[]> {
  const db = await getTestDb();
  // The invoice's own posted/reversed entry, plus any REVERSAL pointing at it.
  const r = await db.execute<EntryRow>(sql`
    select id, status, source_type, source_id, reversal_of_id
    from journal_entries
    where company_id = ${companyId}
      and (source_id = ${invoiceId}
           or reversal_of_id in (select id from journal_entries where company_id = ${companyId} and source_id = ${invoiceId}))
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

async function auditCount(companyId: string, action: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from audit_events where company_id = ${companyId} and action = ${action}`,
  );
  return Number(r.rows[0]?.n);
}

const errOf = async (p: Promise<unknown>): Promise<InvoiceError> => {
  try {
    await p;
    throw new Error('expected InvoiceError');
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceError);
    return e as InvoiceError;
  }
};

async function closePeriodOf(userId: string, companyId: string, date: string): Promise<void> {
  const db = await getTestDb();
  const p = await db.execute<{ id: string }>(sql`
    select id from accounting_periods
    where company_id = ${companyId} and ${date} between start_date and end_date limit 1`);
  const periodId = p.rows[0]?.id;
  if (periodId === undefined) throw new Error(`no period covering ${date}`);
  await closePeriod(userId, companyId, periodId);
}

beforeEach(async () => {
  await truncateAll();
});

describe('computeInvoicePosting (pure) — revenue grouped by account, balanced', () => {
  it('groups multiple lines to the same account and sums tax exactly', () => {
    const p = computeInvoicePosting([
      { accountId: 'a', quantity: '2', unitPrice: '100.00', taxRate: '10' },
      { accountId: 'a', quantity: '1', unitPrice: '25.00', taxRate: '10' }, // same account → merged
      { accountId: 'b', quantity: '1', unitPrice: '50.00', taxRate: '0' },
    ]);
    expect(p.subtotal).toBe('275.0000'); // 200 + 25 + 50
    expect(p.taxTotal).toBe('22.5000'); // (200+25)*10% = 22.5
    expect(p.total).toBe('297.5000');
    // Two distinct accounts, first-appearance order; 'a' merged to 225.
    expect(p.revenueByAccount).toEqual([
      { accountId: 'a', amount: '225.0000' },
      { accountId: 'b', amount: '50.0000' },
    ]);
    // The credits (revenue + tax) sum to the A/R debit (total), exactly — summed
    // with decimal.js, never JS floats (ADR-004).
    const credits = p.revenueByAccount.reduce((s, r) => s.plus(r.amount), new Decimal(p.taxTotal));
    expect(credits.toFixed(4)).toBe(p.total);
  });

  it('rounds each line to 4dp (ROUND_HALF_EVEN) and keeps subtotal = sum(revenueByAccount)', () => {
    // Fractional quantity × odd unit price — where hand rounding drifts.
    const p = computeInvoicePosting([
      { accountId: 'a', quantity: '2.5', unitPrice: '3.3333', taxRate: '8.25' },
      { accountId: 'b', quantity: '3', unitPrice: '19.99', taxRate: '8.25' },
    ]);
    // amount_a = 2.5 × 3.3333 = 8.33325 → 8.3332 (exactly half → round to EVEN, not 8.3333);
    // amount_b = 3 × 19.99 = 59.9700.
    expect(p.revenueByAccount).toEqual([
      { accountId: 'a', amount: '8.3332' },
      { accountId: 'b', amount: '59.9700' },
    ]);
    expect(p.subtotal).toBe('68.3032'); // 8.3332 + 59.9700
    // subtotal is exactly the sum of the per-account revenue credits (decimal.js).
    const sum = p.revenueByAccount.reduce((s, r) => s.plus(r.amount), new Decimal(0));
    expect(sum.toFixed(4)).toBe(p.subtotal);
    // total = subtotal + tax (the relation the finalize's balance depends on).
    expect(p.total).toBe(new Decimal(p.subtotal).plus(p.taxTotal).toFixed(4));
  });
});

describe('finalize — posts a correct, balanced, source-once entry', () => {
  it('posts Dr A/R (customer-tagged) / Cr revenue by account / Cr tax, opens + numbers the invoice', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [
      { accountId: c.revId, quantity: '2', unitPrice: '100.00', taxRate: '10' }, // 200 + 20 tax
      { accountId: c.serviceRevId, quantity: '1', unitPrice: '50.00' }, // 50, no tax
    ]));

    const { invoice: finalized } = await finalizeInvoice(c.userId, c.companyId, invoice.id);
    expect(finalized.status).toBe('OPEN');
    expect(finalized.invoiceNumber).not.toBeNull();
    expect(finalized.total).toBe('270.0000');

    const entries = await invoiceEntries(c.companyId, invoice.id);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.status).toBe('POSTED');
    expect(entry.source_type).toBe('INVOICE');
    expect(entry.source_id).toBe(invoice.id);

    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const taxId = await sysAccount(c.companyId, 'SALES_TAX_PAYABLE');
    const lines = await linesOf(entry.id);
    // Dr A/R = total, tagged with the customer.
    const ar = lines.find((l) => l.account_id === arId);
    expect(ar?.debit).toBe('270.0000');
    expect(ar?.credit).toBe('0.0000');
    expect(ar?.customer_id).toBe(c.customerId);
    // Cr revenue by account.
    expect(lines.find((l) => l.account_id === c.revId)?.credit).toBe('200.0000');
    expect(lines.find((l) => l.account_id === c.serviceRevId)?.credit).toBe('50.0000');
    // Cr Sales Tax Payable = tax.
    expect(lines.find((l) => l.account_id === taxId)?.credit).toBe('20.0000');

    // The A/R debit equals the stored total equals a fresh recompute (ADR-013/-014).
    const lineRows = [
      { accountId: c.revId, quantity: '2', unitPrice: '100.00', taxRate: '10' },
      { accountId: c.serviceRevId, quantity: '1', unitPrice: '50.00', taxRate: '0' },
    ];
    expect(ar?.debit).toBe(finalized.total);
    expect(finalized.total).toBe(computeInvoicePosting(lineRows).total);

    expect(await auditCount(c.companyId, 'INVOICE_FINALIZED')).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a tax-free invoice posts with no Sales Tax Payable line', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    const entry = (await invoiceEntries(c.companyId, invoice.id))[0]!;
    const taxId = await sysAccount(c.companyId, 'SALES_TAX_PAYABLE');
    const lines = await linesOf(entry.id);
    expect(lines).toHaveLength(2); // Dr A/R + Cr revenue only
    expect(lines.some((l) => l.account_id === taxId)).toBe(false);
    await assertLedgerIntegrity(c.companyId);
  });

  it('merges multiple lines on the same revenue account into ONE credit line', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [
      { accountId: c.revId, quantity: '1', unitPrice: '100.00' },
      { accountId: c.revId, quantity: '1', unitPrice: '25.00' }, // same account → merged
      { accountId: c.serviceRevId, unitPrice: '50.00' },
    ]));
    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    const entry = (await invoiceEntries(c.companyId, invoice.id))[0]!;
    const lines = await linesOf(entry.id);
    // One credit line for revId (100 + 25 = 125), one for serviceRevId, plus Dr A/R.
    const revLines = lines.filter((l) => l.account_id === c.revId);
    expect(revLines).toHaveLength(1);
    expect(revLines[0]?.credit).toBe('125.0000');
    expect(lines.filter((l) => l.account_id === c.serviceRevId)).toHaveLength(1);
    expect(lines).toHaveLength(3); // Dr A/R + 2 merged revenue credits, no tax line
    await assertLedgerIntegrity(c.companyId);
  });

  it('finalizing twice is rejected — one posted entry per invoice (INVOICE_NOT_DRAFT)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    expect((await errOf(finalizeInvoice(c.userId, c.companyId, invoice.id))).code).toBe('INVOICE_NOT_DRAFT');
    // Still exactly one posted entry for the invoice.
    expect(await invoiceEntries(c.companyId, invoice.id)).toHaveLength(1);
  });

  it('refuses to finalize a zero-total invoice (INVOICE_ZERO_TOTAL)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '0' }]));
    expect((await errOf(finalizeInvoice(c.userId, c.companyId, invoice.id))).code).toBe('INVOICE_ZERO_TOTAL');
    expect(await invoiceEntries(c.companyId, invoice.id)).toHaveLength(0);
  });
});

describe('finalize — authorization honors "a bookkeeper posts invoices"', () => {
  it('a BOOKKEEPER (invoice.post, but NOT journal.post) can finalize an invoice', async () => {
    const c = await setup();
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00', taxRate: '10' }]));
    // The posting goes through postEntryCore, which does NOT re-gate on journal.post.
    const { invoice: finalized } = await finalizeInvoice(bookkeeper, c.companyId, invoice.id);
    expect(finalized.status).toBe('OPEN');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a READ_ONLY member cannot finalize', async () => {
    const c = await setup();
    const reader = await makeUser();
    await insertMembership(c.companyId, reader, 'READ_ONLY');
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    await expect(finalizeInvoice(reader, c.companyId, invoice.id)).rejects.toThrow();
    expect(await invoiceEntries(c.companyId, invoice.id)).toHaveLength(0);
  });
});

describe('finalize — period and account preconditions', () => {
  it('refuses to finalize into a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    // Finalize one invoice to create the period, then close it.
    const a = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    await finalizeInvoice(c.userId, c.companyId, a.invoice.id);
    await closePeriodOf(c.userId, c.companyId, '2026-01-10');

    const b = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '50.00' }]));
    const err = await finalizeInvoice(c.userId, c.companyId, b.invoice.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('PERIOD_CLOSED');
    // b never posted.
    expect(await invoiceEntries(c.companyId, b.invoice.id)).toHaveLength(0);
  });

  it('a taxed invoice on a company with no Sales Tax Payable account (TAX_ACCOUNT_NOT_CONFIGURED)', async () => {
    // system-only chart has A/R but NO Sales Tax Payable account.
    const c = await setup('system-only');
    const taxed = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00', taxRate: '8.25' }]));
    expect((await errOf(finalizeInvoice(c.userId, c.companyId, taxed.invoice.id))).code).toBe('TAX_ACCOUNT_NOT_CONFIGURED');
    // A tax-FREE invoice still posts fine (A/R exists).
    const free = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    await finalizeInvoice(c.userId, c.companyId, free.invoice.id);
    await assertLedgerIntegrity(c.companyId);
  });

  it('surfaces a missing Accounts Receivable account (AR_ACCOUNT_NOT_CONFIGURED)', async () => {
    const c = await setup();
    // Contrived: strip the A/R system flag so resolution finds nothing.
    const db = await getTestDb();
    await db.execute(sql`update accounts set system_account_type = null where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_RECEIVABLE'`);
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    expect((await errOf(finalizeInvoice(c.userId, c.companyId, invoice.id))).code).toBe('AR_ACCOUNT_NOT_CONFIGURED');
  });
});

describe('void — reverses the entry, nets to zero, marks the invoice VOID', () => {
  it('voids an OPEN invoice: reversal nets every account to zero and the trial balance returns', async () => {
    const c = await setup();
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [
      { accountId: c.revId, quantity: '2', unitPrice: '100.00', taxRate: '10' },
    ]));

    // Trial balance before finalize: A/R is zero.
    const before = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(before.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000').toBe('0.0000');

    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    const afterPost = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(afterPost.rows.find((r) => r.accountId === arId)?.balance).toBe('220.0000'); // 200 + 20 tax

    const { invoice: voided } = await voidInvoice(c.userId, c.companyId, invoice.id, voidInvoiceInput.parse({ reason: 'mistake' }));
    expect(voided.status).toBe('VOID');

    const entries = await invoiceEntries(c.companyId, invoice.id);
    const original = entries.find((e) => e.source_type === 'INVOICE')!;
    const reversal = entries.find((e) => e.source_type === 'REVERSAL')!;
    expect(original.status).toBe('REVERSED');
    expect(reversal.reversal_of_id).toBe(original.id);
    await assertReversalNetsToZero(original.id, reversal.id);

    // The trial balance returns to its pre-finalize state.
    const afterVoid = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(afterVoid.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000').toBe('0.0000');
    expect(afterVoid.balanced).toBe(true);

    expect(await auditCount(c.companyId, 'INVOICE_VOIDED')).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (INVOICE_NOT_OPEN)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    await voidInvoice(c.userId, c.companyId, invoice.id, voidInvoiceInput.parse({}));
    expect((await errOf(voidInvoice(c.userId, c.companyId, invoice.id, voidInvoiceInput.parse({})))).code).toBe('INVOICE_NOT_OPEN');
  });

  it('a DRAFT invoice cannot be voided (INVOICE_NOT_OPEN)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '100.00' }]));
    expect((await errOf(voidInvoice(c.userId, c.companyId, invoice.id, voidInvoiceInput.parse({})))).code).toBe('INVOICE_NOT_OPEN');
  });
});

describe('tenancy — cross-company ids read as a genuine miss', () => {
  it('finalize/void of another company’s invoice id returns INVOICE_NOT_FOUND', async () => {
    const a = await setup();
    const b = await setup();
    const { invoice } = await createInvoice(a.userId, a.companyId, draft(a, [{ accountId: a.revId, unitPrice: '100.00' }]));
    // b, scoped to b's company, sees a's invoice as a genuine miss.
    expect((await errOf(finalizeInvoice(b.userId, b.companyId, invoice.id))).code).toBe('INVOICE_NOT_FOUND');
    expect((await errOf(voidInvoice(b.userId, b.companyId, invoice.id, voidInvoiceInput.parse({})))).code).toBe('INVOICE_NOT_FOUND');
  });
});
