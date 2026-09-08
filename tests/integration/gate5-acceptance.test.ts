/**
 * Gate 5 — Sprint 6 acceptance scenario. Against a real database.
 *
 * Sprint 6 builds the Accounts Payable side as the structural mirror of A/R:
 * VENDORS (LL-060), BILLS + posting (LL-061), BILL PAYMENTS + the A/P control-account
 * lock (LL-062), VENDOR CREDITS (LL-063), the A/P AGING + VENDOR STATEMENT (LL-064),
 * and the A/P UI (LL-065).
 *
 * This is the gate's narrative: one company, two vendors, the full A/P lifecycle —
 * bill → partial payment → vendor credit that clears a bill → partial vendor credit →
 * void the credit → void the payment — asserting at EVERY stage the three-way tie that
 * is the whole point of the subsidiary ledger:
 *
 *     GL A/P control  ==  A/P aging subsidiary total  ==  Σ vendor-statement closings
 *
 * The first equality is GL-T023/T024/T025 (control⇔subsidiary across every A/P mover);
 * the second is GL-T026 (the subsidiary decomposes exactly into per-vendor statements).
 * A/P is credit-natural: a bill is Cr A/P, a payment or vendor credit is Dr A/P, and the
 * trial balance reports the control as a positive magnitude. All money is the service's
 * NUMERIC(19,4) string, compared exactly; nothing is a JS number.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import '@/lib/decimal';
import { toMoney } from '@/lib/decimal';
import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { payBill, voidBillPayment } from '@/server/bill-payments';
import { createBill, finalizeBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { assertLedgerIntegrity } from '@/server/ledger';
import { getApAging, getTrialBalance, getVendorStatement } from '@/server/reports';
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
const PERIOD = { from: '2026-01-01', to: '2026-12-31' } as const;

interface Ctx {
  userId: string;
  companyId: string;
  globexId: string;
  initechId: string;
  suppliesId: string;
  cashId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `g5-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'G' },
    returnHeaders: true,
  });
  const u = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return u.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Gate5 Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const globex = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
  const initech = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Initech' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  return { userId, companyId: company.id, globexId: globex.id, initechId: initech.id, suppliesId: supplies.id, cashId: cash.id };
}

async function openBill(c: Ctx, vendorId: string, price: string, billDate = '2026-01-10'): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId, billDate, lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

async function billStatus(billId: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ status: string }>(sql`select status from bills where id = ${billId}`)).rows[0]!.status;
}

/** The derived GL A/P control balance (from the trial balance). */
async function apControl(c: Ctx): Promise<string> {
  const db = await getTestDb();
  const apId = (await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_PAYABLE' limit 1`,
  )).rows[0]!.id;
  const tb = await getTrialBalance(c.userId, c.companyId, ASOF);
  expect(tb.balanced).toBe(true); // the books balance at every stage
  return tb.rows.find((r) => r.accountId === apId)?.balance ?? '0.0000';
}

/** Σ of every vendor's statement closing balance (the per-vendor decomposition). */
async function sumStatementClosings(c: Ctx): Promise<string> {
  let total = toMoney('0');
  for (const vendorId of [c.globexId, c.initechId]) {
    const s = await getVendorStatement(c.userId, c.companyId, vendorId, PERIOD.from, PERIOD.to);
    total = total.plus(toMoney(s!.closingBalance));
  }
  return total.toFixed(4);
}

/** Assert control == aging subsidiary == Σ statements, and equal to `expected`. */
async function assertThreeWayTie(c: Ctx, expected: string): Promise<void> {
  const control = await apControl(c);
  const aging = (await getApAging(c.userId, c.companyId, ASOF)).totals.total;
  const statements = await sumStatementClosings(c);
  expect(control).toBe(expected);
  expect(aging).toBe(expected);
  expect(statements).toBe(expected);
  await assertLedgerIntegrity(c.companyId);
}

beforeEach(async () => {
  await truncateAll();
});

describe('Gate 5 — Sprint 6 A/P lifecycle reconciles control ⇔ subsidiary ⇔ statements', () => {
  it('holds the three-way tie through bill, payment, vendor credit, void credit, and void payment', async () => {
    const c = await setup();

    // 1. Globex bill #1 $1,000 and #2 $500; Initech bill #3 $300. Control 1,800.
    const bill1 = await openBill(c, c.globexId, '1000.00');
    const bill2 = await openBill(c, c.globexId, '500.00');
    await openBill(c, c.initechId, '300.00');
    await assertThreeWayTie(c, '1800.0000');

    // 2. Pay Globex $400 against #1 (Dr A/P / Cr Cash). Control 1,400. (GL-T024)
    const { payment } = await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.globexId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId: bill1, amountApplied: '400.00' }],
    }));
    await assertThreeWayTie(c, '1400.0000');

    // 3. Vendor credit for the remaining $600 of #1 (Dr A/P / Cr Supplies) → #1 cleared → PAID.
    //    Control 800. (GL-T025: vendor credits move control AND subsidiary together.)
    await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId: bill1, expenseAccountId: c.suppliesId, creditDate: '2026-02-15', amount: '600.00',
    }));
    await assertThreeWayTie(c, '800.0000');
    expect(await billStatus(bill1)).toBe('PAID'); // 400 paid + 600 credited = 1000 → cleared

    // 4. Partial vendor credit $200 on Globex #2. Control 600; #2 stays OPEN.
    const credit2 = await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId: bill2, expenseAccountId: c.suppliesId, creditDate: '2026-03-01', amount: '200.00',
    }));
    await assertThreeWayTie(c, '600.0000');
    expect(await billStatus(bill2)).toBe('OPEN');

    // 5. Void that credit (a reversal, vendor tag preserved). Control back to 800.
    await voidVendorCredit(c.userId, c.companyId, credit2.id, voidVendorCreditInput.parse({ reversalDate: '2026-03-10' }));
    await assertThreeWayTie(c, '800.0000');

    // 6. Void the $400 payment: its Dr A/P reverses, #1 is no longer cleared → back to OPEN
    //    with 400 open (1000 − 600 credit). Control 1,200.
    await voidBillPayment(c.userId, c.companyId, payment.id, voidBillPaymentInput.parse({ reversalDate: '2026-03-15' }));
    await assertThreeWayTie(c, '1200.0000');
    expect(await billStatus(bill1)).toBe('OPEN');
    const open1 = (await getApAging(c.userId, c.companyId, ASOF)).vendors.find((v) => v.vendorId === c.globexId)!.total;
    expect(open1).toBe('900.0000'); // Globex: #1 open 400 + #2 open 500
  });

  it('per-vendor statements each equal that vendor’s A/P slice', async () => {
    const c = await setup();
    // Globex: 1,000 billed, 250 paid, 150 credited → 600. Initech: 300 billed → 300.
    const globexBill = await openBill(c, c.globexId, '1000.00');
    await openBill(c, c.initechId, '300.00');
    await payBill(c.userId, c.companyId, payBillInput.parse({
      vendorId: c.globexId, paymentDate: '2026-02-01', cashAccountId: c.cashId,
      applications: [{ billId: globexBill, amountApplied: '250.00' }],
    }));
    await issueVendorCredit(c.userId, c.companyId, issueVendorCreditInput.parse({
      billId: globexBill, expenseAccountId: c.suppliesId, creditDate: '2026-02-15', amount: '150.00',
    }));

    const globex = (await getVendorStatement(c.userId, c.companyId, c.globexId, PERIOD.from, PERIOD.to))!;
    const initech = (await getVendorStatement(c.userId, c.companyId, c.initechId, PERIOD.from, PERIOD.to))!;
    expect(globex.closingBalance).toBe('600.0000'); // 1000 − 250 − 150
    expect(initech.closingBalance).toBe('300.0000');
    await assertThreeWayTie(c, '900.0000'); // 600 + 300, and control agrees
  });

  it('the A/P control cannot be moved by a manual journal entry — even in raw SQL (0023, structural)', async () => {
    const c = await setup();
    await openBill(c, c.globexId, '100.00');
    const db = await getTestDb();
    const apId = (await db.execute<{ id: string }>(
      sql`select id from accounts where company_id = ${c.companyId} and system_account_type = 'ACCOUNTS_PAYABLE' limit 1`,
    )).rows[0]!.id;
    // Service entirely bypassed: a raw POSTED JOURNAL_ENTRY with a line into A/P. The
    // BEFORE INSERT trigger must refuse the line, so the subsidiary can never drift.
    let rejected = false;
    try {
      await db.transaction(async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number)
          values (${c.companyId}, '2026-02-10', '2026-02-10', 'JOURNAL_ENTRY', ${c.userId}, 'POSTED', 95500)
          returning id`);
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values (${r.rows[0]!.id}, ${c.companyId}, ${apId}, 1, '1.0000', '0.0000')`);
      });
    } catch (e) {
      rejected = true;
      let cur: unknown = e; let text = '';
      while (cur instanceof Error) { text += cur.message; cur = (cur as { cause?: unknown }).cause; }
      expect(text).toMatch(/CONTROL_ACCOUNT_MANUAL_POST/);
    }
    expect(rejected).toBe(true);
    await assertThreeWayTie(c, '100.0000'); // untouched
  });
});
