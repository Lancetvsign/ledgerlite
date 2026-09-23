/**
 * LL-097 — invariant 7 across two companies: if the SECOND side of an assignment fails to
 * post, the first side must not survive. The ledger module is partially mocked so the second
 * `postEntryCore` of one assignment throws after the first has written A's entry inside the
 * same transaction; the transaction must roll back completely.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Ledger from '@/server/ledger';

let failAfterCalls = Number.POSITIVE_INFINITY;
let calls = 0;

vi.mock('@/server/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof Ledger>();
  return {
    ...actual,
    postEntryCore: async (...args: Parameters<typeof actual.postEntryCore>) => {
      const result = await actual.postEntryCore(...args); // A's side really writes first
      calls += 1;
      if (calls >= failAfterCalls) throw new Error('INJECTED_FAULT after the first side posted');
      return result;
    },
  };
});

import { getAuth } from '@/lib/auth';
import { createAccount, listAccounts } from '@/server/accounts';
import { assignSharedLines, getImportBatch, stageImport } from '@/server/bank-import';
import { cannedExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `at-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'A' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}

beforeEach(async () => {
  await truncateAll();
  calls = 0;
  failAfterCalls = Number.POSITIVE_INFINITY;
});

describe('assign is all-or-nothing across the two companies', () => {
  it('a failure on the second side leaves no entry in either company, the line STAGED, and the counters untouched', async () => {
    const owner = await makeUser();
    const a = (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Alpha Co', timezone: 'America/Chicago' }), 'standard')).company.id;
    const b = (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Beta Co', timezone: 'America/Chicago' }), 'standard')).company.id;
    const org = await createOrganization(owner, a, { name: 'G' });
    await addCompanyToOrganization(owner, b, org.id);
    const card = await createAccount(owner, a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const supplies = (await listAccounts(owner, b)).find((x) => x.accountType === 'EXPENSE')!.id;
    const batch = await stageImport(owner, a, { bankAccountId: card.id, fileBytes: new Uint8Array(), shareWithOrganization: true }, cannedExtractor);
    const line = (await getImportBatch(owner, a, batch.id))!.lines[1]!;
    const db = await getTestDb();
    const counters = async () => (await db.execute<{ c: string; n: string }>(sql`select company_id::text c, next_entry_number::text n from company_counters where company_id in (${a}, ${b}) order by 1`)).rows;
    const before = await counters();

    failAfterCalls = 2; // the second postEntryCore of the assignment (B's side)
    await expect(assignSharedLines(owner, b, batch.id, { decisions: [{ lineId: line.id, accountId: supplies }] })).rejects.toThrow(/INJECTED_FAULT/);

    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where source_type = 'INTERCOMPANY'`)).rows[0]!.n).toBe('0');
    const row = (await db.execute<{ status: string; journal_entry_id: string | null; assigned_company_id: string | null }>(sql`select status, journal_entry_id, assigned_company_id from bank_import_lines where id = ${line.id}`)).rows[0]!;
    expect(row).toEqual({ status: 'STAGED', journal_entry_id: null, assigned_company_id: null });
    expect(await counters()).toEqual(before);

    // The pair accounts created inside the same transaction rolled back too, and a retry succeeds cleanly.
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where intercompany_company_id is not null`)).rows[0]!.n).toBe('0');
    failAfterCalls = Number.POSITIVE_INFINITY;
    expect((await assignSharedLines(owner, b, batch.id, { decisions: [{ lineId: line.id, accountId: supplies }] })).assigned).toBe(1);
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where source_type = 'INTERCOMPANY' and status = 'POSTED'`)).rows[0]!.n).toBe('2');
  });
});
