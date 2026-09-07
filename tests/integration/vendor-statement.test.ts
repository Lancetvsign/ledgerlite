/**
 * Vendor statement — LL-064. Against a real database.
 *
 * One vendor's A/P over a period: opening balance, the activity that moved it, and the
 * closing balance — all derived from the vendor-tagged A/P journal lines (no stored
 * balance, invariant 2). The decisive property is reconciliation: a vendor's closing
 * balance is that vendor's slice of the GL A/P control as of `toDate`, and the sum over
 * all vendors equals the control (GL-T026 states this at the release gate; here we prove
 * the mechanics — ordering, running balance, reversal netting, company scoping, decimal
 * exactness). The A/P mirror of customer-statement.test.ts.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { toMoney } from '@/lib/decimal';
import { AuthorizationDenied } from '@/server/authorization';
import { createAccount } from '@/server/accounts';
import { payBill } from '@/server/bill-payments';
import { createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { createVendor } from '@/server/vendors';
import { issueVendorCredit } from '@/server/vendor-credits';
import { getVendorStatement, getTrialBalance } from '@/server/reports';
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
      email: `vstmt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'S',
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
    createCompanyInput.parse({ legalName: 'Vendor Statement Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Acme' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, vendorId: vendor.id, suppliesId: supplies.id, cashId: cash.id };
}

/** Create + finalize an OPEN bill for `price`, dated `billDate`. Returns its id. */
async function openBill(c: Ctx, price: string, billDate: string, vendorId = c.vendorId): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId, billDate, lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

/** The GL A/P control balance as of a date (from the derived trial balance). */
async function apControlBalance(c: Ctx, asOf: string): Promise<string> {
  const db = await getTestDb();
  const apId = (await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_PAYABLE' limit 1`,
  )).rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';
}

beforeEach(async () => {
  await truncateAll();
});

describe('getVendorStatement — opening, activity, closing', () => {
  it('carries an opening balance and a running balance over every A/P event', async () => {
    const c = await setup();
    // Pre-period: a January bill establishes the Feb-01 opening balance.
    await openBill(c, '100.00', '2026-01-10');
    // In-period activity across the A/P-moving document types.
    const febBill = await openBill(c, '200.00', '2026-02-05'); // +200 (EXPENSE / bill)
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-10', cashAccountId: c.cashId,
      applications: [{ billId: febBill, amountApplied: '50.00' }],
    })); // −50 (BILL_PAYMENT) on the February bill
    await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId: febBill, expenseAccountId: c.suppliesId, creditDate: '2026-02-15', amount: '30.00',
    })); // −30 (VENDOR_CREDIT) on the February bill
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-02-20', cashAccountId: c.cashId,
      applications: [{ billId: febBill, amountApplied: '20.00' }],
    })); // −20 (BILL_PAYMENT) on the February bill

    const stmt = (await getVendorStatement(c.userId, c.companyId, c.vendorId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.openingBalance).toBe('100.0000'); // the January bill
    expect(stmt.lines.map((l) => [l.date, l.sourceType, l.charge, l.payment, l.balance])).toEqual([
      ['2026-02-05', 'EXPENSE', '200.0000', '0.0000', '300.0000'],
      ['2026-02-10', 'BILL_PAYMENT', '0.0000', '50.0000', '250.0000'],
      ['2026-02-15', 'VENDOR_CREDIT', '0.0000', '30.0000', '220.0000'],
      ['2026-02-20', 'BILL_PAYMENT', '0.0000', '20.0000', '200.0000'],
    ]);
    expect(stmt.closingBalance).toBe('200.0000');
    // Closing == this vendor's A/P contribution as of toDate (the only vendor here).
    expect(stmt.closingBalance).toBe(await apControlBalance(c, '2026-02-28'));
  });

  it('excludes activity outside the window but reflects it in opening/closing', async () => {
    const c = await setup();
    await openBill(c, '100.00', '2026-01-10'); // before window
    await openBill(c, '40.00', '2026-02-10'); // inside window
    await openBill(c, '7.00', '2026-03-10'); // after window

    const stmt = (await getVendorStatement(c.userId, c.companyId, c.vendorId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.openingBalance).toBe('100.0000'); // Jan only
    expect(stmt.lines).toHaveLength(1);
    expect(stmt.lines[0]!.date).toBe('2026-02-10');
    expect(stmt.closingBalance).toBe('140.0000'); // 100 + 40, March excluded
  });
});

describe('getVendorStatement — reversal netting (vendor tag preserved)', () => {
  it('a void appears as a REVERSAL row and nets its original to zero', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
      vendorId: c.vendorId, billDate: '2026-02-05', lines: [{ accountId: c.suppliesId, unitPrice: '100.00' }],
    }));
    await finalizeBill(c.userId, c.companyId, bill.id);
    // Void with an explicit reversal date inside the window (else it defaults to today).
    await voidBill(c.userId, c.companyId, bill.id, voidBillInput.parse({ reversalDate: '2026-02-10' }));

    const stmt = (await getVendorStatement(c.userId, c.companyId, c.vendorId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.lines.map((l) => [l.date, l.sourceType, l.charge, l.payment, l.balance])).toEqual([
      ['2026-02-05', 'EXPENSE', '100.0000', '0.0000', '100.0000'],
      ['2026-02-10', 'REVERSAL', '0.0000', '100.0000', '0.0000'],
    ]);
    expect(stmt.closingBalance).toBe('0.0000'); // the reversal (vendor-tagged) nets the original
  });
});

describe('getVendorStatement — reconciliation, scoping, authorization, validation', () => {
  it('the sum of every vendor’s closing balance equals the A/P control', async () => {
    const c = await setup();
    const beta = await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'Beta' }));

    // Acme: 100 billed, 40 paid → 60.
    const acmeBill = await openBill(c, '100.00', '2026-01-10');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: acmeBill, amountApplied: '40.00' }],
    }));
    // Beta: 250 billed, 50 credited → 200.
    const betaBill = await openBill(c, '250.00', '2026-01-15', beta.id);
    await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId: betaBill, expenseAccountId: c.suppliesId, creditDate: '2026-01-25', amount: '50.00',
    }));

    const asOf = '2026-12-31';
    const acme = (await getVendorStatement(c.userId, c.companyId, c.vendorId, '2026-01-01', asOf))!;
    const betaStmt = (await getVendorStatement(c.userId, c.companyId, beta.id, '2026-01-01', asOf))!;
    expect(acme.closingBalance).toBe('60.0000');
    expect(betaStmt.closingBalance).toBe('200.0000');

    // Sum with decimal.js — never JS `number` for money (ADR-004).
    const sum = toMoney(acme.closingBalance).plus(toMoney(betaStmt.closingBalance));
    expect(sum.toFixed(4)).toBe(await apControlBalance(c, asOf)); // 260.0000
  });

  it('is company-scoped — another tenant’s vendor id returns null (no leak)', async () => {
    const a = await setup();
    const b = await setup();
    // b's vendor, queried under a → null, exactly as a genuine miss would.
    const cross = await getVendorStatement(a.userId, a.companyId, b.vendorId, '2026-01-01', '2026-12-31');
    expect(cross).toBeNull();
    const missing = await getVendorStatement(a.userId, a.companyId, '00000000-0000-0000-0000-000000000000', '2026-01-01', '2026-12-31');
    expect(missing).toBeNull();
  });

  it('requires report.view — a non-member is denied', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(getVendorStatement(outsider, c.companyId, c.vendorId, '2026-01-01', '2026-12-31'))
      .rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('rejects an inverted date range', async () => {
    const c = await setup();
    await expect(getVendorStatement(c.userId, c.companyId, c.vendorId, '2026-03-01', '2026-02-01'))
      .rejects.toThrow(/on or before/);
  });

  it('is decimal-exact — fractional cents accumulate without float drift', async () => {
    const c = await setup();
    await openBill(c, '0.10', '2026-02-05');
    await openBill(c, '0.20', '2026-02-06');
    const stmt = (await getVendorStatement(c.userId, c.companyId, c.vendorId, '2026-02-01', '2026-02-28'))!;
    expect(stmt.lines.map((l) => l.balance)).toEqual(['0.1000', '0.3000']); // not 0.30000000000000004
    expect(stmt.closingBalance).toBe('0.3000');
  });
});
