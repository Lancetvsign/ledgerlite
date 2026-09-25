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
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { amendImportLine, getImportBatch, listImportBatches, postImportLines, stageImport } from '@/server/bank-import';
import { type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { truncateAll } from '../helpers/database';

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
    expect(view.verification.checks.map((k) => [k.name, k.ok])).toEqual([['credits', true], ['debits', true], ['ending_balance', true]]);
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
