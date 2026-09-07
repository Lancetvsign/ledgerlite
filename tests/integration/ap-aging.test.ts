/**
 * A/P aging report — LL-064. Against a real database.
 *
 * The A/P subsidiary ledger: OPEN bills' open balances bucketed by age, per vendor. The
 * decisive property is reconciliation — the aging grand total equals the GL A/P control
 * balance (derived from journal lines) — which the release gate also enforces (GL-T026).
 * These tests prove the bucketing, grouping, exclusions, and the reconciliation directly.
 * The A/P mirror of ar-aging.test.ts.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { payBill } from '@/server/bill-payments';
import { createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { createVendor } from '@/server/vendors';
import { issueVendorCredit } from '@/server/vendor-credits';
import { getApAging, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { payBillInput } from '@/validation/bill-payment';
import { createCompanyInput } from '@/validation/company';
import { createVendorInput } from '@/validation/vendor';
import { issueVendorCreditInput } from '@/validation/vendor-credit';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  vendorId: string;
  suppliesId: string;
  cashId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `apage-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
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
    createCompanyInput.parse({ legalName: 'AP Aging Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Acme' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, vendorId: vendor.id, suppliesId: supplies.id, cashId: cash.id };
}

/** Create + finalize an OPEN bill for `price`, dated `billDate`, due `dueDate`. */
async function openBill(
  c: Ctx,
  price: string,
  dueDate: string | undefined,
  vendorId = c.vendorId,
  billDate = '2026-01-10',
): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId,
    billDate,
    ...(dueDate !== undefined ? { dueDate } : {}),
    lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

async function apControlBalance(c: Ctx, asOf: string): Promise<string> {
  const db = await getTestDb();
  const ap = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_PAYABLE' limit 1`,
  );
  const apId = ap.rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';
}

beforeEach(async () => {
  await truncateAll();
});

describe('getApAging — bucketing by due date', () => {
  it('places each open bill in the right bucket as of a date', async () => {
    const c = await setup();
    // As of 2026-06-30, due dates chosen to land one bill in each bucket.
    await openBill(c, '100.00', '2026-06-30'); // 0 days → current
    await openBill(c, '200.00', '2026-06-15'); // 15 → 1–30
    await openBill(c, '300.00', '2026-05-15'); // 46 → 31–60
    await openBill(c, '400.00', '2026-04-15'); // 76 → 61–90
    await openBill(c, '500.00', '2026-01-15'); // 166 → 90+

    const aging = await getApAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.vendors).toHaveLength(1);
    const b = aging.vendors[0]!.buckets;
    expect(b.current).toBe('100.0000');
    expect(b.d1to30).toBe('200.0000');
    expect(b.d31to60).toBe('300.0000');
    expect(b.d61to90).toBe('400.0000');
    expect(b.d90plus).toBe('500.0000');
    expect(aging.vendors[0]!.total).toBe('1500.0000');
    expect(aging.totals.total).toBe('1500.0000');
    expect(aging.totals.d1to30).toBe('200.0000');
  });

  it('falls back to the bill date when there is no due date', async () => {
    const c = await setup();
    // No due date; bill dated 2026-01-10, aged as of 2026-03-01 → 50 days → 31–60.
    await openBill(c, '75.00', undefined, c.vendorId, '2026-01-10');
    const aging = await getApAging(c.userId, c.companyId, '2026-03-01');
    expect(aging.vendors[0]!.buckets.d31to60).toBe('75.0000');
    expect(aging.totals.total).toBe('75.0000');
  });
});

describe('getApAging — population and grouping', () => {
  it('groups by vendor and excludes DRAFT / PAID / VOID bills', async () => {
    const c = await setup();
    const other = await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'Beta' }));

    await openBill(c, '100.00', '2026-06-15'); // Acme, OPEN → aged
    await openBill(c, '250.00', '2026-06-15', other.id); // Beta, OPEN → aged
    // A DRAFT (never finalized) is invisible to aging.
    await createBill(c.userId, c.companyId, createBillInput.parse({
      vendorId: c.vendorId, billDate: '2026-01-10', lines: [{ accountId: c.suppliesId, unitPrice: '999.00' }],
    }));
    // A fully-paid bill (→ PAID) is invisible to aging.
    const paid = await openBill(c, '60.00', '2026-06-15');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-06-20', cashAccountId: c.cashId,
      applications: [{ billId: paid, amountApplied: '60.00' }],
    }));
    // A VOID bill (finalized then voided) is invisible to aging.
    const voided = await openBill(c, '80.00', '2026-06-15');
    await voidBill(c.userId, c.companyId, voided, voidBillInput.parse({ reversalDate: '2026-06-25' }));

    const aging = await getApAging(c.userId, c.companyId, '2026-06-30');
    const names = aging.vendors.map((r) => r.vendorName).sort();
    expect(names).toEqual(['Acme', 'Beta']);
    expect(aging.vendors.find((r) => r.vendorName === 'Acme')?.total).toBe('100.0000'); // 999 draft + 60 paid + 80 void excluded
    expect(aging.vendors.find((r) => r.vendorName === 'Beta')?.total).toBe('250.0000');
    expect(aging.totals.total).toBe('350.0000');
  });

  it('a partial bill payment reduces the bucketed open balance', async () => {
    const c = await setup();
    const bill = await openBill(c, '100.00', '2026-06-15');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-06-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '30.00' }],
    }));
    const aging = await getApAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.vendors[0]!.buckets.d1to30).toBe('70.0000'); // 100 − 30
    expect(aging.totals.total).toBe('70.0000');
  });

  it('a vendor credit reduces the bucketed open balance', async () => {
    const c = await setup();
    const bill = await openBill(c, '100.00', '2026-06-15');
    await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId: bill, expenseAccountId: c.suppliesId, creditDate: '2026-06-20', amount: '30.00',
    }));
    const aging = await getApAging(c.userId, c.companyId, '2026-06-30');
    expect(aging.vendors[0]!.buckets.d1to30).toBe('70.0000'); // 100 − 30 credited
    expect(aging.totals.total).toBe('70.0000');
  });

  it('is company-scoped — another tenant’s payables never appear', async () => {
    const a = await setup();
    const b = await setup();
    await openBill(a, '100.00', '2026-06-15');
    await openBill(b, '999.00', '2026-06-15');
    const aging = await getApAging(a.userId, a.companyId, '2026-06-30');
    expect(aging.totals.total).toBe('100.0000'); // only A's payable
  });
});

describe('getApAging — reconciles to the GL A/P control balance', () => {
  it('aging grand total equals the derived Accounts Payable balance', async () => {
    const c = await setup();
    await openBill(c, '100.00', '2026-06-15');
    const partial = await openBill(c, '200.00', '2026-05-15');
    await openBill(c, '50.00', '2026-01-15');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-06-20', cashAccountId: c.cashId,
      applications: [{ billId: partial, amountApplied: '120.00' }],
    }));

    const aging = await getApAging(c.userId, c.companyId, '2026-12-31');
    const apBalance = await apControlBalance(c, '2026-12-31');
    // 100 + (200 − 120) + 50 = 230, and the A/P control agrees exactly.
    expect(aging.totals.total).toBe('230.0000');
    expect(aging.totals.total).toBe(apBalance);

    // The grand total is age-independent (ADR-016 mirror): a different asOf only re-buckets.
    const midYear = await getApAging(c.userId, c.companyId, '2026-06-30');
    expect(midYear.totals.total).toBe(aging.totals.total);
  });
});
