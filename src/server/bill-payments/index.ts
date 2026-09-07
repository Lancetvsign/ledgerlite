import 'server-only';

import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { resolveSystemAccount } from '@/server/accounts';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { LedgerError, postEntryCore, reverseEntryCore } from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';
import { billReductionsExpr, billReductionsTotal } from '@/server/reports/bill-open-balance';

import { BillPaymentError } from './errors';

import type { PoolDatabase } from '@/db';
import type { BillPayment, BillPaymentApplication } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { PayBillInput, VoidBillPaymentInput } from '@/validation/bill-payment';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Bill-payment service — LL-062 (Accounts Payable). The mirror of the payment
 * service (LL-043/045): pay a vendor, applying money to its OPEN bills, and void.
 *
 * Posting is Dr Accounts Payable (vendor-tagged) / Cr the cash account (ADR-015's
 * A/P twin); a fully-paid bill becomes PAID. `amount` is the Σ of applications,
 * ALWAYS service-derived (a document amount, not a balance — invariant 2). Money is
 * a string at every boundary, a `Decimal` only in computation (ADR-004).
 */

export interface BillPaymentWithApplications {
  readonly payment: BillPayment;
  readonly applications: BillPaymentApplication[];
}

export function computeBillPaymentAmount(
  applications: readonly { readonly amountApplied: string }[],
): string {
  return applications
    .reduce((sum, a) => sum.plus(toMoney(a.amountApplied)), new Decimal(0))
    .toFixed(4);
}

export async function payBill(
  actorUserId: string,
  companyId: string,
  input: PayBillInput,
): Promise<BillPaymentWithApplications> {
  await requirePermission(actorUserId, companyId, 'bill_payment.create');

  // A bill may appear at most once in one payment's applications.
  const billIds = input.applications.map((a) => a.billId);
  if (new Set(billIds).size !== billIds.length) {
    throw new BillPaymentError('DUPLICATE_BILL_APPLICATION', 'A bill appears more than once in the applications.');
  }
  const amount = computeBillPaymentAmount(input.applications);

  const period = await getAccountingPeriod(companyId, input.paymentDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${input.paymentDate} is closed.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const apAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_PAYABLE');
    if (apAccountId === null) {
      throw new BillPaymentError('AP_ACCOUNT_NOT_CONFIGURED', 'No Accounts Payable account is configured.');
    }

    // The paid vendor must exist in this company.
    const ven = await tx
      .select({ id: schema.vendors.id })
      .from(schema.vendors)
      .where(and(eq(schema.vendors.companyId, companyId), eq(schema.vendors.id, input.vendorId)))
      .limit(1);
    if (ven[0] === undefined) {
      throw new BillPaymentError('VENDOR_NOT_FOUND', 'That vendor does not exist in this company.');
    }

    // The cash account must be in-company, ACTIVE, and an asset (money leaves there).
    const cashRows = await tx
      .select({
        status: schema.accounts.status,
        accountType: schema.accounts.accountType,
        systemAccountType: schema.accounts.systemAccountType,
      })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.cashAccountId)))
      .limit(1);
    const cash = cashRows[0];
    if (cash === undefined) {
      throw new BillPaymentError('CASH_ACCOUNT_INVALID', 'The cash account does not exist in this company.');
    }
    if (cash.status !== 'ACTIVE') {
      throw new BillPaymentError('CASH_ACCOUNT_INVALID', 'The cash account is inactive.');
    }
    if (cash.accountType !== 'ASSET') {
      throw new BillPaymentError('CASH_ACCOUNT_INVALID', 'A bill payment must pay from an asset account.');
    }
    // The cash account may not be a control account with a subsidiary ledger. Paying
    // "from" A/P (a LIABILITY, already excluded by the ASSET check) would be
    // self-canceling; crediting A/R (an ASSET, so it WOULD pass the ASSET check) would
    // reduce the A/R control through an A/P document, breaking the A/R aging⇔control
    // tie. Both are refused. The cash line (Cr) is client-supplied (AGENTS §6).
    if (cash.systemAccountType === 'ACCOUNTS_RECEIVABLE' || cash.systemAccountType === 'ACCOUNTS_PAYABLE') {
      throw new BillPaymentError('CASH_ACCOUNT_INVALID', 'A bill payment cannot pay from a control account (Accounts Receivable / Payable).');
    }

    // Lock and validate each applied bill; collect those this payment fully pays.
    const fullyPaid: string[] = [];
    for (const app of input.applications) {
      const rows = await tx
        .select()
        .from(schema.bills)
        .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, app.billId)))
        .for('update')
        .limit(1);
      const bill = rows[0];
      if (bill === undefined) {
        throw new BillPaymentError('BILL_NOT_FOUND', 'An applied bill does not exist in this company.');
      }
      if (bill.vendorId !== input.vendorId) {
        throw new BillPaymentError('BILL_WRONG_VENDOR', 'An applied bill belongs to a different vendor.');
      }
      if (bill.status !== 'OPEN') {
        throw new BillPaymentError('BILL_NOT_OPEN', 'Only an open bill can receive a payment.');
      }
      const open = toMoney(bill.total).minus(await billReductionsTotal(tx, companyId, app.billId));
      const applying = toMoney(app.amountApplied);
      if (applying.greaterThan(open)) {
        throw new BillPaymentError(
          'OVERAPPLIED',
          `Applying ${app.amountApplied} exceeds bill ${bill.id}'s open balance ${open.toFixed(4)}.`,
        );
      }
      if (applying.equals(open)) {
        fullyPaid.push(bill.id);
      }
    }

    const paymentRows = await tx
      .insert(schema.billPayments)
      .values({
        companyId,
        vendorId: input.vendorId,
        paymentDate: input.paymentDate,
        amount,
        cashAccountId: input.cashAccountId,
        method: input.method,
        reference: input.reference,
        memo: input.memo,
        status: 'POSTED',
        createdBy: actorUserId,
      })
      .returning();
    const payment = paymentRows[0];
    if (payment === undefined) throw new Error('bill payment insert returned no row');

    await tx.insert(schema.billPaymentApplications).values(
      input.applications.map((a) => ({
        billPaymentId: payment.id,
        companyId,
        billId: a.billId,
        amountApplied: a.amountApplied,
      })),
    );

    // Post: Dr A/P = amount (vendor-tagged) / Cr cash = amount.
    const ledgerLines: PostJournalEntryInput['lines'] = [
      { accountId: apAccountId, debit: amount, credit: '0', vendorId: input.vendorId },
      { accountId: input.cashAccountId, debit: '0', credit: amount },
    ];
    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(`bill payment ${payment.id} posting is unbalanced`);
    }
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: input.paymentDate,
      postingDate: input.paymentDate,
      description: input.reference !== undefined ? `Bill payment ${input.reference}` : 'Bill payment',
      sourceType: 'BILL_PAYMENT',
      sourceId: payment.id,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, input.paymentDate, undefined);

    if (fullyPaid.length > 0) {
      await tx
        .update(schema.bills)
        .set({ status: 'PAID', updatedAt: sql`now()` })
        .where(and(eq(schema.bills.companyId, companyId), inArray(schema.bills.id, fullyPaid), eq(schema.bills.status, 'OPEN')));
    }

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BILL_PAYMENT_MADE',
      entityType: 'bill_payment',
      entityId: payment.id,
      after: { amount, applications: input.applications.length, paidBills: fullyPaid.length },
    });

    return await loadBillPayment(tx, companyId, payment.id);
  });
}

export async function voidBillPayment(
  actorUserId: string,
  companyId: string,
  billPaymentId: string,
  input: VoidBillPaymentInput,
): Promise<BillPaymentWithApplications> {
  await requirePermission(actorUserId, companyId, 'bill_payment.void');

  const pre = await getDbTx()
    .select({ status: schema.billPayments.status })
    .from(schema.billPayments)
    .where(and(eq(schema.billPayments.companyId, companyId), eq(schema.billPayments.id, billPaymentId)))
    .limit(1);
  const preP = pre[0];
  if (preP === undefined) throw new BillPaymentError('BILL_PAYMENT_NOT_FOUND', 'Bill payment not found.');
  if (preP.status !== 'POSTED') {
    throw new BillPaymentError('BILL_PAYMENT_NOT_POSTED', 'Only a posted bill payment can be voided.');
  }

  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new BillPaymentError('BILL_PAYMENT_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.billPayments)
      .where(and(eq(schema.billPayments.companyId, companyId), eq(schema.billPayments.id, billPaymentId)))
      .for('update')
      .limit(1);
    const payment = rows[0];
    if (payment === undefined) throw new BillPaymentError('BILL_PAYMENT_NOT_FOUND', 'Bill payment not found.');
    if (payment.status !== 'POSTED') {
      throw new BillPaymentError('BILL_PAYMENT_NOT_POSTED', 'Only a posted bill payment can be voided.');
    }

    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'BILL_PAYMENT'),
          eq(schema.journalEntries.sourceId, billPaymentId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      throw new Error(`posted bill payment ${billPaymentId} has no journal entry to reverse`);
    }

    // The bills this payment applied to (to revert any that were fully paid).
    const applied = await tx
      .select({ billId: schema.billPaymentApplications.billId })
      .from(schema.billPaymentApplications)
      .where(
        and(
          eq(schema.billPaymentApplications.companyId, companyId),
          eq(schema.billPaymentApplications.billPaymentId, billPaymentId),
        ),
      );
    const appliedBillIds = applied.map((a) => a.billId);
    // Lock the applied bills for the rest of this tx, so PAID→OPEN serialises against
    // a concurrent payment on the same bill (matches the create path's FOR UPDATE).
    if (appliedBillIds.length > 0) {
      await tx
        .select({ id: schema.bills.id })
        .from(schema.bills)
        .where(and(eq(schema.bills.companyId, companyId), inArray(schema.bills.id, appliedBillIds)))
        .for('update');
    }

    // Mark VOID first so this payment's applications drop out of applied totals, then
    // reverse the entry in THIS transaction (both commit together).
    await tx
      .update(schema.billPayments)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.billPayments.companyId, companyId), eq(schema.billPayments.id, billPaymentId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of bill payment ${payment.reference ?? billPaymentId}`,
      },
      reversalDate,
    );

    // Any bill this payment had fully paid is no longer fully paid → back to OPEN.
    if (appliedBillIds.length > 0) {
      await tx
        .update(schema.bills)
        .set({ status: 'OPEN', updatedAt: sql`now()` })
        .where(and(eq(schema.bills.companyId, companyId), inArray(schema.bills.id, appliedBillIds), eq(schema.bills.status, 'PAID')));
    }

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BILL_PAYMENT_VOIDED',
      entityType: 'bill_payment',
      entityId: billPaymentId,
      before: { status: 'POSTED', amount: payment.amount },
      after: { status: 'VOID', reversalDate, reason: input.reason ?? null },
    });

    return await loadBillPayment(tx, companyId, billPaymentId);
  });
}

export async function getBillPayment(
  actorUserId: string,
  companyId: string,
  billPaymentId: string,
): Promise<BillPaymentWithApplications | null> {
  await requirePermission(actorUserId, companyId, 'bill_payment.view');
  const rows = await getDbTx()
    .select({ id: schema.billPayments.id })
    .from(schema.billPayments)
    .where(and(eq(schema.billPayments.companyId, companyId), eq(schema.billPayments.id, billPaymentId)))
    .limit(1);
  if (rows[0] === undefined) return null; // cross-company id reads as a genuine miss
  return await loadBillPayment(getDbTx(), companyId, billPaymentId);
}

/** Company-scoped listing (payment headers). `bill_payment.view`. */
export async function listBillPayments(actorUserId: string, companyId: string): Promise<BillPayment[]> {
  await requirePermission(actorUserId, companyId, 'bill_payment.view');
  return await getDbTx()
    .select()
    .from(schema.billPayments)
    .where(eq(schema.billPayments.companyId, companyId))
    .orderBy(schema.billPayments.paymentDate, schema.billPayments.createdAt);
}

export interface OpenBill {
  readonly id: string;
  readonly billNumber: string | null;
  readonly vendorId: string;
  readonly billDate: string;
  readonly total: string;
  /** total − Σ(amount_applied from non-void bill payments). Derived, never stored. */
  readonly openBalance: string;
}

/**
 * OPEN bills with their open balance, for the bill-payment UI (and the A/P aging,
 * LL-064). The open balance is total − applied-by-non-void-payments, decimal.js from
 * the SQL-summed applied total — never a stored balance (invariant 2). `expense.view`.
 */
export async function listOpenBills(actorUserId: string, companyId: string): Promise<OpenBill[]> {
  await requirePermission(actorUserId, companyId, 'expense.view');
  const rows = await getDbTx().execute<{
    id: string;
    bill_number: string | null;
    vendor_id: string;
    bill_date: string;
    total: string;
    open_balance: string;
  }>(sql`
    select b.id, b.bill_number, b.vendor_id, b.bill_date, b.total,
           (b.total - ${billReductionsExpr(companyId)})::numeric(19,4)::text as open_balance
    from bills b
    where b.company_id = ${companyId} and b.status = 'OPEN'
    order by b.bill_date, b.created_at`);
  return rows.rows.map((r) => ({
    id: r.id,
    billNumber: r.bill_number,
    vendorId: r.vendor_id,
    billDate: r.bill_date,
    total: toMoney(r.total).toFixed(4),
    openBalance: toMoney(r.open_balance).toFixed(4),
  }));
}

async function loadBillPayment(
  tx: Tx | PoolDatabase,
  companyId: string,
  billPaymentId: string,
): Promise<BillPaymentWithApplications> {
  const paymentRows = await tx
    .select()
    .from(schema.billPayments)
    .where(and(eq(schema.billPayments.companyId, companyId), eq(schema.billPayments.id, billPaymentId)))
    .limit(1);
  const payment = paymentRows[0];
  if (payment === undefined) throw new Error('bill payment vanished');
  const applications = await tx
    .select()
    .from(schema.billPaymentApplications)
    .where(eq(schema.billPaymentApplications.billPaymentId, billPaymentId))
    .orderBy(schema.billPaymentApplications.createdAt);
  return { payment, applications };
}

export { BillPaymentError } from './errors';
export type { BillPaymentErrorCode } from './errors';
