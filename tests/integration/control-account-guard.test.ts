/**
 * A/R control-account guard — LL-050 PR2 (ADR-018, migration 0018).
 *
 * Proves the rule is enforced by the DATABASE, not only by LedgerService: a raw
 * INSERT of a MANUAL (source_type='JOURNAL_ENTRY') journal line into Accounts
 * Receivable — the service entirely bypassed — is rejected by the BEFORE INSERT
 * trigger. This is what keeps the A/R aging subsidiary reconciled to the control
 * (GL-T018): A/R moves only through documents the subsidiary can see. Scope is A/R
 * ONLY — a manual entry to another system account (Sales Tax Payable) still posts,
 * and every document path (invoice / payment / write-off) still reaches A/R.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { assertLedgerIntegrity, LedgerError, postJournalEntry } from '@/server/ledger';
import { receivePayment } from '@/server/payments';
import { ensureAppUser } from '@/server/users';
import { writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { postJournalEntryInput } from '@/validation/journal';
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
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `cag-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'C',
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
    createCompanyInput.parse({ legalName: 'CAG Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, cashId: cash.id, badDebtId: badDebt.id };
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]!.id;
}

/** A manual journal entry (source JOURNAL_ENTRY) through the service. */
function postManual(c: Ctx, lines: { accountId: string; debit?: string; credit?: string }[]) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: '2026-02-10',
      sourceType: 'JOURNAL_ENTRY',
      lines,
    }),
  );
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    throw new Error('expected a LedgerError');
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return (e as LedgerError).code;
  }
};

/** Assert a query rejects with `re` found anywhere on the error's cause chain. */
async function expectRejectsOnChain(p: Promise<unknown>, re: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected the query to reject').toBeDefined();
  const seen = new Set<unknown>();
  let cur: unknown = thrown;
  let text = '';
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    text += ' ' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  expect(text).toMatch(re);
}

beforeEach(async () => {
  await truncateAll();
});

describe('A/R control-account guard is STRUCTURAL (database, service bypassed)', () => {
  it('rejects a raw-SQL manual (JOURNAL_ENTRY) line into Accounts Receivable', async () => {
    const c = await setup();
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const db = await getTestDb();
    // The service is entirely bypassed: a raw POSTED JOURNAL_ENTRY, then a line into
    // A/R. The BEFORE INSERT trigger must refuse the line before it can commit.
    await expectRejectsOnChain(
      db.transaction(async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries
            (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
          values (${c.companyId}, '2026-02-10', '2026-02-10', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 95000)
          returning id`);
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values (${r.rows[0]!.id}, ${c.companyId}, ${arId}, 1, '1.0000', '0.0000')`);
      }),
      /CONTROL_ACCOUNT_MANUAL_POST/,
    );
    await assertLedgerIntegrity(c.companyId);
  });

  it('allows a raw-SQL INVOICE-source line into A/R (documents move A/R structurally)', async () => {
    const c = await setup();
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const db = await getTestDb();
    // Same raw insert, but source_type INVOICE — a document path the subsidiary sees.
    // The trigger allows it; the balanced pair commits.
    await db.transaction(async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        insert into journal_entries
          (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
        values (${c.companyId}, '2026-02-10', '2026-02-10', 'INVOICE', ${c.userId}, 'POSTED', 95100)
        returning id`);
      const id = r.rows[0]!.id;
      await tx.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
        values (${id}, ${c.companyId}, ${arId}, 1, '1.0000', '0.0000'),
               (${id}, ${c.companyId}, ${c.revId}, 2, '0.0000', '1.0000')`);
    });
    const cnt = await db.execute<{ n: string }>(
      sql`select count(*)::text n from journal_entries where company_id = ${c.companyId} and entry_number = 95100`,
    );
    expect(Number(cnt.rows[0]?.n)).toBe(1); // committed — an INVOICE-source A/R line is allowed
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('A/R control-account guard through the service (typed error; A/R-only scope)', () => {
  it('a manual journal entry into A/R returns CONTROL_ACCOUNT_MANUAL_POST', async () => {
    const c = await setup();
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    // Dr A/R / Cr Revenue — balanced, but the A/R debit is a manual post to the control.
    expect(await codeOf(postManual(c, [
      { accountId: arId, debit: '10.00' },
      { accountId: c.revId, credit: '10.00' },
    ]))).toBe('CONTROL_ACCOUNT_MANUAL_POST');
  });

  it('a manual journal entry to another system account (Sales Tax Payable) still posts', async () => {
    const c = await setup();
    const taxId = await sysAccount(c.companyId, 'SALES_TAX_PAYABLE');
    // A tax remittance-style manual entry: Dr Sales Tax Payable / Cr Cash. Not A/R, so
    // the guard leaves it alone — other system accounts stay manually postable.
    const { entry } = await postManual(c, [
      { accountId: taxId, debit: '5.00' },
      { accountId: c.cashId, credit: '5.00' },
    ]);
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a manual journal entry between ordinary accounts still posts', async () => {
    const c = await setup();
    const { entry } = await postManual(c, [
      { accountId: c.cashId, debit: '20.00' },
      { accountId: c.revId, credit: '20.00' },
    ]);
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('every document path still reaches A/R (invoice, payment, write-off)', async () => {
    const c = await setup();
    // Invoice finalize posts Dr A/R.
    const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', lines: [{ accountId: c.revId, unitPrice: '100.00' }],
    }));
    await finalizeInvoice(c.userId, c.companyId, invoice.id);
    // Payment posts Cr A/R (partial, so the invoice stays OPEN for the write-off).
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-01-15', depositAccountId: c.cashId,
      applications: [{ invoiceId: invoice.id, amountApplied: '40.00' }],
    }));
    // Write-off posts Cr A/R for the remainder.
    const writeoff = await writeOffInvoice(c.userId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: invoice.id, expenseAccountId: c.badDebtId, writeoffDate: '2026-01-20', amount: '60.00',
    }));
    expect(writeoff.status).toBe('POSTED'); // all three A/R movements succeeded despite the guard
    await assertLedgerIntegrity(c.companyId);
  });
});
