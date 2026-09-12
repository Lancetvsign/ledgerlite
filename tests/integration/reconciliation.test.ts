/**
 * Bank reconciliation — LL-078 (ADR-036). Against a real DB. Proves: the start rules, the tick
 * list (with imported lines flagged), replace-set saving with every validation, completion only
 * at an exact zero difference, opening-cleared carry-forward across statements, reversal
 * interplay, the structural once-only clear, and the authorization split.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import {
  completeReconciliation,
  getReconciliation,
  listReconciliations,
  ReconciliationError,
  setCleared,
  startReconciliation,
  updateReconciliation,
} from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

import type { TransactionExtractor } from '@/server/bank-import/extract';

interface Ctx {
  userId: string;
  companyId: string;
  bankId: string;
  otherBankId: string;
  salesId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `rc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'R' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'Recon Co', timezone: 'America/Chicago' }), 'standard');
  const bank = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Operating Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const other = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Savings Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Consulting Sales', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, bankId: bank.id, otherBankId: other.id, salesId: sales.id };
}

/** Post money into (positive) or out of (negative) a bank account against sales; returns the entry id. */
async function post(c: Ctx, amount: string, date: string, bankId = c.bankId): Promise<string> {
  const inbound = !amount.startsWith('-');
  const abs = inbound ? amount : amount.slice(1);
  const entry = await postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: date, sourceType: 'JOURNAL_ENTRY',
    lines: inbound
      ? [{ accountId: bankId, debit: abs }, { accountId: c.salesId, credit: abs }]
      : [{ accountId: c.salesId, debit: abs }, { accountId: bankId, credit: abs }],
  }));
  return entry.entry.id;
}

/** The bank-side journal line id of an entry. */
async function bankLineOf(c: Ctx, entryId: string, bankId = c.bankId): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(sql`select id from journal_lines where company_id = ${c.companyId} and journal_entry_id = ${entryId} and account_id = ${bankId}`);
  return r.rows[0]!.id;
}

const start = (c: Ctx, amount: string, date = '2026-06-30', bankId = c.bankId) =>
  startReconciliation(c.userId, c.companyId, { bankAccountId: bankId, statementDate: date, statementEndingAmount: amount });

const errOf = async (p: Promise<unknown>): Promise<ReconciliationError> => {
  try {
    await p;
    throw new Error('expected ReconciliationError');
  } catch (e) {
    expect(e).toBeInstanceOf(ReconciliationError);
    return e as ReconciliationError;
  }
};

const canned: TransactionExtractor = () => Promise.resolve([
  { date: '2026-06-01', description: 'DEPOSIT ACME CORP', amount: '1500.00', category: 'Consulting Sales' },
  { date: '2026-06-03', description: 'OFFICE DEPOT', amount: '-120.50', category: 'Consulting Sales' },
]);

beforeEach(async () => {
  await truncateAll();
});

describe('startReconciliation', () => {
  it('starts an IN_PROGRESS reconciliation for a cash account and lists it', async () => {
    const c = await setup();
    const rec = await start(c, '1379.5000');
    expect(rec.status).toBe('IN_PROGRESS');
    expect(rec.statementEndingAmount).toBe('1379.5000');
    expect((await listReconciliations(c.userId, c.companyId)).map((r) => r.id)).toEqual([rec.id]);
  });

  it('rejects a non-cash account, a second in-progress, and a date not after the last completed', async () => {
    const c = await setup();
    expect((await errOf(start(c, '0.00', '2026-06-30', c.salesId))).code).toBe('NOT_A_BANK_ACCOUNT');
    const first = await start(c, '0.00', '2026-06-30');
    expect((await errOf(start(c, '0.00', '2026-07-31'))).code).toBe('ALREADY_IN_PROGRESS');
    await completeReconciliation(c.userId, c.companyId, first.id); // nothing cleared, statement 0 → balanced
    // The same date as the last completed statement, or an earlier one, is refused by the
    // monotonic rule before the (account, statement_date) unique ever gets a say — that
    // unique is the structural backstop, not a reachable path from here.
    expect((await errOf(start(c, '0.00', '2026-06-30'))).code).toBe('STATEMENT_DATE_NOT_AFTER_LAST');
    expect((await errOf(start(c, '0.00', '2026-05-31'))).code).toBe('STATEMENT_DATE_NOT_AFTER_LAST');
    await expect(start(c, '0.00', '2026-07-31')).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });
});

describe('getReconciliation — the tick list and derived figures', () => {
  it('lists uncleared lines up to the statement date, flags imported ones, and derives the figures', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: new Uint8Array() }, canned);
    const lines = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: lines.map((l) => ({ lineId: l.id, action: 'post' as const, accountId: c.salesId })),
    });
    await post(c, '75.00', '2026-06-20'); // manual, not from import
    await post(c, '999.00', '2026-07-05'); // after the statement date — not a candidate

    const rec = await start(c, '1379.5000');
    const view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.lines.map((l) => [l.postingDate, l.amount, l.fromImport, l.cleared])).toEqual([
      ['2026-06-01', '1500.0000', true, false],
      ['2026-06-03', '-120.5000', true, false],
      ['2026-06-20', '75.0000', false, false],
    ]);
    expect(view.openingCleared).toBe('0.0000');
    expect(view.clearedHere).toBe('0.0000');
    expect(view.difference).toBe('1379.5000');
    expect(view.ledgerAsOf).toBe('1454.5000'); // 1500 − 120.50 + 75
  });

  it('returns null for an unknown or another company’s reconciliation', async () => {
    const c = await setup();
    const rec = await start(c, '0.00');
    const other = await setup();
    expect(await getReconciliation(other.userId, other.companyId, rec.id)).toBeNull();
    expect(await getReconciliation(c.userId, c.companyId, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('setCleared — replace the set, validate every line', () => {
  it('saves the ticked set, round-trips it, and replaces it on the next save', async () => {
    const c = await setup();
    const a = await bankLineOf(c, await post(c, '1500.00', '2026-06-01'));
    const b = await bankLineOf(c, await post(c, '-120.50', '2026-06-03'));
    const rec = await start(c, '1379.5000');

    expect(await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [a] })).toEqual({ cleared: 1 });
    let view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.lines.filter((l) => l.cleared).map((l) => l.journalLineId)).toEqual([a]);
    expect(view.clearedHere).toBe('1500.0000');
    expect(view.difference).toBe('-120.5000');

    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [a, b] });
    view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.clearedHere).toBe('1379.5000');
    expect(view.difference).toBe('0.0000');

    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [] }); // untick everything
    view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.lines.every((l) => !l.cleared)).toBe(true);
  });

  it('rejects another account’s line, a line after the statement date, a phantom id, and a line cleared elsewhere', async () => {
    const c = await setup();
    const mine = await bankLineOf(c, await post(c, '10.00', '2026-06-01'));
    const otherAccount = await bankLineOf(c, await post(c, '10.00', '2026-06-01', c.otherBankId), c.otherBankId);
    const late = await bankLineOf(c, await post(c, '10.00', '2026-07-01'));
    const rec = await start(c, '10.0000');

    for (const bad of [otherAccount, late, '00000000-0000-4000-8000-000000000000']) {
      expect((await errOf(setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [mine, bad] }))).code).toBe('LINE_INVALID');
    }
    // Nothing partial was saved by the failed attempts.
    expect((await getReconciliation(c.userId, c.companyId, rec.id))!.lines.every((l) => !l.cleared)).toBe(true);

    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [mine] });
    await completeReconciliation(c.userId, c.companyId, rec.id);
    const next = await start(c, '10.0000', '2026-07-31');
    expect((await errOf(setCleared(c.userId, c.companyId, next.id, { journalLineIds: [mine] }))).code).toBe('LINE_INVALID'); // cleared elsewhere
    expect((await errOf(setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [] }))).code).toBe('NOT_IN_PROGRESS');
  });

  it('a ledger line can be cleared at most once — structurally', async () => {
    const c = await setup();
    const line = await bankLineOf(c, await post(c, '10.00', '2026-06-01'));
    const rec = await start(c, '10.0000');
    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [line] });
    const db = await getTestDb();
    const reason: unknown = await db
      .execute(sql`insert into bank_reconciliation_lines (company_id, reconciliation_id, journal_line_id, bank_account_id) values (${c.companyId}, ${rec.id}, ${line}, ${c.bankId})`)
      .then(() => null, (e: unknown) => e);
    expect(String((reason as { cause?: unknown })?.cause ?? reason)).toMatch(/bank_reconciliation_lines_line_once_unique|duplicate key/i);
  });
});

describe('completeReconciliation', () => {
  it('refuses while the difference is not zero and completes with an audit trail when it is', async () => {
    const c = await setup();
    const a = await bankLineOf(c, await post(c, '1500.00', '2026-06-01'));
    const b = await bankLineOf(c, await post(c, '-120.50', '2026-06-03'));
    const rec = await start(c, '1379.5000');

    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [a] });
    const err = await errOf(completeReconciliation(c.userId, c.companyId, rec.id));
    expect(err.code).toBe('DIFFERENCE_NOT_ZERO');
    expect(err.message).toContain('-120.5000');
    expect((await getReconciliation(c.userId, c.companyId, rec.id))!.reconciliation.status).toBe('IN_PROGRESS');

    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [a, b] });
    const done = await completeReconciliation(c.userId, c.companyId, rec.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.completedBy).toBe(c.userId);
    expect(done.completedAt).not.toBeNull();

    const db = await getTestDb();
    const audit = await db.execute<{ action: string }>(sql`select action from audit_events where company_id = ${c.companyId} and entity_id = ${rec.id} order by created_at`);
    expect(audit.rows.map((r) => r.action)).toEqual(['RECONCILIATION_STARTED', 'RECONCILIATION_COMPLETED']);
    // Completed → the tick list is the cleared set only.
    const view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.lines.map((l) => l.cleared)).toEqual([true, true]);
  });

  it('opening cleared carries into the next statement, so only new movements need ticking', async () => {
    const c = await setup();
    const a = await bankLineOf(c, await post(c, '1500.00', '2026-06-01'));
    const june = await start(c, '1500.0000', '2026-06-30');
    await setCleared(c.userId, c.companyId, june.id, { journalLineIds: [a] });
    await completeReconciliation(c.userId, c.companyId, june.id);

    const b = await bankLineOf(c, await post(c, '-200.00', '2026-07-10'));
    const july = await start(c, '1300.0000', '2026-07-31');
    let view = (await getReconciliation(c.userId, c.companyId, july.id))!;
    expect(view.openingCleared).toBe('1500.0000');
    expect(view.lines.map((l) => l.journalLineId)).toEqual([b]); // a is cleared already — not offered again
    expect(view.difference).toBe('-200.0000');
    await setCleared(c.userId, c.companyId, july.id, { journalLineIds: [b] });
    view = (await getReconciliation(c.userId, c.companyId, july.id))!;
    expect(view.difference).toBe('0.0000');
    await expect(completeReconciliation(c.userId, c.companyId, july.id)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('a reversal after clearing surfaces as a new candidate, not as a change to the cleared line', async () => {
    const c = await setup();
    const entryId = await post(c, '1500.00', '2026-06-01');
    const a = await bankLineOf(c, entryId);
    const june = await start(c, '1500.0000', '2026-06-30');
    await setCleared(c.userId, c.companyId, june.id, { journalLineIds: [a] });
    await completeReconciliation(c.userId, c.companyId, june.id);

    await reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: c.companyId, actorUserId: c.userId, entryId, reversalDate: '2026-07-02' }));
    const july = await start(c, '1500.0000', '2026-07-31');
    const view = (await getReconciliation(c.userId, c.companyId, july.id))!;
    expect(view.openingCleared).toBe('1500.0000'); // the cleared line stays cleared
    expect(view.lines.map((l) => [l.postingDate, l.amount, l.cleared])).toEqual([['2026-07-02', '-1500.0000', false]]);
    expect(view.difference).toBe('0.0000'); // bank never reversed it → the statement still says 1500; ticking the reversal would break agreement
  });
});

describe('updateReconciliation', () => {
  it('corrects the statement figure/date while in progress; refuses when cleared lines would fall after the new date', async () => {
    const c = await setup();
    const a = await bankLineOf(c, await post(c, '10.00', '2026-06-15'));
    const rec = await start(c, '99.0000', '2026-06-30');
    await updateReconciliation(c.userId, c.companyId, rec.id, { statementEndingAmount: '10.0000' });
    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [a] });
    expect((await errOf(updateReconciliation(c.userId, c.companyId, rec.id, { statementDate: '2026-06-10' }))).code).toBe('LINE_INVALID');
    await updateReconciliation(c.userId, c.companyId, rec.id, { statementDate: '2026-06-20' });
    await expect(completeReconciliation(c.userId, c.companyId, rec.id)).resolves.toMatchObject({ status: 'COMPLETED', statementDate: '2026-06-20' });
    expect((await errOf(updateReconciliation(c.userId, c.companyId, rec.id, { statementEndingAmount: '1.00' }))).code).toBe('NOT_IN_PROGRESS');
  });
});

describe('authorization', () => {
  it('a READ_ONLY member can read but not reconcile; a BOOKKEEPER can reconcile; a non-member gets nothing', async () => {
    const c = await setup();
    const line = await bankLineOf(c, await post(c, '10.00', '2026-06-01'));
    const viewer = await makeUser();
    await insertMembership(c.companyId, viewer, 'READ_ONLY');
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const outsider = await makeUser();

    await expect(start({ ...c, userId: viewer }, '10.0000')).rejects.toThrow();
    const rec = await start({ ...c, userId: bookkeeper }, '10.0000');
    expect((await getReconciliation(viewer, c.companyId, rec.id))!.reconciliation.id).toBe(rec.id);
    await expect(setCleared(viewer, c.companyId, rec.id, { journalLineIds: [line] })).rejects.toThrow();
    await setCleared(bookkeeper, c.companyId, rec.id, { journalLineIds: [line] });
    await expect(completeReconciliation(viewer, c.companyId, rec.id)).rejects.toThrow();
    await expect(completeReconciliation(bookkeeper, c.companyId, rec.id)).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(getReconciliation(outsider, c.companyId, rec.id)).rejects.toThrow();
  });
});

describe('credit-card reconciliation (LL-081)', () => {
  /** A card charge: Dr expense / Cr card. A card payment: Dr card / Cr bank. */
  async function cardSetup(c: Ctx): Promise<{ cardId: string; expenseId: string; plainLiabilityId: string }> {
    const card = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card' }));
    const expense = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Travel', accountType: 'EXPENSE' }));
    const plain = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Loan', accountType: 'LIABILITY' }));
    return { cardId: card.id, expenseId: expense.id, plainLiabilityId: plain.id };
  }

  it('reconciles a card statement: charges positive, payments negative, balance owed completes at zero', async () => {
    const c = await setup();
    const { cardId, expenseId } = await cardSetup(c);
    const charge = await postJournalEntry(postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-06-05', sourceType: 'JOURNAL_ENTRY',
      lines: [{ accountId: expenseId, debit: '500.00' }, { accountId: cardId, credit: '500.00' }],
    }));
    const payment = await postJournalEntry(postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-06-20', sourceType: 'JOURNAL_ENTRY',
      lines: [{ accountId: cardId, debit: '150.00' }, { accountId: c.bankId, credit: '150.00' }],
    }));
    const chargeLine = await bankLineOf(c, charge.entry.id, cardId);
    const paymentLine = await bankLineOf(c, payment.entry.id, cardId);

    const rec = await start(c, '350.0000', '2026-06-30', cardId); // the card says: you owe 350
    let view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.lines.map((l) => [l.postingDate, l.amount])).toEqual([['2026-06-05', '500.0000'], ['2026-06-20', '-150.0000']]);
    expect(view.ledgerAsOf).toBe('350.0000');
    expect(view.difference).toBe('350.0000');

    await setCleared(c.userId, c.companyId, rec.id, { journalLineIds: [chargeLine, paymentLine] });
    view = (await getReconciliation(c.userId, c.companyId, rec.id))!;
    expect(view.clearedHere).toBe('350.0000');
    expect(view.difference).toBe('0.0000');
    await expect(completeReconciliation(c.userId, c.companyId, rec.id)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('refuses a liability that is not a credit card', async () => {
    const c = await setup();
    const { plainLiabilityId } = await cardSetup(c);
    expect((await errOf(start(c, '0.00', '2026-06-30', plainLiabilityId))).code).toBe('NOT_A_BANK_ACCOUNT');
  });
});

