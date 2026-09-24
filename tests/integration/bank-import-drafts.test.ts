/**
 * Review drafts — LL-105 / ADR-045. Against a real DB, extractor injected.
 *
 * Proves: a saved choice comes back on the next load and is replaced on the next save; only a
 * STAGED line of the batch takes a draft (others are skipped, never an error); an account that
 * is not the drafting company's own is stored as nothing, never a raw FK error; a counterpart
 * outside the organization likewise; drafts vanish the moment a line leaves STAGED by ANY path
 * (post, ignore, taken by another company, marked as a transfer — the 0043 trigger) and a raw
 * draft for a decided line is refused; the batch list derives new → in progress → complete;
 * deleting a batch takes its drafts; shared drafts belong to the viewing company alone.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount, listAccounts } from '@/server/accounts';
import {
  assignSharedLines,
  BankImportError,
  deleteImportBatch,
  getImportBatch,
  getSharedImportBatch,
  listImportBatches,
  listSharedImports,
  postImportLines,
  saveReviewDrafts,
  saveSharedDrafts,
  setBatchSharing,
  stageImport,
} from '@/server/bank-import';
import { cannedExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
const NOBODY = '00000000-0000-4000-8000-00000000dead';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `dr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'D' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function makeCompany(owner: string, legalName: string): Promise<string> {
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName, timezone: 'America/Chicago' }), 'standard');
  return company.id;
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
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    const seen = new Set<unknown>();
    let cur: unknown = e;
    let text = '';
    while (cur instanceof Error && !seen.has(cur)) { seen.add(cur); text += ' ' + cur.message; cur = (cur as { cause?: unknown }).cause; }
    return text;
  }
}

interface Ctx {
  owner: string;
  a: string; // cardholder
  b: string; // taker
  c: string; // a third member
  cardId: string;
  expenseA: string;
  ownerDistA: string;
  suppliesB: string;
}

/** Owner with A (a Visa card), B and C in one organization. */
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const a = await makeCompany(owner, 'Alpha Co');
  const b = await makeCompany(owner, 'Beta Co');
  const c = await makeCompany(owner, 'Gamma Co');
  const org = await createOrganization(owner, a, { name: 'Group' });
  await addCompanyToOrganization(owner, b, org.id);
  await addCompanyToOrganization(owner, c, org.id);
  const card = await createAccount(owner, a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
  const suppliesB = (await createAccount(owner, b, createAccountInput.parse({ name: 'Supplies Expense', accountType: 'EXPENSE' }))).id;
  const accountsA = await listAccounts(owner, a);
  return {
    owner, a, b, c,
    cardId: card.id,
    expenseA: accountsA.find((x) => x.accountType === 'EXPENSE')!.id,
    ownerDistA: accountsA.find((x) => x.name === 'Owner Distributions')!.id,
    suppliesB,
  };
}
/** Stage the canned card statement (−120.50 OFFICE DEPOT, −45.00 SHELL FUEL, +2000 PAYMENT) in A. */
async function stageCard(c: Ctx, share = true) {
  const batch = await stageImport(c.owner, c.a, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY, shareWithOrganization: share }, cannedExtractor);
  const lines = (await getImportBatch(c.owner, c.a, batch.id))!.lines;
  return { batch, lines };
}
async function draftRows(lineIds: readonly string[]): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from bank_import_line_drafts where line_id in (${sql.join(lineIds.map((id) => sql`${id}`), sql`, `)})`);
  return Number(r.rows[0]!.n);
}

beforeEach(async () => {
  await truncateAll();
});

describe('review drafts (the cardholder screen)', () => {
  it('saves, comes back on the next load, is replaced on the next save; unknown lines are skipped, not errors', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const [l0, l1, l2] = lines.map((l) => l.id) as [string, string, string];
    expect(lines.every((l) => l.draft === null)).toBe(true);

    expect(await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [
      { lineId: l0, action: 'post', accountId: c.expenseA },
      { lineId: l1, action: 'ignore' },
      { lineId: NOBODY, action: 'post' }, // not a line of this batch: skipped
    ] })).toEqual({ saved: 2 });
    let view = (await getImportBatch(c.owner, c.a, batch.id))!;
    expect(view.lines[0]!.draft).toMatchObject({ action: 'post', accountId: c.expenseA, documentId: null, counterpartCompanyId: null });
    expect(view.lines[1]!.draft).toMatchObject({ action: 'ignore', accountId: null });
    expect(view.lines[2]!.draft).toBeNull();
    void l2;

    // Replace: personal, against Owner Distributions; a transfer draft with its counterpart.
    expect(await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [
      { lineId: l0, action: 'personal', accountId: c.ownerDistA },
      { lineId: l2, action: 'intercompany_transfer', counterpartCompanyId: c.b },
    ] })).toEqual({ saved: 2 });
    view = (await getImportBatch(c.owner, c.a, batch.id))!;
    expect(view.lines[0]!.draft).toMatchObject({ action: 'personal', accountId: c.ownerDistA });
    expect(view.lines[1]!.draft).toMatchObject({ action: 'ignore' }); // untouched by a save that did not name it
    expect(view.lines[2]!.draft).toMatchObject({ action: 'intercompany_transfer', counterpartCompanyId: c.b });
    // An empty save is a no-op.
    expect(await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [] })).toEqual({ saved: 0 });
  });

  it('stores nothing for an account that is not this company\'s own, or a counterpart outside the organization — never a raw FK error', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const l0 = lines[0]!.id;
    expect(await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [
      { lineId: l0, action: 'post', accountId: c.suppliesB, counterpartCompanyId: NOBODY },
    ] })).toEqual({ saved: 1 });
    const view = (await getImportBatch(c.owner, c.a, batch.id))!;
    expect(view.lines[0]!.draft).toMatchObject({ action: 'post', accountId: null, counterpartCompanyId: null });
    // The statement account itself is not pickable either.
    await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [{ lineId: l0, action: 'post', accountId: c.cardId }] });
    expect((await getImportBatch(c.owner, c.a, batch.id))!.lines[0]!.draft?.accountId).toBeNull();
  });

  it('another company\'s batch reads as not found', async () => {
    const c = await setup();
    const { batch } = await stageCard(c);
    expect(await codeOf(saveReviewDrafts(c.owner, c.b, batch.id, { drafts: [] }), BankImportError)).toBe('BATCH_NOT_FOUND');
    expect(await codeOf(saveReviewDrafts(c.owner, c.a, NOBODY, { drafts: [] }), BankImportError)).toBe('BATCH_NOT_FOUND');
  });

  it('drafts vanish the moment a line leaves STAGED — by post, ignore, a take from another company, or a transfer mark (trigger); a raw draft for a decided line is refused', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const [l0, l1, l2] = lines.map((l) => l.id) as [string, string, string];
    await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [
      { lineId: l0, action: 'post', accountId: c.expenseA },
      { lineId: l1, action: 'post', accountId: c.expenseA },
      { lineId: l2, action: 'post', accountId: c.expenseA },
    ] });
    await saveSharedDrafts(c.owner, c.b, batch.id, { drafts: [{ lineId: l1, take: true, accountId: c.suppliesB }] });
    expect(await draftRows([l0, l1, l2])).toBe(4);

    // Post one, ignore nothing yet: only that line's draft goes.
    await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: l0, action: 'post', accountId: c.expenseA }] });
    expect(await draftRows([l0])).toBe(0);
    expect(await draftRows([l1, l2])).toBe(3);
    // B takes l1: both A's and B's drafts of it go.
    await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: l1, accountId: c.suppliesB }] });
    expect(await draftRows([l1])).toBe(0);
    // A marks the +2000 payment as a transfer with B: its draft goes.
    await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: l2, action: 'intercompany_transfer', counterpartCompanyId: c.b }] });
    expect(await draftRows([l2])).toBe(0);
    // The service skips decided lines silently; the database refuses a raw draft for one.
    expect(await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [{ lineId: l0, action: 'ignore' }] })).toEqual({ saved: 0 });
    const db = await getTestDb();
    expect(await rejection(db.execute(sql`
      insert into bank_import_line_drafts (line_id, company_id, action, updated_by)
      values (${l0}, ${c.a}, 'ignore', ${c.owner})`))).toMatch(/DRAFT_LINE_NOT_STAGED/);

    // Ignore clears too (a second statement; lines are fresh).
    const again = await stageCard(c, false);
    const m0 = again.lines[0]!.id;
    await saveReviewDrafts(c.owner, c.a, again.batch.id, { drafts: [{ lineId: m0, action: 'ignore' }] });
    await postImportLines(c.owner, c.a, again.batch.id, { decisions: [{ lineId: m0, action: 'ignore' }] });
    expect(await draftRows([m0])).toBe(0);
  });

  it('the batch list derives new → in progress → complete, and a deleted batch takes its drafts', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c, false);
    const [l0, l1, l2] = lines.map((l) => l.id) as [string, string, string];
    const status = async () => (await listImportBatches(c.owner, c.a)).find((b) => b.id === batch.id)!;
    expect(await status()).toMatchObject({ stagedCount: 3, decidedCount: 0, draftCount: 0, reviewStatus: 'new' });

    await saveReviewDrafts(c.owner, c.a, batch.id, { drafts: [{ lineId: l0, action: 'ignore' }] });
    expect(await status()).toMatchObject({ stagedCount: 3, decidedCount: 0, draftCount: 1, reviewStatus: 'in_progress' });

    // The draft's line is decided (draft gone); one decided + two staged is still in progress.
    await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: l0, action: 'ignore' }] });
    expect(await status()).toMatchObject({ stagedCount: 2, decidedCount: 1, draftCount: 0, reviewStatus: 'in_progress' });

    await postImportLines(c.owner, c.a, batch.id, { decisions: [
      { lineId: l1, action: 'post', accountId: c.expenseA },
      { lineId: l2, action: 'post', accountId: c.expenseA },
    ] });
    expect(await status()).toMatchObject({ stagedCount: 0, decidedCount: 3, draftCount: 0, reviewStatus: 'complete' });

    // Delete cascades (a statement that posted nothing).
    const fresh = await stageCard(c, false);
    const ids = fresh.lines.map((l) => l.id);
    await saveReviewDrafts(c.owner, c.a, fresh.batch.id, { drafts: ids.map((lineId) => ({ lineId, action: 'ignore' as const })) });
    expect(await draftRows(ids)).toBe(3);
    await deleteImportBatch(c.owner, c.a, fresh.batch.id);
    expect(await draftRows(ids)).toBe(0);
  });
});

describe('shared drafts (the "take" screen)', () => {
  it('belong to the viewing company: B sees its own, C and the cardholder see nothing of them; a take clears them', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const [l0, l1] = lines.map((l) => l.id) as [string, string];

    expect(await saveSharedDrafts(c.owner, c.b, batch.id, { drafts: [
      { lineId: l0, take: true, accountId: c.suppliesB },
      { lineId: l1, take: false, accountId: c.ownerDistA }, // A's account: not B's own → nothing stored
    ] })).toEqual({ saved: 2 });
    const fromB = (await getSharedImportBatch(c.owner, c.b, batch.id))!;
    expect(fromB.lines.find((x) => x.id === l0)!.draft).toMatchObject({ action: 'take', accountId: c.suppliesB });
    expect(fromB.lines.find((x) => x.id === l1)!.draft).toMatchObject({ action: 'skip', accountId: null });
    expect(fromB.batch.draftCount).toBe(2);
    expect((await listSharedImports(c.owner, c.b)).find((s) => s.batchId === batch.id)!.draftCount).toBe(2);

    // C (another member) and A (the cardholder) see none of B's drafts.
    const fromC = (await getSharedImportBatch(c.owner, c.c, batch.id))!;
    expect(fromC.lines.every((x) => x.draft === null)).toBe(true);
    expect(fromC.batch.draftCount).toBe(0);
    expect((await getImportBatch(c.owner, c.a, batch.id))!.lines.every((x) => x.draft === null)).toBe(true);

    // B takes l0: its draft goes; l1's skip stays.
    await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: l0, accountId: c.suppliesB }] });
    expect(await draftRows([l0])).toBe(0);
    expect(await draftRows([l1])).toBe(1);
  });

  it('an invisible statement reads as not found — un-shared with nothing taken, or a company outside the organization', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const outsider = await makeUser();
    const d = await makeCompany(outsider, 'Delta Co');
    expect(await codeOf(saveSharedDrafts(outsider, d, batch.id, { drafts: [{ lineId: lines[0]!.id, take: true }] }), BankImportError)).toBe('BATCH_NOT_FOUND');
    await setBatchSharing(c.owner, c.a, batch.id, false);
    expect(await codeOf(saveSharedDrafts(c.owner, c.b, batch.id, { drafts: [{ lineId: lines[0]!.id, take: true }] }), BankImportError)).toBe('BATCH_NOT_FOUND');
  });
});
