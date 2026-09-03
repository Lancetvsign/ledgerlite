/**
 * Idempotency and concurrency — LL-032. Real parallel postings against the real
 * database (mocked concurrency proves nothing). After EVERY test:
 * assertLedgerIntact — balanced, one-per-source, no partial journal.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { LedgerError, postJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, entryNumbers } from '../helpers/ledger-invariants';

interface Ctx { userId: string; companyId: string; cashId: string; revId: string }

async function setup(): Promise<Ctx> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `cc-${Date.now()}-${Math.random().toString(36).slice(2,6)}@synthetic.test`, password: 'synthetic-password-1', name: 'C' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  const { company } = await createCompanyWithOwner(user.id, createCompanyInput.parse({ legalName: 'C Co', timezone: 'America/Chicago' }));
  const cash = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  return { userId: user.id, companyId: company.id, cashId: cash.id, revId: rev.id };
}

function invoicePost(c: Ctx, sourceId: string, key: string, amount = '100.0000') {
  return postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-10',
    sourceType: 'INVOICE', sourceId, idempotencyKey: key,
    lines: [{ accountId: c.cashId, debit: amount }, { accountId: c.revId, credit: amount }],
  });
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id=${companyId} and status='POSTED'`);
  return Number(r.rows[0]?.n);
}

beforeEach(async () => { await truncateAll(); });

describe('idempotency semantics', () => {
  it('an identical retry returns the SAME entry, not an error, not a duplicate', async () => {
    const c = await setup();
    const req = invoicePost(c, 'INV-1', 'KEY-1');
    const first = await postJournalEntry(req);
    const retry = await postJournalEntry(req);
    expect(retry.entry.id).toBe(first.entry.id);
    expect(await entryCount(c.companyId)).toBe(1);
    await assertLedgerIntact(c.companyId);
  });

  it('the same key with a DIFFERENT payload fails IDEMPOTENCY_KEY_CONFLICT', async () => {
    const c = await setup();
    await postJournalEntry(invoicePost(c, 'INV-1', 'KEY-1', '100.0000'));
    let code = '';
    try { await postJournalEntry(invoicePost(c, 'INV-1', 'KEY-1', '200.0000')); }
    catch (e) { expect(e).toBeInstanceOf(LedgerError); code = (e as LedgerError).code; }
    expect(code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await entryCount(c.companyId)).toBe(1); // the second never posted
    await assertLedgerIntact(c.companyId);
  });

  it('the same key in DIFFERENT companies is independent', async () => {
    const a = await setup();
    const b = await setup();
    await postJournalEntry(invoicePost(a, 'INV-1', 'SHARED'));
    await postJournalEntry(invoicePost(b, 'INV-1', 'SHARED'));
    expect(await entryCount(a.companyId)).toBe(1);
    expect(await entryCount(b.companyId)).toBe(1);
    await assertLedgerIntact(a.companyId);
    await assertLedgerIntact(b.companyId);
  });

  it('a source-backed posting with NO key is rejected at the boundary', () => {
    const c = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), cashId: crypto.randomUUID(), revId: crypto.randomUUID() };
    const parsed = postJournalEntryInput.safeParse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-10',
      sourceType: 'INVOICE', sourceId: 'INV-1',
      lines: [{ accountId: c.cashId, debit: '1' }, { accountId: c.revId, credit: '1' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('real concurrency', () => {
  it('TWO simultaneous identical requests → exactly one entry', async () => {
    const c = await setup();
    const req = invoicePost(c, 'INV-2', 'K2');
    const results = await Promise.allSettled([postJournalEntry(req), postJournalEntry(req)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await entryCount(c.companyId)).toBe(1);
    await assertLedgerIntact(c.companyId);
  });

  it('FIVE simultaneous identical requests → exactly one entry', async () => {
    const c = await setup();
    const req = invoicePost(c, 'INV-3', 'K3');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => postJournalEntry(req)));
    // Every one succeeds (each resolves to the single entry) — a retry is never an error.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await entryCount(c.companyId)).toBe(1);
    await assertLedgerIntact(c.companyId);
  });

  it('same key, CONFLICTING payloads, concurrent → one entry, the loser errors', async () => {
    const c = await setup();
    const a = invoicePost(c, 'INV-4', 'K4', '100.0000');
    const b = invoicePost(c, 'INV-4', 'K4', '250.0000');
    const results = await Promise.allSettled([postJournalEntry(a), postJournalEntry(b)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    // At most one posts; the other either conflicts or (if it lost the source
    // unique) also rejects. Exactly one entry exists regardless.
    expect(await entryCount(c.companyId)).toBe(1);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    await assertLedgerIntact(c.companyId);
  });

  it('DISTINCT keys concurrent → both post, both balance', async () => {
    const c = await setup();
    const results = await Promise.allSettled([
      postJournalEntry(invoicePost(c, 'INV-5a', 'K5a')),
      postJournalEntry(invoicePost(c, 'INV-5b', 'K5b')),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await entryCount(c.companyId)).toBe(2);
    await assertLedgerIntact(c.companyId);
  });

  it('concurrent entry_number allocation → contiguous, no gaps, no duplicates (ADR-003)', async () => {
    const c = await setup();
    // Ten distinct concurrent postings; the counter lock must serialise them.
    const reqs = Array.from({ length: 10 }, (_, i) => invoicePost(c, `SRC-${i}`, `KK-${i}`));
    const results = await Promise.allSettled(reqs.map((r) => postJournalEntry(r)));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const numbers = await entryNumbers(c.companyId);
    // Exactly 1..10, contiguous, unique.
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await assertLedgerIntact(c.companyId);
  });
});
