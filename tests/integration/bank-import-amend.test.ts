/**
 * Correcting a misread amount on a staged import line — LL-107 / ADR-046. Against a real DB,
 * extractor injected.
 *
 * Proves: the amount changes and the extracted figure is kept (from the first correction on);
 * the correction is audited with before/after; an equal amount is a no-op without an audit row;
 * the duplicate hash follows the corrected figure; a misread transfer finds its mirror once
 * corrected; drafts survive; a decided line is refused by the service AND by the database; a
 * line of another batch reads as not found; the ledger posts the corrected figure.
 *
 * LL-112: the date and description are corrected the same way — what the parser read is kept
 * (from the first correction of each on), only the changed fields are audited, unchanged values
 * are a no-op, the duplicate hash follows, the entry posts on the corrected date with the
 * corrected description, a post that planned with the old date is refused (LINE_CHANGED), and a decided
 * line's date and description are frozen by the service and by the database.
 */
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { schema } from '@/db';
import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { amendImportLine, BankImportError, getImportBatch, lockStagedLine, postImportLines, saveReviewDrafts, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
type Row = { date: string; description: string; amount: string };
const rows = (r: Row[]): TransactionExtractor => () => Promise.resolve(r);
/** A bank statement whose −2000 rent line the parser misread as −200. */
const MISREAD: Row[] = [
  { date: '2026-06-01', description: 'DEPOSIT', amount: '1500.00' },
  { date: '2026-06-02', description: 'OFFICE DEPOT', amount: '-120.50' },
  { date: '2026-06-03', description: 'RENT', amount: '-200.00' },
];

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `am-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'A' },
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
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    const seen = new Set<unknown>();
    let cur: unknown = e;
    let text = '';
    while (cur instanceof Error && !seen.has(cur)) { seen.add(cur); text += ' ' + cur.message; cur = (cur as { cause?: unknown }).cause; }
    return text;
  }
}

interface Ctx { owner: string; companyId: string; bankId: string; cardId: string; expenseId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Amend Co', timezone: 'America/Chicago' }), 'standard');
  const accounts = await listAccounts(owner, company.id);
  return {
    owner,
    companyId: company.id,
    bankId: accounts.find((a) => a.accountNumber === '1000')!.id,
    cardId: accounts.find((a) => a.accountNumber === '2100')!.id,
    expenseId: accounts.find((a) => a.accountType === 'EXPENSE')!.id,
  };
}
async function stage(c: Ctx, accountId: string, r: Row[]) {
  const batch = await stageImport(c.owner, c.companyId, { bankAccountId: accountId, fileBytes: EMPTY }, rows(r));
  const lines = (await getImportBatch(c.owner, c.companyId, batch.id))!.lines;
  return { batch, lines };
}
async function amendments(companyId: string) {
  const db = await getTestDb();
  return await db
    .select({ entityId: schema.auditEvents.entityId, before: schema.auditEvents.beforeJson, after: schema.auditEvents.afterJson })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.companyId, companyId), eq(schema.auditEvents.action, 'BANK_IMPORT_LINE_AMENDED')));
}

beforeEach(async () => {
  await truncateAll();
});

describe('correcting a staged line', () => {
  it('changes the amount, keeps the figure the parser read, audits before/after; an equal amount is a no-op; the original survives a second correction', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    const rent = lines[2]!;
    expect(rent.amount).toBe('-200.0000');
    expect(rent.amendedFrom).toBeNull();

    expect(await amendImportLine(c.owner, c.companyId, batch.id, rent.id, { amount: '-2000.00' })).toEqual({ amended: true });
    let view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines[2]).toMatchObject({ amount: '-2000.0000', amendedFrom: '-200.0000' });
    expect(view.lines[0]!.amendedFrom).toBeNull();
    let audit = await amendments(c.companyId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: rent.id, before: { amount: '-200.0000' }, after: { amount: '-2000.0000', amendedFrom: '-200.0000' } });

    // The same figure again (in another notation): nothing to do, nothing audited.
    expect(await amendImportLine(c.owner, c.companyId, batch.id, rent.id, { amount: '-2000' })).toEqual({ amended: false });
    expect(await amendments(c.companyId)).toHaveLength(1);

    // A second, different correction keeps the ORIGINAL extracted figure.
    await amendImportLine(c.owner, c.companyId, batch.id, rent.id, { amount: '-1999.99' });
    view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines[2]).toMatchObject({ amount: '-1999.9900', amendedFrom: '-200.0000' });
    audit = await amendments(c.companyId);
    expect(audit).toHaveLength(2);
  });

  it('the duplicate hash follows the corrected figure, and a misread transfer finds its mirror once corrected', async () => {
    const c = await setup();
    // The card statement's +2000 payment, posted to Checking: the mirror of the bank's −2000 (LL-094).
    const card = await stage(c, c.cardId, [{ date: '2026-06-03', description: 'PAYMENT THANK YOU', amount: '2000.00' }]);
    await postImportLines(c.owner, c.companyId, card.batch.id, { decisions: [{ lineId: card.lines[0]!.id, action: 'post', accountId: c.bankId }] });

    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    expect(lines[2]!.transferCandidate).toBeNull(); // −200 mirrors nothing
    await amendImportLine(c.owner, c.companyId, batch.id, lines[2]!.id, { amount: '-2000.00' });
    const view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines[2]!.transferCandidate).toMatchObject({ status: 'POSTED', accountId: c.cardId });

    // Re-uploading the corrected statement: its rent line is a staged twin of the corrected one;
    // the misread figure no longer matches anything.
    const again = await stage(c, c.bankId, [MISREAD[0]!, MISREAD[1]!, { ...MISREAD[2]!, amount: '-2000.00' }]);
    expect(again.lines[2]!.duplicateOf).toBe('staged');
    const misreadAgain = await stage(c, c.bankId, [{ ...MISREAD[2]! }]);
    expect(misreadAgain.lines[0]!.duplicateOf).toBeNull();
  });

  it('a draft survives the correction, and the ledger posts the corrected figure', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    const rent = lines[2]!;
    await saveReviewDrafts(c.owner, c.companyId, batch.id, { drafts: [{ lineId: rent.id, action: 'post', accountId: c.expenseId }] });
    await amendImportLine(c.owner, c.companyId, batch.id, rent.id, { amount: '-2000.00' });
    const view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines[2]!.draft).toMatchObject({ action: 'post', accountId: c.expenseId });

    await postImportLines(c.owner, c.companyId, batch.id, { decisions: [{ lineId: rent.id, action: 'post', accountId: c.expenseId }] });
    const posted = (await getImportBatch(c.owner, c.companyId, batch.id))!.lines[2]!;
    expect(posted.status).toBe('POSTED');
    const db = await getTestDb();
    const jl = await db.execute<{ debit: string; credit: string }>(sql`
      select debit::text, credit::text from journal_lines where journal_entry_id = ${posted.journalEntryId} and account_id = ${c.expenseId}`);
    expect(jl.rows[0]).toEqual({ debit: '2000.0000', credit: '0.0000' });
  });

  it('a post that planned with a figure the reviewer has since corrected is refused, never posted with the stale amount', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    const stale = lines[2]!; // read before the correction
    await amendImportLine(c.owner, c.companyId, batch.id, stale.id, { amount: '-2000.00' });
    const db = await getTestDb();
    // The lock every posting path takes compares the locked row with what the caller planned.
    expect(await codeOf(db.transaction((tx) => lockStagedLine(tx, c.companyId, stale.id, stale)), BankImportError)).toBe('LINE_CHANGED');
    expect(await db.transaction((tx) => lockStagedLine(tx, c.companyId, stale.id, { ...stale, amount: '-2000.0000' }))).toBe(true);
    // Through the service the fresh read wins: the corrected figure posts.
    await postImportLines(c.owner, c.companyId, batch.id, { decisions: [{ lineId: stale.id, action: 'post', accountId: c.expenseId }] });
    const posted = (await getImportBatch(c.owner, c.companyId, batch.id))!.lines[2]!;
    const jl = await db.execute<{ debit: string }>(sql`select debit::text from journal_lines where journal_entry_id = ${posted.journalEntryId} and account_id = ${c.expenseId}`);
    expect(jl.rows[0]!.debit).toBe('2000.0000');
  });

  it('a decided line is frozen — by the service and by the database; a line of another batch reads as not found', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    await postImportLines(c.owner, c.companyId, batch.id, { decisions: [
      { lineId: lines[0]!.id, action: 'post', accountId: c.expenseId },
      { lineId: lines[1]!.id, action: 'ignore' },
    ] });
    expect(await codeOf(amendImportLine(c.owner, c.companyId, batch.id, lines[0]!.id, { amount: '1.00' }), BankImportError)).toBe('LINE_NOT_EDITABLE');
    expect(await codeOf(amendImportLine(c.owner, c.companyId, batch.id, lines[1]!.id, { amount: '1.00' }), BankImportError)).toBe('LINE_NOT_EDITABLE');
    const db = await getTestDb();
    expect(await rejection(db.execute(sql`update bank_import_lines set amount = '1.0000' where id = ${lines[0]!.id}`))).toMatch(/LINE_NOT_STAGED/);
    expect(await rejection(db.execute(sql`update bank_import_lines set amount = '1.0000' where id = ${lines[1]!.id}`))).toMatch(/LINE_NOT_STAGED/);
    // A staged line may still change at the database level (the service is the front door).
    await db.execute(sql`update bank_import_lines set amount = amount where id = ${lines[2]!.id}`);

    const other = await stage(c, c.bankId, [{ date: '2026-07-01', description: 'X', amount: '-1.00' }]);
    expect(await codeOf(amendImportLine(c.owner, c.companyId, batch.id, other.lines[0]!.id, { amount: '-2.00' }), BankImportError)).toBe('LINE_NOT_FOUND');
    expect(await codeOf(amendImportLine(c.owner, c.companyId, '00000000-0000-4000-8000-00000000dead', lines[2]!.id, { amount: '-2.00' }), BankImportError)).toBe('BATCH_NOT_FOUND');
    // Untouched figures.
    const view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines.map((l) => l.amount)).toEqual(['1500.0000', '-120.5000', '-200.0000']);
  });
});

describe('correcting a staged line\'s date and description (LL-112)', () => {
  it('changes the date and description, keeps what the parser read, audits only the changed fields; unchanged values are a no-op', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    const depot = lines[1]!;
    expect(await amendImportLine(c.owner, c.companyId, batch.id, depot.id, { amount: '-120.50', txnDate: '2026-06-12', description: '  OFFICE DEPOT #4471 ' })).toEqual({ amended: true });
    let view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines[1]).toMatchObject({
      amount: '-120.5000', amendedFrom: null,
      txnDate: '2026-06-12', amendedDateFrom: '2026-06-02',
      description: 'OFFICE DEPOT #4471', amendedDescriptionFrom: 'OFFICE DEPOT',
    });
    let audit = await amendments(c.companyId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toEqual({ txnDate: '2026-06-02', description: 'OFFICE DEPOT' });
    expect(audit[0]!.after).toEqual({ txnDate: '2026-06-12', amendedDateFrom: '2026-06-02', description: 'OFFICE DEPOT #4471', amendedDescriptionFrom: 'OFFICE DEPOT' });

    // The same values again: nothing changes, nothing is audited.
    expect(await amendImportLine(c.owner, c.companyId, batch.id, depot.id, { amount: '-120.5', txnDate: '2026-06-12', description: 'OFFICE DEPOT #4471' })).toEqual({ amended: false });
    // Omitted fields are left as they are.
    expect(await amendImportLine(c.owner, c.companyId, batch.id, depot.id, { amount: '-120.50' })).toEqual({ amended: false });
    expect(await amendments(c.companyId)).toHaveLength(1);

    // A second date correction keeps the date the parser read; the description is untouched.
    await amendImportLine(c.owner, c.companyId, batch.id, depot.id, { amount: '-120.50', txnDate: '2026-06-13' });
    view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines[1]).toMatchObject({ txnDate: '2026-06-13', amendedDateFrom: '2026-06-02', description: 'OFFICE DEPOT #4471', amendedDescriptionFrom: 'OFFICE DEPOT' });
    audit = await amendments(c.companyId);
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.before)).toContainEqual({ txnDate: '2026-06-12' });
  });

  it('the duplicate hash follows the corrected date and description; the entry posts on the corrected date with the corrected description', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    await amendImportLine(c.owner, c.companyId, batch.id, lines[1]!.id, { amount: '-120.50', txnDate: '2026-06-12', description: 'OFFICE DEPOT #4471' });

    const corrected = await stage(c, c.bankId, [{ date: '2026-06-12', description: 'OFFICE DEPOT #4471', amount: '-120.50' }]);
    expect(corrected.lines[0]!.duplicateOf).toBe('staged');
    const misread = await stage(c, c.bankId, [MISREAD[1]!]);
    expect(misread.lines[0]!.duplicateOf).toBeNull();

    await postImportLines(c.owner, c.companyId, batch.id, { decisions: [{ lineId: lines[1]!.id, action: 'post', accountId: c.expenseId }] });
    const posted = (await getImportBatch(c.owner, c.companyId, batch.id))!.lines[1]!;
    const db = await getTestDb();
    const entry = await db.execute<{ transaction_date: string; posting_date: string; description: string | null }>(sql`
      select transaction_date::text, posting_date::text, description from journal_entries where id = ${posted.journalEntryId}`);
    expect(entry.rows[0]).toEqual({ transaction_date: '2026-06-12', posting_date: '2026-06-12', description: 'OFFICE DEPOT #4471' });
  });

  it('a post that planned with the old date or description is refused (LINE_CHANGED)', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    const stale = lines[0]!;
    await amendImportLine(c.owner, c.companyId, batch.id, stale.id, { amount: '1500.00', txnDate: '2026-06-09' });
    const db = await getTestDb();
    expect(await codeOf(db.transaction((tx) => lockStagedLine(tx, c.companyId, stale.id, stale)), BankImportError)).toBe('LINE_CHANGED');
    expect(await db.transaction((tx) => lockStagedLine(tx, c.companyId, stale.id, { ...stale, txnDate: '2026-06-09' }))).toBe(true);
    await amendImportLine(c.owner, c.companyId, batch.id, stale.id, { amount: '1500.00', description: 'DEPOSIT 0042' });
    expect(await codeOf(db.transaction((tx) => lockStagedLine(tx, c.companyId, stale.id, { ...stale, txnDate: '2026-06-09' })), BankImportError)).toBe('LINE_CHANGED');
  });

  it('a decided line\'s date and description are frozen — by the service and by the database', async () => {
    const c = await setup();
    const { batch, lines } = await stage(c, c.bankId, MISREAD);
    await postImportLines(c.owner, c.companyId, batch.id, { decisions: [
      { lineId: lines[0]!.id, action: 'post', accountId: c.expenseId },
      { lineId: lines[1]!.id, action: 'ignore' },
    ] });
    expect(await codeOf(amendImportLine(c.owner, c.companyId, batch.id, lines[0]!.id, { amount: '1500.00', txnDate: '2026-06-09' }), BankImportError)).toBe('LINE_NOT_EDITABLE');
    expect(await codeOf(amendImportLine(c.owner, c.companyId, batch.id, lines[1]!.id, { amount: '-120.50', description: 'X' }), BankImportError)).toBe('LINE_NOT_EDITABLE');
    const db = await getTestDb();
    for (const id of [lines[0]!.id, lines[1]!.id]) {
      expect(await rejection(db.execute(sql`update bank_import_lines set txn_date = '2026-06-09' where id = ${id}`))).toMatch(/LINE_NOT_STAGED/);
      expect(await rejection(db.execute(sql`update bank_import_lines set description = 'X' where id = ${id}`))).toMatch(/LINE_NOT_STAGED/);
    }
    // A status change alone (Undo, un-ignore) still passes the widened trigger.
    await db.execute(sql`update bank_import_lines set status = 'STAGED' where id = ${lines[1]!.id}`);
    const view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.lines.map((l) => [l.txnDate, l.description])).toEqual([['2026-06-01', 'DEPOSIT'], ['2026-06-02', 'OFFICE DEPOT'], ['2026-06-03', 'RENT']]);
  });
});
