/**
 * Card payments find their paying company on the organization's statements — LL-106. Against a
 * real DB, extractor injected.
 *
 * Proves: another member's STAGED bank line with the opposite amount in the window is offered as
 * the other side (a card there is not; a wrong amount or date is not; a company outside the
 * organization never is); a line the other company already posted as an intercompany mark is the
 * existing match_intercompany candidate, and one it posted some other way is reported as decided;
 * marking by the other company's statement line posts exactly what marking by company posts and
 * the other company then sees the match; a wrong statement line is refused; a transfer that names
 * neither is refused (COUNTERPART_REQUIRED) — the page keeps it as a waiting draft instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createAccount, listAccounts } from '@/server/accounts';
import { BankImportError, getImportBatch, postImportLines, saveReviewDrafts, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { getIntercompanyReport } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { getAuth } from '@/lib/auth';

import { truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `om-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'O' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function company(owner: string, name: string): Promise<string> {
  return (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: name, timezone: 'America/Chicago' }), 'standard')).company.id;
}
type Row = { date: string; description: string; amount: string };
const rows = (r: Row[]): TransactionExtractor => () => Promise.resolve(r);
async function stage(owner: string, companyId: string, accountId: string, r: Row[]) {
  const batch = await stageImport(owner, companyId, { bankAccountId: accountId, fileBytes: EMPTY }, rows(r));
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

interface Ctx { owner: string; a: string; b: string; c: string; bankA: string; cardA: string; bankB: string; cardB: string; bankC: string; expB: string }
/** Owner with A (bank + Visa), B (bank + a card) and C (bank) in one organization; E outside it. */
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const a = await company(owner, 'Alpha Co');
  const b = await company(owner, 'Beta Co');
  const c = await company(owner, 'Gamma Co');
  const org = await createOrganization(owner, a, { name: 'Group' });
  await addCompanyToOrganization(owner, b, org.id);
  await addCompanyToOrganization(owner, c, org.id);
  const bank = async (id: string) => (await listAccounts(owner, id)).find((x) => x.accountNumber === '1000')!.id;
  const card = async (id: string) => (await createAccount(owner, id, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }))).id;
  return { owner, a, b, c, bankA: await bank(a), cardA: await card(a), bankB: await bank(b), cardB: await card(b), bankC: await bank(c), expB: (await listAccounts(owner, b)).find((x) => x.accountType === 'EXPENSE')!.id };
}

beforeEach(async () => {
  await truncateAll();
});

describe('finding the other side on the organization\'s statements', () => {
  it('offers another member\'s STAGED bank line with the opposite amount in the window — never a card there, never a wrong amount or date, never a company outside the organization', async () => {
    const x = await setup();
    // A's card: +2000 PAYMENT on 06-03. B's bank: −2000 on 06-01 (in window), −2000 on 06-20 (out), −1999 (wrong amount).
    await stage(x.owner, x.b, x.bankB, [
      { date: '2026-06-01', description: 'PAY VISA', amount: '-2000.00' },
      { date: '2026-06-20', description: 'PAY VISA LATE', amount: '-2000.00' },
      { date: '2026-06-02', description: 'ALMOST', amount: '-1999.00' },
    ]);
    // B's CARD also shows −2000 (a charge): a card is never the other side of a movement.
    await stage(x.owner, x.b, x.cardB, [{ date: '2026-06-02', description: 'CARD CHARGE', amount: '-2000.00' }]);
    // C's bank: −2000 on 06-05 — a second candidate, further away.
    await stage(x.owner, x.c, x.bankC, [{ date: '2026-06-05', description: 'PAY VISA', amount: '-2000.00' }]);
    // An outsider's bank has the perfect mirror; it must never appear.
    const outsider = await makeUser();
    const e = await company(outsider, 'Echo Co');
    const bankE = (await listAccounts(outsider, e)).find((z) => z.accountNumber === '1000')!.id;
    await stage(outsider, e, bankE, [{ date: '2026-06-03', description: 'PAY VISA', amount: '-2000.00' }]);

    const cardA = await stage(x.owner, x.a, x.cardA, [
      { date: '2026-06-03', description: 'PAYMENT THANK YOU', amount: '2000.00' },
      { date: '2026-06-03', description: 'OFFICE DEPOT', amount: '-120.50' },
    ]);
    const payment = cardA.lines[0]!;
    expect(payment.organizationMatches.map((m) => [m.legalName, m.accountName, m.txnDate, m.status])).toEqual([
      ['Beta Co', 'Checking', '2026-06-01', 'staged'],
      ['Gamma Co', 'Checking', '2026-06-05', 'staged'],
    ]);
    expect(payment.intercompanyCandidate).toBeNull(); // nothing posted anywhere yet
    expect(cardA.lines[1]!.organizationMatches).toEqual([]); // the charge has no mirror
  });

  it('a line the other company already posted as an intercompany mark is the match candidate; one it posted otherwise is reported as decided', async () => {
    const x = await setup();
    const bankB = await stage(x.owner, x.b, x.bankB, [
      { date: '2026-06-01', description: 'PAY VISA', amount: '-2000.00' },
      { date: '2026-06-02', description: 'RENT', amount: '-500.00' },
    ]);
    // B marks the −2000 as a transfer with A (LL-099) and posts the −500 to an expense.
    await postImportLines(x.owner, x.b, bankB.batch.id, { decisions: [
      { lineId: bankB.lines[0]!.id, action: 'intercompany_transfer', counterpartCompanyId: x.a },
      { lineId: bankB.lines[1]!.id, action: 'post', accountId: x.expB },
    ] });
    const cardA = await stage(x.owner, x.a, x.cardA, [
      { date: '2026-06-03', description: 'PAYMENT THANK YOU', amount: '2000.00' },
      { date: '2026-06-03', description: 'REFUND', amount: '500.00' },
    ]);
    expect(cardA.lines[0]!.organizationMatches[0]).toMatchObject({ legalName: 'Beta Co', status: 'posted_mark', detail: null });
    expect(cardA.lines[0]!.intercompanyCandidate).toMatchObject({ counterpartCompanyId: x.b });
    expect(cardA.lines[1]!.organizationMatches[0]).toMatchObject({ legalName: 'Beta Co', status: 'decided' });
    expect(cardA.lines[1]!.organizationMatches[0]!.detail).toMatch(/^posted there to /);
  });
});

describe('marking by the other company\'s statement line', () => {
  it('posts exactly what marking by company posts; the other company then sees the match and mirrors it', async () => {
    const x = await setup();
    const bankB = await stage(x.owner, x.b, x.bankB, [{ date: '2026-06-01', description: 'PAY VISA', amount: '-2000.00' }]);
    const cardA = await stage(x.owner, x.a, x.cardA, [{ date: '2026-06-03', description: 'PAYMENT THANK YOU', amount: '2000.00' }]);
    const match = cardA.lines[0]!.organizationMatches[0]!;
    expect(match).toMatchObject({ lineId: bankB.lines[0]!.id, companyId: x.b, status: 'staged' });

    const r = await postImportLines(x.owner, x.a, cardA.batch.id, { decisions: [
      { lineId: cardA.lines[0]!.id, action: 'intercompany_transfer', counterpartStatementLineId: match.lineId },
    ] });
    expect(r.intercompany).toBe(1);
    const afterA = (await getImportBatch(x.owner, x.a, cardA.batch.id))!.lines[0]!;
    expect(afterA.status).toBe('POSTED');
    expect(afterA.postedSource).toBe('INTERCOMPANY');
    // A collected 2000 from B: B is the payer and holds nothing yet — A's side is "Due to Beta" (A owes B) — see LL-102's pair rule.
    let report = await getIntercompanyReport(x.owner, x.a, '2026-12-31');
    expect(report.rows.find((row) => row.counterpartLegalName === 'Beta Co')).toMatchObject({ state: 'in_transit' });

    // B's own review now offers A's posted side as the match, and matching mirrors the pair.
    const viewB = (await getImportBatch(x.owner, x.b, bankB.batch.id))!;
    expect(viewB.lines[0]!.intercompanyCandidate).toMatchObject({ counterpartCompanyId: x.a });
    await postImportLines(x.owner, x.b, bankB.batch.id, { decisions: [
      { lineId: bankB.lines[0]!.id, action: 'match_intercompany', counterpartEntryId: viewB.lines[0]!.intercompanyCandidate!.entryId },
    ] });
    report = await getIntercompanyReport(x.owner, x.a, '2026-12-31');
    expect(report.rows.find((row) => row.counterpartLegalName === 'Beta Co')).toMatchObject({ state: 'mirrored', mirrored: true });
  });

  it('refuses a statement line that is not the other side, and a transfer that names nothing', async () => {
    const x = await setup();
    const bankB = await stage(x.owner, x.b, x.bankB, [
      { date: '2026-06-01', description: 'PAY VISA', amount: '-2000.00' },
      { date: '2026-06-01', description: 'OTHER', amount: '-75.00' },
    ]);
    const bankC = await stage(x.owner, x.c, x.bankC, [{ date: '2026-06-01', description: 'PAY VISA', amount: '-2000.00' }]);
    const cardA = await stage(x.owner, x.a, x.cardA, [{ date: '2026-06-03', description: 'PAYMENT THANK YOU', amount: '2000.00' }]);
    const line = cardA.lines[0]!.id;
    // Wrong amount; a line B already posted; a line of A's own; nothing at all.
    expect(await codeOf(postImportLines(x.owner, x.a, cardA.batch.id, { decisions: [{ lineId: line, action: 'intercompany_transfer', counterpartStatementLineId: bankB.lines[1]!.id }] }), BankImportError)).toBe('COUNTERPART_INVALID');
    await postImportLines(x.owner, x.c, bankC.batch.id, { decisions: [{ lineId: bankC.lines[0]!.id, action: 'post', accountId: (await listAccounts(x.owner, x.c)).find((z) => z.accountType === 'EXPENSE')!.id }] });
    expect(await codeOf(postImportLines(x.owner, x.a, cardA.batch.id, { decisions: [{ lineId: line, action: 'intercompany_transfer', counterpartStatementLineId: bankC.lines[0]!.id }] }), BankImportError)).toBe('COUNTERPART_INVALID');
    expect(await codeOf(postImportLines(x.owner, x.a, cardA.batch.id, { decisions: [{ lineId: line, action: 'intercompany_transfer', counterpartStatementLineId: line }] }), BankImportError)).toBe('COUNTERPART_INVALID');
    expect(await codeOf(postImportLines(x.owner, x.a, cardA.batch.id, { decisions: [{ lineId: line, action: 'intercompany_transfer' }] }), BankImportError)).toBe('COUNTERPART_REQUIRED');
    // Nothing posted by any of those; the line still waits, and the wait is a draft the page keeps.
    expect((await getImportBatch(x.owner, x.a, cardA.batch.id))!.lines[0]!.status).toBe('STAGED');
    await saveReviewDrafts(x.owner, x.a, cardA.batch.id, { drafts: [{ lineId: line, action: 'intercompany_transfer' }] });
    expect((await getImportBatch(x.owner, x.a, cardA.batch.id))!.lines[0]!.draft).toMatchObject({ action: 'intercompany_transfer', counterpartCompanyId: null });
    // The right line still works after all that.
    const ok = await postImportLines(x.owner, x.a, cardA.batch.id, { decisions: [{ lineId: line, action: 'intercompany_transfer', counterpartStatementLineId: bankB.lines[0]!.id }] });
    expect(ok.intercompany).toBe(1);
  });
});
