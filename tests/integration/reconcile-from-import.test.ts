/**
 * Reconcile from an imported statement — LL-111 (ADR-036 amendment). Against a real DB, extractor
 * injected.
 *
 * Proves: the defaults come from what the statement printed — a bank's ending as printed, a
 * card's negated into the reconciliation's convention, the printed date or else the latest line
 * (flagged); a foreign batch reads as nothing; starting and ticking clears exactly the statement's
 * posted lines on the account and the difference is zero; a matched line's entry line is ticked;
 * staged and ignored lines never are; a line dated after the statement date, or cleared by an
 * earlier reconciliation, is skipped and counted; another account's statement and a completed
 * reconciliation are refused; an unreadable printed date drops only the date, never the totals.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { clearImportedLines, completeReconciliation, getReconciliation, ReconciliationError, reconciliationDefaultsFromImport, startReconciliation } from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
type Row = { date: string; description: string; amount: string };
const statement = (rows: Row[], summary?: Record<string, string>): TransactionExtractor => () =>
  Promise.resolve(summary === undefined ? rows : { transactions: rows, summary });
const BANK_ROWS: Row[] = [
  { date: '2026-06-01', description: 'DEPOSIT', amount: '1500.00' },
  { date: '2026-06-03', description: 'OFFICE DEPOT', amount: '-120.50' },
  { date: '2026-06-05', description: 'RENT', amount: '-2000.00' },
];
const BANK_SUMMARY = { beginningBalance: '0.00', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '-620.50', statementDate: '2026-06-30' };

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `rf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'R' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
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
interface Ctx { owner: string; companyId: string; bankId: string; cardId: string; expenseId: string; revenueId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Reconcile Co', timezone: 'America/Chicago' }), 'standard');
  const accounts = await listAccounts(owner, company.id);
  return {
    owner,
    companyId: company.id,
    bankId: accounts.find((a) => a.accountNumber === '1000')!.id,
    cardId: accounts.find((a) => a.accountNumber === '2100')!.id,
    expenseId: accounts.find((a) => a.accountType === 'EXPENSE')!.id,
    revenueId: accounts.find((a) => a.accountType === 'REVENUE')!.id,
  };
}
async function stage(c: Ctx, accountId: string, extractor: TransactionExtractor) {
  const batch = await stageImport(c.owner, c.companyId, { bankAccountId: accountId, fileBytes: EMPTY, filename: 'june.pdf' }, extractor);
  return { batchId: batch.id, lines: (await getImportBatch(c.owner, c.companyId, batch.id))!.lines };
}
async function postAll(c: Ctx, batchId: string, lines: readonly { id: string; amount: string }[], skip: readonly number[] = []) {
  await postImportLines(c.owner, c.companyId, batchId, {
    decisions: lines.map((l, i) => (skip.includes(i) ? { lineId: l.id, action: 'ignore' as const } : { lineId: l.id, action: 'post' as const, accountId: l.amount.startsWith('-') ? c.expenseId : c.revenueId })),
  });
}

beforeEach(async () => {
  await truncateAll();
});

describe('defaults from what the statement printed', () => {
  it('a bank statement: printed date and ending as printed; a foreign batch reads as nothing', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, statement(BANK_ROWS, BANK_SUMMARY));
    await postAll(c, batchId, lines);
    expect(await reconciliationDefaultsFromImport(c.owner, c.companyId, batchId)).toMatchObject({
      batchId, filename: 'june.pdf', bankAccountId: c.bankId, statementDate: '2026-06-30', statementDateSource: 'printed', statementEndingAmount: '-620.5000', decidedLines: 3,
    });
    const other = await setup();
    expect(await reconciliationDefaultsFromImport(other.owner, other.companyId, batchId)).toBeNull();
  });

  it('a card statement: the ending is negated into the reconciliation\'s convention; no printed date → the latest line, flagged', async () => {
    const c = await setup();
    // Card: charges −120.50, −45.00; payment +2000 → 1834.50 paid ahead (import convention), no printed date.
    const { batchId } = await stage(c, c.cardId, statement(
      [{ date: '2026-06-02', description: 'OFFICE DEPOT', amount: '-120.50' }, { date: '2026-06-04', description: 'SHELL', amount: '-45.00' }, { date: '2026-06-05', description: 'PAYMENT', amount: '2000.00' }],
      { beginningBalance: '0.00', totalCredits: '2000.00', totalDebits: '165.50', endingBalance: '1834.50' },
    ));
    expect(await reconciliationDefaultsFromImport(c.owner, c.companyId, batchId)).toMatchObject({
      statementDate: '2026-06-05', statementDateSource: 'latest_line', statementEndingAmount: '-1834.5000', decidedLines: 0,
    });
  });

  it('an unreadable printed date drops only the date — the totals are kept', async () => {
    const c = await setup();
    const { batchId } = await stage(c, c.bankId, statement(BANK_ROWS, { ...BANK_SUMMARY, statementDate: 'end of June' }));
    const view = (await getImportBatch(c.owner, c.companyId, batchId))!;
    expect(view.batch.statedStatementDate).toBeNull();
    expect(view.batch.statedEndingBalance).toBe('-620.5000');
    expect(view.verification.status).toBe('verified');
  });
});

describe('start and tick the statement\'s lines', () => {
  it('ticks exactly the posted lines on the account — never staged or ignored ones — and the difference is zero; completion succeeds', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, statement(BANK_ROWS, BANK_SUMMARY));
    await postAll(c, batchId, lines, [2]); // rent ignored
    const rec = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '1379.50' });
    expect(await clearImportedLines(c.owner, c.companyId, rec.id, batchId)).toEqual({ cleared: 2, skipped: 0 });
    const view = (await getReconciliation(c.owner, c.companyId, rec.id))!;
    expect(view.lines.filter((l) => l.cleared)).toHaveLength(2);
    expect(view.difference).toBe('0.0000');
    // A second call adds nothing and keeps what is ticked.
    expect(await clearImportedLines(c.owner, c.companyId, rec.id, batchId)).toEqual({ cleared: 0, skipped: 0 });
    expect((await getReconciliation(c.owner, c.companyId, rec.id))!.lines.filter((l) => l.cleared)).toHaveLength(2);
    await completeReconciliation(c.owner, c.companyId, rec.id);
  });

  it('a card payment matched to the bank\'s posting ticks the entry line on the card', async () => {
    const c = await setup();
    const bank = await stage(c, c.bankId, statement([{ date: '2026-06-03', description: 'PAY VISA', amount: '-2000.00' }]));
    await postImportLines(c.owner, c.companyId, bank.batchId, { decisions: [{ lineId: bank.lines[0]!.id, action: 'post', accountId: c.cardId }] });
    const card = await stage(c, c.cardId, statement([{ date: '2026-06-04', description: 'PAYMENT', amount: '2000.00' }]));
    await postImportLines(c.owner, c.companyId, card.batchId, { decisions: [{ lineId: card.lines[0]!.id, action: 'match_transfer', counterpartLineId: card.lines[0]!.transferCandidate!.lineId }] });
    // The card's reconciliation (charges positive): a 2,000 payment is −2,000.
    const rec = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.cardId, statementDate: '2026-06-30', statementEndingAmount: '-2000.00' });
    expect(await clearImportedLines(c.owner, c.companyId, rec.id, card.batchId)).toEqual({ cleared: 1, skipped: 0 });
    expect((await getReconciliation(c.owner, c.companyId, rec.id))!.difference).toBe('0.0000');
  });

  it('skips a line dated after the statement date and one cleared by an earlier reconciliation', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, statement(BANK_ROWS, BANK_SUMMARY));
    await postAll(c, batchId, lines);
    // May's reconciliation clears the deposit first… (dated 06-01, so it needs a June statement date)
    const first = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-02', statementEndingAmount: '1500.00' });
    expect(await clearImportedLines(c.owner, c.companyId, first.id, batchId)).toEqual({ cleared: 1, skipped: 2 }); // 06-03 and 06-05 are after 06-02
    await completeReconciliation(c.owner, c.companyId, first.id);
    const second = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '-620.50' });
    expect(await clearImportedLines(c.owner, c.companyId, second.id, batchId)).toEqual({ cleared: 2, skipped: 1 }); // the deposit is already cleared
    expect((await getReconciliation(c.owner, c.companyId, second.id))!.difference).toBe('0.0000');
  });

  it('refuses another account\'s statement and a completed reconciliation', async () => {
    const c = await setup();
    const { batchId, lines } = await stage(c, c.bankId, statement(BANK_ROWS, BANK_SUMMARY));
    await postAll(c, batchId, lines);
    const cardRec = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.cardId, statementDate: '2026-06-30', statementEndingAmount: '0.00' });
    expect(await codeOf(clearImportedLines(c.owner, c.companyId, cardRec.id, batchId), ReconciliationError)).toBe('IMPORT_NOT_FOR_ACCOUNT');
    const rec = await startReconciliation(c.owner, c.companyId, { bankAccountId: c.bankId, statementDate: '2026-06-30', statementEndingAmount: '-620.50' });
    await clearImportedLines(c.owner, c.companyId, rec.id, batchId);
    await completeReconciliation(c.owner, c.companyId, rec.id);
    expect(await codeOf(clearImportedLines(c.owner, c.companyId, rec.id, batchId), ReconciliationError)).toBe('NOT_IN_PROGRESS');
  });
});
