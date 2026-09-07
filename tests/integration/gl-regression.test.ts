/**
 * GENERAL LEDGER REGRESSION SUITE — LL-036. Release-blocking.
 *
 * The single canonical statement of the accounting invariants, GL-T001..GL-T015.
 * Coverage exists in scattered form across LL-030..LL-035; this file is the one
 * place a reviewer (or a gate) can read the whole contract and the one check that
 * blocks a merge if any invariant regresses.
 *
 * Two rules every case in here follows:
 *   1. Assert the SPECIFIC error code, never merely that something threw. "It
 *      threw" hides a wrong-reason pass; the code is the contract.
 *   2. End by auditing the ledger with all four LL-034 integrity helpers
 *      (`assertLedgerIntegrity`) — so a case that "passes" while leaving the books
 *      corrupt still fails. The integration teardown does this too; doing it
 *      inline makes each invariant's guarantee explicit and self-contained.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { toMoney } from '@/lib/decimal';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { createCustomer } from '@/server/customers';
import { payBill, voidBillPayment } from '@/server/bill-payments';
import { createBill, finalizeBill, voidBill } from '@/server/bills';
import { createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { createVendor } from '@/server/vendors';
import { issueVendorCredit, voidVendorCredit } from '@/server/vendor-credits';
import { issueCreditMemo, voidCreditMemo } from '@/server/credit-memos';
import { receivePayment, voidPayment } from '@/server/payments';
import { voidWriteoff, writeOffInvoice } from '@/server/writeoffs';
import {
  assertLedgerIntegrity,
  getJournalEntry,
  LedgerError,
  postJournalEntry,
  reverseJournalEntry,
} from '@/server/ledger';
import { closePeriod } from '@/server/periods';
import { getApAging, getArAging, getCustomerStatement, getTrialBalance, getVendorStatement } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { issueCreditMemoInput, voidCreditMemoInput } from '@/validation/credit-memo';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';
import { voidWriteoffInput, writeOffInvoiceInput } from '@/validation/writeoff';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { payBillInput, voidBillPaymentInput } from '@/validation/bill-payment';
import { issueVendorCreditInput, voidVendorCreditInput } from '@/validation/vendor-credit';
import { createVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertReversalNetsToZero } from '../helpers/ledger-invariants';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  revId: string;
  expenseId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `gl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'G',
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
    createCompanyInput.parse({ legalName: 'GL Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  const exp = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id, expenseId: exp.id };
}

function post(
  c: Ctx,
  lines: { accountId: string; debit?: string; credit?: string }[],
  extra: Record<string, unknown> = {},
) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: '2026-01-10',
      sourceType: 'JOURNAL_ENTRY',
      lines,
      ...extra,
    }),
  );
}

/** Runs a promise expected to throw a LedgerError; returns its code. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    throw new Error('expected a LedgerError, but the call resolved');
  } catch (e) {
    expect(e, `expected a LedgerError, got: ${String(e)}`).toBeInstanceOf(LedgerError);
    return (e as LedgerError).code;
  }
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from journal_entries where company_id = ${companyId}`,
  );
  return Number(r.rows[0]?.n);
}

beforeEach(async () => {
  await truncateAll();
});

describe('GL regression suite (release-blocking)', () => {
  it('GL-T001 — a balanced entry posts successfully', async () => {
    const c = await setup();
    const { entry, lines } = await post(c, [
      { accountId: c.cashId, debit: '100.0000' },
      { accountId: c.revId, credit: '100.0000' },
    ]);
    expect(entry.status).toBe('POSTED');
    expect(entry.entryNumber).toBe(1);
    expect(lines).toHaveLength(2);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T002 — an unbalanced entry is rejected (UNBALANCED_JOURNAL_ENTRY)', async () => {
    const c = await setup();
    expect(await codeOf(post(c, [
      { accountId: c.cashId, debit: '100.0000' },
      { accountId: c.revId, credit: '99.9999' },
    ]))).toBe('UNBALANCED_JOURNAL_ENTRY');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T003 — a cross-company account reference is rejected (ACCOUNT_NOT_FOUND)', async () => {
    const c = await setup();
    const other = await setup();
    expect(await codeOf(post(c, [
      { accountId: other.cashId, debit: '5.0000' }, // another company's account
      { accountId: c.revId, credit: '5.0000' },
    ]))).toBe('ACCOUNT_NOT_FOUND');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
    await assertLedgerIntegrity(other.companyId);
  });

  it('GL-T004 — posting into a closed period is rejected (PERIOD_CLOSED)', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '1' }, { accountId: c.revId, credit: '1' }]);
    const db = await getTestDb();
    const p = await db.execute<{ id: string }>(
      sql`select id from accounting_periods where company_id = ${c.companyId} limit 1`,
    );
    await closePeriod(c.userId, c.companyId, p.rows[0]!.id);
    expect(await codeOf(post(c, [
      { accountId: c.cashId, debit: '1' },
      { accountId: c.revId, credit: '1' },
    ]))).toBe('PERIOD_CLOSED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T005 — a duplicate idempotency key does not duplicate a posting', async () => {
    const c = await setup();
    const key = 'idem-GL-T005';
    const first = await post(c, [
      { accountId: c.cashId, debit: '10' },
      { accountId: c.revId, credit: '10' },
    ], { sourceType: 'INVOICE', sourceId: 'INV-5', idempotencyKey: key });
    const second = await post(c, [
      { accountId: c.cashId, debit: '10' },
      { accountId: c.revId, credit: '10' },
    ], { sourceType: 'INVOICE', sourceId: 'INV-5', idempotencyKey: key });
    expect(second.entry.id).toBe(first.entry.id); // the same entry, not a new one
    expect(await entryCount(c.companyId)).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T006 — a reversal exactly negates the original', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '250.0000' },
      { accountId: c.expenseId, debit: '50.0000' },
      { accountId: c.revId, credit: '300.0000' },
    ]);
    const { entry: rvsl } = await reverseJournalEntry(
      reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId: orig.id }),
    );
    // The decisive assertion: original + reversal nets to exactly zero on every account.
    await assertReversalNetsToZero(orig.id, rvsl.id);
    const db = await getTestDb();
    const reloaded = await db.execute<{ status: string }>(
      sql`select status from journal_entries where id = ${orig.id}`,
    );
    expect(reloaded.rows[0]?.status).toBe('REVERSED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T007 — editing a posted entry is rejected (POSTED_ENTRY_IMMUTABLE at the database)', async () => {
    const c = await setup();
    const { entry } = await post(c, [
      { accountId: c.cashId, debit: '1' },
      { accountId: c.revId, credit: '1' },
    ]);
    const db = await getTestDb();
    // Bypass every service and attack the table directly; the trigger must refuse.
    let chain = '';
    try {
      await db.execute(sql`update journal_entries set description = 'tampered' where id = ${entry.id}`);
      throw new Error('the database allowed a posted entry to be edited');
    } catch (e) {
      const seen = new Set<unknown>();
      let cur: unknown = e;
      while (cur instanceof Error && !seen.has(cur)) {
        seen.add(cur);
        chain += ' ' + cur.message;
        cur = (cur as { cause?: unknown }).cause;
      }
    }
    expect(chain).toMatch(/POSTED_ENTRY_IMMUTABLE/);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T008 — zero-line and single-line postings are rejected', async () => {
    const c = await setup();
    // Zod rejects both at the boundary (min 2 lines), before the service.
    const zero = postJournalEntryInput.safeParse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-10',
      sourceType: 'JOURNAL_ENTRY', lines: [],
    });
    expect(zero.success).toBe(false);
    const single = postJournalEntryInput.safeParse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-10',
      sourceType: 'JOURNAL_ENTRY', lines: [{ accountId: c.cashId, debit: '10' }],
    });
    expect(single.success).toBe(false);
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T009 — posting to an inactive account is rejected (INACTIVE_ACCOUNT)', async () => {
    const c = await setup();
    const db = await getTestDb();
    await db.execute(sql`update accounts set status = 'INACTIVE' where id = ${c.expenseId}`);
    expect(await codeOf(post(c, [
      { accountId: c.expenseId, debit: '5' },
      { accountId: c.revId, credit: '5' },
    ]))).toBe('INACTIVE_ACCOUNT');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T010 — the tenant boundary fails safely and leaks no existence', async () => {
    const a = await setup();
    const b = await setup();
    const { entry } = await post(a, [
      { accountId: a.cashId, debit: '9' },
      { accountId: a.revId, credit: '9' },
    ]);
    // b reads a's entry id, scoped to b's own company: identical to a genuine miss.
    const foreign = await getJournalEntry(b.userId, b.companyId, entry.id);
    const missing = await getJournalEntry(b.userId, b.companyId, '00000000-0000-0000-0000-000000000000');
    expect(foreign).toBeNull();
    expect(missing).toBeNull();
    // b reverses a's entry, scoped to b: ENTRY_NOT_FOUND, never a cross-tenant write.
    expect(await codeOf(reverseJournalEntry(
      reverseJournalEntryInput.parse({ companyId: b.companyId, actorUserId: b.userId, entryId: entry.id }),
    ))).toBe('ENTRY_NOT_FOUND');
    // a's entry is untouched.
    const db = await getTestDb();
    const still = await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${entry.id}`);
    expect(still.rows[0]?.status).toBe('POSTED');
    await assertLedgerIntegrity(a.companyId);
    await assertLedgerIntegrity(b.companyId);
  });

  it('GL-T011 — decimal precision remains exact at four places', async () => {
    const c = await setup();
    // Amounts a float representation cannot hold exactly, that must still balance.
    await post(c, [
      { accountId: c.cashId, debit: '0.1000' },
      { accountId: c.expenseId, debit: '0.2000' },
      { accountId: c.revId, credit: '0.3000' },
    ]);
    await post(c, [
      { accountId: c.cashId, debit: '0.3333' },
      { accountId: c.expenseId, debit: '0.3333' },
      { accountId: c.cashId, debit: '0.3334' },
      { accountId: c.revId, credit: '1.0000' },
    ]);
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebits).toBe(tb.totalCredits);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T012 — a failed transaction leaves no partial records', async () => {
    const c = await setup();
    const db = await getTestDb();
    // Remove the counter so allocateEntryNumber throws AFTER the tx opened and the
    // company/account/period checks passed. The whole transaction must roll back.
    await db.execute(sql`delete from company_counters where company_id = ${c.companyId}`);
    await codeOf(post(c, [
      { accountId: c.cashId, debit: '5' },
      { accountId: c.revId, credit: '5' },
    ]));
    expect(await entryCount(c.companyId)).toBe(0);
    const lines = await db.execute<{ n: string }>(
      sql`select count(*)::text n from journal_lines where company_id = ${c.companyId}`,
    );
    expect(Number(lines.rows[0]?.n)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T013 — journal source linkage is preserved through reversal', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '40' },
      { accountId: c.revId, credit: '40' },
    ], { sourceType: 'INVOICE', sourceId: 'INV-13', idempotencyKey: 'idem-GL-T013' });

    const { entry: rvsl } = await reverseJournalEntry(
      reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId: orig.id }),
    );
    // The reversal points back at the original (authoritative + source mirror), and
    // the original records which entry reversed it — the linkage survives.
    expect(rvsl.reversalOfId).toBe(orig.id);
    expect(rvsl.sourceType).toBe('REVERSAL');
    expect(rvsl.sourceId).toBe(orig.id);
    const db = await getTestDb();
    const back = await db.execute<{ reversed_by_id: string; status: string }>(
      sql`select reversed_by_id, status from journal_entries where id = ${orig.id}`,
    );
    expect(back.rows[0]?.reversed_by_id).toBe(rvsl.id);
    expect(back.rows[0]?.status).toBe('REVERSED');
    await assertReversalNetsToZero(orig.id, rvsl.id);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T014 — concurrent identical postings produce exactly one entry', async () => {
    const c = await setup();
    const args = {
      sourceType: 'INVOICE' as const,
      sourceId: 'INV-14',
      idempotencyKey: 'idem-GL-T014',
    };
    const results = await Promise.allSettled([
      post(c, [{ accountId: c.cashId, debit: '15' }, { accountId: c.revId, credit: '15' }], args),
      post(c, [{ accountId: c.cashId, debit: '15' }, { accountId: c.revId, credit: '15' }], args),
      post(c, [{ accountId: c.cashId, debit: '15' }, { accountId: c.revId, credit: '15' }], args),
    ]);
    // Every attempt that resolves resolves to the SAME entry; none creates a second.
    const ids = new Set(
      results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.entry.id] : [])),
    );
    expect(ids.size).toBe(1);
    expect(await entryCount(c.companyId)).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T015 — the trial balance derives correctly and balances', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '100.0000' }, { accountId: c.revId, credit: '100.0000' }]);
    await post(c, [{ accountId: c.expenseId, debit: '30.0000' }, { accountId: c.cashId, credit: '30.0000' }]);
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    // Cash: 100 debit − 30 credit = 70 (ASSET, debit-natural).
    const cash = tb.rows.find((r) => r.accountId === c.cashId);
    expect(cash?.balance).toBe('70.0000');
    expect(tb.totalDebits).toBe('130.0000');
    expect(tb.totalCredits).toBe('130.0000');
    expect(tb.balanced).toBe(true);
    await assertLedgerIntegrity(c.companyId);
  });

  it('GL-T016 — an invoice finalizes to a balanced, source-once ledger entry (LL-042)', async () => {
    // Needs the STANDARD chart so A/R and Sales Tax Payable exist for the posting
    // (the shared setup() installs no chart — its tests create their own accounts).
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Inv Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL042 Revenue', accountType: 'REVENUE' }));
    const { invoice } = await createInvoice(
      userId,
      company.id,
      createInvoiceInput.parse({
        customerId: customer.id,
        invoiceDate: '2026-01-10',
        lines: [{ accountId: rev.id, quantity: '2', unitPrice: '100.00', taxRate: '10' }],
      }),
    );
    const { invoice: finalized } = await finalizeInvoice(userId, company.id, invoice.id);
    expect(finalized.status).toBe('OPEN');

    const db = await getTestDb();
    const posted = await db.execute<{ n: string }>(sql`
      select count(*)::text n from journal_entries
      where company_id = ${company.id} and source_type = 'INVOICE'
        and source_id = ${invoice.id} and status = 'POSTED'`);
    expect(posted.rows[0]?.n).toBe('1');

    // A second finalize cannot produce a second posting for the same invoice.
    await expect(finalizeInvoice(userId, company.id, invoice.id)).rejects.toThrow();
    const stillOne = await db.execute<{ n: string }>(sql`
      select count(*)::text n from journal_entries
      where company_id = ${company.id} and source_type = 'INVOICE'
        and source_id = ${invoice.id} and status = 'POSTED'`);
    expect(stillOne.rows[0]?.n).toBe('1');

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T017 — a customer payment posts a balanced, source-once entry that reduces A/R (LL-043)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Pay Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL043 Revenue', accountType: 'REVENUE' }));
    const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL043 Cash', accountType: 'ASSET' }));
    const { invoice } = await createInvoice(userId, company.id, createInvoiceInput.parse({
      customerId: customer.id, invoiceDate: '2026-01-10', lines: [{ accountId: rev.id, quantity: '1', unitPrice: '100.00' }],
    }));
    await finalizeInvoice(userId, company.id, invoice.id);
    const { payment } = await receivePayment(userId, company.id, receivePaymentInput.parse({
      customerId: customer.id, paymentDate: '2026-01-15', depositAccountId: cash.id,
      applications: [{ invoiceId: invoice.id, amountApplied: '100.00' }],
    }));

    const db = await getTestDb();
    const posted = await db.execute<{ n: string }>(sql`
      select count(*)::text n from journal_entries
      where company_id = ${company.id} and source_type = 'CUSTOMER_PAYMENT'
        and source_id = ${payment.id} and status = 'POSTED'`);
    expect(posted.rows[0]?.n).toBe('1');

    // A/R nets to zero once paid, and the trial balance still balances.
    const arId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    const tb = await getTrialBalance(userId, company.id, '2026-12-31');
    expect(tb.rows.find((r) => r.accountId === arId)?.balance ?? '0.0000').toBe('0.0000');
    expect(tb.balanced).toBe(true);

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T018 — the A/R aging subsidiary reconciles to the GL control balance (LL-046)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Aging Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL046 Revenue', accountType: 'REVENUE' }));
    const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL046 Cash', accountType: 'ASSET' }));
    const mkInvoice = async (price: string, dueDate: string): Promise<string> => {
      const { invoice } = await createInvoice(userId, company.id, createInvoiceInput.parse({
        customerId: customer.id, invoiceDate: '2026-01-10', dueDate, lines: [{ accountId: rev.id, unitPrice: price }],
      }));
      await finalizeInvoice(userId, company.id, invoice.id);
      return invoice.id;
    };
    await mkInvoice('100.00', '2026-06-15'); // overdue as of a mid-year date
    const partial = await mkInvoice('200.00', '2026-07-15');
    await receivePayment(userId, company.id, receivePaymentInput.parse({
      customerId: customer.id, paymentDate: '2026-06-20', depositAccountId: cash.id,
      applications: [{ invoiceId: partial, amountApplied: '50.00' }],
    }));

    const db = await getTestDb();
    const arId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    const arBalance = (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
    const aging = await getArAging(userId, company.id, '2026-12-31');

    // The subsidiary (aging of open invoices) equals the control (derived A/R).
    expect(arBalance).toBe('250.0000'); // 100 + (200 − 50)
    expect(aging.totals.total).toBe(arBalance);

    // Void the partial payment: the balance returns to A/R and both still agree.
    await voidPaymentReconciles(userId, company.id, partial, arId);
    await assertLedgerIntegrity(company.id);
  });

  it('GL-T019 — a bad-debt write-off reduces subsidiary and control together and reconciles (LL-050)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Writeoff Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL050 Revenue', accountType: 'REVENUE' }));
    const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
    const mkInvoice = async (price: string): Promise<string> => {
      const { invoice } = await createInvoice(userId, company.id, createInvoiceInput.parse({
        customerId: customer.id, invoiceDate: '2026-01-10', lines: [{ accountId: rev.id, unitPrice: price }],
      }));
      await finalizeInvoice(userId, company.id, invoice.id);
      return invoice.id;
    };
    await mkInvoice('100.00'); // stays fully open
    const partial = await mkInvoice('200.00'); // 80 of it becomes uncollectible

    const db = await getTestDb();
    const arId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    const arNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
    const agingNow = async (): Promise<string> => (await getArAging(userId, company.id, '2026-12-31')).totals.total;

    // Before any write-off: control and subsidiary both 300.
    expect(await arNow()).toBe('300.0000');
    expect(await agingNow()).toBe('300.0000');

    // Write off 80 of the 200 invoice (Dr Bad Debt Expense / Cr A/R): both drop by 80.
    const writeoff = await writeOffInvoice(userId, company.id, writeOffInvoiceInput.parse({
      invoiceId: partial, expenseAccountId: badDebt.id, writeoffDate: '2026-02-01', amount: '80.00',
    }));
    expect(await arNow()).toBe('220.0000'); // 300 − 80
    expect(await agingNow()).toBe(await arNow());

    // Void the write-off: the receivable returns and the two still agree.
    await voidWriteoff(userId, company.id, writeoff.id, voidWriteoffInput.parse({}));
    expect(await arNow()).toBe('300.0000');
    expect(await agingNow()).toBe(await arNow());

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T020 — a credit memo reduces subsidiary and control together and reconciles (LL-051)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Credit Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL051 Revenue', accountType: 'REVENUE' }));
    const returns = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
    const mkInvoice = async (price: string): Promise<string> => {
      const { invoice } = await createInvoice(userId, company.id, createInvoiceInput.parse({
        customerId: customer.id, invoiceDate: '2026-01-10', lines: [{ accountId: rev.id, unitPrice: price }],
      }));
      await finalizeInvoice(userId, company.id, invoice.id);
      return invoice.id;
    };
    await mkInvoice('100.00'); // stays fully open
    const partial = await mkInvoice('200.00'); // 80 of it credited back

    const db = await getTestDb();
    const arId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    const arNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
    const agingNow = async (): Promise<string> => (await getArAging(userId, company.id, '2026-12-31')).totals.total;

    expect(await arNow()).toBe('300.0000');
    expect(await agingNow()).toBe('300.0000');

    // Credit 80 of the 200 invoice (Dr Sales Returns / Cr A/R): both drop by 80.
    const memo = await issueCreditMemo(userId, company.id, issueCreditMemoInput.parse({
      invoiceId: partial, revenueAccountId: returns.id, creditDate: '2026-02-01', amount: '80.00',
    }));
    expect(await arNow()).toBe('220.0000'); // 300 − 80
    expect(await agingNow()).toBe(await arNow());

    // Void the credit memo: the receivable returns and the two still agree.
    await voidCreditMemo(userId, company.id, memo.id, voidCreditMemoInput.parse({}));
    expect(await arNow()).toBe('300.0000');
    expect(await agingNow()).toBe(await arNow());

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T021 — each customer’s statement decomposes the A/R control, summing to it (LL-054)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Statement Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const acme = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const beta = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Beta' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL054 Revenue', accountType: 'REVENUE' }));
    const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL054 Cash', accountType: 'ASSET' }));
    const returns = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL054 Returns', accountType: 'REVENUE' }));
    const mkInvoice = async (customerId: string, price: string): Promise<string> => {
      const { invoice } = await createInvoice(userId, company.id, createInvoiceInput.parse({
        customerId, invoiceDate: '2026-01-10', lines: [{ accountId: rev.id, unitPrice: price }],
      }));
      await finalizeInvoice(userId, company.id, invoice.id);
      return invoice.id;
    };
    // Acme: 100 invoiced, 40 paid → 60. Beta: 250 invoiced, 50 credited → 200.
    const acmeInv = await mkInvoice(acme.id, '100.00');
    await receivePayment(userId, company.id, receivePaymentInput.parse({
      customerId: acme.id, paymentDate: '2026-01-20', depositAccountId: cash.id,
      applications: [{ invoiceId: acmeInv, amountApplied: '40.00' }],
    }));
    const betaInv = await mkInvoice(beta.id, '250.00');
    await issueCreditMemo(userId, company.id, issueCreditMemoInput.parse({
      invoiceId: betaInv, revenueAccountId: returns.id, creditDate: '2026-01-25', amount: '50.00',
    }));

    const db = await getTestDb();
    const arId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    const asOf = '2026-12-31';
    const arControl = (await getTrialBalance(userId, company.id, asOf)).rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';

    const acmeStmt = (await getCustomerStatement(userId, company.id, acme.id, '2026-01-01', asOf))!;
    const betaStmt = (await getCustomerStatement(userId, company.id, beta.id, '2026-01-01', asOf))!;
    // Each customer's closing is their slice of the control (the per-customer GL-T018).
    expect(acmeStmt.closingBalance).toBe('60.0000');
    expect(betaStmt.closingBalance).toBe('200.0000');
    // …and the slices sum to the control exactly (decimal.js, never JS number).
    const sum = toMoney(acmeStmt.closingBalance).plus(toMoney(betaStmt.closingBalance));
    expect(arControl).toBe('260.0000');
    expect(sum.toFixed(4)).toBe(arControl);

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T022 — voiding an invoice with a live write-off or credit memo is refused, keeping subsidiary ⇔ control (Gate 4)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Void Adj Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
    const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'GLT022 Revenue', accountType: 'REVENUE' }));
    const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'GLT022 Bad Debt', accountType: 'EXPENSE' }));
    const returns = await createAccount(userId, company.id, createAccountInput.parse({ name: 'GLT022 Returns', accountType: 'REVENUE' }));
    const mkInvoice = async (price: string): Promise<string> => {
      const { invoice } = await createInvoice(userId, company.id, createInvoiceInput.parse({
        customerId: customer.id, invoiceDate: '2026-01-10', lines: [{ accountId: rev.id, unitPrice: price }],
      }));
      await finalizeInvoice(userId, company.id, invoice.id);
      return invoice.id;
    };
    const db = await getTestDb();
    const arId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    const arNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
    const agingNow = async (): Promise<string> => (await getArAging(userId, company.id, '2026-12-31')).totals.total;

    // Write-off arm: invoice 100, partial write-off 30 → invoice stays OPEN.
    const inv = await mkInvoice('100.00');
    const wo = await writeOffInvoice(userId, company.id, writeOffInvoiceInput.parse({
      invoiceId: inv, expenseAccountId: badDebt.id, writeoffDate: '2026-02-01', amount: '30.00',
    }));
    expect(await arNow()).toBe('70.0000');
    expect(await agingNow()).toBe('70.0000');
    // Voiding the invoice now is REFUSED — otherwise the write-off's Cr A/R would
    // strand and drive the control to −30 while the aging drops the VOID invoice to 0.
    await expect(voidInvoice(userId, company.id, inv, voidInvoiceInput.parse({})))
      .rejects.toMatchObject({ code: 'INVOICE_HAS_ADJUSTMENTS' });
    expect(await arNow()).toBe('70.0000'); // nothing changed
    expect(await agingNow()).toBe(await arNow()); // still reconciles
    // Void the write-off first, THEN the invoice → both net to zero.
    await voidWriteoff(userId, company.id, wo.id, voidWriteoffInput.parse({}));
    await voidInvoice(userId, company.id, inv, voidInvoiceInput.parse({ reversalDate: '2026-02-05' }));
    expect(await arNow()).toBe('0.0000');
    expect(await agingNow()).toBe('0.0000');

    // Credit-memo arm: invoice 200, partial credit 50 → OPEN; void likewise refused.
    const inv2 = await mkInvoice('200.00');
    const cm = await issueCreditMemo(userId, company.id, issueCreditMemoInput.parse({
      invoiceId: inv2, revenueAccountId: returns.id, creditDate: '2026-02-01', amount: '50.00',
    }));
    await expect(voidInvoice(userId, company.id, inv2, voidInvoiceInput.parse({})))
      .rejects.toMatchObject({ code: 'INVOICE_HAS_ADJUSTMENTS' });
    await voidCreditMemo(userId, company.id, cm.id, voidCreditMemoInput.parse({}));
    await voidInvoice(userId, company.id, inv2, voidInvoiceInput.parse({ reversalDate: '2026-02-05' }));
    expect(await agingNow()).toBe(await arNow()); // reconciles to the control

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T023 — finalizing a bill moves the A/P control by its total; void nets to zero (LL-061)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Bill Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
    const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL061 Rent', accountType: 'EXPENSE' }));
    const db = await getTestDb();
    const apId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_PAYABLE'`)).rows[0]!.id;
    const apNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';

    const { bill } = await createBill(userId, company.id, createBillInput.parse({
      vendorId: vendor.id, billDate: '2026-01-10', lines: [{ accountId: rent.id, unitPrice: '750.00' }],
    }));
    await finalizeBill(userId, company.id, bill.id);
    // A/P (a LIABILITY, credit-natural) carries the bill total; Dr Expense / Cr A/P.
    expect(await apNow()).toBe('750.0000');

    // Voiding the bill reverses the entry: the payable returns to zero.
    await voidBill(userId, company.id, bill.id, voidBillInput.parse({ reversalDate: '2026-01-20' }));
    expect(await apNow()).toBe('0.0000');

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T024 — a bill payment reduces the A/P control; void restores it (LL-062)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Bill Pay Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
    const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL062 Rent', accountType: 'EXPENSE' }));
    const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL062 Cash', accountType: 'ASSET' }));
    const db = await getTestDb();
    const apId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_PAYABLE'`)).rows[0]!.id;
    const apNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';

    const { bill } = await createBill(userId, company.id, createBillInput.parse({
      vendorId: vendor.id, billDate: '2026-01-10', lines: [{ accountId: rent.id, unitPrice: '300.00' }],
    }));
    await finalizeBill(userId, company.id, bill.id);
    expect(await apNow()).toBe('300.0000');

    // Pay 120 of it → A/P drops to 180.
    const { payment } = await payBill(userId, company.id, payBillInput.parse({
      vendorId: vendor.id, paymentDate: '2026-01-20', cashAccountId: cash.id,
      applications: [{ billId: bill.id, amountApplied: '120.00' }],
    }));
    expect(await apNow()).toBe('180.0000');

    // Void the payment → the payable returns to 300.
    await voidBillPayment(userId, company.id, payment.id, voidBillPaymentInput.parse({}));
    expect(await apNow()).toBe('300.0000');

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T025 — a vendor credit reduces the A/P control; void restores it (LL-063)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL Vendor Credit Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
    const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL063 Supplies', accountType: 'EXPENSE' }));
    const db = await getTestDb();
    const apId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_PAYABLE'`)).rows[0]!.id;
    const apNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';

    const { bill } = await createBill(userId, company.id, createBillInput.parse({
      vendorId: vendor.id, billDate: '2026-01-10', lines: [{ accountId: supplies.id, unitPrice: '300.00' }],
    }));
    await finalizeBill(userId, company.id, bill.id);
    expect(await apNow()).toBe('300.0000');

    // Credit 120 of it (a return) → Dr A/P / Cr Supplies → A/P drops to 180.
    const credit = await issueVendorCredit(userId, company.id, issueVendorCreditInput.parse({
      billId: bill.id, expenseAccountId: supplies.id, creditDate: '2026-01-20', amount: '120.00',
    }));
    expect(await apNow()).toBe('180.0000');

    // Void the credit → the payable returns to 300.
    await voidVendorCredit(userId, company.id, credit.id, voidVendorCreditInput.parse({}));
    expect(await apNow()).toBe('300.0000');

    await assertLedgerIntegrity(company.id);
  });

  it('GL-T026 — A/P aging and vendor statements decompose the A/P control across a lifecycle (LL-064)', async () => {
    const userId = await makeUser();
    const { company } = await createCompanyWithOwner(
      userId,
      createCompanyInput.parse({ legalName: 'GL AP Subsidiary Co', timezone: 'America/Chicago' }),
      'standard',
    );
    const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
    const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL064 Supplies', accountType: 'EXPENSE' }));
    const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'LL064 Cash', accountType: 'ASSET' }));
    const db = await getTestDb();
    const apId = (await db.execute<{ id: string }>(sql`
      select id from accounts where company_id = ${company.id} and system_account_type = 'ACCOUNTS_PAYABLE'`)).rows[0]!.id;
    const apNow = async (): Promise<string> =>
      (await getTrialBalance(userId, company.id, '2026-12-31')).rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';

    // The subsidiary⇔control tie AND the per-vendor decomposition must hold at every step.
    const reconciles = async (): Promise<string> => {
      const control = await apNow();
      const aging = await getApAging(userId, company.id, '2026-12-31');
      expect(aging.totals.total).toBe(control); // aging grand total == A/P control
      const stmt = (await getVendorStatement(userId, company.id, vendor.id, '2026-01-01', '2026-12-31'))!;
      expect(stmt.closingBalance).toBe(control); // the sole vendor's closing == the whole control
      return control;
    };

    const { bill } = await createBill(userId, company.id, createBillInput.parse({
      vendorId: vendor.id, billDate: '2026-01-10', lines: [{ accountId: supplies.id, unitPrice: '300.00' }],
    }));
    await finalizeBill(userId, company.id, bill.id);
    expect(await reconciles()).toBe('300.0000');

    // Pay 120 → 180.
    const { payment } = await payBill(userId, company.id, payBillInput.parse({
      vendorId: vendor.id, paymentDate: '2026-01-20', cashAccountId: cash.id,
      applications: [{ billId: bill.id, amountApplied: '120.00' }],
    }));
    expect(await reconciles()).toBe('180.0000');

    // Credit 60 → 120.
    const credit = await issueVendorCredit(userId, company.id, issueVendorCreditInput.parse({
      billId: bill.id, expenseAccountId: supplies.id, creditDate: '2026-01-25', amount: '60.00',
    }));
    expect(await reconciles()).toBe('120.0000');

    // Void the credit → 180; void the payment → 300. The tie holds through the void lifecycle.
    // Explicit in-window reversal dates (not the default "today") so the reversal always lands
    // on or before the 2026-12-31 asOf and the report⇔control assertions are time-independent.
    await voidVendorCredit(userId, company.id, credit.id, voidVendorCreditInput.parse({ reversalDate: '2026-02-01' }));
    expect(await reconciles()).toBe('180.0000');
    await voidBillPayment(userId, company.id, payment.id, voidBillPaymentInput.parse({ reversalDate: '2026-02-01' }));
    expect(await reconciles()).toBe('300.0000');

    await assertLedgerIntegrity(company.id);
  });
});

/** Voids the (single) payment on an invoice, then re-asserts subsidiary ⇔ control. */
async function voidPaymentReconciles(userId: string, companyId: string, invoiceId: string, arId: string): Promise<void> {
  const db = await getTestDb();
  const paymentId = (await db.execute<{ id: string }>(sql`
    select p.id from payments p
    join payment_applications pa on pa.company_id = p.company_id and pa.payment_id = p.id
    where p.company_id = ${companyId} and pa.invoice_id = ${invoiceId} and p.status = 'POSTED' limit 1`)).rows[0]!.id;
  await voidPayment(userId, companyId, paymentId, voidPaymentInput.parse({}));
  const arBalance = (await getTrialBalance(userId, companyId, '2026-12-31')).rows.find((r) => r.accountId === arId)?.balance ?? '0.0000';
  const aging = await getArAging(userId, companyId, '2026-12-31');
  expect(arBalance).toBe('300.0000'); // the 50 is un-applied → back to 100 + 200
  expect(aging.totals.total).toBe(arBalance);
}
