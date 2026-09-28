/**
 * Statement totals verification — LL-109. Against a real DB, extractor injected.
 *
 * Proves: the statement's printed figures are stored with the batch and the lines verify
 * against them; a misread amount is a mismatch on exactly the right checks with the exact
 * differences; correcting it (LL-107) or ignoring a bogus subtotal line (LL-089) verifies
 * again — the verdict is derived, never stored; a statement without figures is "not stated";
 * a malformed summary is dropped, not a reason to reject the rows; the batch list carries the
 * verdict; the re-analysis count is stored.
 */
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { schema } from '@/db';
import { getAuth } from '@/lib/auth';
import { errorChainText } from '@/lib/error-chain';
import { listAccounts } from '@/server/accounts';
import { amendImportLine, amendStatementSummary, BankImportError, getImportBatch, listImportBatches, postImportLines, stageImport } from '@/server/bank-import';
import { MODEL_FAILURE_CODES, type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { amendStatementSummaryInput } from '@/validation/bank-import';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

const EMPTY = new Uint8Array();
type Row = { date: string; description: string; amount: string };
const ROWS: Row[] = [
  { date: '2026-06-01', description: 'DEPOSIT', amount: '1500.00' },
  { date: '2026-06-02', description: 'OFFICE DEPOT', amount: '-120.50' },
  { date: '2026-06-03', description: 'RENT', amount: '-2000.00' },
];
const SUMMARY = { beginningBalance: '5000.00', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '4379.50' };
const withSummary = (rows: Row[], summary: Record<string, string> | undefined, attempts?: number): TransactionExtractor => () =>
  Promise.resolve({ transactions: rows, ...(summary === undefined ? {} : { summary }), ...(attempts === undefined ? {} : { attempts }) });

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `vf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'V' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
interface Ctx { owner: string; companyId: string; bankId: string; expenseId: string }
async function setup(): Promise<Ctx> {
  const owner = await makeUser();
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Verify Co', timezone: 'America/Chicago' }), 'standard');
  const accounts = await listAccounts(owner, company.id);
  return { owner, companyId: company.id, bankId: accounts.find((a) => a.accountNumber === '1000')!.id, expenseId: accounts.find((a) => a.accountType === 'EXPENSE')!.id };
}
async function stage(c: Ctx, extractor: TransactionExtractor) {
  const batch = await stageImport(c.owner, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, extractor);
  return (await getImportBatch(c.owner, c.companyId, batch.id))!;
}

beforeEach(async () => {
  await truncateAll();
});

describe('statement totals (LL-109)', () => {
  it('stores the printed figures and verifies the lines against them; the batch list carries the verdict', async () => {
    const c = await setup();
    const view = await stage(c, withSummary(ROWS, SUMMARY, 2));
    expect(view.batch).toMatchObject({ statedBeginningBalance: '5000.0000', statedTotalCredits: '1500.0000', statedTotalDebits: '2120.5000', statedEndingBalance: '4379.5000', extractionAttempts: 2 });
    expect(view.verification.status).toBe('verified');
    expect(view.verification.checks.map((k) => [k.name, k.ok])).toEqual([['statement_math', true], ['credits', true], ['debits', true], ['ending_balance', true]]); // LL-123: the statement's own math first
    expect((await listImportBatches(c.owner, c.companyId))[0]).toMatchObject({ id: view.batch.id, verificationStatus: 'verified', extractionAttempts: 2 });
  });

  it('a misread amount is a mismatch on the right checks with the exact differences; correcting it verifies again', async () => {
    const c = await setup();
    // The rent misread as −200: debits short by 1,800, so the ending balance is 1,800 too high.
    const view = await stage(c, withSummary([ROWS[0]!, ROWS[1]!, { ...ROWS[2]!, amount: '-200.00' }], SUMMARY));
    expect(view.verification.status).toBe('mismatch');
    expect(view.verification.checks.find((k) => k.name === 'credits')).toMatchObject({ ok: true });
    expect(view.verification.checks.find((k) => k.name === 'debits')).toMatchObject({ ok: false, expected: '2120.5000', actual: '320.5000', difference: '-1800.0000' });
    expect(view.verification.checks.find((k) => k.name === 'ending_balance')).toMatchObject({ ok: false, expected: '4379.5000', actual: '6179.5000', difference: '1800.0000' });
    expect((await listImportBatches(c.owner, c.companyId))[0]!.verificationStatus).toBe('mismatch');

    await amendImportLine(c.owner, c.companyId, view.batch.id, view.lines[2]!.id, { amount: '-2000.00' });
    const fixed = (await getImportBatch(c.owner, c.companyId, view.batch.id))!;
    expect(fixed.verification.status).toBe('verified');
    expect((await listImportBatches(c.owner, c.companyId))[0]!.verificationStatus).toBe('verified');
  });

  it('ignoring a line that was never a transaction (a subtotal the reader picked up) verifies again; a posted line still counts', async () => {
    const c = await setup();
    const view = await stage(c, withSummary([...ROWS, { date: '2026-06-30', description: 'TOTAL WITHDRAWALS', amount: '-2120.50' }], SUMMARY));
    expect(view.verification.status).toBe('mismatch');
    expect(view.verification.checks.find((k) => k.name === 'debits')).toMatchObject({ actual: '4241.0000' });
    await postImportLines(c.owner, c.companyId, view.batch.id, { decisions: [
      { lineId: view.lines[3]!.id, action: 'ignore' },
      { lineId: view.lines[0]!.id, action: 'post', accountId: c.expenseId },
    ] });
    const after = (await getImportBatch(c.owner, c.companyId, view.batch.id))!;
    expect(after.verification.status).toBe('verified'); // the ignored line is out; the posted one still counts
    expect(after.verification.lineCredits).toBe('1500.0000');
    expect((await listImportBatches(c.owner, c.companyId))[0]!.verificationStatus).toBe('verified');
  });

  it('a statement without printed figures is "not stated"; a malformed summary is dropped, not a reason to reject the rows', async () => {
    const c = await setup();
    const plain = await stage(c, () => Promise.resolve(ROWS)); // the rows-only extractor shape every older test uses
    expect(plain.verification).toMatchObject({ status: 'not_stated', checks: [], lineCredits: '1500.0000', lineDebits: '2120.5000' });
    expect(plain.batch.statedTotalCredits).toBeNull();
    expect(plain.batch.extractionAttempts).toBe(1);

    const junk = await stage(c, withSummary(ROWS, { totalCredits: 'lots', endingBalance: '4379.50' }));
    expect(junk.verification.status).toBe('not_stated');
    expect(junk.batch.statedEndingBalance).toBeNull();
    expect(junk.lines).toHaveLength(3);
    expect((await listImportBatches(c.owner, c.companyId)).map((b) => b.verificationStatus)).toEqual(['not_stated', 'not_stated']);
  });
});

describe('a re-check that could not run (LL-118)', () => {
  const MISMATCHED: Row[] = [ROWS[0]!, ROWS[1]!]; // the rent line dropped: debits and ending disagree
  const failed = (reanalysisFailure: unknown): TransactionExtractor => () =>
    Promise.resolve({ transactions: MISMATCHED, summary: SUMMARY, attempts: 1, reanalysisFailure } as never);

  it('stores why the re-check failed; a statement whose re-check ran or was not needed stores nothing', async () => {
    const c = await setup();
    const view = await stage(c, failed('EXTRACTION_RATE_LIMITED'));
    expect(view.batch).toMatchObject({ reanalysisFailure: 'EXTRACTION_RATE_LIMITED', extractionAttempts: 1 });
    expect(view.verification.status).toBe('mismatch');
    expect((await stage(c, withSummary(ROWS, SUMMARY, 2))).batch.reanalysisFailure).toBeNull();
    expect((await stage(c, withSummary(ROWS, SUMMARY))).batch.reanalysisFailure).toBeNull();
  });

  it('an unknown value is never stored, and the database refuses one written directly', async () => {
    const c = await setup();
    expect((await stage(c, failed('SOMETHING_ELSE'))).batch.reanalysisFailure).toBeNull();
    expect((await stage(c, failed(42))).batch.reanalysisFailure).toBeNull();
    const db = await getTestDb();
    const refused = await db.execute(sql`update bank_import_batches set reanalysis_failure = 'NOPE' where company_id = ${c.companyId}`).then(() => 'OK', (e: unknown) => errorChainText(e));
    expect(refused).toMatch(/bank_import_batches_reanalysis_failure_known/);
    // The CHECK and the application's list agree: every code the extractor can record is accepted.
    for (const code of MODEL_FAILURE_CODES) {
      await db.execute(sql`update bank_import_batches set reanalysis_failure = ${code} where company_id = ${c.companyId}`);
    }
  });
});

describe('summary figures read by their labels, and corrected by the reviewer (LL-123)', () => {
  const FIGURES = [
    { label: 'Beginning Balance', amount: '5000.00', role: 'beginning', source: 'label', found: true },
    { label: 'Total Deposits', amount: '1500.00', role: 'money_in', source: 'label', found: true },
    { label: 'Total Withdrawals', amount: '2120.50', role: 'money_out', source: 'label', found: true },
    { label: 'Ending Balance', amount: '4379.50', role: 'ending', source: 'label', found: true },
  ] as const;
  const withFigures = (figures: unknown): TransactionExtractor => () =>
    Promise.resolve({ transactions: ROWS, summary: SUMMARY, figures } as never);
  const audits = async (companyId: string) => {
    const db = await getTestDb();
    return await db.select({ before: schema.auditEvents.beforeJson, after: schema.auditEvents.afterJson }).from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.companyId, companyId), eq(schema.auditEvents.action, 'BANK_IMPORT_SUMMARY_AMENDED')));
  };

  it('stores the figures as read; a malformed list is not stored', async () => {
    const c = await setup();
    expect((await stage(c, withFigures(FIGURES))).batch.statedFigures).toEqual(FIGURES);
    expect((await stage(c, withFigures([{ label: 'x', amount: 1 }]))).batch.statedFigures).toBeNull();
    expect((await stage(c, withSummary(ROWS, SUMMARY))).batch.statedFigures).toBeNull();
  });

  it('a correction changes the four totals, keeps what was read, audits, and the checks follow', async () => {
    const c = await setup();
    // Figures stored in the wrong slots (the beginning and ending balances swapped): the statement math is off.
    // (Not every swap breaks it — beginning↔money in or money out↔ending preserve the equation — which is why
    // LL-123 decides the slots from the printed labels; this check is the second line of defence.)
    const view = await stage(c, withSummary(ROWS, { beginningBalance: '4379.50', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '5000.00' }));
    expect(view.verification.checks[0]).toMatchObject({ name: 'statement_math', ok: false });
    const fix = amendStatementSummaryInput.parse({ beginningBalance: '5000.00', totalCredits: '1500.00', totalDebits: '2120.50', endingBalance: '4379.50' });
    expect(await amendStatementSummary(c.owner, c.companyId, view.batch.id, fix)).toEqual({ amended: true });
    const after = (await getImportBatch(c.owner, c.companyId, view.batch.id))!;
    expect(after.batch).toMatchObject({ statedBeginningBalance: '5000.0000', statedTotalCredits: '1500.0000', statedTotalDebits: '2120.5000', statedEndingBalance: '4379.5000' });
    expect(after.batch.summaryAmendedFrom).toEqual({ statedBeginningBalance: '4379.5000', statedTotalCredits: '1500.0000', statedTotalDebits: '2120.5000', statedEndingBalance: '5000.0000' });
    expect(after.verification.status).toBe('verified');
    // The same figures again: nothing changes, nothing is audited; a second correction keeps the first reading.
    expect(await amendStatementSummary(c.owner, c.companyId, view.batch.id, fix)).toEqual({ amended: false });
    await amendStatementSummary(c.owner, c.companyId, view.batch.id, { ...fix, endingBalance: '4379.51' });
    const again = (await getImportBatch(c.owner, c.companyId, view.batch.id))!;
    expect(again.batch.summaryAmendedFrom).toEqual(after.batch.summaryAmendedFrom);
    expect(again.verification.status).toBe('mismatch');
    const rows = await audits(c.companyId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.before).toMatchObject({ statedBeginningBalance: '4379.5000' });
  });

  it('a card\'s balances are entered as printed and stored as owed (negative); another batch reads as not found', async () => {
    const c = await setup();
    const db = await getTestDb();
    const cardId = (await db.execute<{ id: string }>(sql`select id::text as id from accounts where company_id = ${c.companyId} and account_number = '2100'`)).rows[0]!.id;
    const batch = await stageImport(c.owner, c.companyId, { bankAccountId: cardId, fileBytes: EMPTY }, () => Promise.resolve([{ date: '2026-06-02', description: 'SHOP', amount: '-45.00' }]));
    await amendStatementSummary(c.owner, c.companyId, batch.id, amendStatementSummaryInput.parse({ beginningBalance: '100.00', totalCredits: '100.00', totalDebits: '45.00', endingBalance: '45.00' }));
    const view = (await getImportBatch(c.owner, c.companyId, batch.id))!;
    expect(view.batch).toMatchObject({ statedBeginningBalance: '-100.0000', statedEndingBalance: '-45.0000' });
    // Owed 100, paid 100, charged 45: −100 + 100 − 45 = −45, the ending balance owed — the statement math ties.
    expect(view.verification.checks.find((k) => k.name === 'statement_math')?.ok).toBe(true);
    const other = await setup();
    await expect(amendStatementSummary(other.owner, other.companyId, batch.id, amendStatementSummaryInput.parse({ beginningBalance: '1', totalCredits: '1', totalDebits: '1', endingBalance: '1' }))).rejects.toBeInstanceOf(BankImportError);
  });
});
