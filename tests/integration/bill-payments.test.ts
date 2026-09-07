/**
 * Bill payments — LL-062 (Accounts Payable). Against a real database.
 *
 * Paying a vendor posts Dr Accounts Payable (vendor-tagged) / Cr the cash account and
 * applies to the vendor's OPEN bills, marking a fully-paid bill PAID. Voiding reverses
 * the entry and reverts PAID→OPEN. The A/P mirror of the payments suite (LL-043/045).
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { BillPaymentError, listOpenBills, payBill, voidBillPayment } from '@/server/bill-payments';
import { BillError, createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { assertLedgerIntegrity } from '@/server/ledger';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createVendor } from '@/server/vendors';
import { createAccountInput } from '@/validation/account';
import { payBillInput, voidBillPaymentInput } from '@/validation/bill-payment';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { createCompanyInput } from '@/validation/company';
import { createVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  vendorId: string;
  rentId: string;
  cashId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `bpay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'P' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'Pay Co', timezone: 'America/Chicago' }), 'standard');
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent Expense', accountType: 'EXPENSE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, vendorId: vendor.id, rentId: rent.id, cashId: cash.id };
}

/** Create + finalize an OPEN bill for `price`. Returns its id. */
async function openBill(c: Ctx, price: string, vendorId = c.vendorId): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId, billDate: '2026-01-10', lines: [{ accountId: c.rentId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`)).rows[0]!.id;
}
async function billStatus(billId: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ status: string }>(sql`select status from bills where id = ${billId}`)).rows[0]!.status;
}
async function apBalance(c: Ctx): Promise<string> {
  const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  return tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';
}

const errOf = async (p: Promise<unknown>): Promise<BillPaymentError> => {
  try {
    await p;
    throw new Error('expected BillPaymentError');
  } catch (e) {
    expect(e).toBeInstanceOf(BillPaymentError);
    return e as BillPaymentError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('payBill — posts Dr A/P (vendor-tagged) / Cr cash and applies to bills', () => {
  it('a full payment clears the bill (→ PAID) and reduces the A/P control to zero', async () => {
    const c = await setup();
    const bill = await openBill(c, '1000.00');
    expect(await apBalance(c)).toBe('1000.0000');
    const { payment } = await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '1000.00' }],
    }));
    expect(payment.amount).toBe('1000.0000');
    expect(await billStatus(bill)).toBe('PAID');
    expect(await apBalance(c)).toBe('0.0000');
    // The A/P debit is vendor-tagged; cash is credited.
    const db = await getTestDb();
    const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
    const lines = (await db.execute<{ account_id: string; debit: string; credit: string; vendor_id: string | null }>(sql`
      select l.account_id, l.debit::text debit, l.credit::text credit, l.vendor_id
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where e.company_id = ${c.companyId} and e.source_type = 'BILL_PAYMENT' and e.source_id = ${payment.id}`)).rows;
    const ap = lines.find((l) => l.account_id === apId)!;
    expect(ap.debit).toBe('1000.0000');
    expect(ap.vendor_id).toBe(c.vendorId);
    expect(lines.find((l) => l.account_id === c.cashId)!.credit).toBe('1000.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a partial payment leaves the bill OPEN with a reduced open balance', async () => {
    const c = await setup();
    const bill = await openBill(c, '1000.00');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '400.00' }],
    }));
    expect(await billStatus(bill)).toBe('OPEN');
    expect(await apBalance(c)).toBe('600.0000');
    const open = (await listOpenBills(c.userId, c.companyId)).find((b) => b.id === bill);
    expect(open?.openBalance).toBe('600.0000');
  });

  it('rejects over-application beyond the open balance (OVERAPPLIED)', async () => {
    const c = await setup();
    const bill = await openBill(c, '100.00');
    expect((await errOf(payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '100.01' }],
    })))).code).toBe('OVERAPPLIED');
  });

  it('rejects paying a bill that belongs to a different vendor (BILL_WRONG_VENDOR)', async () => {
    const c = await setup();
    const other = await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'Other' }));
    const bill = await openBill(c, '100.00', other.id);
    expect((await errOf(payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '100.00' }],
    })))).code).toBe('BILL_WRONG_VENDOR');
  });

  it('rejects a cash account that is non-asset, A/P, or the A/R control (CASH_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const bill = await openBill(c, '100.00');
    const pay = (cashAccountId: string) => payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId,
      applications: [{ billId: bill, amountApplied: '100.00' }],
    }));
    const revenue = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Some Revenue', accountType: 'REVENUE' }));
    expect((await errOf(pay(revenue.id))).code).toBe('CASH_ACCOUNT_INVALID'); // not an asset
    expect((await errOf(pay(await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE')))).code).toBe('CASH_ACCOUNT_INVALID'); // A/P (liability)
    // A/R is an ASSET, so it passes the asset check — but it is a control account, and
    // crediting it via a bill payment would break the A/R aging⇔control tie. Refused.
    expect((await errOf(pay(await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE')))).code).toBe('CASH_ACCOUNT_INVALID');
  });
});

describe('voidBillPayment — reverses and reverts PAID→OPEN', () => {
  it('voiding a payment returns the payable and reopens the bill', async () => {
    const c = await setup();
    const bill = await openBill(c, '500.00');
    const { payment } = await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '500.00' }],
    }));
    expect(await billStatus(bill)).toBe('PAID');
    const { payment: voided } = await voidBillPayment(c.userId, c.companyId, payment.id, voidBillPaymentInput.parse({ reversalDate: '2026-01-25' }));
    expect(voided.status).toBe('VOID');
    expect(await billStatus(bill)).toBe('OPEN');
    expect(await apBalance(c)).toBe('500.0000'); // payable restored
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (BILL_PAYMENT_NOT_POSTED)', async () => {
    const c = await setup();
    const bill = await openBill(c, '50.00');
    const { payment } = await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '50.00' }],
    }));
    await voidBillPayment(c.userId, c.companyId, payment.id, voidBillPaymentInput.parse({}));
    expect((await errOf(voidBillPayment(c.userId, c.companyId, payment.id, voidBillPaymentInput.parse({})))).code).toBe('BILL_PAYMENT_NOT_POSTED');
  });
});

describe('voidBill is guarded against live bill payments (Gate-4 lesson, A/P twin)', () => {
  it('a bill with a live bill payment cannot be voided (BILL_HAS_PAYMENTS); void the payment first', async () => {
    const c = await setup();
    const bill = await openBill(c, '1000.00');
    // A PARTIAL payment leaves the bill OPEN but with a live payment against it.
    const { payment } = await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '300.00' }],
    }));
    // Voiding the bill now would strand the payment's Dr A/P → refused.
    const err = await voidBill(c.userId, c.companyId, bill, voidBillInput.parse({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillError);
    expect((err as BillError).code).toBe('BILL_HAS_PAYMENTS');
    // Void the payment first, THEN the bill voids cleanly and A/P returns to zero.
    await voidBillPayment(c.userId, c.companyId, payment.id, voidBillPaymentInput.parse({}));
    await voidBill(c.userId, c.companyId, bill, voidBillInput.parse({ reversalDate: '2026-01-25' }));
    expect(await apBalance(c)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('authorization — bill_payment.create pays; bill_payment.void voids', () => {
  it('a BOOKKEEPER can pay but not void; an ACCOUNTANT can void', async () => {
    const c = await setup();
    const bookkeeper = await makeUser();
    const accountant = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    await insertMembership(c.companyId, accountant, 'ACCOUNTANT');
    const bill = await openBill(c, '100.00');
    const { payment } = await payBill(bookkeeper, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-20', cashAccountId: c.cashId,
      applications: [{ billId: bill, amountApplied: '100.00' }],
    }));
    await expect(voidBillPayment(bookkeeper, c.companyId, payment.id, voidBillPaymentInput.parse({}))).rejects.toThrow();
    const { payment: voided } = await voidBillPayment(accountant, c.companyId, payment.id, voidBillPaymentInput.parse({}));
    expect(voided.status).toBe('VOID');
  });
});
