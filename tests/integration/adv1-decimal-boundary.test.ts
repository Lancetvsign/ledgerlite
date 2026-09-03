/**
 * LL-036 ADVERSARIAL — decimal precision, boundary values, malformed money.
 *
 * Attacks the balance invariant through the money boundary: negative zero,
 * leading/trailing zeros, huge magnitudes at the NUMERIC(19,4) edge, sums that
 * overflow the trigger's NUMERIC(19,4) accumulator, scientific notation, too many
 * decimals. Each case ends by auditing the ledger with the four LL-034 helpers.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import {
  assertLedgerIntegrity,
  LedgerError,
  postJournalEntry,
} from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  revId: string;
  expenseId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `adv1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'A',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Adv1 Co', timezone: 'America/Chicago' }),
  );
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  const exp = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, cashId: cash.id, revId: rev.id, expenseId: exp.id };
}

function rawPost(
  c: Ctx,
  lines: { accountId: string; debit?: string; credit?: string }[],
  extra: Record<string, unknown> = {},
) {
  return postJournalEntry(
    postJournalEntryInput.parse({
      companyId: c.companyId,
      actorUserId: c.userId,
      transactionDate: '2026-01-10',
      sourceType: 'JOURNAL_ENTRY',
      lines,
      ...extra,
    }),
  );
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '<<resolved-no-throw>>';
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    // Non-LedgerError (e.g. a raw DB error surfacing) — return its text tagged.
    return `<<non-ledger: ${String((e as { message?: string }).message ?? e).slice(0, 120)}>>`;
  }
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from journal_entries where company_id = ${companyId}`,
  );
  return Number(r.rows[0]?.n);
}

async function lineCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from journal_lines where company_id = ${companyId}`,
  );
  return Number(r.rows[0]?.n);
}

beforeEach(async () => {
  await truncateAll();
});

describe('ADV1 decimal / boundary attacks', () => {
  it('A1 negative-zero debit is not a positive amount → INVALID_LINE', async () => {
    const c = await setup();
    // `Decimal('-0').greaterThan(0)` is false, so the "-0" line has no positive
    // side and the structural check refuses it — it can never sneak in as a debit.
    const code = await codeOf(rawPost(c, [
      { accountId: c.cashId, debit: '-0' },
      { accountId: c.revId, credit: '100.0000' },
    ]));
    expect(code).toBe('INVALID_LINE');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('A2 a -0/0 extra line on an otherwise-balanced entry → INVALID_LINE', async () => {
    const c = await setup();
    const code = await codeOf(rawPost(c, [
      { accountId: c.cashId, debit: '100.0000' },
      { accountId: c.revId, credit: '100.0000' },
      { accountId: c.expenseId, debit: '-0', credit: '0' },
    ]));
    expect(code).toBe('INVALID_LINE'); // the -0/0 line has no positive side
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('A3 leading zeros and trailing zeros must be parsed identically by app & PG', async () => {
    const c = await setup();
    // "007.5000" == 7.5 ; "007.5" == 7.5 ; if app and PG disagree the entry would
    // be stored unbalanced. They must agree -> posts and stays balanced.
    const { entry } = await rawPost(c, [
      { accountId: c.cashId, debit: '007.5000' },
      { accountId: c.expenseId, debit: '00.5' },
      { accountId: c.revId, credit: '8.0' },
    ]);
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('A4 max magnitude at the NUMERIC(19,4) edge (15 int digits, 4 decimals)', async () => {
    const c = await setup();
    const max = '999999999999999.9999'; // 15 nines . 4 nines — fits NUMERIC(19,4)
    const { entry } = await rawPost(c, [
      { accountId: c.cashId, debit: max },
      { accountId: c.revId, credit: max },
    ]);
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('A5 sum-overflow: balanced input whose per-side SUM exceeds NUMERIC(19,4)', async () => {
    const c = await setup();
    const max = '999999999999999.9999';
    // App sums with decimal.js (precision 34) -> balanced -> passes app checks.
    // At COMMIT the deferred trigger does SUM(debit) INTO numeric(19,4): the sum
    // ~1.999e15 has 16 integer digits -> NUMERIC(19,4) overflow. Expect the whole
    // transaction to abort (a raw error), leaving NOTHING behind.
    const code = await codeOf(rawPost(c, [
      { accountId: c.cashId, debit: max },
      { accountId: c.expenseId, debit: max },
      { accountId: c.revId, credit: max },
      { accountId: c.revId, credit: max },
    ]));
    // A balanced entry whose per-side SUM exceeds NUMERIC(19,4) passes the app's
    // decimal.js checks, then the DEFERRED balance trigger's numeric accumulator
    // overflows AT COMMIT and the whole transaction aborts. The error is not a
    // typed LedgerError today (a documented robustness gap), but the invariant
    // that matters holds absolutely: NOTHING partial survives.
    expect(code).not.toBe('<<resolved-no-throw>>'); // it must be rejected somehow
    expect(await entryCount(c.companyId)).toBe(0);
    expect(await lineCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('A6 malformed money is rejected at the Zod boundary (no entry)', async () => {
    const c = await setup();
    const malformed = ['1e3', '0x10', '  10  ', '10.00005', '.5', '1,000.00', 'NaN', 'Infinity', '10.', '+10'];
    for (const m of malformed) {
      const parsed = postJournalEntryInput.safeParse({
        companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-01-10',
        sourceType: 'JOURNAL_ENTRY',
        lines: [{ accountId: c.cashId, debit: m }, { accountId: c.revId, credit: m }],
      });
      expect(parsed.success, `money ${JSON.stringify(m)} should be rejected`).toBe(false);
    }
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('A7 tiny sub-cent imbalance that only appears at the 4th decimal', async () => {
    const c = await setup();
    const code = await codeOf(rawPost(c, [
      { accountId: c.cashId, debit: '100.0001' },
      { accountId: c.revId, credit: '100.0000' },
    ]));
    expect(code).toBe('UNBALANCED_JOURNAL_ENTRY');
    expect(await entryCount(c.companyId)).toBe(0);
    await assertLedgerIntegrity(c.companyId);
  });

  it('A8 many-line entry that balances only via exact 4-dp decimal arithmetic', async () => {
    const c = await setup();
    // 0.3333*3 = 0.9999 debit vs 0.9999 credit — exact at 4dp; a float would drift.
    const { entry } = await rawPost(c, [
      { accountId: c.cashId, debit: '0.3333' },
      { accountId: c.cashId, debit: '0.3333' },
      { accountId: c.expenseId, debit: '0.3333' },
      { accountId: c.revId, credit: '0.9999' },
    ]);
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});
