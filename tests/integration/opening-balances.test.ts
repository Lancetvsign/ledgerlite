/**
 * Opening balances — LL-071. Against a real database.
 *
 * A company seeds its non-control balance-sheet accounts as of a conversion date; the
 * service appends the Opening Balance Equity plug so the entry balances, source-typed
 * OPENING_BALANCE. A/R and A/P are rejected (they reconcile to a subsidiary). Set-once,
 * corrected by void + re-enter.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { assertLedgerIntegrity } from '@/server/ledger';
import { OpeningBalanceError, setOpeningBalances, voidOpeningBalances } from '@/server/opening-balances';
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { setOpeningBalancesInput, voidOpeningBalancesInput } from '@/validation/opening-balance';

import { getTestDb, truncateAll } from '../helpers/database';

const CONV = '2025-12-31';

interface Ctx {
  userId: string;
  companyId: string;
  cashId: string;
  equipmentId: string;
  loanId: string;
}

async function setup(): Promise<Ctx> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `ob-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'O' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  const { company } = await createCompanyWithOwner(user.id, createCompanyInput.parse({ legalName: 'Conv Co', timezone: 'America/Chicago' }), 'standard');
  const cash = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const equipment = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Equipment', accountType: 'ASSET' }));
  const loan = await createAccount(user.id, company.id, createAccountInput.parse({ name: 'Bank Loan', accountType: 'LIABILITY' }));
  return { userId: user.id, companyId: company.id, cashId: cash.id, equipmentId: equipment.id, loanId: loan.id };
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`)).rows[0]!.id;
}

async function balance(c: Ctx, accountId: string): Promise<string> {
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}

async function openingBalanceEntryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId} and source_type = 'OPENING_BALANCE' and status = 'POSTED'`);
  return Number(r.rows[0]?.n ?? '0');
}

const errOf = async (p: Promise<unknown>): Promise<OpeningBalanceError> => {
  try {
    await p;
    throw new Error('expected OpeningBalanceError');
  } catch (e) {
    expect(e).toBeInstanceOf(OpeningBalanceError);
    return e as OpeningBalanceError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('setOpeningBalances — posts a balanced entry with the OBE plug', () => {
  it('seeds accounts and plugs the difference to Opening Balance Equity', async () => {
    const c = await setup();
    await setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [
        { accountId: c.cashId, debit: '10000.00' },
        { accountId: c.equipmentId, debit: '50000.00' },
        { accountId: c.loanId, credit: '20000.00' },
      ],
    }));

    expect(await balance(c, c.cashId)).toBe('10000.0000');
    expect(await balance(c, c.equipmentId)).toBe('50000.0000');
    expect(await balance(c, c.loanId)).toBe('20000.0000');
    // Debits 60000, credits 20000 → OBE credited 40000 to balance.
    const obeId = await sysAccount(c.companyId, 'OPENING_BALANCE_EQUITY');
    expect(await balance(c, obeId)).toBe('40000.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('appends no OBE line when the user lines already balance', async () => {
    const c = await setup();
    const posted = await setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [
        { accountId: c.cashId, debit: '100.00' },
        { accountId: c.loanId, credit: '100.00' },
      ],
    }));
    expect(posted.lines).toHaveLength(2); // no plug line appended
    const obeId = await sysAccount(c.companyId, 'OPENING_BALANCE_EQUITY');
    expect(posted.lines.some((l) => l.accountId === obeId)).toBe(false);
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('exclusions — control accounts and the OBE plug', () => {
  it('rejects a line to the Accounts Receivable control account', async () => {
    const c = await setup();
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    const err = await errOf(setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: arId, debit: '500.00' }],
    })));
    expect(err.code).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');
    expect(await openingBalanceEntryCount(c.companyId)).toBe(0);
  });

  it('rejects a line to the Accounts Payable control account', async () => {
    const c = await setup();
    const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
    const err = await errOf(setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: apId, credit: '500.00' }],
    })));
    expect(err.code).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');
  });

  it('rejects a line to Opening Balance Equity itself', async () => {
    const c = await setup();
    const obeId = await sysAccount(c.companyId, 'OPENING_BALANCE_EQUITY');
    const err = await errOf(setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: obeId, credit: '500.00' }],
    })));
    expect(err.code).toBe('OBE_NOT_ALLOWED');
  });
});

describe('set-once and idempotency', () => {
  it('rejects a second, distinct opening balance', async () => {
    const c = await setup();
    await setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: c.cashId, debit: '100.00' }],
    }));
    const err = await errOf(setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: c.cashId, debit: '200.00' }],
    })));
    expect(err.code).toBe('OPENING_BALANCE_ALREADY_SET');
    expect(await openingBalanceEntryCount(c.companyId)).toBe(1);
  });

  it('two CONCURRENT keyless sets: exactly one posts, the other is rejected (no raw error)', async () => {
    const c = await setup();
    const mk = () => setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: c.cashId, debit: '100.00' }, { accountId: c.loanId, credit: '100.00' }],
    }));
    const results = await Promise.allSettled([mk(), mk()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    // The loser gets the typed domain error, never a raw duplicate-key leak.
    const reason: unknown = rejected[0]!.reason;
    expect(reason).toBeInstanceOf(OpeningBalanceError);
    expect((reason as OpeningBalanceError).code).toBe('OPENING_BALANCE_ALREADY_SET');
    expect(await openingBalanceEntryCount(c.companyId)).toBe(1);
  });

  it('a resubmit with the SAME idempotency key returns the original, posting once', async () => {
    const c = await setup();
    const key = '11111111-1111-4111-8111-111111111111';
    const input = setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV, idempotencyKey: key,
      lines: [{ accountId: c.cashId, debit: '100.00' }, { accountId: c.loanId, credit: '100.00' }],
    });
    const first = await setOpeningBalances(c.userId, c.companyId, input);
    const second = await setOpeningBalances(c.userId, c.companyId, input);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await openingBalanceEntryCount(c.companyId)).toBe(1);
  });
});

describe('void — corrects a mistake by reversal', () => {
  it('voiding zeroes the balances and allows a fresh set', async () => {
    const c = await setup();
    await setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: c.cashId, debit: '100.00' }, { accountId: c.loanId, credit: '100.00' }],
    }));
    await voidOpeningBalances(c.userId, c.companyId, voidOpeningBalancesInput.parse({ reversalDate: CONV }));
    // Original + reversal net to zero.
    expect(await balance(c, c.cashId)).toBe('0.0000');
    expect(await balance(c, c.loanId)).toBe('0.0000');
    expect(await openingBalanceEntryCount(c.companyId)).toBe(0); // the POSTED one is now REVERSED
    await assertLedgerIntegrity(c.companyId);

    // A fresh set is allowed after void.
    await setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
      companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
      lines: [{ accountId: c.cashId, debit: '250.00' }],
    }));
    expect(await balance(c, c.cashId)).toBe('250.0000');
  });

  it('void with nothing set raises OPENING_BALANCE_NOT_SET', async () => {
    const c = await setup();
    const err = await errOf(voidOpeningBalances(c.userId, c.companyId, voidOpeningBalancesInput.parse({})));
    expect(err.code).toBe('OPENING_BALANCE_NOT_SET');
  });
});

describe('period + money guards', () => {
  it('rejects a conversion date in a CLOSED period', async () => {
    const c = await setup();
    const period = await getAccountingPeriod(c.companyId, CONV);
    await closePeriod(c.userId, c.companyId, period.id);
    await expect(
      setOpeningBalances(c.userId, c.companyId, setOpeningBalancesInput.parse({
        companyId: c.companyId, actorUserId: c.userId, conversionDate: CONV,
        lines: [{ accountId: c.cashId, debit: '100.00' }],
      })),
    ).rejects.toThrow(/closed/i);
    expect(await openingBalanceEntryCount(c.companyId)).toBe(0);
  });

  it('rejects a JavaScript number as an amount (ADR-004)', () => {
    // A number must never reach the money boundary — Zod rejects, never coerces.
    const parsed = setOpeningBalancesInput.safeParse({
      companyId: '11111111-1111-4111-8111-111111111111',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      conversionDate: CONV,
      lines: [{ accountId: '33333333-3333-4333-8333-333333333333', debit: 100 }],
    });
    expect(parsed.success).toBe(false);
  });
});
