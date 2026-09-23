/**
 * Shared card statements — LL-097 / ADR-043. Against a real DB, extractor injected.
 *
 * Proves: the structural rules of migration 0041 (line CHECKs, the cross-company composite FK,
 * the group unique + only-INTERCOMPANY CHECK, the immutable trigger covering the group id, the
 * control trigger refusing INTERCOMPANY on A/R); PERSONAL; sharing and its uniform visibility;
 * the shared view's line filter; assign (both sides in one transaction, same group, mirror to
 * the cent, card reconciles), refund flip, validation incl. closed periods on either side;
 * idempotency and concurrency (double submit, 10-way race, assign-vs-post, B and C in parallel
 * with a reverse-direction share, assign-vs-leave); unassign; delete rules.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { toMoney } from '@/lib/decimal';
import { createAccount, listAccounts, resolveSystemAccount } from '@/server/accounts';
import { ensureIntercompanyPair } from '@/server/accounts/internal';
import { AuthorizationDenied } from '@/server/authorization';
import {
  assignSharedLines,
  BankImportError,
  deleteImportBatch,
  getImportBatch,
  getSharedImportBatch,
  listSharedImports,
  postImportLines,
  setBatchSharing,
  stageImport,
  unassignSharedLine,
} from '@/server/bank-import';
import { cannedExtractor, type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { LedgerError, postJournalEntry } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization, OrganizationError, removeCompanyFromOrganization } from '@/server/organizations';
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { getReconciliation, setCleared, startReconciliation } from '@/server/reconciliation';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `sh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'S' },
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
  orgId: string;
  cardId: string;
  bankA: string;
  suppliesB: string;
  ownerDistA: string;
}

/** Owner with A (a Visa card) and B in one organization; B has a Supplies Expense account. */
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const a = await makeCompany(owner, 'Alpha Co');
  const b = await makeCompany(owner, 'Beta Co');
  const org = await createOrganization(owner, a, { name: 'Group' });
  await addCompanyToOrganization(owner, b, org.id);
  const card = await createAccount(owner, a, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
  const suppliesB = (await createAccount(owner, b, createAccountInput.parse({ name: 'Supplies Expense', accountType: 'EXPENSE' }))).id;
  const accountsA = await listAccounts(owner, a);
  const bankA = accountsA.find((x) => x.accountNumber === '1000')!.id;
  const ownerDistA = accountsA.find((x) => x.name === 'Owner Distributions')!.id;
  return { owner, a, b, orgId: org.id, cardId: card.id, bankA, suppliesB, ownerDistA };
}
/** Stage the canned card statement (−120.50 OFFICE DEPOT, −45.00 SHELL FUEL, +2000 PAYMENT) in A, shared. */
async function stageCard(c: Ctx, share = true, extractor: TransactionExtractor = cannedExtractor) {
  const batch = await stageImport(c.owner, c.a, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY, shareWithOrganization: share }, extractor);
  const lines = (await getImportBatch(c.owner, c.a, batch.id))!.lines;
  return { batch, lines };
}
async function balance(owner: string, companyId: string, accountId: string, asOf = '2026-12-31'): Promise<string> {
  const tb = await getTrialBalance(owner, companyId, asOf);
  expect(tb.balanced).toBe(true);
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}
async function pairOf(c: Ctx) {
  return await getDbTx().transaction(async (tx) => await ensureIntercompanyPair(tx, c.owner, c.a, c.b));
}
async function entry(id: string) {
  const db = await getTestDb();
  const e = (await db.execute<{ status: string; source_type: string; source_id: string; intercompany_group_id: string | null; company_id: string }>(sql`select status, source_type::text, source_id, intercompany_group_id, company_id from journal_entries where id = ${id}`)).rows[0]!;
  const lines = (await db.execute<{ account_id: string; debit: string; credit: string }>(sql`select account_id, debit::text, credit::text from journal_lines where journal_entry_id = ${id} order by line_number`)).rows;
  return { ...e, lines };
}
async function auditActions(companyId: string): Promise<string[]> {
  const db = await getTestDb();
  return (await db.execute<{ action: string }>(sql`select action from audit_events where company_id = ${companyId} order by created_at, action`)).rows.map((r) => r.action);
}
async function lineRow(id: string) {
  const db = await getTestDb();
  return (await db.execute<{ status: string; journal_entry_id: string | null; assigned_company_id: string | null; assigned_journal_entry_id: string | null; chosen_account_id: string | null }>(sql`select status, journal_entry_id, assigned_company_id, assigned_journal_entry_id, chosen_account_id from bank_import_lines where id = ${id}`)).rows[0]!;
}

beforeEach(async () => {
  await truncateAll();
});

describe('structural rules (migration 0041)', () => {
  it('line CHECKs: PERSONAL/ASSIGNED need an entry; a STAGED row cannot carry half an assignment; ASSIGNED cannot point at itself', async () => {
    const c = await setup();
    const { lines } = await stageCard(c);
    const db = await getTestDb();
    const l = lines[0]!;
    // Two CHECKs fail on this row (no entry, no account); Postgres reports whichever it evaluates first.
    expect(await rejection(db.execute(sql`update bank_import_lines set status = 'PERSONAL' where id = ${l.id}`))).toMatch(/bank_import_lines_posted_has_entry|bank_import_lines_personal_has_account/);
    expect(await rejection(db.execute(sql`update bank_import_lines set status = 'ASSIGNED' where id = ${l.id}`))).toMatch(/bank_import_lines_posted_has_entry|bank_import_lines_assigned_shape/);
    expect(await rejection(db.execute(sql`update bank_import_lines set assigned_company_id = ${c.b} where id = ${l.id}`))).toMatch(/bank_import_lines_assigned_shape/);
    // A real assignment, then the self-references are refused.
    const { assigned } = await assignSharedLines(c.owner, c.b, lines[0]!.batchId, { decisions: [{ lineId: l.id, accountId: c.suppliesB }] });
    expect(assigned).toBe(1);
    const row = await lineRow(l.id);
    expect(await rejection(db.execute(sql`update bank_import_lines set assigned_company_id = company_id where id = ${l.id}`))).toMatch(/bank_import_lines_assigned_shape|bank_import_lines_assigned_entry_same_assigned_company_fk/);
    expect(await rejection(db.execute(sql`update bank_import_lines set assigned_journal_entry_id = ${row.journal_entry_id} where id = ${l.id}`))).toMatch(/bank_import_lines_assigned_shape|bank_import_lines_assigned_entry_same_assigned_company_fk/);
    expect(await rejection(db.execute(sql`update bank_import_lines set chosen_account_id = ${c.ownerDistA} where id = ${l.id}`))).toMatch(/bank_import_lines_targets_only_when_posted/);
    // PERSONAL needs a chosen account; the composite FK refuses an entry of a third company.
    const cc = await makeCompany(c.owner, 'Gamma Co');
    const third = (await db.execute<{ id: string }>(sql`select id from journal_entries where company_id = ${cc} limit 1`)).rows[0];
    expect(third).toBeUndefined();
    expect(await rejection(db.execute(sql`update bank_import_lines set assigned_company_id = ${cc} where id = ${l.id}`))).toMatch(/bank_import_lines_assigned_entry_same_assigned_company_fk/);
    expect(await rejection(db.execute(sql`update bank_import_lines set status = 'PERSONAL', assigned_company_id = null, assigned_journal_entry_id = null where id = ${l.id}`))).toMatch(/bank_import_lines_personal_has_account/);
  });

  it('journal_entries: one entry per company per group, a group only on INTERCOMPANY, and the group id is immutable once posted', async () => {
    const c = await setup();
    const { lines } = await stageCard(c);
    await assignSharedLines(c.owner, c.b, lines[0]!.batchId, { decisions: [{ lineId: lines[0]!.id, accountId: c.suppliesB }] });
    const row = await lineRow(lines[0]!.id);
    const db = await getTestDb();
    const g = (await entry(row.journal_entry_id!)).intercompany_group_id!;
    expect(await rejection(db.execute(sql`insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, intercompany_group_id) values (${c.a}, '2026-06-02', '2026-06-02', 'INTERCOMPANY', ${c.owner}, 'DRAFT', ${g})`))).toMatch(/journal_entries_intercompany_group_company_unique/);
    expect(await rejection(db.execute(sql`insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, intercompany_group_id) values (${c.a}, '2026-06-02', '2026-06-02', 'JOURNAL_ENTRY', ${c.owner}, 'DRAFT', gen_random_uuid())`))).toMatch(/journal_entries_group_only_intercompany/);
    expect(await rejection(db.execute(sql`update journal_entries set intercompany_group_id = gen_random_uuid() where id = ${row.journal_entry_id}`))).toMatch(/POSTED_ENTRY_IMMUTABLE/);
    // The manual API refuses a group id outright.
    expect(await codeOf(postJournalEntry(postJournalEntryInput.parse({ companyId: c.a, actorUserId: c.owner, transactionDate: '2026-06-02', sourceType: 'JOURNAL_ENTRY', intercompanyGroupId: g, lines: [{ accountId: c.bankA, debit: '1.00' }, { accountId: c.ownerDistA, credit: '1.00' }] })), LedgerError)).toBe('MANUAL_SOURCE_TYPE_REQUIRED');
  });

  it('an INTERCOMPANY posting may never touch Accounts Receivable / Payable (trigger)', async () => {
    const c = await setup();
    const ar = (await resolveSystemAccount(getDbTx(), c.b, 'ACCOUNTS_RECEIVABLE'))!;
    const db = await getTestDb();
    expect(await rejection(db.transaction(async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number) values (${c.b}, '2026-06-02', '2026-06-02', 'INTERCOMPANY', ${c.owner}, 'POSTED', 95000) returning id`);
      await tx.execute(sql`insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit) values (${r.rows[0]!.id}, ${c.b}, ${ar}, 1, '1.0000', '0.0000')`);
    }))).toMatch(/CONTROL_ACCOUNT_MANUAL_POST/);
  });
});

describe('PERSONAL', () => {
  it('posts to Owner Distributions against the card, is counted, refuses expense/revenue/the card, and is idempotent', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c, false);
    const [depot, shell] = lines;
    const r = await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: shell!.id, action: 'personal', accountId: c.ownerDistA }] });
    expect(r).toMatchObject({ posted: 0, personal: 1, ignored: 0 });
    const row = await lineRow(shell!.id);
    expect(row).toMatchObject({ status: 'PERSONAL', chosen_account_id: c.ownerDistA });
    const e = await entry(row.journal_entry_id!);
    expect(e.source_type).toBe('BANK_IMPORT');
    expect(e.lines).toEqual([{ account_id: c.cardId, debit: '0.0000', credit: '45.0000' }, { account_id: c.ownerDistA, debit: '45.0000', credit: '0.0000' }]);

    const suppliesA = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    expect(await codeOf(postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: depot!.id, action: 'personal', accountId: suppliesA }] }), BankImportError)).toBe('ACCOUNT_INVALID');
    expect(await codeOf(postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: depot!.id, action: 'personal', accountId: c.cardId }] }), BankImportError)).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');
    expect(await codeOf(postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: depot!.id, action: 'personal' }] }), BankImportError)).toBe('ACCOUNT_REQUIRED');
    expect(await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: shell!.id, action: 'personal', accountId: c.ownerDistA }] })).toMatchObject({ personal: 0 });
    // A second upload flags the PERSONAL twin as a duplicate; history does not suggest the owner account.
    const again = await stageCard(c, false);
    expect(again.lines[1]!.duplicateOf).toBe('posted');
    expect(again.lines[1]!.suggestedAccountId).not.toBe(c.ownerDistA);
    expect(await codeOf(deleteImportBatch(c.owner, c.a, batch.id), BankImportError)).toBe('BATCH_HAS_POSTINGS');
  });
});

describe('sharing and visibility', () => {
  it('sharing needs an organization and a card; audits; the flag can be set at upload', async () => {
    const owner = await makeUser();
    const solo = await makeCompany(owner, 'Solo Co');
    const card = await createAccount(owner, solo, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const b1 = await stageImport(owner, solo, { bankAccountId: card.id, fileBytes: EMPTY }, cannedExtractor);
    expect(await codeOf(setBatchSharing(owner, solo, b1.id, true), BankImportError)).toBe('NOT_IN_ORGANIZATION');
    expect(await codeOf(stageImport(owner, solo, { bankAccountId: card.id, fileBytes: EMPTY, shareWithOrganization: true }, cannedExtractor), BankImportError)).toBe('NOT_IN_ORGANIZATION');

    const c = await setup();
    const bankBatch = await stageImport(c.owner, c.a, { bankAccountId: c.bankA, fileBytes: EMPTY }, cannedExtractor);
    expect(await codeOf(setBatchSharing(c.owner, c.a, bankBatch.id, true), BankImportError)).toBe('ONLY_CARDS_SHAREABLE');
    const { batch } = await stageCard(c, false);
    expect(batch.sharedWithOrganization).toBe(false);
    expect(await listSharedImports(c.owner, c.b)).toEqual([]);
    expect((await setBatchSharing(c.owner, c.a, batch.id, true)).sharedWithOrganization).toBe(true);
    expect(await auditActions(c.a)).toContain('BANK_IMPORT_SHARING_CHANGED');
    const shared = await listSharedImports(c.owner, c.b);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ batchId: batch.id, ownerCompanyId: c.a, ownerLegalName: 'Alpha Co', accountName: 'Visa', stagedCount: 3, assignedToMeCount: 0 });
    const { batch: atUpload } = await stageCard(c, true);
    expect(atUpload.sharedWithOrganization).toBe(true);
  });

  it('visibility is uniform: every negative is [] / null, never a distinguishable error', async () => {
    const c = await setup();
    const { batch } = await stageCard(c);
    const bOnly = await makeUser(); // OWNER of B, not in A
    await insertMembership(c.b, bOnly, 'OWNER');
    const readOnlyInA = await makeUser(); // OWNER of B, READ_ONLY in A
    await insertMembership(c.b, readOnlyInA, 'OWNER');
    await insertMembership(c.a, readOnlyInA, 'READ_ONLY');
    const otherOrgOwner = await makeUser();
    const d = await makeCompany(otherOrgOwner, 'Delta Co');
    await createOrganization(otherOrgOwner, d, { name: 'Other' });
    await insertMembership(c.a, otherOrgOwner, 'ADMIN');

    for (const [user, viewer] of [[bOnly, c.b], [readOnlyInA, c.b], [otherOrgOwner, d], [c.owner, c.a]] as const) {
      expect(await listSharedImports(user, viewer)).toEqual([]);
      expect(await getSharedImportBatch(user, viewer, batch.id)).toBeNull();
      const e = await assignSharedLines(user, viewer, batch.id, { decisions: [{ lineId: '00000000-0000-4000-8000-000000000000', accountId: '00000000-0000-4000-8000-000000000000' }] }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AuthorizationDenied);
      expect(e).not.toBeInstanceOf(BankImportError);
    }
    // Not a member of the viewer at all → the front-door denial.
    await expect(listSharedImports(bOnly, c.a)).rejects.toBeInstanceOf(AuthorizationDenied);
    // Un-shared: hidden again — unless B already took a line.
    expect(await getSharedImportBatch(c.owner, c.b, batch.id)).not.toBeNull();
    await setBatchSharing(c.owner, c.a, batch.id, false);
    expect(await getSharedImportBatch(c.owner, c.b, batch.id)).toBeNull();
    await setBatchSharing(c.owner, c.a, batch.id, true);
    const lines = (await getImportBatch(c.owner, c.a, batch.id))!.lines;
    await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: lines[1]!.id, accountId: c.suppliesB }] });
    await setBatchSharing(c.owner, c.a, batch.id, false);
    const still = await getSharedImportBatch(c.owner, c.b, batch.id);
    expect(still?.lines.map((l) => l.status)).toEqual(['ASSIGNED']);
    expect(still?.batch.sharedWithOrganization).toBe(false);
    expect(still?.batch.stagedCount).toBe(0);
    expect((await listSharedImports(c.owner, c.b)).map((x) => [x.batchId, x.stagedCount, x.assignedToMeCount])).toEqual([[batch.id, 0, 1]]);
    // …and no NEW take is possible until it is shared again.
    expect(await codeOf(assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: lines[2]!.id, accountId: c.suppliesB }] }), BankImportError)).toBe('LINE_NOT_FOUND');
    await setBatchSharing(c.owner, c.a, batch.id, true);
    expect((await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: lines[2]!.id, accountId: c.suppliesB }] })).assigned).toBe(1);
  });

  it('the shared view shows STAGED lines and the viewer\'s own; suggestions come from the viewer\'s chart', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const cc = await makeCompany(c.owner, 'Gamma Co');
    await addCompanyToOrganization(c.owner, cc, c.orgId);
    const suppliesC = await createAccount(c.owner, cc, createAccountInput.parse({ name: 'Supplies C', accountType: 'EXPENSE' }));
    await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: lines[0]!.id, action: 'post', accountId: (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id }] });
    await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: lines[1]!.id, accountId: c.suppliesB }] });
    await assignSharedLines(c.owner, cc, batch.id, { decisions: [] as never }).catch(() => undefined);

    const fromB = (await getSharedImportBatch(c.owner, c.b, batch.id))!;
    expect(fromB.lines.map((l) => [l.lineNumber, l.status])).toEqual([[2, 'ASSIGNED'], [3, 'STAGED']]);
    expect(fromB.lines[0]!.assignedAccountId).toBe(c.suppliesB);
    expect(fromB.pickable.map((p) => p.id)).toContain(c.suppliesB);
    expect(fromB.pickable.map((p) => p.id)).not.toContain(c.cardId);
    const fromC = (await getSharedImportBatch(c.owner, cc, batch.id))!;
    expect(fromC.lines.map((l) => [l.lineNumber, l.status])).toEqual([[3, 'STAGED']]);
    expect(fromC.pickable.map((p) => p.id)).toContain(suppliesC.id);
    expect(fromC.lines[0]!.suggestedAccountId === null || fromC.pickable.some((p) => p.id === fromC.lines[0]!.suggestedAccountId)).toBe(true);
    expect((await getImportBatch(c.owner, c.a, batch.id))!.lines[1]!.assignedCompanyName).toBe('Beta Co');
  });
});

describe('assign', () => {
  it('posts both sides in one transaction with one group; the pair mirrors to the cent and the card reconciles', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const [depot, shell, payment] = lines;
    const r = await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: shell!.id, accountId: c.suppliesB }] });
    expect(r).toEqual({ assigned: 1 });
    const row = await lineRow(shell!.id);
    expect(row).toMatchObject({ status: 'ASSIGNED', assigned_company_id: c.b });
    const pair = await pairOf(c);
    const eA = await entry(row.journal_entry_id!);
    const eB = await entry(row.assigned_journal_entry_id!);
    expect(eA).toMatchObject({ company_id: c.a, status: 'POSTED', source_type: 'INTERCOMPANY', source_id: shell!.id });
    expect(eB).toMatchObject({ company_id: c.b, status: 'POSTED', source_type: 'INTERCOMPANY', source_id: shell!.id });
    expect(eA.intercompany_group_id).toBe(eB.intercompany_group_id);
    expect(eA.lines).toEqual([{ account_id: pair.dueFrom.id, debit: '45.0000', credit: '0.0000' }, { account_id: c.cardId, debit: '0.0000', credit: '45.0000' }]);
    expect(eB.lines).toEqual([{ account_id: c.suppliesB, debit: '45.0000', credit: '0.0000' }, { account_id: pair.dueTo.id, debit: '0.0000', credit: '45.0000' }]);
    expect(await auditActions(c.a)).toContain('BANK_IMPORT_ASSIGNED');
    expect(await auditActions(c.b)).toContain('BANK_IMPORT_ASSIGNED');
    // Mirror: A's Due from B equals B's Due to A (Decimal eq, never ===).
    const dueFrom = toMoney(await balance(c.owner, c.a, pair.dueFrom.id));
    const dueTo = toMoney(await balance(c.owner, c.b, pair.dueTo.id));
    expect(dueFrom.abs().eq(dueTo.abs())).toBe(true);
    expect(dueFrom.abs().eq(toMoney('45'))).toBe(true);

    // A finishes its side: the purchase is A's, the payment came from A's bank — then the card reconciles.
    const suppliesA = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    await postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: depot!.id, action: 'post', accountId: suppliesA }, { lineId: payment!.id, action: 'post', accountId: c.bankA }] });
    const rec = await startReconciliation(c.owner, c.a, { bankAccountId: c.cardId, statementDate: '2026-06-30', statementEndingAmount: '-1834.50' });
    const view = (await getReconciliation(c.owner, c.a, rec.id))!;
    expect(view.lines).toHaveLength(3);
    expect(view.lines.every((l) => l.fromImport)).toBe(true);
    await setCleared(c.owner, c.a, rec.id, { journalLineIds: view.lines.map((l) => l.journalLineId) });
    expect(toMoney((await getReconciliation(c.owner, c.a, rec.id))!.difference).isZero()).toBe(true);
  });

  it('a refund flips both sides', async () => {
    const c = await setup();
    const refund: TransactionExtractor = () => Promise.resolve([{ date: '2026-06-09', description: 'REFUND OFFICE DEPOT', amount: '10.00', category: 'Office Supplies' }]);
    const { batch, lines } = await stageCard(c, true, refund);
    await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: lines[0]!.id, accountId: c.suppliesB }] });
    const row = await lineRow(lines[0]!.id);
    const pair = await pairOf(c);
    expect((await entry(row.journal_entry_id!)).lines).toEqual([{ account_id: c.cardId, debit: '10.0000', credit: '0.0000' }, { account_id: pair.dueFrom.id, debit: '0.0000', credit: '10.0000' }]);
    expect((await entry(row.assigned_journal_entry_id!)).lines).toEqual([{ account_id: pair.dueTo.id, debit: '10.0000', credit: '0.0000' }, { account_id: c.suppliesB, debit: '0.0000', credit: '10.0000' }]);
  });

  it('validation: wrong account, foreign line, closed period on either side (named), nothing posted', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const l = lines[1]!;
    const suppliesA = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    const arB = (await resolveSystemAccount(getDbTx(), c.b, 'ACCOUNTS_RECEIVABLE'))!;
    const pair = await pairOf(c);
    for (const bad of [suppliesA, arB, pair.dueTo.id, c.cardId]) {
      expect(await codeOf(assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: l.id, accountId: bad }] }), BankImportError)).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');
    }
    const other = await stageImport(c.owner, c.a, { bankAccountId: c.cardId, fileBytes: EMPTY, shareWithOrganization: true }, cannedExtractor);
    const otherLine = (await getImportBatch(c.owner, c.a, other.id))!.lines[0]!;
    expect(await codeOf(assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: otherLine.id, accountId: c.suppliesB }] }), BankImportError)).toBe('LINE_NOT_FOUND');

    const pb = await getAccountingPeriod(c.b, l.txnDate);
    await closePeriod(c.owner, c.b, pb.id);
    const closedB = await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: l.id, accountId: c.suppliesB }] }).catch((e: unknown) => e);
    expect(closedB).toBeInstanceOf(LedgerError);
    expect((closedB as LedgerError).message).toMatch(/Beta Co/);
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where source_type = 'INTERCOMPANY'`)).rows[0]!.n).toBe('0');
    expect((await lineRow(l.id)).status).toBe('STAGED');
    // Closed in A instead.
    const c2 = await setup();
    const s2 = await stageCard(c2);
    const pa = await getAccountingPeriod(c2.a, s2.lines[1]!.txnDate);
    await closePeriod(c2.owner, c2.a, pa.id);
    const closedA = await assignSharedLines(c2.owner, c2.b, s2.batch.id, { decisions: [{ lineId: s2.lines[1]!.id, accountId: c2.suppliesB }] }).catch((e: unknown) => e);
    expect((closedA as LedgerError).message).toMatch(/Alpha Co/);
  });

  it('idempotent and race-safe: double submit, 10-way race, assign-vs-post, B and C in parallel with a reverse-direction share, assign-vs-leave', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const dec = { decisions: [{ lineId: lines[1]!.id, accountId: c.suppliesB }] };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => assignSharedLines(c.owner, c.b, batch.id, dec)));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String(r.reason))).toEqual([]);
    expect(results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.assigned : 0), 0)).toBe(1);
    expect((await assignSharedLines(c.owner, c.b, batch.id, dec)).assigned).toBe(0);
    const db = await getTestDb();
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where source_type = 'INTERCOMPANY' and status = 'POSTED'`)).rows[0]!.n).toBe('2');

    // assign (B) vs post (A) on one line → exactly one outcome.
    const suppliesA = (await listAccounts(c.owner, c.a)).find((x) => x.accountType === 'EXPENSE')!.id;
    await Promise.allSettled([
      assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: lines[0]!.id, accountId: c.suppliesB }] }),
      postImportLines(c.owner, c.a, batch.id, { decisions: [{ lineId: lines[0]!.id, action: 'post', accountId: suppliesA }] }),
    ]);
    const r0 = await lineRow(lines[0]!.id);
    expect(['ASSIGNED', 'POSTED']).toContain(r0.status);
    expect((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.a} and source_id = ${lines[0]!.id} and status = 'POSTED'`)).rows[0]!.n).toBe('1');

    // B and C take different lines of a fresh statement while B's own card, shared to A, is taken by A — no deadlock.
    const cc = await makeCompany(c.owner, 'Gamma Co');
    await addCompanyToOrganization(c.owner, cc, c.orgId);
    const suppliesC = (await createAccount(c.owner, cc, createAccountInput.parse({ name: 'Supplies C', accountType: 'EXPENSE' }))).id;
    const cardB = await createAccount(c.owner, c.b, createAccountInput.parse({ accountNumber: '2150', name: 'Visa B', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'FINANCING' }));
    const s2 = await stageCard(c);
    const bBatch = await stageImport(c.owner, c.b, { bankAccountId: cardB.id, fileBytes: EMPTY, shareWithOrganization: true }, cannedExtractor);
    const bLines = (await getImportBatch(c.owner, c.b, bBatch.id))!.lines;
    const settled = await Promise.allSettled([
      assignSharedLines(c.owner, c.b, s2.batch.id, { decisions: [{ lineId: s2.lines[0]!.id, accountId: c.suppliesB }] }),
      assignSharedLines(c.owner, cc, s2.batch.id, { decisions: [{ lineId: s2.lines[1]!.id, accountId: suppliesC }] }),
      assignSharedLines(c.owner, c.a, bBatch.id, { decisions: [{ lineId: bLines[0]!.id, accountId: suppliesA }] }),
      assignSharedLines(c.owner, cc, bBatch.id, { decisions: [{ lineId: bLines[1]!.id, accountId: suppliesC }] }),
    ]);
    expect(settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason))).toEqual([]);
    for (const id of [c.a, c.b, cc]) {
      const gaps = await db.execute<{ n: string; mx: string }>(sql`select count(*)::text n, max(entry_number)::text mx from journal_entries where company_id = ${id} and entry_number is not null`);
      expect(gaps.rows[0]!.n).toBe(gaps.rows[0]!.mx); // gapless
    }

    // assign vs leave: never both.
    const s3 = await stageCard(c);
    const race = await Promise.allSettled([
      assignSharedLines(c.owner, cc, s3.batch.id, { decisions: [{ lineId: s3.lines[2]!.id, accountId: suppliesC }] }),
      removeCompanyFromOrganization(c.owner, cc),
    ]);
    const leaveOk = race[1].status === 'fulfilled';
    const took = race[0].status === 'fulfilled' && race[0].value.assigned === 1;
    if (leaveOk) {
      expect(took).toBe(false);
    } else {
      expect((race[1] as PromiseRejectedResult).reason).toBeInstanceOf(OrganizationError);
    }
  });
});

describe('unassign', () => {
  it('reverses both sides, returns the line to STAGED, refuses others, and allows a fresh take', async () => {
    const c = await setup();
    const { batch, lines } = await stageCard(c);
    const l = lines[1]!;
    await assignSharedLines(c.owner, c.b, batch.id, { decisions: [{ lineId: l.id, accountId: c.suppliesB }] });
    const before = await lineRow(l.id);
    const cc = await makeCompany(c.owner, 'Gamma Co');
    await addCompanyToOrganization(c.owner, cc, c.orgId);
    expect(await codeOf(unassignSharedLine(c.owner, cc, batch.id, l.id), BankImportError)).toBe('LINE_NOT_FOUND');
    expect(await codeOf(unassignSharedLine(c.owner, c.b, batch.id, lines[0]!.id), BankImportError)).toBe('LINE_NOT_FOUND');

    expect(await unassignSharedLine(c.owner, c.b, batch.id, l.id)).toEqual({ reversed: true });
    expect(await lineRow(l.id)).toEqual({ status: 'STAGED', journal_entry_id: null, assigned_company_id: null, assigned_journal_entry_id: null, chosen_account_id: null });
    expect((await entry(before.journal_entry_id!)).status).toBe('REVERSED');
    expect((await entry(before.assigned_journal_entry_id!)).status).toBe('REVERSED');
    expect(await auditActions(c.a)).toContain('BANK_IMPORT_UNASSIGNED');
    expect(await auditActions(c.b)).toContain('BANK_IMPORT_UNASSIGNED');
    const pair = await pairOf(c);
    expect(toMoney(await balance(c.owner, c.a, pair.dueFrom.id)).isZero()).toBe(true);
    expect(toMoney(await balance(c.owner, c.b, pair.dueTo.id)).isZero()).toBe(true);
    expect(await codeOf(unassignSharedLine(c.owner, c.b, batch.id, l.id), BankImportError)).toBe('LINE_NOT_FOUND');
    // Taken again, by C this time, with a new group.
    const suppliesC = (await createAccount(c.owner, cc, createAccountInput.parse({ name: 'Supplies C', accountType: 'EXPENSE' }))).id;
    expect((await assignSharedLines(c.owner, cc, batch.id, { decisions: [{ lineId: l.id, accountId: suppliesC }] })).assigned).toBe(1);
    const after = await lineRow(l.id);
    expect(after.assigned_company_id).toBe(cc);
    expect((await entry(after.journal_entry_id!)).intercompany_group_id).not.toBe((await entry(before.journal_entry_id!)).intercompany_group_id);
    expect(await codeOf(deleteImportBatch(c.owner, c.a, batch.id), BankImportError)).toBe('BATCH_HAS_POSTINGS');
    await pause(0);
  });
});
