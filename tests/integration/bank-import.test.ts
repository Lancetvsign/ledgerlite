/**
 * Bank-statement import — LL-076a. Against a real DB, with the extractor INJECTED (no
 * external model). Proves the pipeline: extracted rows are validated and staged with a
 * suggested account (extractor category → chart, else history), reviewed decisions post
 * categorised entries through the ledger once each, and control accounts are excluded.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { BankImportError, getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { notConfiguredExtractor, type TransactionExtractor } from '@/server/bank-import/extract';
import { createCompanyWithOwner } from '@/server/companies';
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  bankId: string;
  salesId: string;
  suppliesId: string;
  rentId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `bi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'B' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'BI Co', timezone: 'America/Chicago' }), 'standard');
  const bank = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Operating Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Consulting Sales', accountType: 'REVENUE' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies Expense', accountType: 'EXPENSE' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent Expense', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, bankId: bank.id, salesId: sales.id, suppliesId: supplies.id, rentId: rent.id };
}

const fixed = (rows: { date: string; description: string; amount: string; category?: string }[]): TransactionExtractor =>
  () => Promise.resolve(rows);

/** The injected extractors ignore the bytes; the pipeline never needs a real PDF here. */
const EMPTY = new Uint8Array();

/** A typical little statement: one deposit (in), two payments (out). */
const STATEMENT = fixed([
  { date: '2026-06-01', description: 'DEPOSIT ACME', amount: '1500.00', category: 'Consulting Sales' },
  { date: '2026-06-03', description: 'OFFICE DEPOT', amount: '-120.50', category: 'Supplies Expense' },
  { date: '2026-06-05', description: 'MONTHLY RENT', amount: '-2000.00' }, // no category → history/none
]);

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`)).rows[0]!.id;
}

async function balance(c: Ctx, accountId: string): Promise<string> {
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  return Number((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId} and source_type = 'BANK_IMPORT' and status = 'POSTED'`)).rows[0]?.n ?? '0');
}

const errOf = async (p: Promise<unknown>): Promise<BankImportError> => {
  try {
    await p;
    throw new Error('expected BankImportError');
  } catch (e) {
    expect(e).toBeInstanceOf(BankImportError);
    return e as BankImportError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('stageImport — validates and stages with suggestions', () => {
  it('stages every extracted row, mapping the extractor category to a chart account', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'june.pdf', fileBytes: EMPTY }, STATEMENT);
    const view = await getImportBatch(c.userId, c.companyId, batch.id);
    expect(view).not.toBeNull();
    expect(view!.lines).toHaveLength(3);
    expect(view!.lines.every((l) => l.status === 'STAGED')).toBe(true);
    expect(view!.lines[0]?.suggestedAccountId).toBe(c.salesId); // 'Consulting Sales' mapped by name
    expect(view!.lines[1]?.suggestedAccountId).toBe(c.suppliesId);
    expect(view!.lines[2]?.suggestedAccountId).toBeNull(); // no category, no history yet
    expect(view!.lines[0]?.amount).toBe('1500.0000');
    expect(view!.lines[1]?.amount).toBe('-120.5000');
  });

  it('falls back to history: the account confirmed before for the same description', async () => {
    const c = await setup();
    const first = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const v1 = await getImportBatch(c.userId, c.companyId, first.id);
    const rentLine = v1!.lines[2]!;
    await postImportLines(c.userId, c.companyId, first.id, { decisions: [{ lineId: rentLine.id, action: 'post', accountId: c.rentId }] });

    // A later statement with the same description (still no category) is suggested Rent.
    const second = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-07-05', description: 'MONTHLY RENT', amount: '-2000.00' },
    ]));
    const v2 = await getImportBatch(c.userId, c.companyId, second.id);
    expect(v2!.lines[0]?.suggestedAccountId).toBe(c.rentId);
  });

  it('rejects a malformed extracted row rather than staging a partial batch', async () => {
    const c = await setup();
    const bad = fixed([{ date: '2026-06-01', description: 'X', amount: '12.34567' }]); // 5 decimals
    const err = await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, bad));
    expect(err.code).toBe('EXTRACTION_FAILED');
    const zero = fixed([{ date: '2026-06-01', description: 'X', amount: '0.00' }]);
    expect((await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, zero))).code).toBe('EXTRACTION_FAILED');
  });

  it('rejects a bank account that is not an active cash asset', async () => {
    const c = await setup();
    const err = await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.salesId, fileBytes: EMPTY }, STATEMENT));
    expect(err.code).toBe('INVALID_BANK_ACCOUNT');
  });

  it('reports not-configured when no extractor is wired (the production default until LL-076b)', async () => {
    const c = await setup();
    const err = await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, notConfiguredExtractor));
    expect(err.code).toBe('EXTRACTION_NOT_CONFIGURED');
  });
});

describe('postImportLines — categorised entries through the ledger, once each', () => {
  it('posts money-in as Dr bank / Cr category and money-out as Cr bank / Dr category', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const view = await getImportBatch(c.userId, c.companyId, batch.id);
    const [dep, supplies, rent] = view!.lines;

    const result = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: dep!.id, action: 'post', accountId: c.salesId },
        { lineId: supplies!.id, action: 'post', accountId: c.suppliesId },
        { lineId: rent!.id, action: 'ignore' },
      ],
    });
    expect(result).toEqual({ posted: 2, ignored: 1 });

    // Bank (asset, debit-natural): +1500 − 120.50 = 1379.50. Sales credited 1500; supplies debited 120.50.
    expect(await balance(c, c.bankId)).toBe('1379.5000');
    expect(await balance(c, c.salesId)).toBe('1500.0000');
    expect(await balance(c, c.suppliesId)).toBe('120.5000');
    expect(await balance(c, c.rentId)).toBe('0.0000'); // ignored

    const after = await getImportBatch(c.userId, c.companyId, batch.id);
    expect(after!.lines.map((l) => l.status)).toEqual(['POSTED', 'POSTED', 'IGNORED']);
    expect(after!.lines[0]?.journalEntryId).not.toBeNull();
    expect(after!.lines[0]?.chosenAccountId).toBe(c.salesId);
  });

  it('is post-once: re-submitting a posted line is a no-op', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const line = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.salesId }] });
    const again = await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.suppliesId }] });
    expect(again.posted).toBe(0);
    expect(await entryCount(c.companyId)).toBe(1);
    expect(await balance(c, c.salesId)).toBe('1500.0000'); // the original stands; not re-categorised
  });

  it('rejects a control account, the OBE account, and the bank account itself', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const line = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    for (const bad of [await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE'), await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE'), await sysAccount(c.companyId, 'OPENING_BALANCE_EQUITY'), c.bankId]) {
      const err = await errOf(postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: bad }] }));
      expect(err.code).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');
    }
    expect(await entryCount(c.companyId)).toBe(0);
  });

  it('requires an account to post, and rejects a closed period before posting anything', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const [dep, supplies] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep!.id, action: 'post' }] }))).code).toBe('ACCOUNT_REQUIRED');

    const period = await getAccountingPeriod(c.companyId, '2026-06-03');
    await closePeriod(c.userId, c.companyId, period.id);
    await expect(
      postImportLines(c.userId, c.companyId, batch.id, {
        decisions: [
          { lineId: dep!.id, action: 'post', accountId: c.salesId },
          { lineId: supplies!.id, action: 'post', accountId: c.suppliesId },
        ],
      }),
    ).rejects.toThrow(/closed/i);
    expect(await entryCount(c.companyId)).toBe(0); // validated up front — nothing posted
  });

  it('flags a re-imported transaction as a possible duplicate', async () => {
    const c = await setup();
    const one = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const line = (await getImportBatch(c.userId, c.companyId, one.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, one.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.salesId }] });

    const two = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const v2 = await getImportBatch(c.userId, c.companyId, two.id);
    expect(v2!.lines[0]?.isDuplicate).toBe(true); // same deposit already posted
    expect(v2!.lines[1]?.isDuplicate).toBe(false); // supplies was never posted
  });

  it('denies a non-member', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(stageImport(outsider, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT)).rejects.toThrow();
  });
});
