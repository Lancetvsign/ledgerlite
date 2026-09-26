/**
 * Correcting a posted transaction — LL-110 (ADR-044 amendment). Against a real DB, extractor injected.
 *
 * Proves: a manual entry is reversed through the path the Reverse button uses, and a document's
 * entry is refused there (its correction is the document's void); a posted import line is undone
 * — its entry reversed, the line back to STAGED, amendable and re-postable — including PERSONAL;
 * the origin of a matched transfer takes its mirror back with it (one reversal); a matched line
 * alone goes back without a reversal; applied / intercompany / taken / ignored lines are undone
 * elsewhere; a posting cleared in a reconciliation is refused; a closed period is refused; a
 * second undo changes nothing; voiding a payment returns its applied line to review. The ledger
 * is intact after every one.
 */
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { schema } from '@/db';
import { getAuth } from '@/lib/auth';
import { createAccount, listAccounts } from '@/server/accounts';
import { amendImportLine, BankImportError, getImportBatch, postImportLines, stageImport, unpostImportLine } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { assertLedgerIntegrity, LedgerError, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { voidPayment } from '@/server/payments';
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { completeReconciliation, setCleared, startReconciliation } from '@/server/reconciliation';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
type Row = { date: string; description: string; amount: string };
const rows = (r: Row[]): TransactionExtractor => () => Promise.resolve(r);

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'C' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function codeOf<T extends { code: string }>(p: Promise<unknown>, cls: new (...a: never[]) => T): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    return (e as T).code;
  }
}

interface Ctx { owner: string; companyId: string; bankId: string; cardId: string; rentId: string; suppliesId: string; salesId: string; ownerDistId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Correct Co', timezone: 'America/Chicago' }), 'standard');
  const accounts = await listAccounts(owner, company.id);
  const rent = await createAccount(owner, company.id, createAccountInput.parse({ name: 'Rent Expense (test)', accountType: 'EXPENSE' }));
  const supplies = await createAccount(owner, company.id, createAccountInput.parse({ name: 'Supplies Expense (test)', accountType: 'EXPENSE' }));
  return {
    owner,
    companyId: company.id,
    bankId: accounts.find((a) => a.accountNumber === '1000')!.id,
    cardId: accounts.find((a) => a.accountNumber === '2100')!.id,
    salesId: accounts.find((a) => a.accountType === 'REVENUE')!.id,
    ownerDistId: accounts.find((a) => a.name === 'Owner Distributions')!.id,
    rentId: rent.id,
    suppliesId: supplies.id,
  };
}
async function stage(c: Ctx, accountId: string, r: Row[]) {
  const batch = await stageImport(c.owner, c.companyId, { bankAccountId: accountId, fileBytes: EMPTY }, rows(r));
  return { batchId: batch.id, lines: (await getImportBatch(c.owner, c.companyId, batch.id))!.lines };
}
async function lineOf(c: Ctx, batchId: string, i: number) {
  return (await getImportBatch(c.owner, c.companyId, batchId))!.lines[i]!;
}
async function entryStatus(id: string): Promise<string> {
  const db = await getTestDb();
  return (await db.select({ s: schema.journalEntries.status }).from(schema.journalEntries).where(eq(schema.journalEntries.id, id)).limit(1))[0]!.s;
}
async function balance(c: Ctx, accountId: string): Promise<string> {
  const tb = await getTrialBalance(c.owner, c.companyId, '2026-12-31');
  expect(tb.balanced).toBe(true);
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}
async function audits(companyId: string, entityId: string): Promise<number> {
  const db = await getTestDb();
  return (await db.select({ id: schema.auditEvents.id }).from(schema.auditEvents).where(and(eq(schema.auditEvents.companyId, companyId), eq(schema.auditEvents.entityId, entityId), eq(schema.auditEvents.action, 'BANK_IMPORT_LINE_UNPOSTED')))).length;
}

beforeEach(async () => {
  await truncateAll();
});

describe('manual entry — the Reverse button path', () => {
  it('reverses a posted manual entry into a new entry; a document\'s entry is refused (its void is the correction)', async () => {
    const c = await setup();
    const { entry } = await postJournalEntry(postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.owner, transactionDate: '2026-06-10', sourceType: 'JOURNAL_ENTRY',
      lines: [{ accountId: c.rentId, debit: '300.00' }, { accountId: c.bankId, credit: '300.00' }],
    }));
    expect(await balance(c, c.rentId)).toBe('300.0000');
    const reversal = await reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.owner, entryId: entry.id, reversalDate: '2026-06-11', description: 'Wrong account' }));
    expect(reversal.entry).toMatchObject({ status: 'POSTED', sourceType: 'REVERSAL', reversalOfId: entry.id, description: 'Wrong account' });
    expect(await entryStatus(entry.id)).toBe('REVERSED');
    expect(await balance(c, c.rentId)).toBe('0.0000');

    // A bank-import posting is not a manual entry: the Reverse path refuses it.
    const { batchId, lines } = await stage(c, c.bankId, [{ date: '2026-06-02', description: 'RENT', amount: '-2000.00' }]);
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [{ lineId: lines[0]!.id, action: 'post', accountId: c.rentId }] });
    const posted = await lineOf(c, batchId, 0);
    expect(await codeOf(reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.owner, entryId: posted.journalEntryId! })), LedgerError)).toBe('DOCUMENT_REVERSAL_REQUIRES_VOID');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('import line — Undo posting', () => {
  it('reverses the entry, returns the line to review, and the line can be corrected and posted afresh', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, [{ date: '2026-06-02', description: 'RENT', amount: '-200.00' }]);
    const line = lines[0]!;
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [{ lineId: line.id, action: 'post', accountId: c.suppliesId }] });
    const posted = await lineOf(c, batchId, 0);
    expect(await balance(c, c.suppliesId)).toBe('200.0000');

    const r = await unpostImportLine(c.owner, c.companyId, batchId, line.id);
    expect(r.unposted).toBe(1);
    expect(r.reversalEntryId).not.toBeNull();
    expect(await entryStatus(posted.journalEntryId!)).toBe('REVERSED');
    const back = await lineOf(c, batchId, 0);
    expect(back).toMatchObject({ status: 'STAGED', journalEntryId: null, chosenAccountId: null });
    expect(await balance(c, c.suppliesId)).toBe('0.0000');
    expect(await balance(c, c.bankId)).toBe('0.0000');
    expect(await audits(c.companyId, line.id)).toBe(1);

    // Back in review: the misread amount is correctable again (LL-107) and it posts to the right account.
    await amendImportLine(c.owner, c.companyId, batchId, line.id, { amount: '-2000.00' });
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [{ lineId: line.id, action: 'post', accountId: c.rentId }] });
    expect(await balance(c, c.rentId)).toBe('2000.0000');
    expect(await balance(c, c.suppliesId)).toBe('0.0000');
    expect(await balance(c, c.bankId)).toBe('-2000.0000');

    // A second undo of a line that is posted again works; an undo of a STAGED line changes nothing.
    await unpostImportLine(c.owner, c.companyId, batchId, line.id);
    expect(await unpostImportLine(c.owner, c.companyId, batchId, line.id)).toEqual({ unposted: 0, reversalEntryId: null });
    await assertLedgerIntegrity(c.companyId);
  });

  it('a PERSONAL line is undone the same way', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, [{ date: '2026-06-02', description: 'GROCERIES', amount: '-80.00' }]);
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [{ lineId: lines[0]!.id, action: 'personal', accountId: c.ownerDistId }] });
    expect((await lineOf(c, batchId, 0)).status).toBe('PERSONAL');
    expect((await unpostImportLine(c.owner, c.companyId, batchId, lines[0]!.id)).unposted).toBe(1);
    expect(await lineOf(c, batchId, 0)).toMatchObject({ status: 'STAGED', chosenAccountId: null });
    expect(await balance(c, c.ownerDistId)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('the origin of a matched transfer takes its mirror back (one reversal); a matched line alone goes back without one', async () => {
    const c = await setup();
    // Bank −2000 posted to the card; the card's +2000 payment matched to it (LL-094).
    const bank = await stage(c, c.bankId, [{ date: '2026-06-03', description: 'PAY VISA', amount: '-2000.00' }]);
    await postImportLines(c.owner, c.companyId, bank.batchId, { decisions: [{ lineId: bank.lines[0]!.id, action: 'post', accountId: c.cardId }] });
    const card = await stage(c, c.cardId, [{ date: '2026-06-04', description: 'PAYMENT THANK YOU', amount: '2000.00' }]);
    const cand = card.lines[0]!.transferCandidate!;
    await postImportLines(c.owner, c.companyId, card.batchId, { decisions: [{ lineId: card.lines[0]!.id, action: 'match_transfer', counterpartLineId: cand.lineId }] });
    const entryId = (await lineOf(c, bank.batchId, 0)).journalEntryId!;
    expect((await lineOf(c, card.batchId, 0)).journalEntryId).toBe(entryId);

    // The matched card line alone: back to review, no reversal, the bank posting stands.
    const alone = await unpostImportLine(c.owner, c.companyId, card.batchId, card.lines[0]!.id);
    expect(alone).toEqual({ unposted: 1, reversalEntryId: null });
    expect(await lineOf(c, card.batchId, 0)).toMatchObject({ status: 'STAGED', mirrorOfLineId: null, journalEntryId: null });
    expect(await entryStatus(entryId)).toBe('POSTED');
    // Match again, then undo the ORIGIN: both lines come back, one reversal.
    await postImportLines(c.owner, c.companyId, card.batchId, { decisions: [{ lineId: card.lines[0]!.id, action: 'match_transfer', counterpartLineId: cand.lineId }] });
    const both = await unpostImportLine(c.owner, c.companyId, bank.batchId, bank.lines[0]!.id);
    expect(both.unposted).toBe(2);
    expect(await entryStatus(entryId)).toBe('REVERSED');
    expect((await lineOf(c, bank.batchId, 0)).status).toBe('STAGED');
    expect(await lineOf(c, card.batchId, 0)).toMatchObject({ status: 'STAGED', mirrorOfLineId: null });
    expect(await balance(c, c.cardId)).toBe('0.0000');
    expect(await audits(c.companyId, card.lines[0]!.id)).toBe(2); // once alone, once with the origin
    await assertLedgerIntegrity(c.companyId);
  });

  it('applied and ignored lines are undone elsewhere; a line of another batch reads as not found', async () => {
    const c = await setup();
    const customer = await createCustomer(c.owner, c.companyId, createCustomerInput.parse({ name: 'Acme' }));
    const { invoice } = await createInvoice(c.owner, c.companyId, createInvoiceInput.parse({ customerId: customer.id, invoiceDate: '2026-05-20', lines: [{ accountId: c.salesId, quantity: '1', unitPrice: '1500.00' }] }));
    await finalizeInvoice(c.owner, c.companyId, invoice.id);
    const { batchId, lines } = await stage(c, c.bankId, [
      { date: '2026-06-01', description: 'DEPOSIT ACME', amount: '1500.00' },
      { date: '2026-06-02', description: 'DUPLICATE', amount: '-10.00' },
    ]);
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [
      { lineId: lines[0]!.id, action: 'apply_invoice', documentId: invoice.id },
      { lineId: lines[1]!.id, action: 'ignore' },
    ] });
    expect(await codeOf(unpostImportLine(c.owner, c.companyId, batchId, lines[0]!.id), BankImportError)).toBe('UNPOST_ELSEWHERE');
    expect(await codeOf(unpostImportLine(c.owner, c.companyId, batchId, lines[1]!.id), BankImportError)).toBe('UNPOST_ELSEWHERE');
    const other = await stage(c, c.bankId, [{ date: '2026-07-01', description: 'X', amount: '-1.00' }]);
    expect(await codeOf(unpostImportLine(c.owner, c.companyId, batchId, other.lines[0]!.id), BankImportError)).toBe('LINE_NOT_FOUND');

    // Voiding the payment the deposit created brings the line back for review (LL-110).
    const applied = await lineOf(c, batchId, 0);
    await voidPayment(c.owner, c.companyId, applied.paymentId!, { reason: 'Wrong invoice' });
    const back = await lineOf(c, batchId, 0);
    expect(back).toMatchObject({ status: 'STAGED', paymentId: null, journalEntryId: null });
    expect(await audits(c.companyId, lines[0]!.id)).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a posting cleared in a reconciliation is refused — in progress and completed', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, [{ date: '2026-06-02', description: 'RENT', amount: '-2000.00' }]);
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [{ lineId: lines[0]!.id, action: 'post', accountId: c.rentId }] });
    const entryId = (await lineOf(c, batchId, 0)).journalEntryId!;
    const db = await getTestDb();
    const bankLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where journal_entry_id = ${entryId} and account_id = ${c.bankId}`)).rows[0]!.id;
    const rec = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '-2000.00' });
    await setCleared(c.owner, c.companyId, rec.id, { journalLineIds: [bankLine] });
    const inProgress = await codeOf(unpostImportLine(c.owner, c.companyId, batchId, lines[0]!.id), BankImportError);
    expect(inProgress).toBe('LINE_RECONCILED');
    await completeReconciliation(c.owner, c.companyId, rec.id);
    expect(await codeOf(unpostImportLine(c.owner, c.companyId, batchId, lines[0]!.id), BankImportError)).toBe('LINE_RECONCILED');
    expect(await entryStatus(entryId)).toBe('POSTED');
    expect((await lineOf(c, batchId, 0)).status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a closed period for today refuses the undo, and nothing changes', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, [{ date: '2026-06-02', description: 'RENT', amount: '-2000.00' }]);
    await postImportLines(c.owner, c.companyId, batchId, { decisions: [{ lineId: lines[0]!.id, action: 'post', accountId: c.rentId }] });
    const db = await getTestDb();
    const tz = (await db.select({ tz: schema.companies.timezone }).from(schema.companies).where(eq(schema.companies.id, c.companyId)))[0]!.tz;
    const { todayInTimeZone } = await import('@/lib/dates');
    const today = await getAccountingPeriod(c.companyId, todayInTimeZone(tz));
    await closePeriod(c.owner, c.companyId, today.id);
    expect(await codeOf(unpostImportLine(c.owner, c.companyId, batchId, lines[0]!.id), LedgerError)).toBe('PERIOD_CLOSED');
    expect((await lineOf(c, batchId, 0)).status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});
