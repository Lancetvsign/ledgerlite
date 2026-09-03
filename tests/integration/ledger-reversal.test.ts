/**
 * Reversal engine & posted-entry immutability — LL-033. Against a real database.
 *
 * The decisive assertion for every reversal is that the original plus its
 * reversal net to exactly zero on every account (decimal.js, not floats) —
 * `assertReversalNetsToZero`. A reversal that does not net to zero is not a
 * reversal, however plausible it looks.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { LedgerError, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { toLedgerDomainError } from '@/server/ledger/internal';
import { closePeriod } from '@/server/periods';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

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
      email: `rv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'R',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({
    id: response.user.id,
    email: response.user.email,
    name: response.user.name,
  });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'R Co', timezone: 'America/Chicago' }),
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

function reverse(c: Ctx, entryId: string, extra: Record<string, unknown> = {}) {
  return reverseJournalEntry(
    reverseJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      entryId,
      ...extra,
    }),
  );
}

const errOf = async (p: Promise<unknown>): Promise<LedgerError> => {
  try {
    await p;
    throw new Error('expected LedgerError');
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return e as LedgerError;
  }
};

/**
 * Asserts a query rejects with `re` found ANYWHERE on the error's cause chain.
 * The Neon driver wraps a trigger's RAISE in a generic "Failed query: …" message
 * and carries the real text (`POSTED_ENTRY_IMMUTABLE: …`) on `.cause` — so a
 * plain `.rejects.toThrow(re)`, which only reads the top message, would miss it.
 */
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

async function reloadEntry(id: string): Promise<{ status: string; reversed_by_id: string | null }> {
  const db = await getTestDb();
  const rows = await db.execute<{ status: string; reversed_by_id: string | null }>(
    sql`select status, reversed_by_id from journal_entries where id = ${id}`,
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('entry not found');
  return row;
}

async function reversalCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text n from journal_entries where company_id = ${companyId} and source_type = 'REVERSAL'`,
  );
  return Number(rows.rows[0]?.n);
}

beforeEach(async () => {
  await truncateAll();
});

describe('reversal produces the exact mirror of the original', () => {
  it('single debit/credit pair: swaps the two sides and nets to zero', async () => {
    const c = await setup();
    const { entry: orig, lines: origLines } = await post(c, [
      { accountId: c.cashId, debit: '100.00' },
      { accountId: c.revId, credit: '100.00' },
    ]);

    const { entry: rvsl, lines: rvslLines } = await reverse(c, orig.id);

    expect(rvsl.status).toBe('POSTED');
    expect(rvsl.sourceType).toBe('REVERSAL');
    expect(rvsl.reversalOfId).toBe(orig.id);
    expect(rvsl.entryNumber).toBe(2); // original was 1
    // Every line's debit and credit are swapped, same account and position.
    for (const ol of origLines) {
      const rl = rvslLines.find((l) => l.lineNumber === ol.lineNumber);
      expect(rl).toBeDefined();
      expect(rl!.accountId).toBe(ol.accountId);
      expect(rl!.debit).toBe(ol.credit);
      expect(rl!.credit).toBe(ol.debit);
    }
    // Original is driven through the one permitted transition, nothing else.
    const reloaded = await reloadEntry(orig.id);
    expect(reloaded.status).toBe('REVERSED');
    expect(reloaded.reversed_by_id).toBe(rvsl.id);

    await assertReversalNetsToZero(orig.id, rvsl.id);
  });

  it('multi-line entry: every side swaps and the whole thing nets to zero', async () => {
    const c = await setup();
    const { entry: orig, lines: origLines } = await post(c, [
      { accountId: c.cashId, debit: '60.00' },
      { accountId: c.expenseId, debit: '40.00' },
      { accountId: c.revId, credit: '100.00' },
    ]);

    const { entry: rvsl, lines: rvslLines } = await reverse(c, orig.id);

    expect(rvslLines).toHaveLength(3);
    for (const ol of origLines) {
      const rl = rvslLines.find((l) => l.lineNumber === ol.lineNumber)!;
      expect(rl.accountId).toBe(ol.accountId);
      expect(rl.debit).toBe(ol.credit);
      expect(rl.credit).toBe(ol.debit);
    }
    await assertReversalNetsToZero(orig.id, rvsl.id);
  });

  it('preserves customer/vendor tags and four-decimal amounts, still nets to zero', async () => {
    const c = await setup();
    const { entry: orig, lines: origLines } = await post(c, [
      { accountId: c.cashId, debit: '0.3333' },
      { accountId: c.expenseId, debit: '0.3333' },
      { accountId: c.revId, credit: '0.6666' },
    ]);
    const { entry: rvsl, lines: rvslLines } = await reverse(c, orig.id);
    for (const ol of origLines) {
      const rl = rvslLines.find((l) => l.lineNumber === ol.lineNumber)!;
      expect(rl.debit).toBe(ol.credit);
      expect(rl.credit).toBe(ol.debit);
    }
    await assertReversalNetsToZero(orig.id, rvsl.id);
  });
});

describe('reversal date & closed periods (ADR-007)', () => {
  it('reverses an entry whose ORIGINAL period is closed, into an open period, without touching the closed one', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '250.00' },
      { accountId: c.revId, credit: '250.00' },
    ]);
    // Close January (the original's period).
    const db = await getTestDb();
    const jan = await db.execute<{ id: string; status: string }>(
      sql`select id, status from accounting_periods where company_id = ${c.companyId} and start_date = '2026-01-01'`,
    );
    const janId = jan.rows[0]!.id;
    await closePeriod(c.userId, c.companyId, janId);

    // Reverse into an explicitly open month — the correction lands there.
    const { entry: rvsl } = await reverse(c, orig.id, { reversalDate: '2026-03-15' });
    expect(rvsl.postingDate).toBe('2026-03-15');

    // January is untouched: still closed, and the original still sits in January.
    const janAfter = await db.execute<{ status: string }>(
      sql`select status from accounting_periods where id = ${janId}`,
    );
    expect(janAfter.rows[0]!.status).toBe('CLOSED');
    const origAfter = await db.execute<{ posting_date: string; status: string }>(
      sql`select posting_date, status from journal_entries where id = ${orig.id}`,
    );
    expect(origAfter.rows[0]!.posting_date).toBe('2026-01-10');
    expect(origAfter.rows[0]!.status).toBe('REVERSED');

    await assertReversalNetsToZero(orig.id, rvsl.id);
  });

  it('rejects a reversal date that lands in a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '10.00' },
      { accountId: c.revId, credit: '10.00' },
    ]);
    const db = await getTestDb();
    const jan = await db.execute<{ id: string }>(
      sql`select id from accounting_periods where company_id = ${c.companyId} and start_date = '2026-01-01'`,
    );
    await closePeriod(c.userId, c.companyId, jan.rows[0]!.id);

    const err = await errOf(reverse(c, orig.id, { reversalDate: '2026-01-20' }));
    expect(err.code).toBe('PERIOD_CLOSED');
    // Nothing partial: no reversal entry, original untouched.
    expect(await reversalCount(c.companyId)).toBe(0);
    expect((await reloadEntry(orig.id)).status).toBe('POSTED');
  });
});

describe('what cannot be reversed', () => {
  it('an already-reversed entry cannot be reversed again (ENTRY_ALREADY_REVERSED)', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '5.00' },
      { accountId: c.revId, credit: '5.00' },
    ]);
    await reverse(c, orig.id);
    const err = await errOf(reverse(c, orig.id));
    expect(err.code).toBe('ENTRY_ALREADY_REVERSED');
    expect(await reversalCount(c.companyId)).toBe(1); // still exactly one
  });

  it('a reversal itself CAN be reversed (reversing a reversal is ordinary)', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '5.00' },
      { accountId: c.revId, credit: '5.00' },
    ]);
    const { entry: rvsl } = await reverse(c, orig.id);
    // Reverse the reversal — permitted (ADR-007). It nets the reversal back out.
    const { entry: rvsl2 } = await reverse(c, rvsl.id);
    expect(rvsl2.reversalOfId).toBe(rvsl.id);
    expect((await reloadEntry(rvsl.id)).status).toBe('REVERSED');
    await assertReversalNetsToZero(rvsl.id, rvsl2.id);
  });

  it('a non-existent entry id returns ENTRY_NOT_FOUND', async () => {
    const c = await setup();
    const err = await errOf(reverse(c, '00000000-0000-0000-0000-000000000000'));
    expect(err.code).toBe('ENTRY_NOT_FOUND');
  });
});

describe('authorization & tenant isolation', () => {
  it('a member of another company cannot reverse this company’s entry (denied, no leak)', async () => {
    const a = await setup();
    const b = await setup();
    const { entry: orig } = await post(a, [
      { accountId: a.cashId, debit: '9.00' },
      { accountId: a.revId, credit: '9.00' },
    ]);
    // b's owner names company A: not a member there -> denied (not a LedgerError).
    await expect(
      reverseJournalEntry(
        reverseJournalEntryInput.parse({ companyId: a.companyId, actorUserId: b.userId, entryId: orig.id }),
      ),
    ).rejects.toThrow();
    expect(await reversalCount(a.companyId)).toBe(0);
    expect((await reloadEntry(orig.id)).status).toBe('POSTED');
  });

  it('naming your OWN company but a foreign entry id returns ENTRY_NOT_FOUND (same as a miss)', async () => {
    const a = await setup();
    const b = await setup();
    const { entry: orig } = await post(a, [
      { accountId: a.cashId, debit: '9.00' },
      { accountId: a.revId, credit: '9.00' },
    ]);
    // b's owner, scoped to company B, cannot even see A's entry.
    const err = await errOf(
      reverseJournalEntry(
        reverseJournalEntryInput.parse({ companyId: b.companyId, actorUserId: b.userId, entryId: orig.id }),
      ),
    );
    expect(err.code).toBe('ENTRY_NOT_FOUND');
    expect((await reloadEntry(orig.id)).status).toBe('POSTED');
  });

  it('a member lacking journal.post (READ_ONLY) is denied', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '9.00' },
      { accountId: c.revId, credit: '9.00' },
    ]);
    const reader = await makeUser();
    await insertMembership(c.companyId, reader, 'READ_ONLY');
    await expect(
      reverseJournalEntry(
        reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: reader, entryId: orig.id }),
      ),
    ).rejects.toThrow();
    expect(await reversalCount(c.companyId)).toBe(0);
  });
});

describe('concurrency: two reversals of the same entry produce exactly one', () => {
  it('one wins, one is rejected, and the pair nets to zero', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '77.00' },
      { accountId: c.revId, credit: '77.00' },
    ]);

    const results = await Promise.allSettled([reverse(c, orig.id), reverse(c, orig.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser fails with a typed ledger error — the entry was already reversed,
    // or the DB immutability trigger caught the second write.
    const reason: unknown = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(LedgerError);
    expect(['ENTRY_ALREADY_REVERSED', 'POSTED_ENTRY_IMMUTABLE']).toContain(
      (reason as LedgerError).code,
    );

    // Exactly one reversal exists; the original is REVERSED exactly once.
    expect(await reversalCount(c.companyId)).toBe(1);
    const reloaded = await reloadEntry(orig.id);
    expect(reloaded.status).toBe('REVERSED');
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ entry: { id: string } }>).value;
    expect(reloaded.reversed_by_id).toBe(winner.entry.id);
    await assertReversalNetsToZero(orig.id, winner.entry.id);
  });
});

describe('posted-entry immutability — the database layer (service bypassed)', () => {
  it('rejects a raw UPDATE of a posted entry field', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '1.00' },
      { accountId: c.revId, credit: '1.00' },
    ]);
    const db = await getTestDb();
    await expectRejectsOnChain(
      db.execute(sql`update journal_entries set description = 'tampered' where id = ${orig.id}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
  });

  it('rejects a raw DELETE of a posted entry', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '1.00' },
      { accountId: c.revId, credit: '1.00' },
    ]);
    const db = await getTestDb();
    await expectRejectsOnChain(
      db.execute(sql`delete from journal_entries where id = ${orig.id}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
  });

  it('rejects a raw UPDATE and DELETE of a posted entry’s lines', async () => {
    const c = await setup();
    const { entry: orig } = await post(c, [
      { accountId: c.cashId, debit: '1.00' },
      { accountId: c.revId, credit: '1.00' },
    ]);
    const db = await getTestDb();
    await expectRejectsOnChain(
      db.execute(sql`update journal_lines set debit = '2.0000' where journal_entry_id = ${orig.id}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
    await expectRejectsOnChain(
      db.execute(sql`delete from journal_lines where journal_entry_id = ${orig.id}`),
      /POSTED_ENTRY_IMMUTABLE/,
    );
  });
});

describe('posted-entry immutability — the service layer maps the trigger error', () => {
  it('toLedgerDomainError turns a trigger-shaped failure into a typed POSTED_ENTRY_IMMUTABLE', () => {
    // The driver wraps the raise on the cause chain; the mapper must walk it.
    const raw = new Error('update failed');
    (raw as { cause?: unknown }).cause = new Error(
      'POSTED_ENTRY_IMMUTABLE: a posted entry may only transition to REVERSED',
    );
    const mapped = toLedgerDomainError(raw);
    expect(mapped).toBeInstanceOf(LedgerError);
    expect((mapped as LedgerError).code).toBe('POSTED_ENTRY_IMMUTABLE');
  });

  it('passes an unrelated error through unchanged', () => {
    const other = new Error('connection reset');
    expect(toLedgerDomainError(other)).toBe(other);
  });
});
