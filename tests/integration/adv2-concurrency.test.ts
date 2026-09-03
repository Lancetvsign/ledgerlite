/**
 * LL-036 ADVERSARIAL — concurrency. Promise.all of many simultaneous
 * posts/reversals aimed at: double-posting a source, duplicating an idempotent
 * post, producing two reversals of one entry, or gapping/duplicating entry
 * numbers. Each case audits the four LL-034 invariants at the end.
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
      email: `adv2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@synthetic.test`,
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
    createCompanyInput.parse({ legalName: 'Adv2 Co', timezone: 'America/Chicago' }),
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

async function entryCount(companyId: string, status?: string): Promise<number> {
  const db = await getTestDb();
  const r = status === undefined
    ? await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId}`)
    : await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId} and status = ${status}`);
  return Number(r.rows[0]?.n);
}

function codes(results: PromiseSettledResult<unknown>[]): string[] {
  return results.map((r) =>
    r.status === 'fulfilled'
      ? 'OK'
      : r.reason instanceof LedgerError
        ? r.reason.code
        : `ERR:${String((r.reason as { message?: string }).message ?? r.reason).slice(0, 60)}`,
  );
}

beforeEach(async () => {
  await truncateAll();
});

describe('ADV2 concurrency attacks', () => {
  it('C1 — 12 simultaneous identical idempotent posts collapse to one entry', async () => {
    const c = await setup();
    const args = { sourceType: 'INVOICE' as const, sourceId: 'INV-C1', idempotencyKey: 'idem-C1' };
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        post(c, [{ accountId: c.cashId, debit: '15.0000' }, { accountId: c.revId, credit: '15.0000' }], args)),
    );
    const ids = new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.entry.id] : [])));
    expect(ids.size).toBe(1);
    expect(await entryCount(c.companyId)).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('C2 — 10 simultaneous posts of the SAME source with DIFFERENT idempotency keys: one POSTED', async () => {
    const c = await setup();
    // The double-post attack: dodge the idempotency index by varying the key, and
    // try to land two POSTED rows for one (sourceType, sourceId).
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        post(c, [{ accountId: c.cashId, debit: '20.0000' }, { accountId: c.revId, credit: '20.0000' }],
          { sourceType: 'INVOICE', sourceId: 'INV-C2', idempotencyKey: `idem-C2-${String(i)}` })),
    );
    // Exactly one wins the "one POSTED per source" index; the other nine collide
    // and are turned away (IDEMPOTENCY_KEY_CONFLICT) — never a second POSTED.
    const outcomes = codes(results);
    expect(outcomes.filter((o) => o === 'OK')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'IDEMPOTENCY_KEY_CONFLICT')).toHaveLength(9);
    expect(await entryCount(c.companyId, 'POSTED')).toBe(1);
    // No two POSTED rows share the source.
    const db = await getTestDb();
    const dup = await db.execute<{ n: string }>(sql`
      select count(*)::text n from (
        select 1 from journal_entries
        where company_id = ${c.companyId} and status='POSTED' and source_id is not null
        group by source_type, source_id having count(*) > 1) x`);
    expect(Number(dup.rows[0]?.n)).toBe(0);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('C3 — 10 simultaneous reversals of one entry produce exactly one reversal', async () => {
    const c = await setup();
    const { entry } = await post(c, [
      { accountId: c.cashId, debit: '77.0000' },
      { accountId: c.revId, credit: '77.0000' },
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        reverseJournalEntry(reverseJournalEntryInput.parse({
          companyId: c.companyId, actorUserId: c.userId, entryId: entry.id, reversalDate: '2026-03-10',
        }))),
    );
    const reversalIds = new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.entry.id] : [])));
    expect(reversalIds.size).toBe(1);
    // Original reversed exactly once; ledger has exactly 2 entries (orig + 1 reversal).
    expect(await entryCount(c.companyId)).toBe(2);
    expect(await entryCount(c.companyId, 'REVERSED')).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('C4 — 20 distinct concurrent manual posts: all balanced, entry numbers gapless & unique', async () => {
    const c = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        post(c, [
          { accountId: c.cashId, debit: `${String(i + 1)}.0000` },
          { accountId: c.revId, credit: `${String(i + 1)}.0000` },
        ])),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const db = await getTestDb();
    const nums = await db.execute<{ entry_number: string }>(sql`
      select entry_number from journal_entries where company_id = ${c.companyId} order by entry_number`);
    const list = nums.rows.map((r) => Number(r.entry_number));
    const unique = new Set(list);
    expect(ok).toBe(20);
    expect(unique.size).toBe(list.length); // no duplicate numbers
    // Gapless 1..20.
    expect(list).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('C5 — interleave post and reverse of DISTINCT entries concurrently', async () => {
    const c = await setup();
    // Seed 6 entries, then concurrently reverse them all while posting 6 more.
    const seeds = [];
    for (let i = 0; i < 6; i += 1) {
      seeds.push(await post(c, [
        { accountId: c.cashId, debit: '5.0000' },
        { accountId: c.revId, credit: '5.0000' },
      ]));
    }
    const ops: Promise<unknown>[] = [];
    for (const s of seeds) {
      ops.push(reverseJournalEntry(reverseJournalEntryInput.parse({
        companyId: c.companyId, actorUserId: c.userId, entryId: s.entry.id, reversalDate: '2026-03-10',
      })));
    }
    for (let i = 0; i < 6; i += 1) {
      ops.push(post(c, [{ accountId: c.expenseId, debit: '3.0000' }, { accountId: c.revId, credit: '3.0000' }]));
    }
    const results = await Promise.allSettled(ops);
    // Distinct entries, distinct reversals — every operation succeeds and the
    // ledger stays intact under the interleaving.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });
});
