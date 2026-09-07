/**
 * Vendor credits — LL-063 (Accounts Payable). Against a real database.
 *
 * A vendor credit against an OPEN bill (whole or part) posts Dr Accounts Payable
 * (vendor-tagged) / Cr an expense account and reduces that bill's open balance in the
 * A/P subsidiary — so the A/P aging⇔control reconciliation keeps holding (GL-T023/T025).
 * A vendor credit that clears the bill marks it PAID; voiding reverses the entry and
 * reopens the bill. These tests prove the accounting is exact (the A/P mirror of the
 * credit-memo suite), the guards hold, the subsidiary reflects the credit, the voidBill
 * BILL_HAS_ADJUSTMENTS guard is in place, and tenancy is safe.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount, deactivateAccount } from '@/server/accounts';
import { payBill, listOpenBills } from '@/server/bill-payments';
import { BillError, createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createVendor } from '@/server/vendors';
import { LedgerError, assertLedgerIntegrity } from '@/server/ledger';
import { closePeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import {
  VendorCreditError,
  getVendorCredit,
  issueVendorCredit,
  listVendorCredits,
  voidVendorCredit,
} from '@/server/vendor-credits';
import { createAccountInput } from '@/validation/account';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { payBillInput } from '@/validation/bill-payment';
import { createCompanyInput } from '@/validation/company';
import { createVendorInput } from '@/validation/vendor';
import { issueVendorCreditInput, voidVendorCreditInput } from '@/validation/vendor-credit';

import { getTestDb, truncateAll } from '../helpers/database';
import { assertLedgerIntact, assertReversalNetsToZero } from '../helpers/ledger-invariants';

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
      email: `vc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'V',
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
    createCompanyInput.parse({ legalName: 'Vendor Credit Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, vendorId: vendor.id, suppliesId: supplies.id, cashId: cash.id };
}

/** Create and finalize a bill for `unitPrice`; returns its id (OPEN). */
async function openBill(c: Ctx, unitPrice: string): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId: c.vendorId,
    billDate: '2026-01-10',
    lines: [{ accountId: c.suppliesId, quantity: '1', unitPrice }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]!.id;
}

type EntryRow = { id: string; status: string; source_type: string; reversal_of_id: string | null };
async function creditEntries(companyId: string, creditId: string): Promise<EntryRow[]> {
  const db = await getTestDb();
  const r = await db.execute<EntryRow>(sql`
    select id, status, source_type, reversal_of_id
    from journal_entries
    where company_id = ${companyId}
      and (source_id = ${creditId}
           or reversal_of_id in (select id from journal_entries where company_id = ${companyId} and source_id = ${creditId}))
    order by entry_number`);
  return r.rows;
}

async function linesOf(entryId: string): Promise<{ account_id: string; debit: string; credit: string; vendor_id: string | null }[]> {
  const db = await getTestDb();
  const r = await db.execute<{ account_id: string; debit: string; credit: string; vendor_id: string | null }>(
    sql`select account_id, debit, credit, vendor_id from journal_lines where journal_entry_id = ${entryId} order by line_number`,
  );
  return r.rows;
}

async function billStatus(companyId: string, billId: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ status: string }>(
    sql`select status from bills where company_id = ${companyId} and id = ${billId}`,
  );
  return r.rows[0]!.status;
}

async function apBalance(c: Ctx): Promise<string> {
  const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  return tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';
}

async function auditCount(companyId: string, action: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from audit_events where company_id = ${companyId} and action = ${action}`,
  );
  return Number(r.rows[0]?.n);
}

const vcErr = async (p: Promise<unknown>): Promise<VendorCreditError> => {
  try {
    await p;
    throw new Error('expected VendorCreditError');
  } catch (e) {
    expect(e).toBeInstanceOf(VendorCreditError);
    return e as VendorCreditError;
  }
};

const billErr = async (p: Promise<unknown>): Promise<BillError> => {
  try {
    await p;
    throw new Error('expected BillError');
  } catch (e) {
    expect(e).toBeInstanceOf(BillError);
    return e as BillError;
  }
};

const vc = (c: Ctx, billId: string, amount: string, extra: Record<string, unknown> = {}) =>
  issueVendorCreditInput.parse({ billId, expenseAccountId: c.suppliesId, creditDate: '2026-02-01', amount, ...extra });

beforeEach(async () => {
  await truncateAll();
});

describe('issueVendorCredit — posts Dr A/P / Cr expense and reduces the subsidiary', () => {
  it('a full vendor credit posts the entry, marks the bill PAID, and clears A/P', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    expect(await apBalance(c)).toBe('100.0000');

    const credit = await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '100.00', { reason: 'returned goods' }));
    expect(credit.amount).toBe('100.0000');
    expect(credit.status).toBe('POSTED');
    expect(credit.vendorId).toBe(c.vendorId); // derived from the bill

    const entries = await creditEntries(c.companyId, credit.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_type).toBe('VENDOR_CREDIT');
    const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
    const lines = await linesOf(entries[0]!.id);
    const ap = lines.find((l) => l.account_id === apId);
    expect(ap?.debit).toBe('100.0000'); // Dr A/P reduces the payable
    expect(ap?.vendor_id).toBe(c.vendorId); // A/P line is vendor-tagged (subsidiary sees it)
    expect(lines.find((l) => l.account_id === c.suppliesId)?.credit).toBe('100.0000'); // Cr expense

    expect(await billStatus(c.companyId, billId)).toBe('PAID'); // settled
    expect(await apBalance(c)).toBe('0.0000');
    expect(await auditCount(c.companyId, 'VENDOR_CREDIT_ISSUED')).toBe(1);
    await assertLedgerIntact(c.companyId);
    await assertLedgerIntegrity(c.companyId);
  });

  it('a partial vendor credit leaves the bill OPEN and reduces its open balance', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '30.00'));

    expect(await billStatus(c.companyId, billId)).toBe('OPEN');
    expect(await apBalance(c)).toBe('70.0000'); // 100 − 30
    const open = await listOpenBills(c.userId, c.companyId);
    expect(open.find((o) => o.id === billId)?.openBalance).toBe('70.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a bill payment and a vendor credit together clear one bill; the open balance respects both', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.vendorId, paymentDate: '2026-01-15', cashAccountId: c.cashId,
      applications: [{ billId, amountApplied: '60.00' }],
    }));
    expect(await apBalance(c)).toBe('40.0000');
    // Crediting 41 would exceed the remaining open balance.
    expect((await vcErr(issueVendorCredit(c.userId, c.companyId, vc(c, billId, '41.00')))).code).toBe('CREDIT_EXCEEDS_BALANCE');
    // Crediting exactly 40 settles it.
    await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '40.00'));
    expect(await billStatus(c.companyId, billId)).toBe('PAID');
    expect(await apBalance(c)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('getVendorCredit returns it; listVendorCredits lists it; a cross-company id is a genuine miss', async () => {
    const c = await setup();
    const billId = await openBill(c, '50.00');
    const credit = await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '50.00'));
    expect((await getVendorCredit(c.userId, c.companyId, credit.id))?.id).toBe(credit.id);
    expect((await listVendorCredits(c.userId, c.companyId)).map((m) => m.id)).toContain(credit.id);
    const other = await setup();
    expect(await getVendorCredit(other.userId, other.companyId, credit.id)).toBeNull();
  });

  it('a BOOKKEEPER (vendor_credit.create) can issue a vendor credit', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const credit = await issueVendorCredit(bookkeeper, c.companyId, vc(c, billId, '100.00'));
    expect(credit.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('issueVendorCredit — guards', () => {
  it('rejects crediting a DRAFT bill (BILL_NOT_OPEN)', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
      vendorId: c.vendorId, billDate: '2026-01-10', lines: [{ accountId: c.suppliesId, unitPrice: '100.00' }],
    }));
    expect((await vcErr(issueVendorCredit(c.userId, c.companyId, vc(c, bill.id, '100.00')))).code).toBe('BILL_NOT_OPEN');
  });

  it('rejects amount exceeding the open balance (CREDIT_EXCEEDS_BALANCE)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    expect((await vcErr(issueVendorCredit(c.userId, c.companyId, vc(c, billId, '100.01')))).code).toBe('CREDIT_EXCEEDS_BALANCE');
  });

  it('rejects a non-expense account (CREDIT_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    // Cash is an ASSET, not an expense account — cannot be the vendor credit's credit leg.
    expect((await vcErr(issueVendorCredit(c.userId, c.companyId,
      issueVendorCreditInput.parse({ billId, expenseAccountId: c.cashId, creditDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('CREDIT_ACCOUNT_INVALID');
  });

  it('rejects an inactive expense account (CREDIT_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const stale = await createAccount(c.userId, c.companyId, createAccountInput.parse({ name: 'Stale Expense', accountType: 'EXPENSE' }));
    await deactivateAccount(c.userId, c.companyId, stale.id);
    expect((await vcErr(issueVendorCredit(c.userId, c.companyId,
      issueVendorCreditInput.parse({ billId, expenseAccountId: stale.id, creditDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('CREDIT_ACCOUNT_INVALID');
  });

  it('refuses to credit into a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00'); // finalize at 2026-01-10 creates the Jan period
    const db = await getTestDb();
    const p = await db.execute<{ id: string }>(sql`
      select id from accounting_periods where company_id = ${c.companyId} and '2026-01-15' between start_date and end_date limit 1`);
    await closePeriod(c.userId, c.companyId, p.rows[0]!.id);
    const err = await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '100.00', { creditDate: '2026-01-15' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('PERIOD_CLOSED');
  });

  it('a cross-company bill id is a genuine miss (BILL_NOT_FOUND)', async () => {
    const a = await setup();
    const b = await setup();
    const billId = await openBill(a, '100.00');
    expect((await vcErr(issueVendorCredit(b.userId, b.companyId,
      issueVendorCreditInput.parse({ billId, expenseAccountId: b.suppliesId, creditDate: '2026-02-01', amount: '100.00' }),
    ))).code).toBe('BILL_NOT_FOUND');
  });
});

describe('voidVendorCredit — reverses the entry and reopens the bill', () => {
  it('voids a vendor credit: reversal nets to zero, credit VOID, PAID bill back to OPEN, A/P restored', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const credit = await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '100.00'));
    expect(await billStatus(c.companyId, billId)).toBe('PAID');

    const voided = await voidVendorCredit(c.userId, c.companyId, credit.id, voidVendorCreditInput.parse({ reason: 'issued in error' }));
    expect(voided.status).toBe('VOID');

    const entries = await creditEntries(c.companyId, credit.id);
    const original = entries.find((e) => e.source_type === 'VENDOR_CREDIT')!;
    const reversal = entries.find((e) => e.source_type === 'REVERSAL')!;
    expect(original.status).toBe('REVERSED');
    await assertReversalNetsToZero(original.id, reversal.id);

    // The reversal's A/P line must stay VENDOR-TAGGED (Cr A/P un-reduces the payable):
    // the vendor's A/P subsidiary un-reduces with the control, not just the control total.
    const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
    const reversalAp = (await linesOf(reversal.id)).find((l) => l.account_id === apId);
    expect(reversalAp?.credit).toBe('100.0000');
    expect(reversalAp?.vendor_id).toBe(c.vendorId);

    expect(await billStatus(c.companyId, billId)).toBe('OPEN'); // reopened
    expect(await apBalance(c)).toBe('100.0000'); // payable is owed again
    expect(await auditCount(c.companyId, 'VENDOR_CREDIT_VOIDED')).toBe(1);
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (VENDOR_CREDIT_NOT_POSTED)', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const credit = await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '40.00'));
    await voidVendorCredit(c.userId, c.companyId, credit.id, voidVendorCreditInput.parse({}));
    expect((await vcErr(voidVendorCredit(c.userId, c.companyId, credit.id, voidVendorCreditInput.parse({})))).code).toBe('VENDOR_CREDIT_NOT_POSTED');
  });

  it('a BOOKKEEPER cannot void (vendor_credit.void is LEDGER_WRITERS); an ACCOUNTANT can', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const credit = await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '40.00'));

    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    await expect(voidVendorCredit(bookkeeper, c.companyId, credit.id, voidVendorCreditInput.parse({}))).rejects.toThrow();

    const accountant = await makeUser();
    await insertMembership(c.companyId, accountant, 'ACCOUNTANT');
    const voided = await voidVendorCredit(accountant, c.companyId, credit.id, voidVendorCreditInput.parse({}));
    expect(voided.status).toBe('VOID');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('voidBill — BILL_HAS_ADJUSTMENTS guard (the reduction-source completion)', () => {
  it('refuses to void a bill with a live vendor credit; succeeds once the credit is voided', async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    await issueVendorCredit(c.userId, c.companyId, vc(c, billId, '30.00')); // bill still OPEN (70 remains)

    // Voiding the bill now would reverse its FULL A/P while the credit's Dr A/P remained,
    // driving A/P negative — the guard refuses it.
    expect((await billErr(voidBill(c.userId, c.companyId, billId, voidBillInput.parse({})))).code).toBe('BILL_HAS_ADJUSTMENTS');

    // Void the credit first, then the bill voids cleanly and A/P returns to zero.
    const credit = (await listVendorCredits(c.userId, c.companyId))[0]!;
    await voidVendorCredit(c.userId, c.companyId, credit.id, voidVendorCreditInput.parse({}));
    const { bill: voided } = await voidBill(c.userId, c.companyId, billId, voidBillInput.parse({}));
    expect(voided.status).toBe('VOID');
    expect(await apBalance(c)).toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });
});
