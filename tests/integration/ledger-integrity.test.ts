/**
 * Ledger integrity assertions — LL-034. Against a real database.
 *
 * Two halves: the assertions PASS on a sound ledger, and each one DETECTS the
 * specific corruption it exists to catch. Injecting corruption is deliberately
 * hard — the schema forbids it — so we exploit two facts:
 *
 *   1. The balance/《≥2 lines》 guard is a DEFERRABLE trigger that fires only at
 *      COMMIT. Inside a transaction we roll back, it never fires, so an unbalanced
 *      or line-less POSTED entry is briefly observable.
 *   2. DDL is transactional in PostgreSQL. `alter table … drop constraint` inside
 *      a transaction is undone by rollback, so an FK can be lifted just long enough
 *      to insert an orphan or cross-company row, then restored automatically.
 *
 * Every corruption is therefore injected inside a transaction that always rolls
 * back — nothing corrupt ever commits, and the global teardown audit stays green.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { postJournalEntry } from '@/server/ledger';
import {
  assertAccountOwnership,
  assertLedgerBalanced,
  assertLedgerIntegrity,
  assertNoOrphanedLines,
  assertTrialBalanceBalanced,
  LedgerIntegrityError,
  type Executor,
} from '@/server/ledger/invariants';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';

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
      email: `int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'I',
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
    createCompanyInput.parse({ legalName: 'Int Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id };
}

function postValid(c: Ctx, debit: string, credit: string) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: '2026-01-10',
      sourceType: 'JOURNAL_ENTRY',
      lines: [
        { accountId: c.cashId, debit },
        { accountId: c.revId, credit },
      ],
    }),
  );
}

/**
 * Injects corruption inside a transaction, runs the assertion against that same
 * (uncommitted) state, and asserts it was detected — then always rolls back.
 */
async function expectDetected(
  inject: (tx: Executor) => Promise<void>,
  check: (tx: Executor) => Promise<void>,
): Promise<void> {
  const db = await getTestDb();
  let detected = false;
  try {
    await db.transaction(async (tx) => {
      await inject(tx);
      await check(tx); // throws LedgerIntegrityError when the assertion works
      throw new Error('__not_detected__'); // reached only if it did NOT — force rollback
    });
  } catch (e) {
    if (e instanceof LedgerIntegrityError) detected = true;
    else if (e instanceof Error && e.message === '__not_detected__') detected = false;
    else throw e; // an unexpected DB error means the injection itself was wrong
  }
  expect(detected, 'the assertion did not detect the injected corruption').toBe(true);
}

beforeEach(async () => {
  await truncateAll();
});

describe('a sound ledger passes every assertion', () => {
  it('assertLedgerIntegrity resolves on valid, committed data', async () => {
    const c = await setup();
    await postValid(c, '100.00', '100.00');
    await postValid(c, '40.0000', '40.0000');
    await expect(assertLedgerIntegrity(c.companyId)).resolves.toBeUndefined();
    // And each individually.
    await expect(assertLedgerBalanced(c.companyId)).resolves.toBeUndefined();
    await expect(assertNoOrphanedLines(c.companyId)).resolves.toBeUndefined();
    await expect(assertAccountOwnership(c.companyId)).resolves.toBeUndefined();
    await expect(assertTrialBalanceBalanced(c.companyId)).resolves.toBeUndefined();
  });

  it('an empty company is trivially intact', async () => {
    const c = await setup();
    await expect(assertLedgerIntegrity(c.companyId)).resolves.toBeUndefined();
  });
});

describe('each assertion detects its corruption', () => {
  it('assertLedgerBalanced catches an unbalanced POSTED entry', async () => {
    const c = await setup();
    await expectDetected(
      async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
          values (${c.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 90001) returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values (${id}, ${c.companyId}, ${c.cashId}, 1, '100.0000', '0.0000'),
                 (${id}, ${c.companyId}, ${c.revId}, 2, '0.0000', '90.0000')`);
      },
      (tx) => assertLedgerBalanced(c.companyId, tx),
    );
  });

  it('assertTrialBalanceBalanced catches the same imbalance company-wide', async () => {
    const c = await setup();
    await expectDetected(
      async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
          values (${c.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 90002) returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values (${id}, ${c.companyId}, ${c.cashId}, 1, '100.0000', '0.0000'),
                 (${id}, ${c.companyId}, ${c.revId}, 2, '0.0000', '90.0000')`);
      },
      (tx) => assertTrialBalanceBalanced(c.companyId, tx),
    );
  });

  it('assertNoOrphanedLines catches a POSTED entry with no lines', async () => {
    const c = await setup();
    await expectDetected(
      async (tx) => {
        await tx.execute(sql`
          insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
          values (${c.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 90003)`);
      },
      (tx) => assertNoOrphanedLines(c.companyId, tx),
    );
  });

  it('assertNoOrphanedLines catches a line whose entry does not exist', async () => {
    const c = await setup();
    await expectDetected(
      async (tx) => {
        // Lift the entry FK just long enough to insert the orphan; rollback restores it.
        await tx.execute(sql`alter table journal_lines drop constraint journal_lines_entry_same_company_fk`);
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values ('00000000-0000-0000-0000-0000000000ff', ${c.companyId}, ${c.cashId}, 1, '5.0000', '0.0000')`);
      },
      (tx) => assertNoOrphanedLines(c.companyId, tx),
    );
  });

  it('assertAccountOwnership catches a line referencing another company’s account', async () => {
    const a = await setup();
    const b = await setup();
    await expectDetected(
      async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
          values (${a.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${a.userId}, 'POSTED', 90004) returning id`);
        const entryId = r.rows[0]!.id;
        // Lift the account FK; insert A's line pointing at B's account; rollback restores it.
        await tx.execute(sql`alter table journal_lines drop constraint journal_lines_account_same_company_fk`);
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values (${entryId}, ${a.companyId}, ${b.cashId}, 1, '5.0000', '0.0000')`);
      },
      (tx) => assertAccountOwnership(a.companyId, tx),
    );
  });
});

describe('company scoping', () => {
  it('an assertion scoped to one company ignores another company’s (valid) data', async () => {
    const a = await setup();
    const b = await setup();
    await postValid(a, '100.00', '100.00');
    await postValid(b, '5.00', '5.00');
    // Both are valid, so both pass; the point is the scoped query runs per-company.
    await expect(assertLedgerIntegrity(a.companyId)).resolves.toBeUndefined();
    await expect(assertLedgerIntegrity(b.companyId)).resolves.toBeUndefined();
    await expect(assertLedgerIntegrity()).resolves.toBeUndefined(); // all companies
  });
});
