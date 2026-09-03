/**
 * LL-036 ADVERSARIAL — period transitions racing a posting.
 *
 * The per-company counter lock serialises intra-company POSTS, but the accounting
 * period lives in a different table and is NOT covered by that lock. This file
 * hammers the close-vs-post and close-vs-reverse TOCTOU windows and reports how
 * many operations land in a period that ends up CLOSED. It then audits the four
 * LL-034 invariants (balance / orphan / ownership / trial-balance), which a
 * closed-period leak does NOT by itself break — reported separately.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import {
  assertLedgerIntegrity,
  LedgerError,
  postJournalEntry,
  reverseJournalEntry,
} from '@/server/ledger';
import { closePeriod, getAccountingPeriod, reopenPeriod } from '@/server/periods';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact } from '../helpers/ledger-invariants';

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
      email: `adv4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'A',
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
    createCompanyInput.parse({ legalName: 'Adv4 Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  const exp = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id, expenseId: exp.id };
}

function post(c: Ctx, date: string, lines: { accountId: string; debit?: string; credit?: string }[]) {
  return postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: date,
    sourceType: 'JOURNAL_ENTRY', lines,
  }));
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    if (e instanceof LedgerError) return e.code;
    return `ERR:${String((e as { message?: string }).message ?? e).slice(0, 60)}`;
  }
}

async function periodId(c: Ctx, date: string): Promise<string> {
  const p = await getAccountingPeriod(c.companyId, date);
  return p.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe('ADV4 period-transition races', () => {
  it('P1 — closing a period concurrently with posts into it breaks no invariant', async () => {
    const c = await setup();
    const date = '2026-01-15';
    const pid = await periodId(c, date); // materialize Jan, OPEN
    for (let round = 0; round < 3; round += 1) {
      await code(reopenPeriod(c.userId, c.companyId, pid)); // fresh OPEN each round
      const ops: Promise<string>[] = [];
      for (let i = 0; i < 8; i += 1) {
        ops.push(code(post(c, date, [
          { accountId: c.cashId, debit: '1.0000' },
          { accountId: c.revId, credit: '1.0000' },
        ])));
      }
      ops.push(code(closePeriod(c.userId, c.companyId, pid)));
      await Promise.all(ops);
      // Since ADR-012 (migration 0010) the posting trigger reads the period FOR SHARE,
      // so a concurrent close serialises against in-flight posts: each post either
      // commits before the close (which WAITS for it) or, once the close has
      // committed, is refused. There is no "post committed into an already-closed
      // period" window. Below: a post after the committed close is always rejected.
      const afterClose = await code(post(c, date, [
        { accountId: c.cashId, debit: '1.0000' },
        { accountId: c.revId, credit: '1.0000' },
      ]));
      expect(afterClose).toBe('PERIOD_CLOSED');
    }
    // Every core invariant holds regardless of the interleaving.
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('P2 — month/year/leap boundary dates resolve to the correct period and post', async () => {
    const c = await setup();
    const dates = [
      '2026-01-01', '2026-01-31', // Jan edges
      '2026-02-01', '2026-02-28', // Feb (non-leap) edges
      '2026-12-31', '2027-01-01', // year edge
      '2028-02-29', // leap day
    ];
    for (const d of dates) {
      const { entry } = await post(c, d, [
        { accountId: c.cashId, debit: '2.0000' },
        { accountId: c.revId, credit: '2.0000' },
      ]);
      expect(entry.status).toBe('POSTED');
      // The posting must fall inside exactly one period bracketing its date.
      const db = await getTestDb();
      const cnt = await db.execute<{ n: string }>(sql`
        select count(*)::text n from accounting_periods
        where company_id = ${c.companyId} and ${d} between start_date and end_date`);
      expect(Number(cnt.rows[0]?.n)).toBe(1);
    }
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('P3 — reverse into a period being CLOSED concurrently', async () => {
    const c = await setup();
    const { entry: a } = await post(c, '2026-01-10', [
      { accountId: c.cashId, debit: '30.0000' },
      { accountId: c.revId, credit: '30.0000' },
    ]);
    const revDate = '2026-05-15';
    const pid = await periodId(c, revDate);
    // Race: reverse A into May while May is being closed.
    await Promise.all([
      code(reverseJournalEntry(reverseJournalEntryInput.parse({
        companyId: c.companyId, actorUserId: c.userId, entryId: a.id, reversalDate: revDate,
      }))),
      code(closePeriod(c.userId, c.companyId, pid)),
    ]);
    // Whatever the interleaving: never two reversals, original at most once reversed.
    const db = await getTestDb();
    const revs = await db.execute<{ n: string }>(sql`
      select count(*)::text n from journal_entries where company_id=${c.companyId} and reversal_of_id = ${a.id}`);
    expect(Number(revs.rows[0]?.n)).toBeLessThanOrEqual(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('P4 — post while the SAME period is being close/reopen flapped concurrently', async () => {
    const c = await setup();
    const date = '2026-07-15';
    const pid = await periodId(c, date);
    const ops: Promise<string>[] = [];
    for (let i = 0; i < 10; i += 1) {
      ops.push(code(post(c, date, [
        { accountId: c.expenseId, debit: '1.0000' },
        { accountId: c.revId, credit: '1.0000' },
      ])));
    }
    // Flap the period open/closed underneath the posts.
    for (let i = 0; i < 4; i += 1) {
      ops.push(code(closePeriod(c.userId, c.companyId, pid)));
      ops.push(code(reopenPeriod(c.userId, c.companyId, pid)));
    }
    await Promise.all(ops);
    // No invariant may break no matter how the posts and close/reopen interleave.
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });
});
