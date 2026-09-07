/**
 * Bill finalize → post → void — LL-061 (Accounts Payable). Against a real database.
 *
 * Finalizing a DRAFT bill assigns its number, transitions it to OPEN, and posts the
 * balanced entry (Dr Expense by account / Cr Accounts Payable, vendor-tagged) through
 * the ledger — atomically and source-once. Voiding an OPEN bill reverses that entry
 * (netting every account to zero) and marks the bill VOID. The A/P mirror of the
 * invoice-posting suite (LL-042).
 */
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { BillError, computeBillPosting, createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { assertLedgerIntegrity, LedgerError } from '@/server/ledger';
import { closePeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createVendor } from '@/server/vendors';
import { createAccountInput } from '@/validation/account';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { createCompanyInput } from '@/validation/company';
import { createVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  vendorId: string;
  rentId: string;
  suppliesId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `bill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'B' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(chart: 'standard' | 'system-only' = 'standard'): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Bill Co', timezone: 'America/Chicago' }),
    chart,
  );
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex Supply' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent Expense', accountType: 'EXPENSE' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies Expense', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, vendorId: vendor.id, rentId: rent.id, suppliesId: supplies.id };
}

function draft(c: Ctx, lines: { accountId: string; quantity?: string; unitPrice: string }[]) {
  return createBillInput.parse({ vendorId: c.vendorId, billDate: '2026-01-10', lines });
}

async function sysAccount(companyId: string, type: string): Promise<string | null> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]?.id ?? null;
}

/** The lines of the bill's POSTED entry: account, debit, credit, vendor tag. */
async function billEntryLines(companyId: string, billId: string): Promise<{ account_id: string; debit: string; credit: string; vendor_id: string | null }[]> {
  const db = await getTestDb();
  const r = await db.execute<{ account_id: string; debit: string; credit: string; vendor_id: string | null }>(sql`
    select l.account_id, l.debit::text as debit, l.credit::text as credit, l.vendor_id
    from journal_lines l join journal_entries e on e.id = l.journal_entry_id
    where e.company_id = ${companyId} and e.source_type = 'EXPENSE' and e.source_id = ${billId} and e.status = 'POSTED'
    order by l.line_number`);
  return r.rows;
}

const errOf = async (p: Promise<unknown>): Promise<BillError> => {
  try {
    await p;
    throw new Error('expected BillError');
  } catch (e) {
    expect(e).toBeInstanceOf(BillError);
    return e as BillError;
  }
};

async function closePeriodOf(userId: string, companyId: string, date: string): Promise<void> {
  const db = await getTestDb();
  const p = await db.execute<{ id: string }>(sql`
    select id from accounting_periods where company_id = ${companyId} and ${date} between start_date and end_date limit 1`);
  const periodId = p.rows[0]?.id;
  if (periodId === undefined) throw new Error(`no period covering ${date}`);
  await closePeriod(userId, companyId, periodId);
}

beforeEach(async () => {
  await truncateAll();
});

describe('computeBillPosting (pure) — expense grouped by account, balanced', () => {
  it('groups multiple lines to the same account and sums to total', () => {
    const p = computeBillPosting([
      { accountId: 'a', quantity: '2', unitPrice: '10.00' },
      { accountId: 'b', quantity: '1', unitPrice: '5.00' },
      { accountId: 'a', quantity: '1', unitPrice: '3.00' },
    ]);
    expect(p.total).toBe('28.0000');
    expect(p.expenseByAccount).toEqual([
      { accountId: 'a', amount: '23.0000' },
      { accountId: 'b', amount: '5.0000' },
    ]);
  });

  it('rounds each line to 4dp and keeps total = sum(expenseByAccount)', () => {
    const p = computeBillPosting([{ accountId: 'a', quantity: '3', unitPrice: '0.3333' }]);
    const sum = p.expenseByAccount.reduce((acc, e) => acc.plus(e.amount), new Decimal(0));
    expect(sum.toFixed(4)).toBe(p.total);
  });
});

describe('finalize — posts a correct, balanced, source-once entry', () => {
  it('posts Dr Expense by account / Cr A/P (vendor-tagged), opens + numbers the bill', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, draft(c, [
      { accountId: c.rentId, unitPrice: '1000.00' },
      { accountId: c.suppliesId, unitPrice: '250.00' },
    ]));
    const { bill: finalized } = await finalizeBill(c.userId, c.companyId, bill.id);
    expect(finalized.status).toBe('OPEN');
    expect(finalized.billNumber).toBe('1');
    expect(finalized.total).toBe('1250.0000');

    const apId = (await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE'))!;
    const lines = await billEntryLines(c.companyId, bill.id);
    // Two expense debits + one A/P credit, vendor-tagged on the A/P line only.
    const ap = lines.find((l) => l.account_id === apId)!;
    expect(ap.credit).toBe('1250.0000');
    expect(ap.debit).toBe('0.0000');
    expect(ap.vendor_id).toBe(c.vendorId);
    expect(lines.find((l) => l.account_id === c.rentId)!.debit).toBe('1000.0000');
    expect(lines.find((l) => l.account_id === c.suppliesId)!.debit).toBe('250.0000');
    expect(lines.filter((l) => l.vendor_id !== null)).toHaveLength(1); // only the A/P line

    // A/P control (a LIABILITY, credit-natural) now carries the bill total.
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(tb.rows.find((r) => r.accountId === apId)?.balance).toBe('1250.0000');
    expect(tb.balanced).toBe(true);
    await assertLedgerIntegrity(c.companyId);
  });

  it('merges multiple lines on the same expense account into ONE debit line', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, draft(c, [
      { accountId: c.rentId, unitPrice: '100.00' },
      { accountId: c.rentId, unitPrice: '50.00' },
    ]));
    await finalizeBill(c.userId, c.companyId, bill.id);
    const lines = await billEntryLines(c.companyId, bill.id);
    expect(lines.filter((l) => l.account_id === c.rentId)).toHaveLength(1);
    expect(lines.find((l) => l.account_id === c.rentId)!.debit).toBe('150.0000');
  });

  it('finalizing twice is rejected — one posted entry per bill (BILL_NOT_DRAFT)', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '10.00' }]));
    await finalizeBill(c.userId, c.companyId, bill.id);
    expect((await errOf(finalizeBill(c.userId, c.companyId, bill.id))).code).toBe('BILL_NOT_DRAFT');
  });

  it('surfaces a missing Accounts Payable account (AP_ACCOUNT_NOT_CONFIGURED)', async () => {
    const c = await setup();
    const db = await getTestDb();
    await db.execute(sql`update accounts set system_account_type = null where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_PAYABLE'`);
    const { bill } = await createBill(c.userId, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '100.00' }]));
    expect((await errOf(finalizeBill(c.userId, c.companyId, bill.id))).code).toBe('AP_ACCOUNT_NOT_CONFIGURED');
  });

  it('refuses to finalize into a CLOSED period (PERIOD_CLOSED)', async () => {
    const c = await setup();
    // Finalize one bill to create the period, then close it.
    const a = await createBill(c.userId, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '100.00' }]));
    await finalizeBill(c.userId, c.companyId, a.bill.id);
    await closePeriodOf(c.userId, c.companyId, '2026-01-10');
    const b = await createBill(c.userId, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '50.00' }]));
    const err = await finalizeBill(c.userId, c.companyId, b.bill.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe('PERIOD_CLOSED');
  });
});

describe('bill lines cannot post to a system control account', () => {
  it('rejects a line naming the A/P control account (LINE_ACCOUNT_INVALID)', async () => {
    const c = await setup();
    const apId = (await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE'))!;
    expect((await errOf(
      createBill(c.userId, c.companyId, draft(c, [{ accountId: apId, unitPrice: '100.00' }])),
    )).code).toBe('LINE_ACCOUNT_INVALID');
  });
});

describe('void — reverses the entry, nets to zero, marks the bill VOID', () => {
  it('voids an OPEN bill: the reversal returns the A/P control to zero', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '400.00' }]));
    await finalizeBill(c.userId, c.companyId, bill.id);
    const { bill: voided } = await voidBill(c.userId, c.companyId, bill.id, voidBillInput.parse({ reversalDate: '2026-01-20' }));
    expect(voided.status).toBe('VOID');
    const apId = (await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE'))!;
    const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
    expect(tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000').toBe('0.0000');
    await assertLedgerIntegrity(c.companyId);
  });

  it('voiding twice is rejected (BILL_NOT_OPEN)', async () => {
    const c = await setup();
    const { bill } = await createBill(c.userId, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '10.00' }]));
    await finalizeBill(c.userId, c.companyId, bill.id);
    await voidBill(c.userId, c.companyId, bill.id, voidBillInput.parse({}));
    expect((await errOf(voidBill(c.userId, c.companyId, bill.id, voidBillInput.parse({})))).code).toBe('BILL_NOT_OPEN');
  });
});

describe('authorization — expense.create finalizes; bill.void voids', () => {
  it('a BOOKKEEPER can create + finalize but cannot void; an ACCOUNTANT can void', async () => {
    const c = await setup();
    const bookkeeper = await makeUser();
    const accountant = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    await insertMembership(c.companyId, accountant, 'ACCOUNTANT');
    const { bill } = await createBill(bookkeeper, c.companyId, draft(c, [{ accountId: c.rentId, unitPrice: '100.00' }]));
    await finalizeBill(bookkeeper, c.companyId, bill.id); // expense.create — allowed
    await expect(voidBill(bookkeeper, c.companyId, bill.id, voidBillInput.parse({}))).rejects.toThrow(); // bill.void — denied
    const { bill: voided } = await voidBill(accountant, c.companyId, bill.id, voidBillInput.parse({}));
    expect(voided.status).toBe('VOID');
  });
});

describe('tenancy — cross-company ids read as a genuine miss', () => {
  it('finalizing another company’s bill id returns BILL_NOT_FOUND', async () => {
    const a = await setup();
    const b = await setup();
    const { bill } = await createBill(b.userId, b.companyId, draft(b, [{ accountId: b.rentId, unitPrice: '10.00' }]));
    expect((await errOf(finalizeBill(a.userId, a.companyId, bill.id))).code).toBe('BILL_NOT_FOUND');
  });
});
