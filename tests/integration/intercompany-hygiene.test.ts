/**
 * Shared-path hygiene — LL-102 (Gate 7 M3, M4, L9). Against a real DB.
 * A card PAYMENT mirrored by the cardholder's own bank is never on offer to another company (a
 * refund is); a card CHARGE cannot be marked as an intercompany bank transfer; with pairs in both
 * directions a repayment reduces the open balance instead of grossing up; a deactivated pair is
 * reused (reactivated) rather than the reverse direction being created.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { toMoney } from '@/lib/decimal';
import { createAccount, listAccounts } from '@/server/accounts';
import { assignSharedLines, BankImportError, getImportBatch, getSharedImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { addCompanyToOrganization, createOrganization, organizationsActorCanAddTo, removeCompanyFromOrganization } from '@/server/organizations';
import { getIntercompanyReport } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `hy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'H' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function company(owner: string, name: string): Promise<string> {
  return (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: name, timezone: 'America/Chicago' }), 'standard')).company.id;
}
const rows = (r: { date: string; description: string; amount: string; category?: string }[]): TransactionExtractor => () => Promise.resolve(r);
async function stage(owner: string, companyId: string, accountId: string, r: { date: string; description: string; amount: string; category?: string }[], share = false) {
  const batch = await stageImport(owner, companyId, { bankAccountId: accountId, fileBytes: EMPTY, shareWithOrganization: share }, rows(r));
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
interface Ctx { owner: string; a: string; b: string; bankA: string; bankB: string; cardA: string; expB: string; orgId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const a = await company(owner, 'Alpha Co');
  const b = await company(owner, 'Beta Co');
  const org = await createOrganization(owner, a, { name: 'Group' });
  await addCompanyToOrganization(owner, b, org.id);
  const bankA = (await listAccounts(owner, a)).find((x) => x.accountNumber === '1000')!.id;
  const bankB = (await listAccounts(owner, b)).find((x) => x.accountNumber === '1000')!.id;
  const cardA = (await createAccount(owner, a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }))).id;
  const expB = (await listAccounts(owner, b)).find((x) => x.accountType === 'EXPENSE')!.id;
  return { owner, a, b, bankA, bankB, cardA, expB, orgId: org.id };
}
async function pairBalances(): Promise<Record<string, string>> {
  const db = await getTestDb();
  const r = await db.execute<{ k: string; balance: string }>(sql`
    select (a.company_id::text || ':' || a.system_account_type) as k,
           coalesce(sum(case when e.status in ('POSTED','REVERSED') then (case when a.account_type = 'ASSET' then l.debit - l.credit else l.credit - l.debit end) else 0 end), 0)::numeric(19,4)::text as balance
    from accounts a left join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    left join journal_entries e on e.id = l.journal_entry_id
    where a.intercompany_company_id is not null group by a.company_id, a.system_account_type`);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.balance]));
}

beforeEach(async () => {
  await truncateAll();
});

describe('card payments stay with the cardholder (M3)', () => {
  it('a positive card line mirrored by the cardholder\'s bank (POSTED or STAGED) is hidden from and refused to takers; a refund is takeable', async () => {
    const c = await setup();
    // A's bank shows the −2000 card payment (posted to the card) and a −500 one still staged.
    const bank = await stage(c.owner, c.a, c.bankA, [{ date: '2026-06-05', description: 'CARD PAYMENT', amount: '-2000.00' }, { date: '2026-06-20', description: 'CARD PAYMENT 2', amount: '-500.00' }]);
    await postImportLines(c.owner, c.a, bank.batch.id, { decisions: [{ lineId: bank.lines[0]!.id, action: 'post', accountId: c.cardA }] });
    const card = await stage(c.owner, c.a, c.cardA, [
      { date: '2026-06-04', description: 'SHELL FUEL', amount: '-45.00' },
      { date: '2026-06-05', description: 'PAYMENT - THANK YOU', amount: '2000.00' },
      { date: '2026-06-06', description: 'REFUND OFFICE DEPOT', amount: '30.00' },
      { date: '2026-06-21', description: 'PAYMENT - THANK YOU', amount: '500.00' },
    ], true);
    const view = (await getSharedImportBatch(c.owner, c.b, card.batch.id))!;
    expect(view.lines.map((l) => l.lineNumber)).toEqual([1, 3]); // both payments hidden (posted mirror, staged mirror); the refund offered
    expect(await codeOf(assignSharedLines(c.owner, c.b, card.batch.id, { decisions: [{ lineId: card.lines[1]!.id, accountId: c.expB }] }), BankImportError)).toBe('CARD_PAYMENT_NOT_TAKEABLE');
    expect(await codeOf(assignSharedLines(c.owner, c.b, card.batch.id, { decisions: [{ lineId: card.lines[3]!.id, accountId: c.expB }] }), BankImportError)).toBe('CARD_PAYMENT_NOT_TAKEABLE');
    expect((await assignSharedLines(c.owner, c.b, card.batch.id, { decisions: [{ lineId: card.lines[2]!.id, accountId: c.expB }] })).assigned).toBe(1);
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.b} and source_type = 'INTERCOMPANY'`)).rows[0]!.n).toBe('1');
  });
});

describe('card charges are not bank transfers (L9)', () => {
  it('marking a card CHARGE as an intercompany transfer is refused; a card payment/refund may be marked', async () => {
    const c = await setup();
    const card = await stage(c.owner, c.a, c.cardA, [{ date: '2026-06-04', description: 'SHELL FUEL', amount: '-45.00' }, { date: '2026-06-06', description: 'REFUND', amount: '30.00' }]);
    expect(await codeOf(postImportLines(c.owner, c.a, card.batch.id, { decisions: [{ lineId: card.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] }), BankImportError)).toBe('CARD_CHARGE_NOT_TRANSFER');
    expect((await postImportLines(c.owner, c.a, card.batch.id, { decisions: [{ lineId: card.lines[1]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] })).intercompany).toBe(1);
  });
});

describe('pair choice reduces the open balance (M4)', () => {
  it('with pairs in both directions a repayment pays down the payable instead of grossing up; then nets to zero', async () => {
    const c = await setup();
    // B owes A 165.50 (B took A's card charges) — pair (A,B).
    const card = await stage(c.owner, c.a, c.cardA, [{ date: '2026-06-02', description: 'OFFICE DEPOT', amount: '-120.50' }, { date: '2026-06-04', description: 'SHELL', amount: '-45.00' }], true);
    await assignSharedLines(c.owner, c.b, card.batch.id, { decisions: card.lines.map((l) => ({ lineId: l.id, accountId: c.expB })) });
    // A owes B 40 (A took a charge from B's card) — pair (B,A).
    const cardB = (await createAccount(c.owner, c.b, createAccountInput.parse({ accountNumber: '2150', name: 'Visa B', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }))).id;
    const expA = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    const cardBatchB = await stage(c.owner, c.b, cardB, [{ date: '2026-06-10', description: 'PRINTER', amount: '-40.00' }], true);
    await assignSharedLines(c.owner, c.a, cardBatchB.batch.id, { decisions: [{ lineId: cardBatchB.lines[0]!.id, accountId: expA }] });
    let bal = await pairBalances();
    expect(bal[`${c.a}:INTERCOMPANY_RECEIVABLE`]).toBe('165.5000');
    expect(bal[`${c.b}:INTERCOMPANY_PAYABLE`]).toBe('165.5000');
    expect(bal[`${c.b}:INTERCOMPANY_RECEIVABLE`]).toBe('40.0000');
    expect(bal[`${c.a}:INTERCOMPANY_PAYABLE`]).toBe('40.0000');

    // B repays 165.50: B's PAYABLE goes down (not B's receivable up); A matches and its receivable goes down.
    const outB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-01', description: 'REPAY ALPHA', amount: '-165.50' }]);
    await postImportLines(c.owner, c.b, outB.batch.id, { decisions: [{ lineId: outB.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.a }] });
    const inA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-02', description: 'FROM BETA', amount: '165.50' }]);
    await postImportLines(c.owner, c.a, inA.batch.id, { decisions: [{ lineId: inA.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: inA.lines[0]!.intercompanyCandidate!.entryId }] });
    bal = await pairBalances();
    expect(bal[`${c.b}:INTERCOMPANY_PAYABLE`]).toBe('0.0000');
    expect(bal[`${c.a}:INTERCOMPANY_RECEIVABLE`]).toBe('0.0000');
    expect(bal[`${c.b}:INTERCOMPANY_RECEIVABLE`]).toBe('40.0000');
    // A repays its 40: A's payable goes down; the whole relationship is settled.
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-03', description: 'REPAY BETA', amount: '-40.00' }]);
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    const inB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-04', description: 'FROM ALPHA', amount: '40.00' }]);
    await postImportLines(c.owner, c.b, inB.batch.id, { decisions: [{ lineId: inB.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: inB.lines[0]!.intercompanyCandidate!.entryId }] });
    bal = await pairBalances();
    for (const v of Object.values(bal)) expect(toMoney(v).isZero()).toBe(true);
    const report = await getIntercompanyReport(c.owner, c.a, '2026-12-31');
    expect(report.mirrored).toBe(true);
    // Both companies can now leave.
    await expect(removeCompanyFromOrganization(c.owner, c.b)).resolves.toBeUndefined();
  });

  it('after a leave and rejoin the deactivated pair is reused, not the reverse direction created', async () => {
    const c = await setup();
    const outA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-01', description: 'TFR', amount: '-10.00' }]);
    await postImportLines(c.owner, c.a, outA.batch.id, { decisions: [{ lineId: outA.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    const inB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-02', description: 'FROM ALPHA', amount: '10.00' }]);
    await postImportLines(c.owner, c.b, inB.batch.id, { decisions: [{ lineId: inB.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: inB.lines[0]!.intercompanyCandidate!.entryId }] });
    // Settle the other way, leave, rejoin.
    const outB = await stage(c.owner, c.b, c.bankB, [{ date: '2026-07-05', description: 'BACK', amount: '-10.00' }]);
    await postImportLines(c.owner, c.b, outB.batch.id, { decisions: [{ lineId: outB.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.a }] });
    const inA = await stage(c.owner, c.a, c.bankA, [{ date: '2026-07-06', description: 'BACK', amount: '10.00' }]);
    await postImportLines(c.owner, c.a, inA.batch.id, { decisions: [{ lineId: inA.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: inA.lines[0]!.intercompanyCandidate!.entryId }] });
    await removeCompanyFromOrganization(c.owner, c.b);
    await addCompanyToOrganization(c.owner, c.b, (await organizationsActorCanAddTo(c.owner))[0]!.id);
    // B pays A first this time: the existing pair (A holds the receivable) is reactivated and moved.
    const again = await stage(c.owner, c.b, c.bankB, [{ date: '2026-08-01', description: 'PAY', amount: '-7.00' }]);
    await postImportLines(c.owner, c.b, again.batch.id, { decisions: [{ lineId: again.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: c.a }] });
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where intercompany_company_id is not null`)).rows[0]!.n).toBe('2');
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where intercompany_company_id is not null and status = 'ACTIVE'`)).rows[0]!.n).toBe('2');
    const bal = await pairBalances();
    expect(bal[`${c.b}:INTERCOMPANY_PAYABLE`]).toBe('-7.0000');
  });
});
