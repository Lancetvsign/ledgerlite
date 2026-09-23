/**
 * Intercompany balances report + the mirror invariant — LL-098 / GL-T029. Against a real DB.
 * Two companies of one owner in one organization split a shared card statement (LL-097); the
 * report in EACH company shows the same figure on both sides with a zero difference, before
 * and after a line is given back; a deliberately one-sided raw posting (inside a rolled-back
 * transaction) is detected by `findIntercompanyMismatches` and flips the report to MISMATCH.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { toMoney } from '@/lib/decimal';
import { createAccount, listAccounts } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import { assignSharedLines, getImportBatch, stageImport, unassignSharedLine } from '@/server/bank-import';
import { cannedExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { assertIntercompanyMirror, findIntercompanyMismatches, LedgerIntegrityError } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { getIntercompanyReport } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `ic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'I' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function company(owner: string, name: string): Promise<string> {
  return (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: name, timezone: 'America/Chicago' }), 'standard')).company.id;
}

beforeEach(async () => {
  await truncateAll();
});

describe('intercompany report (LL-098)', () => {
  it('shows the same figure on both sides with a zero difference, in either company, before and after a give-back', async () => {
    const owner = await makeUser();
    const a = await company(owner, 'Alpha Co');
    const b = await company(owner, 'Beta Co');
    const org = await createOrganization(owner, a, { name: 'Group' });
    await addCompanyToOrganization(owner, b, org.id);
    const card = await createAccount(owner, a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const supplies = (await listAccounts(owner, b)).find((x) => x.accountType === 'EXPENSE')!.id;
    const batch = await stageImport(owner, a, { bankAccountId: card.id, fileBytes: new Uint8Array(), shareWithOrganization: true }, cannedExtractor);
    const lines = (await getImportBatch(owner, a, batch.id))!.lines; // −120.50, −45.00, +2000
    await assignSharedLines(owner, b, batch.id, { decisions: [{ lineId: lines[0]!.id, accountId: supplies }, { lineId: lines[1]!.id, accountId: supplies }] });

    const fromA = await getIntercompanyReport(owner, a, '2026-12-31');
    expect(fromA.organizationName).toBe('Group');
    expect(fromA.mirrored).toBe(true);
    expect(fromA.rows).toHaveLength(1);
    expect(fromA.rows[0]).toMatchObject({ counterpartId: b, counterpartLegalName: 'Beta Co', dueFrom: '165.5000', counterpartDueTo: '165.5000', receivableDifference: '0.0000', dueTo: '0.0000', counterpartDueFrom: '0.0000', payableDifference: '0.0000', mirrored: true });
    expect(fromA.totalDueFrom).toBe('165.5000');
    expect(fromA.totalDueTo).toBe('0.0000');
    const fromB = await getIntercompanyReport(owner, b, '2026-12-31');
    expect(fromB.rows[0]).toMatchObject({ counterpartId: a, dueFrom: '0.0000', dueTo: '165.5000', counterpartDueFrom: '165.5000', payableDifference: '0.0000', mirrored: true });
    expect(fromB.totalDueTo).toBe('165.5000');
    expect(toMoney(fromA.rows[0]!.dueFrom).eq(toMoney(fromB.rows[0]!.dueTo))).toBe(true);
    // As of a date before the postings: nothing due, still mirrored.
    expect((await getIntercompanyReport(owner, a, '2026-01-01')).rows[0]).toMatchObject({ dueFrom: '0.0000', counterpartDueTo: '0.0000', mirrored: true });

    await unassignSharedLine(owner, b, batch.id, lines[1]!.id);
    expect((await getIntercompanyReport(owner, a, '2026-12-31')).rows[0]).toMatchObject({ dueFrom: '120.5000', counterpartDueTo: '120.5000', mirrored: true });
    expect(await findIntercompanyMismatches(getDbTx())).toEqual([]);
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();

    // Not in an organization → no name, no rows; a stranger is denied.
    const solo = await company(owner, 'Solo Co');
    expect(await getIntercompanyReport(owner, solo, '2026-12-31')).toMatchObject({ organizationName: null, rows: [], mirrored: true });
    await expect(getIntercompanyReport(await makeUser(), a, '2026-12-31')).rejects.toBeInstanceOf(AuthorizationDenied);
    await expect(getIntercompanyReport(owner, a, 'not-a-date')).rejects.toThrow(/calendar date/);
  });

  it('a one-sided posting is detected — by the invariant and as MISMATCH on the report (rolled back afterwards)', async () => {
    const owner = await makeUser();
    const a = await company(owner, 'Alpha Co');
    const b = await company(owner, 'Beta Co');
    const org = await createOrganization(owner, a, { name: 'Group' });
    await addCompanyToOrganization(owner, b, org.id);
    const card = await createAccount(owner, a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const supplies = (await listAccounts(owner, b)).find((x) => x.accountType === 'EXPENSE')!.id;
    const batch = await stageImport(owner, a, { bankAccountId: card.id, fileBytes: new Uint8Array(), shareWithOrganization: true }, cannedExtractor);
    const lines = (await getImportBatch(owner, a, batch.id))!.lines;
    await assignSharedLines(owner, b, batch.id, { decisions: [{ lineId: lines[1]!.id, accountId: supplies }] });
    const db = await getTestDb();
    const dueFromA = (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${a} and intercompany_company_id = ${b} and system_account_type = 'INTERCOMPANY_RECEIVABLE'`)).rows[0]!.id;
    const expenseA = (await listAccounts(owner, a)).find((x) => x.accountType === 'EXPENSE')!.id;

    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        // Corrupt A's side only: +10 on Due from B with no B-side entry (source INTERCOMPANY passes the trigger).
        const e = await tx.execute<{ id: string }>(sql`insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number) values (${a}, '2026-06-10', '2026-06-10', 'INTERCOMPANY', ${owner}, 'POSTED', 95000) returning id`);
        await tx.execute(sql`insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit) values (${e.rows[0]!.id}, ${a}, ${dueFromA}, 1, '10.0000', '0.0000'), (${e.rows[0]!.id}, ${a}, ${expenseA}, 2, '0.0000', '10.0000')`);
        expect(await findIntercompanyMismatches(tx)).toEqual([`${a}->${b}`]);
        await expect(assertIntercompanyMirror(undefined, tx)).rejects.toBeInstanceOf(LedgerIntegrityError);
        throw new Error('ROLLBACK');
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe('ROLLBACK');
    // Rolled back: clean again, on the invariant and on the report.
    expect(await findIntercompanyMismatches(getDbTx())).toEqual([]);
    expect((await getIntercompanyReport(owner, a, '2026-12-31')).mirrored).toBe(true);
  });
});
