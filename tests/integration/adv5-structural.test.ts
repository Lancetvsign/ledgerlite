/**
 * LL-036 ADVERSARIAL — line-level / structural attacks and documented edges.
 * Both-sided lines, zero/zero lines, duplicate account across lines, reversal
 * against a later-deactivated account, and a direct REVERSAL-sourced post.
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
      email: `adv5-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@synthetic.test`,
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
    createCompanyInput.parse({ legalName: 'Adv5 Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  const exp = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id, expenseId: exp.id };
}

function rawPost(
  c: Ctx,
  lines: { accountId: string; debit?: string; credit?: string }[],
  extra: Record<string, unknown> = {},
) {
  return postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-10',
    sourceType: 'JOURNAL_ENTRY', lines, ...extra,
  }));
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return '<<resolved>>'; } catch (e) {
    if (e instanceof LedgerError) return e.code;
    return `<<non-ledger: ${String((e as { message?: string }).message ?? e).slice(0, 100)}>>`;
  }
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId}`);
  return Number(r.rows[0]?.n);
}

beforeEach(async () => {
  await truncateAll();
});

describe('ADV5 structural / line-level attacks', () => {
  it('S1 — a line with BOTH a positive debit and a positive credit is rejected (INVALID_LINE)', async () => {
    const c = await setup();
    expect(await codeOf(rawPost(c, [
      { accountId: c.cashId, debit: '5.0000', credit: '5.0000' },
      { accountId: c.revId, credit: '5.0000' },
      { accountId: c.expenseId, debit: '5.0000' },
    ]))).toBe('INVALID_LINE');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('S2 — a zero/zero line is rejected (INVALID_LINE)', async () => {
    const c = await setup();
    expect(await codeOf(rawPost(c, [
      { accountId: c.cashId, debit: '0', credit: '0' },
      { accountId: c.revId, credit: '0' },
    ]))).toBe('INVALID_LINE');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('S3 — the SAME account on multiple lines is allowed and stays balanced', async () => {
    const c = await setup();
    const { entry, lines } = await rawPost(c, [
      { accountId: c.cashId, debit: '10.0000' },
      { accountId: c.cashId, credit: '4.0000' },
      { accountId: c.revId, credit: '6.0000' },
    ]);
    expect(entry.status).toBe('POSTED');
    expect(lines).toHaveLength(3);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('S4 — reversal still works after the referenced account is DEACTIVATED', async () => {
    const c = await setup();
    const { entry: a } = await rawPost(c, [
      { accountId: c.expenseId, debit: '25.0000' },
      { accountId: c.revId, credit: '25.0000' },
    ]);
    // Deactivate the expense account after posting (app-plausible: accounts service).
    const db = await getTestDb();
    await db.execute(sql`update accounts set status='INACTIVE' where id = ${c.expenseId}`);
    // Reversal must not re-check account status; it must succeed and net to zero.
    const { entry: r } = await reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: a.id, reversalDate: '2026-03-10',
    }));
    expect(r.status).toBe('POSTED');
    await assertReversalNetsToZero(a.id, r.id);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('S5 — a direct REVERSAL-sourced post (no reversal_of_id) posts as an ordinary balanced entry', async () => {
    const c = await setup();
    // sourceType REVERSAL is a legal enum value; a caller could pass it directly.
    // It should behave as any balanced entry and not corrupt integrity.
    const { entry } = await rawPost(c, [
      { accountId: c.cashId, debit: '3.0000' },
      { accountId: c.revId, credit: '3.0000' },
    ], { sourceType: 'REVERSAL' });
    expect(entry.status).toBe('POSTED');
    expect(entry.reversalOfId).toBeNull();
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('S6 — cross-company account in a line is rejected (ACCOUNT_NOT_FOUND), no partial write', async () => {
    const a = await setup();
    const b = await setup();
    expect(await codeOf(rawPost(a, [
      { accountId: b.cashId, debit: '5.0000' }, // another company's account
      { accountId: a.revId, credit: '5.0000' },
    ]))).toBe('ACCOUNT_NOT_FOUND');
    expect(await entryCount(a.companyId)).toBe(0);
    await assertLedgerIntegrity(a.companyId);
    await assertLedgerIntegrity(b.companyId);
  });
});
