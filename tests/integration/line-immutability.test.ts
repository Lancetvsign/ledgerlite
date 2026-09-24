/**
 * Structural line immutability — LL-104 (Gate 7 M5, 5c L4, 5c N4), ADR-044. Against a real DB.
 *
 * Since migration 0042 the `journal_lines` guard fires on INSERT as well as UPDATE/DELETE and
 * has no escape hatch: nothing can add a line under a POSTED or REVERSED entry. The engine
 * therefore posts by TRANSITION (DRAFT → lines → POSTED), the closed-period guard judges that
 * transition, and a REVERSAL must carry its original. Every probe here bypasses LedgerService.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { createAccount, listAccounts } from '@/server/accounts';
import { getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { assertIntercompanyMirror, assertLedgerIntegrity, findIntercompanyMismatches, LedgerError, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { closePeriod } from '@/server/periods';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';
import { entryNumbers } from '../helpers/ledger-invariants';
import { rawDraftEntry, rawPost, rawPostedEntry } from '../helpers/raw-entry';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  revId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `li-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'L',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

/** A company on the standard chart (so A/R exists) plus two plain accounts to post between. */
async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Immutable Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Petty Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Other Revenue', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id };
}

function post(c: Ctx, date: string, lines?: { accountId: string; debit?: string; credit?: string }[]) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: date,
      sourceType: 'JOURNAL_ENTRY',
      lines: lines ?? [
        { accountId: c.cashId, debit: '10.0000' },
        { accountId: c.revId, credit: '10.0000' },
      ],
    }),
  );
}

/** The error's message text across its cause chain — trigger messages surface as causes. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (e) {
    const seen = new Set<unknown>();
    let cur: unknown = e;
    let text = '';
    while (cur instanceof Error && !seen.has(cur)) {
      seen.add(cur);
      text += ' ' + cur.message;
      cur = (cur as { cause?: unknown }).cause;
    }
    return text;
  }
}

async function lineCount(entryId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_lines where journal_entry_id = ${entryId}`);
  return Number(r.rows[0]!.n);
}

async function entryRow(entryId: string): Promise<{ status: string; posted_at: string | null }> {
  const db = await getTestDb();
  const r = await db.execute<{ status: string; posted_at: string | null }>(sql`select status, posted_at from journal_entries where id = ${entryId}`);
  return r.rows[0]!;
}

beforeEach(async () => {
  await truncateAll();
});

describe('no line may be added under a posted or reversed entry (Gate 7 M5)', () => {
  it('refuses a raw balanced pair, and a single line, appended to a service-posted entry; UPDATE and DELETE stay refused', async () => {
    const c = await setup();
    const { entry } = await post(c, '2026-01-15');
    const db = await getTestDb();

    // The M5 shape: a balanced pair, in one transaction, under an entry that is already POSTED.
    expect(await rejection(db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
        values (${entry.id}, ${c.companyId}, ${c.cashId}, 3, '500.0000', '0.0000'),
               (${entry.id}, ${c.companyId}, ${c.revId}, 4, '0.0000', '500.0000')`);
    }))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
    // A single line is refused by the same guard, before the balance trigger could ever see it.
    expect(await rejection(db.execute(sql`
      insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
      values (${entry.id}, ${c.companyId}, ${c.cashId}, 3, '1.0000', '0.0000')`))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
    // The UPDATE / DELETE arms are unchanged.
    expect(await rejection(db.execute(sql`update journal_lines set debit = '99.0000' where journal_entry_id = ${entry.id} and line_number = 1`))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
    expect(await rejection(db.execute(sql`delete from journal_lines where journal_entry_id = ${entry.id}`))).toMatch(/POSTED_ENTRY_IMMUTABLE/);

    expect(await lineCount(entry.id)).toBe(2);
    await assertLedgerIntegrity(c.companyId);
  });

  it('after a reversal, both the REVERSED original and the POSTED reversal refuse an added line', async () => {
    const c = await setup();
    const { entry } = await post(c, '2026-01-15');
    const reversal = await reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: entry.id,
    }));
    const db = await getTestDb();
    for (const id of [entry.id, reversal.entry.id]) {
      expect(await rejection(db.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
        values (${id}, ${c.companyId}, ${c.cashId}, 3, '1.0000', '0.0000')`))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
      expect(await lineCount(id)).toBe(2);
    }
    expect((await entryRow(entry.id)).status).toBe('REVERSED');
    expect((await entryRow(reversal.entry.id)).status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('the intercompany mirror holds against a raw append onto a POSTED INTERCOMPANY entry', async () => {
    const owner = await makeUser();
    const company = async (name: string) =>
      (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: name, timezone: 'America/Chicago' }), 'standard')).company.id;
    const a = await company('Alpha Co');
    const b = await company('Beta Co');
    const org = await createOrganization(owner, a, { name: 'Group' });
    await addCompanyToOrganization(owner, b, org.id);
    const bankA = (await listAccounts(owner, a)).find((x) => x.accountNumber === '1000')!.id;
    const expenseA = (await listAccounts(owner, a)).find((x) => x.accountType === 'EXPENSE')!.id;
    const extractor: TransactionExtractor = () => Promise.resolve([{ date: '2026-07-01', description: 'TFR TO BETA', amount: '-10.00' }]);
    const batch = await stageImport(owner, a, { bankAccountId: bankA, fileBytes: new Uint8Array() }, extractor);
    const line = (await getImportBatch(owner, a, batch.id))!.lines[0]!;
    await postImportLines(owner, a, batch.id, { decisions: [{ lineId: line.id, action: 'intercompany_transfer', counterpartCompanyId: b }] });

    const db = await getTestDb();
    const mark = (await db.execute<{ id: string }>(sql`select id from journal_entries where company_id = ${a} and source_type = 'INTERCOMPANY' and status = 'POSTED'`)).rows[0]!;
    const dueFromA = (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${a} and intercompany_company_id = ${b} and system_account_type = 'INTERCOMPANY_RECEIVABLE'`)).rows[0]!.id;

    // Source INTERCOMPANY passes the Due-account allow-list; the balanced pair would keep the entry
    // balanced. Only the line guard stands in the way — and it does, unconditionally.
    expect(await rejection(db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
        values (${mark.id}, ${a}, ${dueFromA}, 3, '99.0000', '0.0000'),
               (${mark.id}, ${a}, ${expenseA}, 4, '0.0000', '99.0000')`);
    }))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
    expect(await lineCount(mark.id)).toBe(2);
    // The mark is legitimately in transit; nothing about the pair is a mismatch.
    expect(await findIntercompanyMismatches(getDbTx(), undefined, { asOf: '2026-07-05' })).toEqual([]);
    await expect(assertIntercompanyMirror(undefined, getDbTx(), { asOf: '2026-07-05' })).resolves.toBeUndefined();
    await assertLedgerIntegrity(a);
    await assertLedgerIntegrity(b);
  });
});

describe('the only raw shape that posts is the transition the engine uses (ADR-044)', () => {
  it('DRAFT → lines → POSTED commits balanced with posted_at set; an unbalanced or single-line draft is refused at commit', async () => {
    const c = await setup();
    const db = await getTestDb();
    const id = await db.transaction((tx) =>
      rawPostedEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'JOURNAL_ENTRY', entryNumber: 91000, lines: [
        { accountId: c.cashId, debit: '7.0000', credit: '0.0000' },
        { accountId: c.revId, debit: '0.0000', credit: '7.0000' },
      ] }),
    );
    expect(await entryRow(id)).toMatchObject({ status: 'POSTED' });
    expect((await entryRow(id)).posted_at).not.toBeNull();
    expect(await lineCount(id)).toBe(2);

    expect(await rejection(db.transaction((tx) =>
      rawPostedEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'JOURNAL_ENTRY', entryNumber: 91001, lines: [
        { accountId: c.cashId, debit: '7.0000', credit: '0.0000' },
        { accountId: c.revId, debit: '0.0000', credit: '6.0000' },
      ] }),
    ))).toMatch(/UNBALANCED_JOURNAL_ENTRY|check_violation/);
    expect(await rejection(db.transaction((tx) =>
      rawPostedEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'JOURNAL_ENTRY', entryNumber: 91002, lines: [
        { accountId: c.cashId, debit: '7.0000', credit: '0.0000' },
      ] }),
    ))).toMatch(/at least 2|check_violation/);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a REVERSAL without its original, and a non-reversal carrying reversal_of_id, are refused (Gate 7 5c L4)', async () => {
    const c = await setup();
    const { entry } = await post(c, '2026-01-15');
    const db = await getTestDb();
    expect(await rejection(db.transaction((tx) =>
      rawDraftEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'REVERSAL', entryNumber: 91010, lines: [] }),
    ))).toMatch(/journal_entries_reversal_link_consistent/);
    expect(await rejection(db.transaction((tx) =>
      rawDraftEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'JOURNAL_ENTRY', entryNumber: 91011, reversalOfId: entry.id, lines: [] }),
    ))).toMatch(/journal_entries_reversal_link_consistent/);
    // A well-formed raw reversal is still admitted (the service is the only sane author, but the CHECK is about shape).
    const ok = await db.transaction((tx) =>
      rawPostedEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'REVERSAL', entryNumber: 91012, reversalOfId: entry.id, transactionDate: '2026-01-16', lines: [
        { accountId: c.revId, debit: '10.0000', credit: '0.0000' },
        { accountId: c.cashId, debit: '0.0000', credit: '10.0000' },
      ] }),
    );
    expect((await entryRow(ok)).status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('the closed-period guard judges the transition (Gate 7 5c N4)', () => {
  it('a draft dated in a closed period cannot be flipped to POSTED, and a raw POSTED insert there is still refused', async () => {
    const c = await setup();
    await post(c, '2026-01-10'); // creates January
    const db = await getTestDb();
    const jan = (await db.execute<{ id: string }>(sql`select id from accounting_periods where company_id = ${c.companyId} and start_date = '2026-01-01'`)).rows[0]!;
    await closePeriod(c.userId, c.companyId, jan.id);

    expect(await rejection(db.transaction(async (tx) => {
      const id = await rawDraftEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'JOURNAL_ENTRY', entryNumber: 92000, transactionDate: '2026-01-20', lines: [
        { accountId: c.cashId, debit: '1.0000', credit: '0.0000' },
        { accountId: c.revId, debit: '0.0000', credit: '1.0000' },
      ] });
      await rawPost(tx, id); // the transition — judged by the new BEFORE UPDATE trigger
    }))).toMatch(/PERIOD_CLOSED/);
    expect(await rejection(db.execute(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
      values (${c.companyId}, '2026-01-20', '2026-01-20', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 92001)`))).toMatch(/PERIOD_CLOSED/);
    // Nothing leaked: no DRAFT left behind, no entry in January beyond the original.
    const n = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.companyId}`);
    expect(Number(n.rows[0]!.n)).toBe(1);
    // A draft in the OPEN period flips fine.
    const feb = await db.transaction((tx) =>
      rawPostedEntry(tx, { companyId: c.companyId, userId: c.userId, sourceType: 'JOURNAL_ENTRY', entryNumber: 92002, transactionDate: '2026-02-05', lines: [
        { accountId: c.cashId, debit: '1.0000', credit: '0.0000' },
        { accountId: c.revId, debit: '0.0000', credit: '1.0000' },
      ] }),
    );
    expect((await entryRow(feb)).status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('the engine posts by transition', () => {
  it('postJournalEntry returns POSTED with posted_at; a failure after the DRAFT insert leaves no draft and the number is reused', async () => {
    const c = await setup();
    const first = await post(c, '2026-01-15');
    expect(first.entry.status).toBe('POSTED');
    expect(first.entry.postedAt).not.toBeNull();
    expect((await entryRow(first.entry.id)).status).toBe('POSTED');

    // Fails AFTER the DRAFT row exists: the A/R line guard fires on the line insert. The
    // transaction rolls back — no DRAFT survives and the counter is reused (gapless).
    const db = await getTestDb();
    const ar = (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_RECEIVABLE'`)).rows[0]!.id;
    let code = 'OK';
    try {
      await post(c, '2026-01-16', [{ accountId: ar, debit: '5.0000' }, { accountId: c.revId, credit: '5.0000' }]);
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerError);
      code = (e as LedgerError).code;
    }
    expect(code).toBe('CONTROL_ACCOUNT_MANUAL_POST');
    const drafts = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.companyId} and status = 'DRAFT'`);
    expect(Number(drafts.rows[0]!.n)).toBe(0);

    const second = await post(c, '2026-01-16');
    expect(second.entry.entryNumber).toBe(first.entry.entryNumber! + 1);
    expect(await entryNumbers(c.companyId)).toEqual([first.entry.entryNumber, second.entry.entryNumber]);
    await assertLedgerIntegrity(c.companyId);
  });

  it('reverseJournalEntry still reverses: original REVERSED, reversal POSTED with posted_at, numbers gapless', async () => {
    const c = await setup();
    const { entry } = await post(c, '2026-01-15');
    const reversal = await reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: entry.id,
    }));
    expect(reversal.entry.status).toBe('POSTED');
    expect(reversal.entry.postedAt).not.toBeNull();
    expect(reversal.entry.reversalOfId).toBe(entry.id);
    expect((await entryRow(entry.id)).status).toBe('REVERSED');
    expect(await entryNumbers(c.companyId)).toEqual([entry.entryNumber, reversal.entry.entryNumber]);
    await assertLedgerIntegrity(c.companyId);
  });
});
