/**
 * LL-036 ADVERSARIAL — reversal edge cases. Reverse a reversal, double-reversal
 * races, reverse into a closed period, cross-company reverse, self-reference,
 * re-post a source after its entry was reversed. Audits all four invariants.
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
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, assertReversalNetsToZero } from '../helpers/ledger-invariants';

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
      email: `adv3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@synthetic.test`,
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
    createCompanyInput.parse({ legalName: 'Adv3 Co', timezone: 'America/Chicago' }),
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

function reverse(c: Ctx, entryId: string, reversalDate = '2026-03-10', extra: Record<string, unknown> = {}) {
  return reverseJournalEntry(reverseJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, entryId, reversalDate, ...extra,
  }));
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '<<resolved>>';
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    return `<<non-ledger: ${String((e as { message?: string }).message ?? e).slice(0, 100)}>>`;
  }
}

async function statusOf(entryId: string): Promise<string | undefined> {
  const db = await getTestDb();
  const r = await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${entryId}`);
  return r.rows[0]?.status;
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId}`);
  return Number(r.rows[0]?.n);
}

beforeEach(async () => {
  await truncateAll();
});

describe('ADV3 reversal edge cases', () => {
  it('R1 — reverse a reversal (chain of 3): every adjacent pair nets to zero, integrity holds', async () => {
    const c = await setup();
    const { entry: a } = await post(c, [
      { accountId: c.cashId, debit: '100.0000' },
      { accountId: c.revId, credit: '100.0000' },
    ]);
    const { entry: b } = await reverse(c, a.id, '2026-03-10'); // reversal of A
    const { entry: d } = await reverse(c, b.id, '2026-04-10'); // reversal of the reversal
    // A -> REVERSED (by B). B -> REVERSED (by D). D -> POSTED.
    expect(await statusOf(a.id)).toBe('REVERSED');
    expect(await statusOf(b.id)).toBe('REVERSED');
    expect(await statusOf(d.id)).toBe('POSTED');
    await assertReversalNetsToZero(a.id, b.id);
    await assertReversalNetsToZero(b.id, d.id);
    expect(await entryCount(c.companyId)).toBe(3);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('R2 — reversing an already-reversed entry is rejected (ENTRY_ALREADY_REVERSED)', async () => {
    const c = await setup();
    const { entry: a } = await post(c, [
      { accountId: c.cashId, debit: '10.0000' },
      { accountId: c.revId, credit: '10.0000' },
    ]);
    await reverse(c, a.id);
    expect(await codeOf(reverse(c, a.id))).toBe('ENTRY_ALREADY_REVERSED');
    expect(await entryCount(c.companyId)).toBe(2);
    await assertLedgerIntegrity(c.companyId);
  });

  it('R3 — reversing into a CLOSED period is rejected (PERIOD_CLOSED)', async () => {
    const c = await setup();
    const { entry: a } = await post(c, [
      { accountId: c.cashId, debit: '10.0000' },
      { accountId: c.revId, credit: '10.0000' },
    ]);
    // Materialize + close the March period, then aim the reversal at it.
    const march = await getAccountingPeriod(c.companyId, '2026-03-15');
    await closePeriod(c.userId, c.companyId, march.id);
    expect(await codeOf(reverse(c, a.id, '2026-03-10'))).toBe('PERIOD_CLOSED');
    // Original untouched, still POSTED.
    expect(await statusOf(a.id)).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('R4 — cross-company reversal is ENTRY_NOT_FOUND, never a cross-tenant write', async () => {
    const a = await setup();
    const b = await setup();
    const { entry } = await post(a, [
      { accountId: a.cashId, debit: '9.0000' },
      { accountId: a.revId, credit: '9.0000' },
    ]);
    // b tries to reverse a's entry, scoped to b.
    expect(await codeOf(reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: b.companyId, actorUserId: b.userId, entryId: entry.id, reversalDate: '2026-03-10',
    })))).toBe('ENTRY_NOT_FOUND');
    expect(await statusOf(entry.id)).toBe('POSTED');
    await assertLedgerIntegrity(a.companyId);
    await assertLedgerIntegrity(b.companyId);
  });

  it('R5 — reversing a nonexistent / all-zeros uuid is ENTRY_NOT_FOUND', async () => {
    const c = await setup();
    expect(await codeOf(reverse(c, '00000000-0000-0000-0000-000000000000'))).toBe('ENTRY_NOT_FOUND');
    await assertLedgerIntegrity(c.companyId);
  });

  it('R6 — double-reversal race on a reversal entry itself yields exactly one grand-reversal', async () => {
    const c = await setup();
    const { entry: a } = await post(c, [
      { accountId: c.cashId, debit: '50.0000' },
      { accountId: c.revId, credit: '50.0000' },
    ]);
    const { entry: b } = await reverse(c, a.id, '2026-03-10');
    // Now race many reversals of B (the reversal).
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => reverse(c, b.id, '2026-04-10')),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(1);
    expect(await statusOf(b.id)).toBe('REVERSED');
    expect(await entryCount(c.companyId)).toBe(3);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('R7 — reverse a source-backed entry, then RE-POST the same source (must not double-post)', async () => {
    const c = await setup();
    const { entry: a } = await post(c, [
      { accountId: c.cashId, debit: '40.0000' },
      { accountId: c.revId, credit: '40.0000' },
    ], { sourceType: 'INVOICE', sourceId: 'INV-R7', idempotencyKey: 'idem-R7-a' });
    await reverse(c, a.id, '2026-03-10'); // original now REVERSED, leaves the source-posted index
    // Re-post the SAME (sourceType, sourceId) with a fresh key: ALLOWED, because the
    // prior is no longer POSTED (it left the partial "one POSTED per source" index
    // when it became REVERSED). It succeeds and posts.
    const reposted = await post(c, [
      { accountId: c.cashId, debit: '40.0000' },
      { accountId: c.revId, credit: '40.0000' },
    ], { sourceType: 'INVOICE', sourceId: 'INV-R7', idempotencyKey: 'idem-R7-b' });
    expect(reposted.entry.status).toBe('POSTED');
    // …but there is still at most one POSTED entry for that source.
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

  it('R8 — reversal on a leap-day boundary date resolves the right period and nets to zero', async () => {
    const c = await setup();
    const { entry: a } = await post(c, [
      { accountId: c.expenseId, debit: '12.3400' },
      { accountId: c.revId, credit: '12.3400' },
    ]);
    // 2028 is a leap year; Feb 29 must resolve to the Feb 2028 period and post.
    const { entry: r } = await reverse(c, a.id, '2028-02-29');
    expect(r.status).toBe('POSTED');
    await assertReversalNetsToZero(a.id, r.id);
    await assertLedgerIntegrity(c.companyId);
  });

  it('R9 — a chain of 5 reversals stays perfectly balanced end to end', async () => {
    const c = await setup();
    let { entry: cur } = await post(c, [
      { accountId: c.cashId, debit: '1.0000' },
      { accountId: c.revId, credit: '1.0000' },
    ]);
    const ids = [cur.id];
    for (let i = 0; i < 5; i += 1) {
      const month = String(3 + i).padStart(2, '0');
      const res = await reverse(c, cur.id, `2026-${month}-10`);
      cur = res.entry;
      ids.push(cur.id);
    }
    // 6 entries total; consecutive pairs each net to zero.
    expect(await entryCount(c.companyId)).toBe(6);
    for (let i = 0; i + 1 < ids.length; i += 1) {
      await assertReversalNetsToZero(ids[i]!, ids[i + 1]!);
    }
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });
});
