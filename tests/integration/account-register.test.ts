/**
 * Account register — LL-085 (ADR-040). Against a real DB. Proves: opening balance from
 * activity strictly before the period, a stable running balance in the account's normal
 * side (debit-normal and credit-normal), reversed entries and their reversals both shown
 * and netting (ADR-011), drafts excluded, closing equal to the trial balance, source
 * fields for linking, and the authorization/validation edges.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import { createCompanyWithOwner } from '@/server/companies';
import { postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { getAccountRegister, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  revenueId: string;
  suppliesId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `reg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'R' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'Reg Co', timezone: 'America/Chicago' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ accountNumber: '1000', name: 'Cash', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const revenue = await createAccount(userId, company.id, createAccountInput.parse({ accountNumber: '4000', name: 'Revenue', accountType: 'REVENUE' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ accountNumber: '6300', name: 'Supplies', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, revenueId: revenue.id, suppliesId: supplies.id };
}

async function post(c: Ctx, date: string, debitId: string, creditId: string, amount: string, description?: string): Promise<string> {
  const { entry } = await postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: date, sourceType: 'JOURNAL_ENTRY', description,
    lines: [{ accountId: debitId, debit: amount }, { accountId: creditId, credit: amount }],
  }));
  return entry.id;
}

/** The trial balance's derived balance for one account as of a date. */
async function tbBalance(c: Ctx, accountId: string, asOf: string): Promise<string> {
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}

const register = (c: Ctx, accountId: string, from: string, to: string) =>
  getAccountRegister(c.userId, c.companyId, accountId, from, to);

beforeEach(async () => {
  await truncateAll();
});

describe('getAccountRegister', () => {
  it('a debit-normal account: opening from before the period, running balance, reversal netting, closing = trial balance', async () => {
    const c = await setup();
    await post(c, '2026-01-10', c.cashId, c.revenueId, '100.00', 'January sale');
    await post(c, '2026-02-05', c.suppliesId, c.cashId, '30.00', 'Paper');
    const sale = await post(c, '2026-02-20', c.cashId, c.revenueId, '50.00', 'February sale');
    await reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId: sale, reversalDate: '2026-02-21' }));

    const reg = (await register(c, c.cashId, '2026-02-01', '2026-02-28'))!;
    expect(reg).toMatchObject({ accountNumber: '1000', accountName: 'Cash', accountType: 'ASSET', debitNormal: true });
    expect(reg.openingBalance).toBe('100.0000');
    expect(reg.lines.map((l) => [l.date, l.sourceType, l.debit, l.credit, l.balance])).toEqual([
      ['2026-02-05', 'JOURNAL_ENTRY', '0.0000', '30.0000', '70.0000'],
      ['2026-02-20', 'JOURNAL_ENTRY', '50.0000', '0.0000', '120.0000'],
      ['2026-02-21', 'REVERSAL', '0.0000', '50.0000', '70.0000'],
    ]);
    expect(reg.totalDebits).toBe('50.0000');
    expect(reg.totalCredits).toBe('80.0000');
    expect(reg.closingBalance).toBe('70.0000');
    expect(reg.closingBalance).toBe(await tbBalance(c, c.cashId, '2026-02-28'));

    // Source fields for linking: every row names its entry; the reversal names its original.
    expect(reg.lines.every((l) => l.entryId.length === 36 && l.entryNumber !== '')).toBe(true);
    expect(reg.lines[2]!.reversalOfId).toBe(sale);
    expect(reg.lines[1]!.reversalOfId).toBeNull();
    expect(reg.lines.every((l) => l.bankImportBatchId === null)).toBe(true);
    expect(reg.lines[0]!.description).toBe('Paper');
  });

  it('a credit-normal account accumulates credit − debit, and its closing equals the trial balance', async () => {
    const c = await setup();
    await post(c, '2026-01-10', c.cashId, c.revenueId, '100.00');
    const sale = await post(c, '2026-02-20', c.cashId, c.revenueId, '50.00');
    await reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId: sale, reversalDate: '2026-02-21' }));

    const reg = (await register(c, c.revenueId, '2026-01-01', '2026-12-31'))!;
    expect(reg.debitNormal).toBe(false);
    expect(reg.openingBalance).toBe('0.0000');
    expect(reg.lines.map((l) => [l.debit, l.credit, l.balance])).toEqual([
      ['0.0000', '100.0000', '100.0000'],
      ['0.0000', '50.0000', '150.0000'],
      ['50.0000', '0.0000', '100.0000'],
    ]);
    expect(reg.closingBalance).toBe('100.0000');
    expect(reg.closingBalance).toBe(await tbBalance(c, c.revenueId, '2026-12-31'));
  });

  it('the period is inclusive on both ends and an empty period still carries the opening forward', async () => {
    const c = await setup();
    await post(c, '2026-03-01', c.cashId, c.revenueId, '10.00');
    await post(c, '2026-03-31', c.cashId, c.revenueId, '20.00');
    const march = (await register(c, c.cashId, '2026-03-01', '2026-03-31'))!;
    expect(march.lines).toHaveLength(2);
    const april = (await register(c, c.cashId, '2026-04-01', '2026-04-30'))!;
    expect(april.lines).toHaveLength(0);
    expect(april.openingBalance).toBe('30.0000');
    expect(april.closingBalance).toBe('30.0000');
  });

  it('drafts never appear, in the opening or the activity (ADR-011)', async () => {
    const c = await setup();
    await post(c, '2026-01-10', c.cashId, c.revenueId, '100.00');
    const db = await getTestDb();
    const drafts = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, status, source_type, created_by)
      values (${c.companyId}, '2026-01-05', '2026-01-05', 'DRAFT', 'JOURNAL_ENTRY', ${c.userId}) returning id`);
    const draftId = drafts.rows[0]!.id;
    await db.execute(sql`
      insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
      values (${draftId}, ${c.companyId}, ${c.cashId}, 1, 999, 0), (${draftId}, ${c.companyId}, ${c.revenueId}, 2, 0, 999)`);

    const reg = (await register(c, c.cashId, '2026-01-01', '2026-01-31'))!;
    expect(reg.lines.map((l) => l.debit)).toEqual(['100.0000']);
    const later = (await register(c, c.cashId, '2026-02-01', '2026-02-28'))!;
    expect(later.openingBalance).toBe('100.0000');
  });

  it('a cross-company or unknown account reads as a miss; an outsider is denied; bad ranges throw', async () => {
    const a = await setup();
    const b = await setup();
    expect(await register(a, b.cashId, '2026-01-01', '2026-12-31')).toBeNull();
    expect(await register(a, '00000000-0000-4000-8000-000000000000', '2026-01-01', '2026-12-31')).toBeNull();
    await expect(getAccountRegister(b.userId, a.companyId, a.cashId, '2026-01-01', '2026-12-31')).rejects.toBeInstanceOf(AuthorizationDenied);
    await expect(register(a, a.cashId, '2026-02-01', '2026-01-01')).rejects.toThrow(/on or before/);
    await expect(register(a, a.cashId, 'yesterday', '2026-01-01')).rejects.toThrow(/calendar date/);
  });
});
