/**
 * Intercompany corrections — LL-100 (Gate 7 H1, 5c M1, 5b L1). Against a real DB.
 * Un-marking a transfer reverses this side (and the other side when matched) in one transaction,
 * both lines return to STAGED; a give-back reactivates a deactivated pair and dates both
 * reversals the same day; the leave rule counts balances on INACTIVE pair accounts.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { toMoney } from '@/lib/decimal';
import { createAccount, listAccounts } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import { assignSharedLines, BankImportError, getImportBatch, postImportLines, stageImport, unassignSharedLine, unmarkIntercompanyTransfer } from '@/server/bank-import';
import { cannedExtractor, type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { assertIntercompanyMirror } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization, OrganizationError, organizationsActorCanAddTo, removeCompanyFromOrganization } from '@/server/organizations';
import { getIntercompanyReport } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `cx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'C' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function company(owner: string, name: string): Promise<string> {
  return (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: name, timezone: 'America/Chicago' }), 'standard')).company.id;
}
async function codeOf<T extends { code: string }>(p: Promise<unknown>, cls: new (...a: never[]) => T): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    return (e as T).code;
  }
}
const rows = (r: { date: string; description: string; amount: string }[]): TransactionExtractor => () => Promise.resolve(r);
async function stageOne(owner: string, companyId: string, bankId: string, date: string, description: string, amount: string) {
  const batch = await stageImport(owner, companyId, { bankAccountId: bankId, fileBytes: EMPTY }, rows([{ date, description, amount }]));
  const line = (await getImportBatch(owner, companyId, batch.id))!.lines[0]!;
  return { batch, line };
}
async function lineRow(id: string) {
  const db = await getTestDb();
  return (await db.execute<{ status: string; journal_entry_id: string | null; chosen_account_id: string | null }>(sql`select status, journal_entry_id, chosen_account_id from bank_import_lines where id = ${id}`)).rows[0]!;
}
async function entryStatus(id: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${id}`)).rows[0]!.status;
}
interface Ctx { owner: string; a: string; b: string; bankA: string; bankB: string; orgId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const a = await company(owner, 'Alpha Co');
  const b = await company(owner, 'Beta Co');
  const org = await createOrganization(owner, a, { name: 'Group' });
  await addCompanyToOrganization(owner, b, org.id);
  const bankA = (await listAccounts(owner, a)).find((x) => x.accountNumber === '1000')!.id;
  const bankB = (await listAccounts(owner, b)).find((x) => x.accountNumber === '1000')!.id;
  return { owner, a, b, bankA, bankB, orgId: org.id };
}

beforeEach(async () => {
  await truncateAll();
});

describe('un-mark (Gate 7 H1)', () => {
  it('a one-sided mark is reversed and the line returns to STAGED; the pair nets to zero; the candidate is gone', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'OOPS SUPPLIER', '-5000.00');
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    const before = await lineRow(outA.line.id);
    expect((await getImportBatch(c.owner, c.a, outA.batch.id))!.lines[0]!.postedSource).toBe('INTERCOMPANY');
    expect(await unmarkIntercompanyTransfer(c.owner, c.a, outA.batch.id, outA.line.id)).toEqual({ reversed: 1 });
    expect(await lineRow(outA.line.id)).toEqual({ status: 'STAGED', journal_entry_id: null, chosen_account_id: null });
    expect(await entryStatus(before.journal_entry_id!)).toBe('REVERSED');
    const report = await getIntercompanyReport(c.owner, c.a, '2026-12-31');
    expect(report.rows[0]).toMatchObject({ dueFrom: '0.0000', receivableInTransit: '0.0000', mirrored: true });
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
    const inB = await stageOne(c.owner, c.b, c.bankB, '2026-07-02', 'FROM ALPHA', '5000.00');
    expect(inB.line.intercompanyCandidate).toBeNull();
    // A second un-mark is a no-op / not found; a plain posted line is not un-markable.
    expect(await codeOf(unmarkIntercompanyTransfer(c.owner, c.a, outA.batch.id, outA.line.id), BankImportError)).toBe('LINE_NOT_FOUND');
    const supplies = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'post', accountId: supplies }] });
    expect(await codeOf(unmarkIntercompanyTransfer(c.owner, c.a, outA.batch.id, outA.line.id), BankImportError)).toBe('LINE_NOT_FOUND');
  });

  it('a matched transfer is un-marked from either side: both entries reversed on one date, both lines STAGED; rights needed in both companies', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'TFR', '-700.00');
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    const inB = await stageOne(c.owner, c.b, c.bankB, '2026-07-02', 'FROM ALPHA', '700.00');
    await postImportLines(c.owner, c.b, inB.batch.id, { decisions: [{ lineId: inB.line.id, action: 'match_intercompany', counterpartEntryId: inB.line.intercompanyCandidate!.entryId }] });
    const aRow = await lineRow(outA.line.id);
    const bRow = await lineRow(inB.line.id);
    // An accountant of B who is only READ_ONLY in A cannot undo a matched transfer (it reverses A's side too).
    const acct = await makeUser();
    await insertMembership(c.b, acct, 'ACCOUNTANT');
    await insertMembership(c.a, acct, 'READ_ONLY');
    await expect(unmarkIntercompanyTransfer(acct, c.b, inB.batch.id, inB.line.id)).rejects.toBeInstanceOf(AuthorizationDenied);

    expect(await unmarkIntercompanyTransfer(c.owner, c.b, inB.batch.id, inB.line.id)).toEqual({ reversed: 2 });
    expect((await lineRow(outA.line.id)).status).toBe('STAGED');
    expect((await lineRow(inB.line.id)).status).toBe('STAGED');
    expect(await entryStatus(aRow.journal_entry_id!)).toBe('REVERSED');
    expect(await entryStatus(bRow.journal_entry_id!)).toBe('REVERSED');
    const db = await getTestDb();
    const dates = (await db.execute<{ d: string }>(sql`select distinct transaction_date::text d from journal_entries where source_type = 'REVERSAL'`)).rows;
    expect(dates).toHaveLength(1);
    expect(toMoney((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]!.dueFrom).isZero()).toBe(true);
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
    // Both lines can be decided again — a re-mark starts a fresh group.
    expect((await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] })).intercompany).toBe(1);
  });
});

describe('give-back and the leave rule (Gate 7 5c M1, 5b L1)', () => {
  it('take → repay → leave → rejoin → give back → leave is refused (the balance on the reactivated pair counts)', async () => {
    const c = await setup();
    const card = await createAccount(c.owner, c.a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const supplies = (await listAccounts(c.owner, c.b)).find((x) => x.accountType === 'EXPENSE')!.id;
    const shared = await stageImport(c.owner, c.a, { bankAccountId: card.id, fileBytes: EMPTY, shareWithOrganization: true }, cannedExtractor);
    const lines = (await getImportBatch(c.owner, c.a, shared.id))!.lines;
    await assignSharedLines(c.owner, c.b, shared.id, { decisions: [{ lineId: lines[1]!.id, accountId: supplies }] }); // −45.00
    // Repay through the transfer flow.
    const outB = await stageOne(c.owner, c.b, c.bankB, '2026-07-10', 'REPAY', '-45.00');
    await postImportLines(c.owner, c.b, outB.batch.id, { decisions: [{ lineId: outB.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.a }] });
    const inA = await stageOne(c.owner, c.a, c.bankA, '2026-07-11', 'FROM BETA', '45.00');
    await postImportLines(c.owner, c.a, inA.batch.id, { decisions: [{ lineId: inA.line.id, action: 'match_intercompany', counterpartEntryId: inA.line.intercompanyCandidate!.entryId }] });
    // Leave at zero deactivates the pair; rejoin.
    await removeCompanyFromOrganization(c.owner, c.b);
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where intercompany_company_id is not null and status = 'INACTIVE'`)).rows[0]!.n).toBe('2');
    await addCompanyToOrganization(c.owner, c.b, (await organizationsActorCanAddTo(c.owner))[0]!.id);
    // Give the card line back: the pair is reactivated first, both reversals dated the same day.
    expect(await unassignSharedLine(c.owner, c.b, shared.id, lines[1]!.id)).toEqual({ reversed: true });
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where intercompany_company_id is not null and status = 'ACTIVE'`)).rows[0]!.n).toBe('2');
    const dates = (await db.execute<{ d: string }>(sql`select distinct transaction_date::text d from journal_entries where source_type = 'REVERSAL'`)).rows;
    expect(dates).toHaveLength(1);
    // A's Due from B is now −45 (A owes B the repayment): leaving is refused for both.
    expect(await codeOf(removeCompanyFromOrganization(c.owner, c.b), OrganizationError)).toBe('ORG_HAS_INTERCOMPANY_BALANCE');
    expect(await codeOf(removeCompanyFromOrganization(c.owner, c.a), OrganizationError)).toBe('ORG_HAS_INTERCOMPANY_BALANCE');
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
  });

  it('a balance left on an INACTIVE pair account (raw) still blocks leaving', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'TFR', '-10.00');
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    const db = await getTestDb();
    await db.execute(sql`update accounts set status = 'INACTIVE' where intercompany_company_id is not null`);
    expect(await codeOf(removeCompanyFromOrganization(c.owner, c.b), OrganizationError)).toBe('ORG_HAS_INTERCOMPANY_BALANCE');
    // Un-mark clears it; then leaving works again.
    await unmarkIntercompanyTransfer(c.owner, c.a, outA.batch.id, outA.line.id);
    await expect(removeCompanyFromOrganization(c.owner, c.b)).resolves.toBeUndefined();
    await expect(getDbTx().select().from((await import('@/db')).schema.organizations)).resolves.toHaveLength(1);
  });
});
