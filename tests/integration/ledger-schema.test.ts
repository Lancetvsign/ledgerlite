/**
 * Ledger schema invariants — LL-030. The database enforces these; these tests
 * attack it directly (raw SQL, no posting service — that is LL-031), asserting
 * each violation is REJECTED. This is the permanent regression net for the
 * product's foundation.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createAccount } from '@/server/accounts';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

async function fixture() {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `led-${Date.now()}@synthetic.test`, password: 'synthetic-password-1', name: 'L' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  const { company } = await createCompanyWithOwner(user.id, createCompanyInput.parse({ legalName: 'Ledger Co', timezone: 'America/Chicago' }));
  const cash = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  return { userId: user.id, companyId: company.id, cashId: cash.id, revId: rev.id };
}

/** Insert an entry (default DRAFT) directly and return its id. */
async function insertEntry(
  db: Awaited<ReturnType<typeof getTestDb>>,
  companyId: string,
  userId: string,
  opts: { status?: string; entryNumber?: number; sourceId?: string; idem?: string } = {},
): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`
    insert into journal_entries
      (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number, source_id, idempotency_key)
    values (${companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${userId},
            ${opts.status ?? 'DRAFT'}, ${opts.entryNumber ?? null}, ${opts.sourceId ?? null}, ${opts.idem ?? null})
    returning id`);
  return r.rows[0]!.id;
}

/** Post a balanced 2-line entry atomically (entry + lines in one tx), as the
 *  real posting service will in LL-031. Returns the entry id. */
async function postBalanced(
  companyId: string,
  userId: string,
  cashId: string,
  revId: string,
  opts: { entryNumber: number; sourceId?: string; fingerprint?: string },
): Promise<string> {
  const { getDbTx } = await import('@/db');
  return await getDbTx().transaction(async (tx) => {
    // idempotency_fingerprint can only be set at INSERT: the immutability trigger
    // forbids changing it once the row is POSTED (that is the invariant under test).
    const r = await tx.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number, source_id, idempotency_fingerprint)
      values (${companyId}, '2026-01-10', '2026-01-10', 'INVOICE', ${userId}, 'POSTED', ${opts.entryNumber}, ${opts.sourceId ?? null}, ${opts.fingerprint ?? null})
      returning id`);
    const id = r.rows[0]!.id;
    await tx.execute(sql`insert into journal_lines (journal_entry_id,company_id,account_id,line_number,debit,credit) values (${id},${companyId},${cashId},1,10,0),(${id},${companyId},${revId},2,0,10)`);
    return id;
  });
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    expect.unreachable('the database should have rejected this');
  } catch (error) {
    expect(String((error as Error).cause ?? error)).toMatch(pattern);
  }
}

beforeEach(async () => {
  await truncateAll();
});

describe('invariant 1 — sign discipline', () => {
  it.each([
    ['negative debit', '-5, 0'],
    ['both positive', '5, 5'],
    ['both zero', '0, 0'],
  ])('rejects a line with %s', async (_l, vals) => {
    const f = await fixture();
    const db = await getTestDb();
    const e = await insertEntry(db, f.companyId, f.userId);
    await rejects(
      db.execute(sql.raw(`insert into journal_lines (journal_entry_id,company_id,account_id,line_number,debit,credit) values ('${e}','${f.companyId}','${f.cashId}',1,${vals})`)),
      /check constraint|journal_lines_sign/i,
    );
  });
});

describe('invariant 2 — no cross-company reference', () => {
  it('rejects a line referencing another company account', async () => {
    const a = await fixture();
    const b = await fixture();
    const db = await getTestDb();
    const e = await insertEntry(db, a.companyId, a.userId);
    // A's entry, but B's account.
    await rejects(
      db.execute(sql`insert into journal_lines (journal_entry_id,company_id,account_id,line_number,debit,credit) values (${e},${a.companyId},${b.cashId},1,5,0)`),
      /foreign key|same_company/i,
    );
  });
});

describe('invariant 3 & 4 — idempotency and one-posting-per-source', () => {
  it('rejects a duplicate idempotency key in the same company', async () => {
    const f = await fixture();
    const db = await getTestDb();
    await insertEntry(db, f.companyId, f.userId, { idem: 'DUP' });
    await rejects(insertEntry(db, f.companyId, f.userId, { idem: 'DUP' }), /duplicate key|idempotency/i);
  });

  it('rejects a second POSTED entry for one source', async () => {
    const f = await fixture();
    await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 1, sourceId: 'INV-1' });
    await rejects(
      postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 2, sourceId: 'INV-1' }),
      /duplicate key|source_posted_once/i,
    );
  });
});

describe('invariant 6 — balance at commit, POSTED only', () => {
  it('a balanced 2-line POSTED entry commits', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const e = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 10 });
    const n = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where id=${e} and status='POSTED'`);
    expect(n.rows[0]?.n).toBe('1');
  });

  it('rejects an unbalanced POSTED entry at commit', async () => {
    const f = await fixture();
    const { getDbTx } = await import('@/db');
    await rejects(
      getDbTx().transaction(async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`insert into journal_entries (company_id,transaction_date,posting_date,source_type,created_by,status,entry_number) values (${f.companyId},'2026-01-10','2026-01-10','JOURNAL_ENTRY',${f.userId},'POSTED',20) returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`insert into journal_lines (journal_entry_id,company_id,account_id,line_number,debit,credit) values (${id},${f.companyId},${f.cashId},1,100,0),(${id},${f.companyId},${f.revId},2,0,99)`);
      }),
      /UNBALANCED_JOURNAL_ENTRY|check_violation/i,
    );
  });

  it('rejects a single-line POSTED entry at commit', async () => {
    const f = await fixture();
    const { getDbTx } = await import('@/db');
    await rejects(
      getDbTx().transaction(async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`insert into journal_entries (company_id,transaction_date,posting_date,source_type,created_by,status,entry_number) values (${f.companyId},'2026-01-10','2026-01-10','JOURNAL_ENTRY',${f.userId},'POSTED',21) returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`insert into journal_lines (journal_entry_id,company_id,account_id,line_number,debit,credit) values (${id},${f.companyId},${f.cashId},1,50,0)`);
      }),
      /at least 2|check_violation/i,
    );
  });

  it('a DRAFT may be unbalanced and single-line', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const e = await insertEntry(db, f.companyId, f.userId); // DRAFT
    await db.execute(sql`insert into journal_lines (journal_entry_id,company_id,account_id,line_number,debit,credit) values (${e},${f.companyId},${f.cashId},1,100,0)`);
    // No error — drafts are exempt.
    const n = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_lines where journal_entry_id=${e}`);
    expect(n.rows[0]?.n).toBe('1');
  });
});

describe('invariant 7 — posted entries are immutable', () => {
  it('rejects UPDATE and DELETE of a posted entry, and DELETE of its lines', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const e = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 30 });
    await rejects(db.execute(sql`update journal_entries set description='x' where id=${e}`), /POSTED_ENTRY_IMMUTABLE|restrict/i);
    await rejects(db.execute(sql`delete from journal_entries where id=${e}`), /POSTED_ENTRY_IMMUTABLE|restrict/i);
    await rejects(db.execute(sql`delete from journal_lines where journal_entry_id=${e}`), /POSTED_ENTRY_IMMUTABLE|restrict/i);
  });

  it('permits POSTED → REVERSED setting reversed_by_id', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const orig = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 40 });
    const rev = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 41 });
    await db.execute(sql`update journal_entries set status='REVERSED', reversed_by_id=${rev} where id=${orig}`);
    const s = await db.execute<{ status: string }>(sql`select status from journal_entries where id=${orig}`);
    expect(s.rows[0]?.status).toBe('REVERSED');
  });

  // Regression: idempotency_fingerprint was added in migration 0008, AFTER 0006's
  // frozen-column list. The permitted POSTED→REVERSED transition must still change
  // NOTHING but status + reversed_by_id — including this later-added column.
  it('rejects POSTED → REVERSED that also changes idempotency_fingerprint', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const orig = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 50, fingerprint: 'fp-original' });
    const rev = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 51 });
    await rejects(
      db.execute(sql`update journal_entries set status='REVERSED', reversed_by_id=${rev}, idempotency_fingerprint='fp-tampered' where id=${orig}`),
      /POSTED_ENTRY_IMMUTABLE|restrict/i,
    );
    // The original is untouched: still POSTED, fingerprint unchanged.
    const after = await db.execute<{ status: string; idempotency_fingerprint: string }>(
      sql`select status, idempotency_fingerprint from journal_entries where id=${orig}`,
    );
    expect(after.rows[0]?.status).toBe('POSTED');
    expect(after.rows[0]?.idempotency_fingerprint).toBe('fp-original');
  });

  it('permits POSTED → REVERSED when idempotency_fingerprint is carried through unchanged', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const orig = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 52, fingerprint: 'fp-original' });
    const rev = await postBalanced(f.companyId, f.userId, f.cashId, f.revId, { entryNumber: 53 });
    // Freezing the column must not FORBID the transition when the fingerprint is
    // left untouched — exactly what the real reversal path does (reversal.ts).
    await db.execute(sql`update journal_entries set status='REVERSED', reversed_by_id=${rev} where id=${orig}`);
    const after = await db.execute<{ status: string; idempotency_fingerprint: string }>(
      sql`select status, idempotency_fingerprint from journal_entries where id=${orig}`,
    );
    expect(after.rows[0]?.status).toBe('REVERSED');
    expect(after.rows[0]?.idempotency_fingerprint).toBe('fp-original');
  });
});

describe('company_counters (ADR-003)', () => {
  it('a counter row is seeded for each company at creation', async () => {
    const f = await fixture();
    const db = await getTestDb();
    const r = await db.execute<{ next_entry_number: string; next_invoice_number: string }>(
      sql`select next_entry_number, next_invoice_number from company_counters where company_id=${f.companyId}`,
    );
    expect(r.rows[0]?.next_entry_number).toBe('1');
    // The invoice-number counter (LL-042) shares this row and also starts at 1.
    expect(r.rows[0]?.next_invoice_number).toBe('1');
  });
});
