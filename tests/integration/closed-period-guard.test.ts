/**
 * Closed-period structural guard — Gate 2 remediation (invariant 5 / ADR-012, migration 0010).
 *
 * Proves the rule is now enforced by the DATABASE, not only by LedgerService: a raw
 * INSERT into a closed period — the service entirely bypassed — is rejected by the
 * trigger. The trigger is scoped to POSTED entries and leaves drafts alone, and the
 * application path still returns the typed PERIOD_CLOSED. The concurrency window this
 * closes (close racing an in-flight post) is exercised in `adv4-period-race.test.ts`.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { assertLedgerIntegrity, LedgerError, postJournalEntry } from '@/server/ledger';
import { closePeriod } from '@/server/periods';
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
      email: `cpg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'C',
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
    createCompanyInput.parse({ legalName: 'CPG Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id };
}

function post(c: Ctx, postingDate: string) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: postingDate,
      sourceType: 'JOURNAL_ENTRY',
      lines: [
        { accountId: c.cashId, debit: '1.0000' },
        { accountId: c.revId, credit: '1.0000' },
      ],
    }),
  );
}

/** Create January by posting into it, then close it. Returns nothing. */
async function postThenCloseJanuary(c: Ctx): Promise<void> {
  await post(c, '2026-01-10');
  const db = await getTestDb();
  const jan = await db.execute<{ id: string }>(
    sql`select id from accounting_periods where company_id = ${c.companyId} and start_date = '2026-01-01'`,
  );
  await closePeriod(c.userId, c.companyId, jan.rows[0]!.id);
}

/** Assert a query rejects with `re` found anywhere on the error's cause chain. */
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

describe('closed-period guard is STRUCTURAL (database, service bypassed)', () => {
  it('rejects a raw-SQL POSTED insert into a closed period', async () => {
    const c = await setup();
    await postThenCloseJanuary(c);
    const db = await getTestDb();
    // The service is entirely bypassed: a direct INSERT of a POSTED entry dated in
    // the now-closed January. The BEFORE INSERT trigger must refuse it.
    await expectRejectsOnChain(
      db.execute(sql`
        insert into journal_entries
          (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
        values (${c.companyId}, '2026-01-20', '2026-01-20', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 90100)`),
      /PERIOD_CLOSED/,
    );
    await assertLedgerIntegrity(c.companyId);
  });

  it('leaves DRAFT inserts into a closed period alone (the guard is scoped to POSTED)', async () => {
    const c = await setup();
    await postThenCloseJanuary(c);
    const db = await getTestDb();
    // A DRAFT carries no ledger effect; the trigger's WHEN clause skips it.
    const draft = await db.execute<{ id: string }>(sql`
      insert into journal_entries
        (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${c.companyId}, '2026-01-20', '2026-01-20', 'JOURNAL_ENTRY', ${c.userId}, 'DRAFT')
      returning id`);
    expect(draft.rows[0]?.id).toBeDefined(); // accepted
    await assertLedgerIntegrity(c.companyId);
  });

  it('allows a raw-SQL POSTED insert into an OPEN period (control)', async () => {
    const c = await setup();
    await post(c, '2026-01-10'); // creates January, OPEN — never closed here
    const db = await getTestDb();
    // A balanced 2-line POSTED entry, service bypassed, in one tx so the deferred
    // balance trigger is satisfied at commit. The period guard must NOT block it.
    await db.transaction(async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        insert into journal_entries
          (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
        values (${c.companyId}, '2026-01-25', '2026-01-25', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 90200)
        returning id`);
      const id = r.rows[0]!.id;
      await tx.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
        values (${id}, ${c.companyId}, ${c.cashId}, 1, '1.0000', '0.0000'),
               (${id}, ${c.companyId}, ${c.revId}, 2, '0.0000', '1.0000')`);
    });
    const cnt = await db.execute<{ n: string }>(
      sql`select count(*)::text n from journal_entries where company_id = ${c.companyId} and entry_number = 90200`,
    );
    expect(Number(cnt.rows[0]?.n)).toBe(1); // committed — the guard does not block open periods
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('closed-period guard through the service (typed error preserved)', () => {
  it('posting into a closed period returns PERIOD_CLOSED', async () => {
    const c = await setup();
    await postThenCloseJanuary(c);
    expect(await codeOf(post(c, '2026-01-15'))).toBe('PERIOD_CLOSED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('posting into an open period still succeeds', async () => {
    const c = await setup();
    await postThenCloseJanuary(c); // January closed…
    const { entry } = await post(c, '2026-02-10'); // …February is open
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});
