/**
 * Intercompany BANK transfers — LL-099 / ADR-043. Against a real DB, extractor injected.
 * A pays B 5,000: A marks its bank line (Dr Due from B / Cr Bank A); B's review offers A's
 * posted side as a candidate and B matches it (Dr Bank B / Cr Due to A) — same group, both
 * banks reconcile, the pair mirrors. Settlement is the same flow the other way: B pays back what
 * it owed from card charges (LL-097) and both Due accounts return to zero. Plus: the pair-choice
 * rule, both-marked-independently still mirrors, validation, visibility, races, closed periods.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { toMoney } from '@/lib/decimal';
import { createAccount, listAccounts } from '@/server/accounts';
import { assignSharedLines, BankImportError, getImportBatch, postImportLines, stageImport, transferCounterparts } from '@/server/bank-import';
import { cannedExtractor, type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { assertIntercompanyMirror, LedgerError } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { getReconciliation, setCleared, startReconciliation } from '@/server/reconciliation';
import { getIntercompanyReport } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'T' },
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
/** Stage one statement line and return its view. */
async function stageOne(owner: string, companyId: string, bankId: string, date: string, description: string, amount: string) {
  const batch = await stageImport(owner, companyId, { bankAccountId: bankId, fileBytes: EMPTY }, rows([{ date, description, amount }]));
  const line = (await getImportBatch(owner, companyId, batch.id))!.lines[0]!;
  return { batch, line };
}
async function entry(id: string) {
  const db = await getTestDb();
  const e = (await db.execute<{ status: string; source_type: string; intercompany_group_id: string | null }>(sql`select status, source_type::text, intercompany_group_id from journal_entries where id = ${id}`)).rows[0]!;
  const lines = (await db.execute<{ account_id: string; debit: string; credit: string }>(sql`select account_id, debit::text, credit::text from journal_lines where journal_entry_id = ${id} order by line_number`)).rows;
  return { ...e, lines };
}
async function pairIds(a: string, b: string): Promise<{ dueFromInA: string | null; dueToInB: string | null; dueFromInB: string | null; dueToInA: string | null }> {
  const db = await getTestDb();
  const q = async (c: string, cp: string, role: string) => (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${c} and intercompany_company_id = ${cp} and system_account_type = ${role}`)).rows[0]?.id ?? null;
  return { dueFromInA: await q(a, b, 'INTERCOMPANY_RECEIVABLE'), dueToInB: await q(b, a, 'INTERCOMPANY_PAYABLE'), dueFromInB: await q(b, a, 'INTERCOMPANY_RECEIVABLE'), dueToInA: await q(a, b, 'INTERCOMPANY_PAYABLE') };
}

beforeEach(async () => {
  await truncateAll();
});

describe('mark, then match from the other company', () => {
  it('A pays B: A marks, B is offered the candidate and matches; same group, mirrored, both banks reconcile', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'TFR TO BETA', '-5000.00');
    expect(outA.line.intercompanyCandidate).toBeNull();
    const r1 = await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    expect(r1).toMatchObject({ posted: 0, intercompany: 1 });
    const markedA = (await getImportBatch(c.owner, c.a, outA.batch.id))!.lines[0]!;
    expect(markedA.status).toBe('POSTED');
    const pair = await pairIds(c.a, c.b);
    expect(pair.dueFromInA).not.toBeNull(); // payer holds the receivable
    expect(pair.dueFromInB).toBeNull();
    const eA = await entry(markedA.journalEntryId!);
    expect(eA).toMatchObject({ status: 'POSTED', source_type: 'INTERCOMPANY' });
    expect(eA.intercompany_group_id).not.toBeNull();
    expect(eA.lines).toEqual([{ account_id: pair.dueFromInA, debit: '5000.0000', credit: '0.0000' }, { account_id: c.bankA, debit: '0.0000', credit: '5000.0000' }]);

    // Between the mark and the match the mirror holds NET OF CASH IN TRANSIT (LL-099).
    const pending = (await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]!;
    expect(pending).toMatchObject({ dueFrom: '5000.0000', counterpartDueTo: '0.0000', receivableDifference: '5000.0000', receivableInTransit: '5000.0000', state: 'in_transit', mirrored: false, inTransitOldestDays: 183 });
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
    // B's statement two days later: the candidate is offered and the default is to match it.
    const inB = await stageOne(c.owner, c.b, c.bankB, '2026-07-03', 'DEPOSIT FROM ALPHA', '5000.00');
    expect(inB.line.intercompanyCandidate).toMatchObject({ entryId: markedA.journalEntryId, counterpartCompanyId: c.a, counterpartLegalName: 'Alpha Co', txnDate: '2026-07-01' });
    const r2 = await postImportLines(c.owner, c.b, inB.batch.id, { decisions: [{ lineId: inB.line.id, action: 'match_intercompany', counterpartEntryId: markedA.journalEntryId! }] });
    expect(r2).toMatchObject({ posted: 0, intercompany: 1 });
    const matchedB = (await getImportBatch(c.owner, c.b, inB.batch.id))!.lines[0]!;
    const eB = await entry(matchedB.journalEntryId!);
    expect(eB.intercompany_group_id).toBe(eA.intercompany_group_id);
    expect(eB.lines).toEqual([{ account_id: c.bankB, debit: '5000.0000', credit: '0.0000' }, { account_id: pair.dueToInB, debit: '0.0000', credit: '5000.0000' }]);

    // Mirror and reconciliation on both sides.
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
    expect((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]).toMatchObject({ dueFrom: '5000.0000', counterpartDueTo: '5000.0000', receivableInTransit: '0.0000', mirrored: true });
    for (const [companyId, bankId, ending] of [[c.a, c.bankA, '-5000.00'], [c.b, c.bankB, '5000.00']] as const) {
      const rec = await startReconciliation(c.owner, companyId, { bankAccountId: bankId, statementDate: '2026-07-31', statementEndingAmount: ending });
      const view = (await getReconciliation(c.owner, companyId, rec.id))!;
      expect(view.lines).toHaveLength(1);
      expect(view.lines[0]!.fromImport).toBe(true);
      await setCleared(c.owner, companyId, rec.id, { journalLineIds: view.lines.map((l) => l.journalLineId) });
      expect(toMoney((await getReconciliation(c.owner, companyId, rec.id))!.difference).isZero()).toBe(true);
    }
    // Once matched, the candidate is no longer offered to anyone.
    const again = await stageOne(c.owner, c.b, c.bankB, '2026-07-02', 'DEPOSIT FROM ALPHA', '5000.00');
    expect(again.line.intercompanyCandidate).toBeNull();
  });

  it('settlement: B repays the card charges it took; the existing pair is used and both Due accounts return to zero', async () => {
    const c = await setup();
    const card = await createAccount(c.owner, c.a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const supplies = (await listAccounts(c.owner, c.b)).find((x) => x.accountType === 'EXPENSE')!.id;
    const shared = await stageImport(c.owner, c.a, { bankAccountId: card.id, fileBytes: EMPTY, shareWithOrganization: true }, cannedExtractor);
    const lines = (await getImportBatch(c.owner, c.a, shared.id))!.lines; // −120.50, −45.00, +2000
    await assignSharedLines(c.owner, c.b, shared.id, { decisions: [{ lineId: lines[0]!.id, accountId: supplies }, { lineId: lines[1]!.id, accountId: supplies }] });
    expect((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]).toMatchObject({ dueFrom: '165.5000', counterpartDueTo: '165.5000' });

    // B pays 165.50 back from its bank: the payer would normally hold the receivable, but the
    // existing pair (A holds it) is moved instead — B's payable goes down.
    const outB = await stageOne(c.owner, c.b, c.bankB, '2026-07-10', 'REPAY ALPHA CARD', '-165.50');
    await postImportLines(c.owner, c.b, outB.batch.id, { decisions: [{ lineId: outB.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.a }] });
    const pair = await pairIds(c.a, c.b);
    expect(pair.dueFromInB).toBeNull(); // no second pair was created
    const eB = await entry((await getImportBatch(c.owner, c.b, outB.batch.id))!.lines[0]!.journalEntryId!);
    expect(eB.lines).toEqual([{ account_id: pair.dueToInB, debit: '165.5000', credit: '0.0000' }, { account_id: c.bankB, debit: '0.0000', credit: '165.5000' }]);
    const inA = await stageOne(c.owner, c.a, c.bankA, '2026-07-11', 'DEPOSIT BETA', '165.50');
    expect(inA.line.intercompanyCandidate?.counterpartCompanyId).toBe(c.b);
    await postImportLines(c.owner, c.a, inA.batch.id, { decisions: [{ lineId: inA.line.id, action: 'match_intercompany', counterpartEntryId: inA.line.intercompanyCandidate!.entryId }] });
    const eA = await entry((await getImportBatch(c.owner, c.a, inA.batch.id))!.lines[0]!.journalEntryId!);
    expect(eA.lines).toEqual([{ account_id: c.bankA, debit: '165.5000', credit: '0.0000' }, { account_id: pair.dueFromInA, debit: '0.0000', credit: '165.5000' }]);
    const report = await getIntercompanyReport(c.owner, c.a, '2026-12-31');
    expect(report.rows[0]).toMatchObject({ dueFrom: '0.0000', counterpartDueTo: '0.0000', dueTo: '0.0000', counterpartDueFrom: '0.0000', mirrored: true });
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
  });

  it('a second independent mark joins the first mark\'s group; a receipt with no pair makes the payer the receivable holder', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'TFR TO BETA', '-700.00');
    const inB = await stageOne(c.owner, c.b, c.bankB, '2026-07-01', 'FROM ALPHA', '700.00');
    // B marks first (money IN, no pair yet): the payer A holds the receivable.
    await postImportLines(c.owner, c.b, inB.batch.id, { decisions: [{ lineId: inB.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.a }] });
    const pair = await pairIds(c.a, c.b);
    expect(pair.dueFromInA).not.toBeNull();
    expect(pair.dueFromInB).toBeNull();
    // A marks independently instead of matching: the mark auto-joins B's open group (LL-101).
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
    expect((await getIntercompanyReport(c.owner, c.a, '2026-12-31')).rows[0]).toMatchObject({ dueFrom: '700.0000', counterpartDueTo: '700.0000', state: 'mirrored', mirrored: true });
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(distinct intercompany_group_id)::text n from journal_entries where source_type = 'INTERCOMPANY'`)).rows[0]!.n).toBe('1');
  });
});

describe('validation, visibility and races', () => {
  it('counterpart must be a member the actor can post in; self, a stranger company and an ADMIN-only outsider are refused', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'X', '-10.00');
    const solo = await company(c.owner, 'Solo Co');
    for (const bad of [c.a, solo, '00000000-0000-4000-8000-000000000000']) {
      expect(await codeOf(postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: bad }] }), BankImportError)).toBe('COUNTERPART_INVALID');
    }
    expect(await codeOf(postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer' }] }), BankImportError)).toBe('COUNTERPART_INVALID');
    // An accountant of A who is only READ_ONLY in B cannot move money with B — and sees no B candidates.
    const acct = await makeUser();
    await insertMembership(c.a, acct, 'ACCOUNTANT');
    await insertMembership(c.b, acct, 'READ_ONLY');
    expect(await transferCounterparts(acct, c.a)).toEqual([]);
    expect(await codeOf(postImportLines(acct, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] }), BankImportError)).toBe('COUNTERPART_INVALID');
    expect((await transferCounterparts(c.owner, c.a)).map((m) => m.id)).toEqual([c.b]);
    expect(await transferCounterparts(c.owner, solo)).toEqual([]);
  });

  it('match: wrong amount, wrong direction, out of window, a stale entry id, and a second match of the same group', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-07-01', 'TFR', '-500.00');
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    const entryA = (await getImportBatch(c.owner, c.a, outA.batch.id))!.lines[0]!.journalEntryId!;
    const wrongAmount = await stageOne(c.owner, c.b, c.bankB, '2026-07-01', 'X', '499.00');
    const wrongWay = await stageOne(c.owner, c.b, c.bankB, '2026-07-01', 'X', '-500.00');
    const late = await stageOne(c.owner, c.b, c.bankB, '2026-07-09', 'X', '500.00');
    for (const l of [wrongAmount, wrongWay, late]) {
      expect(l.line.intercompanyCandidate).toBeNull();
      expect(await codeOf(postImportLines(c.owner, c.b, l.batch.id, { decisions: [{ lineId: l.line.id, action: 'match_intercompany', counterpartEntryId: entryA }] }), BankImportError)).toBe('TRANSFER_MISMATCH');
    }
    const right = await stageOne(c.owner, c.b, c.bankB, '2026-07-02', 'X', '500.00');
    const twin = await stageOne(c.owner, c.b, c.bankB, '2026-07-02', 'X twin', '500.00');
    expect(right.line.intercompanyCandidate?.entryId).toBe(entryA);
    expect(twin.line.intercompanyCandidate?.entryId).toBe(entryA);
    // Both try to match the same group at once: exactly one succeeds; the other is told.
    const settled = await Promise.allSettled([
      postImportLines(c.owner, c.b, right.batch.id, { decisions: [{ lineId: right.line.id, action: 'match_intercompany', counterpartEntryId: entryA }] }),
      postImportLines(c.owner, c.b, twin.batch.id, { decisions: [{ lineId: twin.line.id, action: 'match_intercompany', counterpartEntryId: entryA }] }),
    ]);
    const ok = settled.filter((r) => r.status === 'fulfilled' && r.value.intercompany === 1).length;
    const told = settled.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'TRANSFER_ALREADY_MATCHED').length;
    expect(ok).toBe(1);
    expect(told).toBe(1);
    await expect(assertIntercompanyMirror()).resolves.toBeUndefined();
    // A double submit of the winner is a no-op.
    const winner = settled[0].status === 'fulfilled' ? right : twin;
    expect((await postImportLines(c.owner, c.b, winner.batch.id, { decisions: [{ lineId: winner.line.id, action: 'match_intercompany', counterpartEntryId: entryA }] })).intercompany).toBe(0);
  });

  it('a closed period blocks the marking side; nothing posts', async () => {
    const c = await setup();
    const outA = await stageOne(c.owner, c.a, c.bankA, '2026-08-01', 'TFR', '-1.00');
    const p = await getAccountingPeriod(c.a, '2026-08-01');
    await closePeriod(c.owner, c.a, p.id);
    expect(await codeOf(postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.line.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] }), LedgerError)).toBe('PERIOD_CLOSED');
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where source_type = 'INTERCOMPANY'`)).rows[0]!.n).toBe('0');
    expect((await getDbTx().select().from((await import('@/db')).schema.accounts).where(sql`intercompany_company_id is not null`)).length).toBe(0);
  });
});
