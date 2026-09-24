/**
 * Gate 6 housekeeping — LL-095. Against a real DB. Proves the new structural rules
 * (restrict FKs on the statement line tables, the one-mirror unique, the import-line and
 * template CHECKs, the DRAFT-delete trigger fix), that PURGE_ORDER is a topological order of
 * the FK graph, and the concurrency properties the gate asked for (delete-vs-post,
 * double-submit, save-vs-complete, start-vs-account-lock).
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { deleteImportBatch, getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { cannedExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner, PURGE_ORDER } from '@/server/companies';
import { isIdempotencyViolation, postJournalEntry } from '@/server/ledger';
import { completeReconciliation, getReconciliation, setCleared, startReconciliation } from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';
import { getDbTx, schema } from '@/db';
import { and, eq } from 'drizzle-orm';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx { userId: string; companyId: string; bankId: string; salesId: string; suppliesId: string; rentId: string }

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `hk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'H' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'HK Co', timezone: 'America/Chicago' }), 'standard');
  const bank = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Operating Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Consulting Sales', accountType: 'REVENUE' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies Expense', accountType: 'EXPENSE' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent Expense', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, bankId: bank.id, salesId: sales.id, suppliesId: supplies.id, rentId: rent.id };
}
const EMPTY = new Uint8Array();
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
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(async () => {
  await truncateAll();
});

describe('structural rules (migration 0039)', () => {
  it('a batch with a POSTED line cannot be deleted from under it; the service path still works when nothing posted', async () => {
    const c = await setup();
    const db = await getTestDb();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 's.pdf', fileBytes: EMPTY }, cannedExtractor);
    const l0 = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: l0.id, action: 'post', accountId: c.salesId }] });
    expect(await rejection(db.execute(sql`delete from bank_import_batches where id = ${batch.id}`))).toMatch(/bank_import_lines_batch_same_company_fk|violates foreign key/);
    const fresh = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 't.pdf', fileBytes: EMPTY }, cannedExtractor);
    await expect(deleteImportBatch(c.userId, c.companyId, fresh.id)).resolves.toEqual({ lines: 3 });
  });

  it('import-line CHECKs: POSTED needs an entry, targets only when posted, no zero amount', async () => {
    const c = await setup();
    const db = await getTestDb();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 's.pdf', fileBytes: EMPTY }, cannedExtractor);
    const l0 = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    expect(await rejection(db.execute(sql`update bank_import_lines set status = 'POSTED' where id = ${l0.id}`))).toMatch(/bank_import_lines_posted_has_entry/);
    expect(await rejection(db.execute(sql`update bank_import_lines set chosen_account_id = ${c.salesId} where id = ${l0.id}`))).toMatch(/bank_import_lines_targets_only_when_posted/);
    expect(await rejection(db.execute(sql`update bank_import_lines set amount = 0 where id = ${l0.id}`))).toMatch(/bank_import_lines_amount_nonzero/);
  });

  it('one mirror per posted transfer line — the unique index, not only the service check', async () => {
    const c = await setup();
    const db = await getTestDb();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 's.pdf', fileBytes: EMPTY }, cannedExtractor);
    const [a, b, cc] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: a!.id, action: 'post', accountId: c.salesId }, { lineId: b!.id, action: 'post', accountId: c.suppliesId }, { lineId: cc!.id, action: 'post', accountId: c.rentId }] });
    const entryOfA = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!.journalEntryId;
    // Two raw "mirrors" of line a: the second violates the unique.
    await db.execute(sql`update bank_import_lines set mirror_of_line_id = ${a!.id} where id = ${b!.id}`);
    expect(await rejection(db.execute(sql`update bank_import_lines set mirror_of_line_id = ${a!.id} where id = ${cc!.id}`))).toMatch(/bank_import_lines_mirror_of_line_id_unique/);
    expect(entryOfA).not.toBeNull();
  });

  it('the template flag cannot survive on an archived company (raw flip refused)', async () => {
    const c = await setup();
    const db = await getTestDb();
    expect(await rejection(db.execute(sql`update companies set is_template = true, status = 'INACTIVE' where id = ${c.companyId}`))).toMatch(/companies_template_is_active/);
  });

  it('a DRAFT journal entry can be deleted (the trigger no longer cancels it); a POSTED one still cannot', async () => {
    const c = await setup();
    const db = await getTestDb();
    const d = await db.execute<{ id: string }>(sql`insert into journal_entries (company_id, transaction_date, posting_date, status, source_type, created_by) values (${c.companyId}, '2026-03-01', '2026-03-01', 'DRAFT', 'JOURNAL_ENTRY', ${c.userId}) returning id`);
    await db.execute(sql`delete from journal_entries where id = ${d.rows[0]!.id}`);
    const gone = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where id = ${d.rows[0]!.id}`);
    expect(gone.rows[0]!.n).toBe('0');
    const { entry } = await postJournalEntry(postJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-03-02', sourceType: 'JOURNAL_ENTRY', lines: [{ accountId: c.bankId, debit: '10.00' }, { accountId: c.salesId, credit: '10.00' }] }));
    expect(await rejection(db.execute(sql`delete from journal_entries where id = ${entry.id}`))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
  });

  it('a reconciliation header with cleared lines cannot be deleted from under them', async () => {
    const c = await setup();
    const db = await getTestDb();
    const { entry } = await postJournalEntry(postJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-06-01', sourceType: 'JOURNAL_ENTRY', lines: [{ accountId: c.bankId, debit: '100.00' }, { accountId: c.salesId, credit: '100.00' }] }));
    const rec = await startReconciliation(c.userId, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '100.00' });
    const line = (await db.execute<{ id: string }>(sql`select id from journal_lines where journal_entry_id = ${entry.id} and account_id = ${c.bankId}`)).rows[0]!.id;
    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [line] });
    expect(await rejection(db.execute(sql`delete from bank_reconciliations where id = ${rec.id}`))).toMatch(/bank_reconciliation_lines_reconciliation_same_account_fk|violates foreign key/);
  });

  it('PURGE_ORDER is a topological order of the tenant FK graph (children before the tables they reference)', async () => {
    const db = await getTestDb();
    const purgeArray = `{${PURGE_ORDER.join(',')}}`; // one text[] literal, not a spread row
    const rows = await db.execute<{ child: string; parent: string }>(sql`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
      from pg_constraint c
      where c.contype = 'f' and c.conrelid <> c.confrelid
        and c.conrelid::regclass::text = any(${purgeArray}::text[])
        and c.confrelid::regclass::text = any(${purgeArray}::text[])`);
    const pos = new Map<string, number>(PURGE_ORDER.map((t, i) => [t, i]));
    const violations = rows.rows.filter((r) => (pos.get(r.child) ?? -1) > (pos.get(r.parent) ?? -1)).map((r) => `${r.child} references ${r.parent} but is purged after it`);
    expect(violations).toEqual([]);
    expect(rows.rows.length).toBeGreaterThan(5);
  });
});

describe('concurrency (Gate 6 N9)', () => {
  it('delete-vs-post never leaves a POSTED line without its batch or a batch without its posted line', async () => {
    for (let round = 0; round < 3; round += 1) {
      const c = await setup();
      const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 's.pdf', fileBytes: EMPTY }, cannedExtractor);
      const l0 = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
      const results = await Promise.allSettled([
        postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: l0.id, action: 'post', accountId: c.salesId }] }),
        deleteImportBatch(c.userId, c.companyId, batch.id),
      ]);
      const db = await getTestDb();
      const batches = Number((await db.execute<{ n: string }>(sql`select count(*)::text n from bank_import_batches where id = ${batch.id}`)).rows[0]!.n);
      const posted = Number((await db.execute<{ n: string }>(sql`select count(*)::text n from bank_import_lines where batch_id = ${batch.id} and status = 'POSTED'`)).rows[0]!.n);
      const entries = Number((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.companyId} and source_type = 'BANK_IMPORT'`)).rows[0]!.n);
      // Either the delete won (nothing posted, batch gone) or the post won (batch kept, one entry).
      expect([`${batches}/${posted}/${entries}`, results.map((r) => r.status).join(',')]).toSatisfy(([state]: [string, string]) => state === '0/0/0' || state === '1/1/1');
    }
  });

  it('a double submit posts each line once', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 's.pdf', fileBytes: EMPTY }, cannedExtractor);
    const lines = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    const decisions = [
      { lineId: lines[0]!.id, action: 'post' as const, accountId: c.salesId },
      { lineId: lines[1]!.id, action: 'post' as const, accountId: c.suppliesId },
      { lineId: lines[2]!.id, action: 'post' as const, accountId: c.rentId },
    ];
    const [r1, r2] = await Promise.all([postImportLines(c.userId, c.companyId, batch.id, { decisions }), postImportLines(c.userId, c.companyId, batch.id, { decisions })]);
    expect(r1.posted + r2.posted).toBe(3);
    const db = await getTestDb();
    expect(Number((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.companyId} and source_type = 'BANK_IMPORT' and status = 'POSTED'`)).rows[0]!.n)).toBe(3);
  });

  it('save-vs-complete: a completed reconciliation always reflects the saved set', async () => {
    const c = await setup();
    const db = await getTestDb();
    const { entry } = await postJournalEntry(postJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-06-01', sourceType: 'JOURNAL_ENTRY', lines: [{ accountId: c.bankId, debit: '100.00' }, { accountId: c.salesId, credit: '100.00' }] }));
    const rec = await startReconciliation(c.userId, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '100.00' });
    const line = (await db.execute<{ id: string }>(sql`select id from journal_lines where journal_entry_id = ${entry.id} and account_id = ${c.bankId}`)).rows[0]!.id;
    const results = await Promise.allSettled([
      setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [line] }),
      completeReconciliation(c.userId, c.companyId, rec.id),
    ]);
    const view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    if (view.reconciliation.status === 'COMPLETED') {
      expect(view.lines.filter((l) => l.cleared).map((l) => l.journalLineId)).toEqual([line]); // completed only over the saved set
    } else {
      expect(results[1].status).toBe('rejected'); // completion lost the race to a non-zero difference
    }
  });

  it('startReconciliation waits for a holder of the account row (the completion lock)', async () => {
    const c = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = getDbTx().transaction(async (tx) => {
      await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(and(eq(schema.accounts.companyId, c.companyId), eq(schema.accounts.id, c.bankId))).for('update');
      await gate;
    });
    await pause(200);
    let settled = false;
    const start = startReconciliation(c.userId, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '0.00' }).then((r) => { settled = true; return r; });
    await pause(700);
    expect(settled).toBe(false);
    release();
    await holder;
    expect((await start).status).toBe('IN_PROGRESS');
  });
});

describe('isIdempotencyViolation (LL-095 N2)', () => {
  it('recognises only the once-only journal_entries indexes, through the cause chain', () => {
    const wrap = (msg: string) => new Error('Failed query', { cause: new Error(msg) });
    expect(isIdempotencyViolation(wrap('duplicate key value violates unique constraint "journal_entries_source_posted_once"'))).toBe(true);
    expect(isIdempotencyViolation(wrap('duplicate key value violates unique constraint "journal_entries_one_opening_balance"'))).toBe(true);
    expect(isIdempotencyViolation(wrap('duplicate key value violates unique constraint "journal_entries_idempotency_unique"'))).toBe(true);
    expect(isIdempotencyViolation(wrap('duplicate key value violates unique constraint "accounts_company_number_unique"'))).toBe(false);
    expect(isIdempotencyViolation(new Error('connection refused'))).toBe(false);
  });
});
