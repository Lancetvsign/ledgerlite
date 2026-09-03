/**
 * Trial balance — LL-034. Derived entirely from journal_lines, against a real DB.
 *
 * The load-bearing test is "entry plus its reversal nets to zero": it proves the
 * trial balance counts REVERSED entries alongside their reversals. If it did not,
 * a reversed entry would vanish and its reversal would stand alone — the books
 * would be wrong exactly when a correction was made.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { getTrialBalance } from '@/server/reports';
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
  expenseId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `tb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'T',
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
    createCompanyInput.parse({ legalName: 'TB Co', timezone: 'America/Chicago' }),
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

function rowFor(tb: Awaited<ReturnType<typeof getTrialBalance>>, accountId: string) {
  return tb.rows.find((r) => r.accountId === accountId);
}

beforeEach(async () => {
  await truncateAll();
});

describe('shape and balancing', () => {
  it('an empty company has no rows and balances at zero', async () => {
    const c = await setup();
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(tb.rows).toHaveLength(0);
    expect(tb.totalDebits).toBe('0.0000');
    expect(tb.totalCredits).toBe('0.0000');
    expect(tb.balanced).toBe(true);
  });

  it('a single balanced entry shows each account in its natural direction', async () => {
    const c = await setup();
    await post(c, [
      { accountId: c.cashId, debit: '100.00' },
      { accountId: c.revId, credit: '100.00' },
    ]);
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');

    const cash = rowFor(tb, c.cashId)!;
    expect(cash.debits).toBe('100.0000');
    expect(cash.credits).toBe('0.0000');
    expect(cash.balance).toBe('100.0000'); // ASSET: debit-natural

    const rev = rowFor(tb, c.revId)!;
    expect(rev.credits).toBe('100.0000');
    expect(rev.balance).toBe('100.0000'); // REVENUE: credit-natural, positive

    expect(tb.totalDebits).toBe('100.0000');
    expect(tb.totalCredits).toBe('100.0000');
    expect(tb.balanced).toBe(true);
  });

  it('sums many entries per account and stays balanced', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '60' }, { accountId: c.revId, credit: '60' }]);
    await post(c, [{ accountId: c.cashId, debit: '40' }, { accountId: c.revId, credit: '40' }]);
    await post(c, [{ accountId: c.expenseId, debit: '25' }, { accountId: c.cashId, credit: '25' }]);
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    // Cash: 60 + 40 debit, 25 credit → net debit 75.
    const cash = rowFor(tb, c.cashId)!;
    expect(cash.debits).toBe('100.0000');
    expect(cash.credits).toBe('25.0000');
    expect(cash.balance).toBe('75.0000');
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebits).toBe(tb.totalCredits);
  });

  it('four-decimal amounts sum exactly (no float drift)', async () => {
    const c = await setup();
    await post(c, [
      { accountId: c.cashId, debit: '0.3333' },
      { accountId: c.expenseId, debit: '0.3333' },
      { accountId: c.revId, credit: '0.6666' },
    ]);
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(tb.totalDebits).toBe('0.6666');
    expect(tb.totalCredits).toBe('0.6666');
    expect(tb.balanced).toBe(true);
  });
});

describe('the reversal case (proves REVERSED entries are counted)', () => {
  it('an entry plus its reversal nets every account to zero', async () => {
    const c = await setup();
    const { entry } = await post(c, [
      { accountId: c.cashId, debit: '100.00' },
      { accountId: c.revId, credit: '100.00' },
    ]);
    await reverseJournalEntry(
      reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId: entry.id }),
    );

    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    // Original (now REVERSED) still contributes; the reversal offsets it → zero.
    expect(rowFor(tb, c.cashId)!.balance).toBe('0.0000');
    expect(rowFor(tb, c.revId)!.balance).toBe('0.0000');
    // Both sides still present in the gross totals, and they balance.
    expect(tb.totalDebits).toBe('200.0000');
    expect(tb.totalCredits).toBe('200.0000');
    expect(tb.balanced).toBe(true);
  });
});

describe('scoping', () => {
  it('asOfDate excludes entries posted later', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '100' }, { accountId: c.revId, credit: '100' }], {
      transactionDate: '2026-01-10',
    });
    await post(c, [{ accountId: c.cashId, debit: '50' }, { accountId: c.revId, credit: '50' }], {
      transactionDate: '2026-03-10',
    });
    const jan = await getTrialBalance(c.userId, c.companyId, '2026-02-01');
    expect(rowFor(jan, c.cashId)!.balance).toBe('100.0000'); // March entry excluded
    const march = await getTrialBalance(c.userId, c.companyId, '2026-03-31');
    expect(rowFor(march, c.cashId)!.balance).toBe('150.0000');
  });

  it('excludes DRAFT entries', async () => {
    const c = await setup();
    await post(c, [{ accountId: c.cashId, debit: '100' }, { accountId: c.revId, credit: '100' }]);
    // Raw-insert a DRAFT with a line — never posted, must not appear.
    const db = await getTestDb();
    const draft = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${c.companyId}, '2026-01-15', '2026-01-15', 'JOURNAL_ENTRY', ${c.userId}, 'DRAFT') returning id`);
    await db.execute(sql`
      insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
      values (${draft.rows[0]!.id}, ${c.companyId}, ${c.cashId}, 1, '999.0000', '0.0000')`);

    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(rowFor(tb, c.cashId)!.balance).toBe('100.0000'); // draft's 999 excluded
    expect(tb.balanced).toBe(true);
  });

  it('shows only the caller company’s entries', async () => {
    const a = await setup();
    const b = await setup();
    await post(a, [{ accountId: a.cashId, debit: '100' }, { accountId: a.revId, credit: '100' }]);
    await post(b, [{ accountId: b.cashId, debit: '7' }, { accountId: b.revId, credit: '7' }]);
    const tbA = await getTrialBalance(a.userId, a.companyId, '2026-12-31');
    expect(tbA.totalDebits).toBe('100.0000');
    expect(rowFor(tbA, b.cashId)).toBeUndefined();
  });
});

describe('authorization', () => {
  it('a non-member is denied', async () => {
    const c = await setup();
    const outsider = await setup();
    await expect(getTrialBalance(outsider.userId, c.companyId, '2026-12-31')).rejects.toThrow();
  });
});
