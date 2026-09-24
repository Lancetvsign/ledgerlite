import { randomUUID } from 'node:crypto';

/**
 * Cash in transit done right — LL-101 (Gate 7 H2, M2, L7, L8, 5c L1). Against a real DB.
 * Three report states; "in transit" only for a mark (a POSTED statement line on the pair account)
 * whose group has no other side AS OF the date; unequal independent marks are in transit, not
 * mirrored; a group-bearing raw one-sided entry is a mismatch; a stale mark fails the gate; a mark
 * auto-joins the counterpart's open group; one submit never aims two lines at one entry.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { BankImportError, getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { assertIntercompanyMirror, findIntercompanyMismatches, LedgerIntegrityError } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { getIntercompanyReport } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';
import { rawPostedEntry } from '../helpers/raw-entry';

const EMPTY = new Uint8Array();
async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'T' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function company(owner: string, name: string): Promise<string> {
  return (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: name, timezone: 'America/Chicago' }), 'standard')).company.id;
}
const rows = (r: { date: string; description: string; amount: string }[]): TransactionExtractor => () => Promise.resolve(r);
async function stage(owner: string, companyId: string, bankId: string, r: { date: string; description: string; amount: string }[]) {
  const batch = await stageImport(owner, companyId, { bankAccountId: bankId, fileBytes: EMPTY }, rows(r));
  const lines = (await getImportBatch(owner, companyId, batch.id))!.lines;
  return { batch, lines };
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
interface Ctx { owner: string; a: string; b: string; bankA: string; bankB: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const a = await company(owner, 'Alpha Co');
  const b = await company(owner, 'Beta Co');
  const org = await createOrganization(owner, a, { name: 'Group' });
  await addCompanyToOrganization(owner, b, org.id);
  const bankA = (await listAccounts(owner, a)).find((x) => x.accountNumber === '1000')!.id;
  const bankB = (await listAccounts(owner, b)).find((x) => x.accountNumber === '1000')!.id;
  return { owner, a, b, bankA, bankB };
}
async function mark(c: Ctx, companyId: string, batchId: string, lineId: string, counterpart: string) {
  return await postImportLines(c.owner, companyId, batchId, { decisions: [{ lineId, action: 'intercompany_transfer', counterpartCompanyId: counterpart }] });
}

beforeEach(async () => {
  await truncateAll();
});

describe('three states (Gate 7 H2)', () => {
  it('unequal independent marks are IN TRANSIT — never mirrored; the amounts and the age are shown; a stale mark fails the gate', async () => {
    const c = await setup();
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-01', description: 'TFR', amount: '-5000.00' }]);
    await mark(c, c.a, outA.batch.id, outA.lines[0]!.id, c.b);
    const inB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-01', description: 'FROM ALPHA', amount: '4500.00' }]);
    expect(inB.lines[0]!.intercompanyCandidate).toBeNull(); // amounts differ: nothing to auto-link either
    await mark(c, c.b, inB.batch.id, inB.lines[0]!.id, c.a);
    const row = (await getIntercompanyReport(c.owner, c.a, '2026-07-05')).rows[0]!;
    expect(row).toMatchObject({ dueFrom: '5000.0000', counterpartDueTo: '4500.0000', receivableDifference: '500.0000', receivableInTransit: '500.0000', state: 'in_transit', mirrored: false, inTransitOldestDays: 4 });
    expect((await getIntercompanyReport(c.owner, c.a, '2026-07-05')).state).toBe('in_transit');
    // Fresh: the gate accepts it as in transit; old: it is reported as stale (both marks).
    expect(await findIntercompanyMismatches(getDbTx(), undefined, { asOf: '2026-07-05' })).toEqual([]);
    const stale = await findIntercompanyMismatches(getDbTx(), undefined, { asOf: '2026-09-01' });
    expect(stale.filter((x) => x.startsWith('stale:'))).toHaveLength(2);
    await expect(assertIntercompanyMirror(undefined, getDbTx(), { maxTransitDays: 0 })).rejects.toBeInstanceOf(LedgerIntegrityError);
  });

  it('a one-sided entry that is NOT a statement mark is a MISMATCH even with a group id', async () => {
    const c = await setup();
    const db = await getTestDb();
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-01', description: 'TFR', amount: '-10.00' }]);
    await mark(c, c.a, outA.batch.id, outA.lines[0]!.id, c.b); // creates the pair
    const dueFromA = (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${c.a} and intercompany_company_id = ${c.b} and system_account_type = 'INTERCOMPANY_RECEIVABLE'`)).rows[0]!.id;
    const expenseA = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await rawPostedEntry(tx, { companyId: c.a, userId: c.owner, sourceType: 'INTERCOMPANY', entryNumber: 95000, transactionDate: '2026-07-02', intercompanyGroupId: randomUUID(), lines: [{ accountId: dueFromA, debit: '99.0000', credit: '0.0000' }, { accountId: expenseA, debit: '0.0000', credit: '99.0000' }] });
        expect(await findIntercompanyMismatches(tx, undefined, { asOf: '2026-07-05' })).toEqual([`${c.a}->${c.b}`]);
        throw new Error('ROLLBACK');
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe('ROLLBACK');
    expect(await findIntercompanyMismatches(getDbTx(), undefined, { asOf: '2026-07-05' })).toEqual([]);
  });

  it('as of a date between the two statement dates the pair is in transit, then mirrored (Gate 7 M2)', async () => {
    const c = await setup();
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-01', description: 'TFR', amount: '-300.00' }]);
    await mark(c, c.a, outA.batch.id, outA.lines[0]!.id, c.b);
    const inB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-03', description: 'FROM ALPHA', amount: '300.00' }]);
    await postImportLines(c.owner, c.b, inB.batch.id, { decisions: [{ lineId: inB.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: inB.lines[0]!.intercompanyCandidate!.entryId }] });
    expect((await getIntercompanyReport(c.owner, c.a, '2026-07-02')).rows[0]).toMatchObject({ receivableDifference: '300.0000', receivableInTransit: '300.0000', state: 'in_transit' });
    expect((await getIntercompanyReport(c.owner, c.a, '2026-07-03')).rows[0]).toMatchObject({ receivableDifference: '0.0000', receivableInTransit: '0.0000', state: 'mirrored' });
    expect(await findIntercompanyMismatches(getDbTx(), undefined, { asOf: '2026-07-02' })).toEqual([]);
  });
});

describe('auto-link and per-submit allocation (L7, L8)', () => {
  it('two equal lines in one batch are offered different entries; one submit cannot aim two lines at one entry', async () => {
    const c = await setup();
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-01', description: 'TFR 1', amount: '-100.00' }, { date: '2026-07-01', description: 'TFR 2', amount: '-100.00' }]);
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: outA.lines.map((l) => ({ lineId: l.id, action: 'intercompany_transfer' as const, counterpartCompanyId: c.b })) });
    const entriesA = (await getImportBatch(c.owner, c.a, outA.batch.id))!.lines.map((l) => l.journalEntryId);
    const inB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-02', description: 'IN 1', amount: '100.00' }, { date: '2026-07-02', description: 'IN 2', amount: '100.00' }]);
    const offered = inB.lines.map((l) => l.intercompanyCandidate?.entryId ?? null);
    expect(new Set(offered).size).toBe(2);
    expect([...offered].sort()).toEqual([...entriesA].sort()); // copy: `offered` is indexed by line below
    // Aiming both lines at the same entry is refused up front (the second line's offered
    // candidate is the other entry, so it is a mismatch; a same-candidate pair would be
    // TRANSFER_ALREADY_MATCHED), and nothing posts.
    expect(['TRANSFER_MISMATCH', 'TRANSFER_ALREADY_MATCHED']).toContain(await codeOf(postImportLines(c.owner, c.b, inB.batch.id, { decisions: [
      { lineId: inB.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: offered[0]! },
      { lineId: inB.lines[1]!.id, action: 'match_intercompany', counterpartEntryId: offered[0]! },
    ] }), BankImportError));
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.b} and source_type = 'INTERCOMPANY'`)).rows[0]!.n).toBe('0');
    // The offered allocation posts both.
    const r = await postImportLines(c.owner, c.b, inB.batch.id, { decisions: inB.lines.map((l, i) => ({ lineId: l.id, action: 'match_intercompany' as const, counterpartEntryId: offered[i]! })) });
    expect(r.intercompany).toBe(2);
    expect((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).state).toBe('mirrored');
  });

  it('a mark auto-joins the counterpart\'s open mark of the same amount in the window; outside the window it opens its own group', async () => {
    const c = await setup();
    const inB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-01', description: 'FROM ALPHA', amount: '250.00' }]);
    await mark(c, c.b, inB.batch.id, inB.lines[0]!.id, c.a);
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-03', description: 'TFR', amount: '-250.00' }, { date: '2026-07-20', description: 'TFR LATE', amount: '-250.00' }]);
    expect((await mark(c, c.a, outA.batch.id, outA.lines[0]!.id, c.b)).intercompany).toBe(1);
    const db = await getTestDb();
    const groups = async () => (await db.execute<{ n: string }>(sql`select count(distinct intercompany_group_id)::text n from journal_entries where source_type = 'INTERCOMPANY'`)).rows[0]!.n;
    expect(await groups()).toBe('1');
    expect((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]).toMatchObject({ dueFrom: '250.0000', counterpartDueTo: '250.0000', state: 'mirrored' });
    await mark(c, c.a, outA.batch.id, outA.lines[1]!.id, c.b);
    expect(await groups()).toBe('2');
    expect((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]).toMatchObject({ receivableInTransit: '250.0000', state: 'in_transit' });
  });
});
