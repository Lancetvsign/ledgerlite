/**
 * GATE 3 — Accounts Receivable manual-acceptance scenario, executed.
 *
 * Sprint 4 built A/R end to end: customers -> invoices -> finalize (post to the
 * ledger) -> payments (apply to A/R) -> void -> aging. This reproduces a full A/R
 * lifecycle on a synthetic company and asserts, at every stage, the two properties
 * the gate certifies:
 *
 *   1. Every document posts the CORRECT double entry through LedgerService
 *      (invoice: Dr A/R / Cr revenue / Cr tax; payment: Dr deposit / Cr A/R), and
 *      void is a REVERSAL, never a mutation.
 *   2. The A/R SUBSIDIARY ledger (the aging's open balances) reconciles EXACTLY to
 *      the general-ledger A/R CONTROL balance derived from journal lines — after
 *      each finalize, each payment, and each void. This is the invariant the
 *      release gate also enforces (GL-T018); here it is walked step by step so the
 *      human reviewer has a precise, reproducible record rather than a hand
 *      computation.
 *
 * Balances below are the natural-direction balances the trial balance derives from
 * journal lines alone. No customer open balance is stored (proven at the end).
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { createCustomer } from '@/server/customers';
import { InvoiceError, createInvoice, finalizeInvoice, voidInvoice } from '@/server/invoices';
import { assertLedgerIntegrity } from '@/server/ledger';
import { receivePayment, voidPayment } from '@/server/payments';
import { getArAging, getTrialBalance } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { voidWriteoff, writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';
import { voidWriteoffInput, writeOffInvoiceInput } from '@/validation/writeoff';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  cashId: string;
  badDebtId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `gate3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'Gate3',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  // 'standard' chart installs the A/R and Sales Tax Payable SYSTEM accounts the
  // posting resolves; we add exactly the revenue and cash accounts the scenario names.
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Receivables Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const badDebt = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Bad Debt Expense', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, cashId: cash.id, badDebtId: badDebt.id };
}

/** The id of a system account (e.g. ACCOUNTS_RECEIVABLE, SALES_TAX_PAYABLE). */
async function systemAccountId(c: Ctx, type: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${c.companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]!.id;
}

/** Derived trial-balance balance for one account id, as of a date. */
async function balanceOf(c: Ctx, accountId: string, asOf: string): Promise<string> {
  const tb = await getTrialBalance(c.userId, c.companyId, asOf);
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}

const AS_OF = '2026-12-31';

async function errOf(p: Promise<unknown>): Promise<InvoiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceError);
    return e as InvoiceError;
  }
  throw new Error('expected an InvoiceError to be thrown');
}

beforeEach(async () => {
  await truncateAll();
});

describe('GATE 3 — A/R lifecycle acceptance; subsidiary reconciles to the GL control at every step', () => {
  it('finalize, partial + full payment, void — every stage posts correctly and aging == derived A/R', async () => {
    const c = await setup();
    const arId = await systemAccountId(c, 'ACCOUNTS_RECEIVABLE');
    const taxId = await systemAccountId(c, 'SALES_TAX_PAYABLE');

    // The reconciliation the whole gate rests on, asserted at each checkpoint:
    // aging grand total  ==  derived A/R control balance.
    const assertReconciles = async (expected: string): Promise<void> => {
      const aging = await getArAging(c.userId, c.companyId, AS_OF);
      const arControl = await balanceOf(c, arId, AS_OF);
      expect(aging.totals.total).toBe(expected);
      expect(arControl).toBe(expected);
      const tb = await getTrialBalance(c.userId, c.companyId, AS_OF);
      expect(tb.balanced).toBe(true); // the books balance at every stage
    };

    // 1) Invoice #1 — $1,000, no tax, due 2026-06-30. -----------------------
    const { invoice: inv1 } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', dueDate: '2026-06-30',
      lines: [{ accountId: c.revId, unitPrice: '1000.00' }],
    }));
    await finalizeInvoice(c.userId, c.companyId, inv1.id);
    // Dr A/R 1,000 / Cr Revenue 1,000.
    expect(await balanceOf(c, arId, AS_OF)).toBe('1000.0000');
    expect(await balanceOf(c, c.revId, AS_OF)).toBe('1000.0000');
    await assertReconciles('1000.0000');

    // 2) Invoice #2 — $500 + 10% tax = $550, due 2026-05-15. ----------------
    const { invoice: inv2 } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
      customerId: c.customerId, invoiceDate: '2026-01-10', dueDate: '2026-05-15',
      lines: [{ accountId: c.revId, unitPrice: '500.00', taxRate: '10' }],
    }));
    await finalizeInvoice(c.userId, c.companyId, inv2.id);
    // Dr A/R 550 / Cr Revenue 500 / Cr Sales Tax Payable 50.
    expect(await balanceOf(c, arId, AS_OF)).toBe('1550.0000');
    expect(await balanceOf(c, c.revId, AS_OF)).toBe('1500.0000'); // 1,000 + 500
    expect(await balanceOf(c, taxId, AS_OF)).toBe('50.0000');
    await assertReconciles('1550.0000');

    // 3) Partial payment — $400 against invoice #1 (Dr Cash / Cr A/R). ------
    const { payment: partial } = await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-06-20', depositAccountId: c.cashId,
      applications: [{ invoiceId: inv1.id, amountApplied: '400.00' }],
    }));
    expect(await balanceOf(c, arId, AS_OF)).toBe('1150.0000'); // 1,550 − 400
    expect(await balanceOf(c, c.cashId, AS_OF)).toBe('400.0000');
    await assertReconciles('1150.0000'); // invoice #1 now shows 600 open, invoice #2 550

    // 4) Full payment — $550 against invoice #2 → invoice #2 becomes PAID. --
    await receivePayment(c.userId, c.companyId, receivePaymentInput.parse({
      customerId: c.customerId, paymentDate: '2026-06-21', depositAccountId: c.cashId,
      applications: [{ invoiceId: inv2.id, amountApplied: '550.00' }],
    }));
    expect(await balanceOf(c, arId, AS_OF)).toBe('600.0000'); // 1,150 − 550
    expect(await balanceOf(c, c.cashId, AS_OF)).toBe('950.0000');
    // A PAID invoice leaves the aging entirely; only invoice #1's 600 remains.
    const agingAfterPaid = await getArAging(c.userId, c.companyId, AS_OF);
    expect(agingAfterPaid.customers[0]!.total).toBe('600.0000');
    await assertReconciles('600.0000');

    // 5) Neither posted invoice can be voided while payments reference it — two
    // distinct guards, both refusing before the books could un-balance:
    //   - invoice #2 is fully paid (PAID), so it is no longer OPEN.
    expect((await errOf(voidInvoice(c.userId, c.companyId, inv2.id, voidInvoiceInput.parse({})))).code)
      .toBe('INVOICE_NOT_OPEN');
    //   - invoice #1 is still OPEN, but a payment is applied against it.
    expect((await errOf(voidInvoice(c.userId, c.companyId, inv1.id, voidInvoiceInput.parse({})))).code)
      .toBe('INVOICE_HAS_PAYMENTS');
    await assertReconciles('600.0000'); // the refusals changed nothing

    // 6) Void the partial payment — a REVERSAL restores the receivable. -----
    const { payment: voided } = await voidPayment(c.userId, c.companyId, partial.id, voidPaymentInput.parse({}));
    expect(voided.status).toBe('VOID'); // the payment is marked VOID, not deleted
    expect(await balanceOf(c, arId, AS_OF)).toBe('1000.0000'); // 600 + 400 back
    expect(await balanceOf(c, c.cashId, AS_OF)).toBe('550.0000'); // 950 − 400
    // Invoice #1 is whole again (1,000 open); invoice #2 stays PAID/excluded.
    const finalAging = await getArAging(c.userId, c.companyId, AS_OF);
    expect(finalAging.customers[0]!.total).toBe('1000.0000');
    await assertReconciles('1000.0000');

    // 7) Bad-debt write-off — the SANCTIONED way to reduce A/R (LL-050). Write off
    // $250 of invoice #1 (Dr Bad Debt Expense / Cr A/R): control and subsidiary drop
    // together, and a void restores them. (A manual journal entry to A/R is instead
    // structurally blocked — LL-050 PR2 / ADR-016.)
    const writeoff = await writeOffInvoice(c.userId, c.companyId, writeOffInvoiceInput.parse({
      invoiceId: inv1.id, expenseAccountId: c.badDebtId, writeoffDate: '2026-06-30', amount: '250.00',
    }));
    expect(await balanceOf(c, arId, AS_OF)).toBe('750.0000'); // 1,000 − 250
    expect(await balanceOf(c, c.badDebtId, AS_OF)).toBe('250.0000'); // Bad Debt Expense
    await assertReconciles('750.0000'); // invoice #1 now shows 750 open

    // Void the write-off — the receivable returns and the books still reconcile.
    const voidedWo = await voidWriteoff(c.userId, c.companyId, writeoff.id, voidWriteoffInput.parse({}));
    expect(voidedWo.status).toBe('VOID');
    await assertReconciles('1000.0000');

    // The full ledger integrity audit passes over everything posted here.
    await assertLedgerIntegrity(c.companyId);
  });

  it('stores no A/R subsidiary balance — the customer open balance is derived, not held', async () => {
    // The aging derives every open balance from invoices + non-void applications
    // (invariant 2). No column on the A/R tables caches a customer balance. The
    // document totals on `invoices` (subtotal/tax_total/total) and a payment's
    // `amount` are properties of the source document, not an account balance.
    const db = await getTestDb();
    const cols = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and table_name in ('customers', 'invoices', 'invoice_lines', 'payments', 'payment_applications', 'writeoffs')
        and (column_name ilike '%balance%' or column_name ilike '%outstanding%'
             or column_name ilike '%running%' or column_name ilike '%cached%')`);
    expect(cols.rows).toEqual([]);
  });
});
