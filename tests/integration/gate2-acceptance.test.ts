/**
 * GATE 2 — General Ledger manual-acceptance scenario, executed.
 *
 * The Gate 2 acceptance script (prompt pack, Sprint 3) posts four entries on a
 * synthetic company and checks the derived balances. This reproduces it exactly
 * and asserts the mathematically-correct result at every stage, so the human
 * reviewer has a precise, reproducible record rather than a hand computation.
 *
 * NOTE FOR THE REVIEWER — a discrepancy in the acceptance script's stated numbers:
 * the script says "Checking is 7,500.00" AND "Office Supplies 0.00 after reversal".
 * Those describe two different instants. $7,500 is Checking AFTER entries 1–3 and
 * BEFORE the reversal. The reversal of entry 2 (Office Supplies Dr / Checking Cr)
 * must, by double entry, credit Checking back — so once Office Supplies returns to
 * 0, Checking is 8,000.00, not 7,500.00. This test asserts BOTH instants to make
 * the timeline explicit. The engine is correct; the script's single-line summary
 * conflated the pre- and post-reversal states.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { assertLedgerIntegrity } from '@/server/ledger';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertReversalNetsToZero } from '../helpers/ledger-invariants';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `gate2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'Gate2',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

interface Ctx {
  userId: string;
  companyId: string;
  checkingId: string;
  ownerId: string;
  suppliesId: string;
  savingsId: string;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  // system-only chart, then add exactly the accounts the scenario names.
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Acceptance Co', timezone: 'America/Chicago' }),
    'system-only',
  );
  const mk = (name: string, accountType: 'ASSET' | 'EQUITY' | 'EXPENSE') =>
    createAccount(userId, company.id, createAccountInput.parse({ name, accountType }));
  const checking = await mk('Checking', 'ASSET');
  const owner = await mk('Owner Contributions', 'EQUITY');
  const supplies = await mk('Office Supplies', 'EXPENSE');
  const savings = await mk('Savings', 'ASSET');
  return {
    userId,
    companyId: company.id,
    checkingId: checking.id,
    ownerId: owner.id,
    suppliesId: supplies.id,
    savingsId: savings.id,
  };
}

function post(c: Ctx, lines: { accountId: string; debit?: string; credit?: string }[]) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: '2026-01-15',
      sourceType: 'JOURNAL_ENTRY',
      lines,
    }),
  );
}

function balanceOf(tb: Awaited<ReturnType<typeof getTrialBalance>>, accountId: string): string | undefined {
  return tb.rows.find((r) => r.accountId === accountId)?.balance;
}

beforeEach(async () => {
  await truncateAll();
});

describe('GATE 2 — manual acceptance scenario, derived purely from journal lines', () => {
  it('posts the four entries and derives every balance correctly, with the reversal netting to zero', async () => {
    const c = await setup();

    // 1) Owner contributes $10,000.
    await post(c, [
      { accountId: c.checkingId, debit: '10000.00' },
      { accountId: c.ownerId, credit: '10000.00' },
    ]);
    // 2) Office supplies $500 paid from Checking.
    const { entry: entry2 } = await post(c, [
      { accountId: c.suppliesId, debit: '500.00' },
      { accountId: c.checkingId, credit: '500.00' },
    ]);
    // 3) Transfer $2,000 to Savings.
    await post(c, [
      { accountId: c.savingsId, debit: '2000.00' },
      { accountId: c.checkingId, credit: '2000.00' },
    ]);

    // --- Checkpoint A: BEFORE the reversal (entries 1–3). -------------------
    const before = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(balanceOf(before, c.checkingId)).toBe('7500.0000'); // 10,000 − 500 − 2,000
    expect(balanceOf(before, c.suppliesId)).toBe('500.0000');
    expect(balanceOf(before, c.savingsId)).toBe('2000.0000');
    expect(balanceOf(before, c.ownerId)).toBe('10000.0000');
    expect(before.balanced).toBe(true);
    // Trial-balance totals are GROSS (every debit line vs every credit line):
    // 10,000 + 500 + 2,000 on each side.
    expect(before.totalDebits).toBe('12500.0000');
    expect(before.totalCredits).toBe('12500.0000');

    // 4) Reverse entry 2.
    const { entry: reversal } = await reverseJournalEntry(
      reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId: entry2.id }),
    );

    // --- Checkpoint B: AFTER the reversal (final). --------------------------
    const after = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    // Office Supplies returns to 0 — and the reversal credits Checking back, so
    // Checking is 8,000.00 (NOT 7,500.00, which was its pre-reversal value).
    expect(balanceOf(after, c.suppliesId)).toBe('0.0000');
    expect(balanceOf(after, c.checkingId)).toBe('8000.0000');
    expect(balanceOf(after, c.savingsId)).toBe('2000.0000');
    expect(balanceOf(after, c.ownerId)).toBe('10000.0000');
    expect(after.balanced).toBe(true);
    // Gross totals grow by the reversal's 500/500: 12,500 + 500 on each side.
    expect(after.totalDebits).toBe('13000.0000');
    expect(after.totalCredits).toBe('13000.0000');

    // The reversal nets entry 2 to exactly zero on every account it touched.
    await assertReversalNetsToZero(entry2.id, reversal.id);

    // Entry 2 remains visible, UNMODIFIED, marked REVERSED with its original lines.
    const db = await getTestDb();
    const orig = await db.execute<{ status: string; debit: string; credit: string; account_id: string }>(sql`
      select e.status, l.debit, l.credit, l.account_id
      from journal_entries e join journal_lines l on l.journal_entry_id = e.id
      where e.id = ${entry2.id} order by l.line_number`);
    expect(orig.rows[0]?.status).toBe('REVERSED');
    // Original lines unchanged: Office Supplies Dr 500 / Checking Cr 500.
    expect(orig.rows.map((r) => ({ a: r.account_id, d: r.debit, c: r.credit }))).toEqual([
      { a: c.suppliesId, d: '500.0000', c: '0.0000' },
      { a: c.checkingId, d: '0.0000', c: '500.0000' },
    ]);

    await assertLedgerIntegrity(c.companyId);
  });

  it('stores no balance anywhere — proven from the schema, not the code', async () => {
    const db = await getTestDb();
    // No column on any table resembles a stored balance/total (invariant 2).
    const cols = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and (column_name ilike '%balance%' or column_name ilike '%running_total%'
             or column_name = 'total' or column_name ilike '%cached%')`);
    expect(cols.rows).toEqual([]);
  });
});
