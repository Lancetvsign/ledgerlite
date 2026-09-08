/**
 * A/P concurrency & idempotency — Gate 5 (AGENTS §7: concurrency is proven against a
 * REAL database, never mocks). The A/P analogue of adv2-concurrency.
 *
 * The bill's open balance is derived (bill.total − Σ non-void bill-payments − Σ non-void
 * vendor-credits), never stored, and every reduction is applied while holding the bill's
 * `FOR UPDATE` lock. These cases fire simultaneous reductions at one bill and assert the
 * lock makes over-application impossible, the PAID↔OPEN transition is exact when one of
 * several reductions is voided, and the id-sorted lock order (Gate 5 fix) keeps two
 * payments touching the same bills in opposite orders from deadlocking. Every case ends
 * by re-checking the A/P subsidiary reconciles to the GL control.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import '@/lib/decimal';
import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { BillPaymentError, payBill, voidBillPayment } from '@/server/bill-payments';
import { createBill, finalizeBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { assertLedgerIntegrity, LedgerError } from '@/server/ledger';
import { getApAging, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { issueVendorCredit, voidVendorCredit } from '@/server/vendor-credits';
import { createVendor } from '@/server/vendors';
import { createAccountInput } from '@/validation/account';
import { createBillInput } from '@/validation/bill';
import { payBillInput, voidBillPaymentInput } from '@/validation/bill-payment';
import { createCompanyInput } from '@/validation/company';
import { createVendorInput } from '@/validation/vendor';
import { issueVendorCreditInput, voidVendorCreditInput } from '@/validation/vendor-credit';

import { getTestDb, truncateAll } from '../helpers/database';

const ASOF = '2026-12-31';

interface Ctx {
  userId: string;
  companyId: string;
  vendorId: string;
  suppliesId: string;
  cashId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `adv6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@synthetic.test`, password: 'synthetic-password-1', name: 'A' },
    returnHeaders: true,
  });
  const u = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return u.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'AP Concurrency Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, vendorId: vendor.id, suppliesId: supplies.id, cashId: cash.id };
}

async function openBill(c: Ctx, price: string): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId: c.vendorId, billDate: '2026-01-10', lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

async function billStatus(billId: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ status: string }>(sql`select status from bills where id = ${billId}`)).rows[0]!.status;
}

/** The derived GL A/P control balance, and its equality with the aging subsidiary. */
async function apControl(c: Ctx): Promise<string> {
  const db = await getTestDb();
  const apId = (await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_PAYABLE' limit 1`,
  )).rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, ASOF);
  expect(tb.balanced).toBe(true);
  const control = tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';
  const aging = (await getApAging(c.userId, c.companyId, ASOF)).totals.total;
  expect(aging).toBe(control); // subsidiary ⇔ control at every checkpoint
  return control;
}

/** The error code of a rejected settle, or 'OK' for a fulfilled one. */
function codeOf(r: PromiseSettledResult<unknown>): string {
  if (r.status === 'fulfilled') return 'OK';
  const e: unknown = r.reason;
  return e instanceof BillPaymentError ? e.code : (e instanceof Error ? e.name : 'ERR');
}

beforeEach(async () => {
  await truncateAll();
});

describe('A/P concurrency — the bill FOR UPDATE lock makes over-application impossible', () => {
  it('two simultaneous payments of 60 on a 100 bill: one posts, one is OVERAPPLIED', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');

    const results = await Promise.allSettled([
      payBill(c.userId, c.companyId, payBillInput.parse({
        vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
        applications: [{ billId, amountApplied: '60.00' }],
      })),
      payBill(c.userId, c.companyId, payBillInput.parse({
        vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
        applications: [{ billId, amountApplied: '60.00' }],
      })),
    ]);

    const codes = results.map(codeOf);
    expect(codes.filter((x) => x === 'OK')).toHaveLength(1); // exactly one wins
    expect(codes.filter((x) => x === 'OVERAPPLIED')).toHaveLength(1); // the other sees open=40
    expect(await apControl(c)).toBe('40.0000'); // 100 − 60, never 100 − 120
    expect(await billStatus(billId)).toBe('OPEN');
    await assertLedgerIntegrity(c.companyId);
  });

  it('two simultaneous reductions (a payment and a vendor credit) of 60 on a 100 bill: one wins', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');

    const results = await Promise.allSettled([
      payBill(c.userId, c.companyId, payBillInput.parse({
        vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
        applications: [{ billId, amountApplied: '60.00' }],
      })),
      issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
        billId, expenseAccountId: c.suppliesId, creditDate: '2026-02-01', amount: '60.00',
      })),
    ]);
    // The two reduction sources contend on the same bill lock; whichever commits second
    // sees open=40 and is refused (payment → OVERAPPLIED, credit → CREDIT_EXCEEDS_BALANCE).
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(await apControl(c)).toBe('40.0000');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('A/P idempotency of transitions — voiding one of several reductions is exact', () => {
  it('voiding one of two payments on a PAID bill reverts it to OPEN with the right open balance', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const { payment: pA } = await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '60.00' }],
    }));
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-02', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '40.00' }],
    }));
    expect(await billStatus(billId)).toBe('PAID'); // 60 + 40 = 100 → cleared
    expect(await apControl(c)).toBe('0.0000');

    // Void payment A (60): reductions drop to 40, the bill is no longer cleared → OPEN.
    await voidBillPayment(c.userId, c.companyId, pA.id, voidBillPaymentInput.parse({ reversalDate: '2026-02-10' }));
    expect(await billStatus(billId)).toBe('OPEN');
    expect(await apControl(c)).toBe('60.0000'); // 100 − 40 (payment B still live)
    await assertLedgerIntegrity(c.companyId);
  });

  it('a payment and a vendor credit both clear a bill; voiding the credit reopens it', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '60.00' }],
    }));
    const credit = await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId, expenseAccountId: c.suppliesId, creditDate: '2026-02-02', amount: '40.00',
    }));
    expect(await billStatus(billId)).toBe('PAID'); // 60 paid + 40 credited
    expect(await apControl(c)).toBe('0.0000');

    await voidVendorCredit(c.userId, c.companyId, credit.id, voidVendorCreditInput.parse({ reversalDate: '2026-02-10' }));
    expect(await billStatus(billId)).toBe('OPEN');
    expect(await apControl(c)).toBe('40.0000'); // 100 − 60 (payment still live)
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('A/P lock order — two payments touching the same bills in opposite orders do not deadlock', () => {
  it('id-sorted locking lets both concurrent multi-bill payments commit (Gate 5 fix 8)', async () => {
    const c = await setup();
    const billA = await openBill(c, '100.00');
    const billB = await openBill(c, '100.00');

    // Payment 1 lists [A, B]; payment 2 lists [B, A]. Without a deterministic lock order
    // these can deadlock; with the id-sort both lock in the same order and both commit.
    const results = await Promise.allSettled([
      payBill(c.userId, c.companyId, payBillInput.parse({
        vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
        applications: [{ billId: billA, amountApplied: '10.00' }, { billId: billB, amountApplied: '10.00' }],
      })),
      payBill(c.userId, c.companyId, payBillInput.parse({
        vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
        applications: [{ billId: billB, amountApplied: '20.00' }, { billId: billA, amountApplied: '20.00' }],
      })),
    ]);

    expect(results.map(codeOf)).toEqual(['OK', 'OK']); // neither deadlocked, both applied
    expect(await apControl(c)).toBe('140.0000'); // 200 − (30 on A + 30 on B)
    await assertLedgerIntegrity(c.companyId);
  });
});

async function billPaymentCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from bill_payments where company_id = ${companyId}`);
  return Number(r.rows[0]?.n);
}

describe('A/P submit-once idempotency — a keyed retry never disburses twice (LL-067)', () => {
  it('N simultaneous payments with the SAME key collapse to ONE payment', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const key = crypto.randomUUID();
    const makeInput = () => payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '40.00' }], idempotencyKey: key,
    });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => payBill(c.userId, c.companyId, makeInput())));
    // Every call SUCCEEDS and returns the SAME payment — the winner posts, the rest
    // collide on the key and resolve to it (no error, no second disbursement).
    const ids = new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.payment.id] : [])));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(ids.size).toBe(1);
    expect(await billPaymentCount(c.companyId)).toBe(1); // one row, not six
    expect(await apControl(c)).toBe('60.0000'); // 100 − 40, never 100 − 240
    await assertLedgerIntegrity(c.companyId);
  });

  it('a resubmit LARGER than the remaining balance still returns the original (early key check)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const key = crypto.randomUUID();
    const input = payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '60.00' }], idempotencyKey: key,
    });
    const first = await payBill(c.userId, c.companyId, input); // open now 40
    // Retrying the SAME request (60) would OVERAPPLY the now-40 open balance — but the key
    // is resolved BEFORE that check, so the retry is a no-op returning the original.
    const retry = await payBill(c.userId, c.companyId, input);
    expect(retry.payment.id).toBe(first.payment.id);
    expect(await billPaymentCount(c.companyId)).toBe(1);
    expect(await apControl(c)).toBe('40.0000'); // 100 − 60 (once)
    await assertLedgerIntegrity(c.companyId);
  });

  it('a sequential resubmit with the same key returns the original; a new key posts a second', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const key = crypto.randomUUID();
    const input = payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '30.00' }], idempotencyKey: key,
    });
    const first = await payBill(c.userId, c.companyId, input);
    const retry = await payBill(c.userId, c.companyId, input); // same key + content
    expect(retry.payment.id).toBe(first.payment.id); // the original, not a new one
    expect(await billPaymentCount(c.companyId)).toBe(1);
    expect(await apControl(c)).toBe('70.0000'); // 100 − 30 (once)

    // A different key is a genuinely new intent → a second payment posts.
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-02', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '20.00' }], idempotencyKey: crypto.randomUUID(),
    }));
    expect(await billPaymentCount(c.companyId)).toBe(2);
    expect(await apControl(c)).toBe('50.0000'); // 100 − 30 − 20
    await assertLedgerIntegrity(c.companyId);
  });

  it('the same key with DIFFERENT content is refused (IDEMPOTENCY_KEY_CONFLICT), never silently merged', async () => {
    const c = await setup();
    const billA = await openBill(c, '100.00');
    const billB = await openBill(c, '100.00');
    const key = crypto.randomUUID();
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId: billA, amountApplied: '40.00' }], idempotencyKey: key,
    }));
    // Same key, a payment of the SAME total against a DIFFERENT bill — the request
    // fingerprint differs, so the retry is a conflict, not a false match.
    let code = '';
    try {
      await payBill(c.userId, c.companyId, payBillInput.parse({
        vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
        applications: [{ billId: billB, amountApplied: '40.00' }], idempotencyKey: key,
      }));
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerError);
      code = (e as LedgerError).code;
    }
    expect(code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await billPaymentCount(c.companyId)).toBe(1); // the second never posted
    await assertLedgerIntegrity(c.companyId);
  });

  it('a keyless payment still posts (backward compatible)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    // Two keyless payments are two distinct disbursements — no idempotency applies.
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '10.00' }],
    }));
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-02', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '10.00' }],
    }));
    expect(await billPaymentCount(c.companyId)).toBe(2);
    expect(await apControl(c)).toBe('80.0000'); // 100 − 10 − 10
    await assertLedgerIntegrity(c.companyId);
  });
});
