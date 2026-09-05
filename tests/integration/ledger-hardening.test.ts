/**
 * Ledger hardening — LL-052 (Gate 2 §7 items 5–6).
 *
 * Two defense-in-depth guarantees, both proven against a real database:
 *  1. REVERSED entries are immutable too (migration 0020) — a reversed original, and
 *     its lines, can no longer be UPDATEd or DELETEd, with the service bypassed. Only
 *     a DRAFT is editable; the POSTED -> REVERSED reversal still works.
 *  2. An entry whose per-side total exceeds NUMERIC(19,4) is rejected with a typed
 *     ENTRY_AMOUNT_OUT_OF_RANGE, not an opaque overflow at COMMIT.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { LedgerError, assertLedgerIntegrity, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  revId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `hard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'H',
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
    createCompanyInput.parse({ legalName: 'Hardening Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id };
}

/** Post a balanced 2-line entry, then reverse it. Returns the (now REVERSED) original id. */
async function postThenReverse(c: Ctx): Promise<string> {
  const { entry } = await postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-15', sourceType: 'JOURNAL_ENTRY',
    lines: [{ accountId: c.cashId, debit: '10.0000' }, { accountId: c.revId, credit: '10.0000' }],
  }));
  await reverseJournalEntry(reverseJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, entryId: entry.id,
  }));
  return entry.id;
}

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

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    throw new Error('expected a LedgerError');
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return (e as LedgerError).code;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('REVERSED entries are immutable (structural, service bypassed)', () => {
  it('rejects a raw UPDATE and DELETE of a REVERSED entry', async () => {
    const c = await setup();
    const reversedId = await postThenReverse(c);
    const db = await getTestDb();
    // Confirm it is REVERSED, then attack it directly.
    const status = await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${reversedId}`);
    expect(status.rows[0]?.status).toBe('REVERSED');

    await expectRejectsOnChain(
      db.execute(sql`update journal_entries set description = 'tampered' where id = ${reversedId}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
    await expectRejectsOnChain(
      db.execute(sql`delete from journal_entries where id = ${reversedId}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
    await assertLedgerIntegrity(c.companyId);
  });

  it('rejects a raw UPDATE and DELETE of a REVERSED entry’s lines', async () => {
    const c = await setup();
    const reversedId = await postThenReverse(c);
    const db = await getTestDb();
    await expectRejectsOnChain(
      db.execute(sql`update journal_lines set debit = '99.0000' where journal_entry_id = ${reversedId}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
    await expectRejectsOnChain(
      db.execute(sql`delete from journal_lines where journal_entry_id = ${reversedId}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
    await assertLedgerIntegrity(c.companyId);
  });

  it('still allows the reversal (POSTED → REVERSED) and leaves a DRAFT editable', async () => {
    const c = await setup();
    // The reversal itself succeeded (postThenReverse would have thrown otherwise);
    // the original is REVERSED and its reversal is POSTED.
    const reversedId = await postThenReverse(c);
    const db = await getTestDb();
    const entries = await db.execute<{ status: string; source_type: string }>(
      sql`select status, source_type from journal_entries where company_id = ${c.companyId} order by entry_number`,
    );
    expect(entries.rows.map((r) => r.status)).toEqual(['REVERSED', 'POSTED']); // original, then the reversal
    void reversedId;

    // A DRAFT entry and its line remain freely editable (the guard is scoped to POSTED/REVERSED).
    const draft = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${c.companyId}, '2026-01-20', '2026-01-20', 'JOURNAL_ENTRY', ${c.userId}, 'DRAFT') returning id`);
    const draftId = draft.rows[0]!.id;
    await db.execute(sql`
      insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
      values (${draftId}, ${c.companyId}, ${c.cashId}, 1, '5.0000', '0.0000')`);
    await db.execute(sql`update journal_lines set debit = '6.0000' where journal_entry_id = ${draftId}`); // allowed
    const line = await db.execute<{ debit: string }>(sql`select debit from journal_lines where journal_entry_id = ${draftId}`);
    expect(line.rows[0]?.debit).toBe('6.0000');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('entry total is bounded to NUMERIC(19,4) with a typed error', () => {
  it('rejects a balanced entry whose per-side total exceeds the ceiling (ENTRY_AMOUNT_OUT_OF_RANGE)', async () => {
    const c = await setup();
    // Two debits + two credits of 999,999,999,999,999 each: balanced, but each side
    // sums to ~2e15, above the NUMERIC(19,4) max of 999,999,999,999,999.9999.
    expect(await codeOf(postJournalEntry(postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-15', sourceType: 'JOURNAL_ENTRY',
      lines: [
        { accountId: c.cashId, debit: '999999999999999' },
        { accountId: c.cashId, debit: '999999999999999' },
        { accountId: c.revId, credit: '999999999999999' },
        { accountId: c.revId, credit: '999999999999999' },
      ],
    })))).toBe('ENTRY_AMOUNT_OUT_OF_RANGE');
  });

  it('accepts an entry at the ceiling', async () => {
    const c = await setup();
    const { entry } = await postJournalEntry(postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-15', sourceType: 'JOURNAL_ENTRY',
      lines: [
        { accountId: c.cashId, debit: '999999999999999.9999' },
        { accountId: c.revId, credit: '999999999999999.9999' },
      ],
    }));
    expect(entry.status).toBe('POSTED'); // exactly at the max is fine
    await assertLedgerIntegrity(c.companyId);
  });
});
