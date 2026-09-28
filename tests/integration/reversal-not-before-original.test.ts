/**
 * A reversal is never dated before the entry it reverses — LL-121 (ADR-044 amendment). Against a
 * real DB.
 *
 * Proves: a CHOSEN date before the original is refused (REVERSAL_BEFORE_ORIGINAL) and nothing
 * changes; the original's own date is accepted; a DEFAULTED date (today) is lifted to a
 * future-dated original's own date — a manual entry and a document void alike — instead of
 * failing; a chosen early date on a void is refused; the database refuses a raw REVERSAL row dated
 * before its original (trigger 0050) and accepts one on the same day.
 */
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { schema } from '@/db';
import { getAuth } from '@/lib/auth';
import { errorChainText } from '@/lib/error-chain';
import { listAccounts } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { assertLedgerIntegrity, LedgerError, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';
import { rawDraftEntry } from '../helpers/raw-entry';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `rb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'R' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
interface Ctx { owner: string; companyId: string; bankId: string; salesId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Before Co', timezone: 'America/Chicago' }), 'standard');
  const accounts = await listAccounts(owner, company.id);
  return { owner, companyId: company.id, bankId: accounts.find((a) => a.accountNumber === '1000')!.id, salesId: accounts.find((a) => a.accountType === 'REVENUE')!.id };
}
async function manualEntry(c: Ctx, date: string): Promise<string> {
  const { entry } = await postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.owner, transactionDate: date, sourceType: 'JOURNAL_ENTRY',
    lines: [{ accountId: c.bankId, debit: '100.00' }, { accountId: c.salesId, credit: '100.00' }],
  }));
  return entry.id;
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return (e as LedgerError).code;
  }
}
async function reversalsOf(companyId: string, originalId: string) {
  const db = await getTestDb();
  return await db
    .select({ postingDate: schema.journalEntries.postingDate, transactionDate: schema.journalEntries.transactionDate })
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.reversalOfId, originalId)));
}
const reverse = (c: Ctx, entryId: string, reversalDate?: string) =>
  reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.owner, entryId, ...(reversalDate === undefined ? {} : { reversalDate }) }));

beforeEach(async () => {
  await truncateAll();
});

describe('a chosen reversal date', () => {
  it('before the original is refused and nothing changes; the original\'s own date is accepted', async () => {
    const c = await setup();
    const id = await manualEntry(c, '2026-03-10');
    expect(await codeOf(reverse(c, id, '2026-03-09'))).toBe('REVERSAL_BEFORE_ORIGINAL');
    expect(await reversalsOf(c.companyId, id)).toHaveLength(0);
    await reverse(c, id, '2026-03-10');
    expect(await reversalsOf(c.companyId, id)).toEqual([{ postingDate: '2026-03-10', transactionDate: '2026-03-10' }]);
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('a defaulted reversal date (today) and a future-dated original', () => {
  it('a future-dated manual entry reversed without a date lands on its own date', async () => {
    const c = await setup();
    const id = await manualEntry(c, '2027-01-15');
    await reverse(c, id);
    expect(await reversalsOf(c.companyId, id)).toEqual([{ postingDate: '2027-01-15', transactionDate: '2027-01-15' }]);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a future-dated invoice voided without a date lands on its own date; a chosen earlier date is refused', async () => {
    const c = await setup();
    const customer = await createCustomer(c.owner, c.companyId, createCustomerInput.parse({ name: 'Later Co' }));
    const make = async () => {
      const { invoice } = await createInvoice(c.owner, c.companyId, createInvoiceInput.parse({ customerId: customer.id, invoiceDate: '2027-02-20', lines: [{ accountId: c.salesId, quantity: '1', unitPrice: '250.00' }] }));
      await finalizeInvoice(c.owner, c.companyId, invoice.id);
      const db = await getTestDb();
      const posted = (await db.select({ id: schema.journalEntries.id }).from(schema.journalEntries)
        .where(and(eq(schema.journalEntries.companyId, c.companyId), eq(schema.journalEntries.sourceId, invoice.id))))[0]!;
      return { invoiceId: invoice.id, entryId: posted.id };
    };
    const a = await make();
    await voidInvoice(c.owner, c.companyId, a.invoiceId, voidInvoiceInput.parse({}));
    expect(await reversalsOf(c.companyId, a.entryId)).toEqual([{ postingDate: '2027-02-20', transactionDate: '2027-02-20' }]);

    const b = await make();
    expect(await codeOf(voidInvoice(c.owner, c.companyId, b.invoiceId, voidInvoiceInput.parse({ reversalDate: '2027-02-19' })))).toBe('REVERSAL_BEFORE_ORIGINAL');
    expect(await reversalsOf(c.companyId, b.entryId)).toHaveLength(0);
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('the database refuses an early reversal row (trigger 0050)', () => {
  it('a raw REVERSAL dated before its original is refused; one on the same day is accepted', async () => {
    const c = await setup();
    const id = await manualEntry(c, '2026-04-10');
    const db = await getTestDb();
    const lines = [{ accountId: c.bankId, debit: '0', credit: '100.00' }, { accountId: c.salesId, debit: '100.00', credit: '0' }];
    const early = await rawDraftEntry(db, { companyId: c.companyId, userId: c.owner, sourceType: 'REVERSAL', transactionDate: '2026-04-09', reversalOfId: id, lines }).then(() => 'OK', (e: unknown) => errorChainText(e));
    expect(early).toMatch(/REVERSAL_BEFORE_ORIGINAL/);
    const sameDay = await rawDraftEntry(db, { companyId: c.companyId, userId: c.owner, sourceType: 'REVERSAL', transactionDate: '2026-04-10', reversalOfId: id, lines });
    // Moving that row's date before the original is refused too.
    const moved = await db.execute(sql`update journal_entries set posting_date = '2026-04-01' where id = ${sameDay}`).then(() => 'OK', (e: unknown) => errorChainText(e));
    expect(moved).toMatch(/REVERSAL_BEFORE_ORIGINAL/);
  });
});
