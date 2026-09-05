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
import { invoiceReductionsExpr, invoiceReductionsTotal } from '@/server/reports/open-balance';

import { PaymentError } from './errors';

import type { PoolDatabase } from '@/db';
import type { Payment, PaymentApplication } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { ReceivePaymentInput, VoidPaymentInput } from '@/validation/payment';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Payment service — LL-043 (Accounts Receivable). Receive a customer payment,
 * apply it to one or more of that customer's OPEN invoices, and post it to the
 * general ledger; void reverses it. ADR-015.
 *
 * A payment posts through `LedgerService` (AGENTS §4.8) exactly like an invoice:
 * Dr the deposit account, Cr Accounts Receivable, source-typed CUSTOMER_PAYMENT
 * and source-once. The payment `amount` is ALWAYS Σ(applications) — derived here,
 * never input (ADR-013/-015). No account or per-invoice balance is stored; a
 * customer's receivable derives from journal lines and an invoice's open balance
 * from the applications. Authorization is `payment.create` (ALL_WRITERS incl.
 * BOOKKEEPER); the posting goes through `postEntryCore`, which does not re-gate on
 * `journal.post`, so a bookkeeper who works documents is not blocked.
 */

export interface PaymentWithApplications {
  readonly payment: Payment;
  readonly applications: PaymentApplication[];
}

/** The one place a payment's amount is computed: Σ of the applications (decimal.js). */
export function computePaymentAmount(
  applications: readonly { readonly amountApplied: string }[],
): string {
  return applications
    .reduce((sum, a) => sum.plus(toMoney(a.amountApplied)), new Decimal(0))
    .toFixed(4);
}

export async function receivePayment(
  actorUserId: string,
  companyId: string,
  input: ReceivePaymentInput,
): Promise<PaymentWithApplications> {
  await requirePermission(actorUserId, companyId, 'payment.create');

  // An invoice may appear at most once in one payment's applications.
  const invoiceIds = input.applications.map((a) => a.invoiceId);
  if (new Set(invoiceIds).size !== invoiceIds.length) {
    throw new PaymentError(
      'DUPLICATE_INVOICE_APPLICATION',
      'An invoice appears more than once in the applications.',
    );
  }
  const amount = computePaymentAmount(input.applications);

  // Resolve-and-create the posting period BEFORE the tx (never lazily inside — a
  // concurrent create races the exclusion constraint, LL-032).
  const period = await getAccountingPeriod(companyId, input.paymentDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${input.paymentDate} is closed.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const arAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_RECEIVABLE');
    if (arAccountId === null) {
      throw new PaymentError('AR_ACCOUNT_NOT_CONFIGURED', 'No Accounts Receivable account is configured.');
    }

    // The paying customer must exist in this company.
    const cust = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, input.customerId)))
      .limit(1);
    if (cust[0] === undefined) {
      throw new PaymentError('CUSTOMER_NOT_FOUND', 'That customer does not exist in this company.');
    }

    // The deposit account must be in-company, ACTIVE, and an asset (money lands there).
    const dep = await tx
      .select({ status: schema.accounts.status, accountType: schema.accounts.accountType })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.depositAccountId)))
      .limit(1);
    const deposit = dep[0];
    if (deposit === undefined) {
      throw new PaymentError('DEPOSIT_ACCOUNT_INVALID', 'The deposit account does not exist in this company.');
    }
    if (deposit.status !== 'ACTIVE') {
      throw new PaymentError('DEPOSIT_ACCOUNT_INVALID', 'The deposit account is inactive.');
    }
    if (deposit.accountType !== 'ASSET') {
      throw new PaymentError('DEPOSIT_ACCOUNT_INVALID', 'A payment must deposit into an asset account.');
    }
    // A/R is an asset, but depositing there would post Dr A/R / Cr A/R — a
    // self-canceling entry that marks the invoice PAID without reducing the
    // receivable. The money must land somewhere other than A/R.
    if (input.depositAccountId === arAccountId) {
      throw new PaymentError('DEPOSIT_ACCOUNT_INVALID', 'A payment cannot deposit into Accounts Receivable.');
    }

    // Lock and validate each applied invoice; collect those this payment fully pays.
    const fullyPaid: string[] = [];
    for (const app of input.applications) {
      const rows = await tx
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, app.invoiceId)))
        .for('update')
        .limit(1);
      const invoice = rows[0];
      if (invoice === undefined) {
        throw new PaymentError('INVOICE_NOT_FOUND', 'An applied invoice does not exist in this company.');
      }
      if (invoice.customerId !== input.customerId) {
        throw new PaymentError('INVOICE_WRONG_CUSTOMER', 'An applied invoice belongs to a different customer.');
      }
      if (invoice.status !== 'OPEN') {
        throw new PaymentError('INVOICE_NOT_OPEN', 'Only an open invoice can receive a payment.');
      }
      const open = toMoney(invoice.total).minus(await invoiceReductionsTotal(tx, companyId, app.invoiceId));
      const applying = toMoney(app.amountApplied);
      if (applying.greaterThan(open)) {
        throw new PaymentError(
          'OVERAPPLIED',
          `Applying ${app.amountApplied} exceeds invoice ${invoice.id}'s open balance ${open.toFixed(4)}.`,
        );
      }
      // Fully paid exactly when this application clears the remaining open balance.
      if (applying.equals(open)) {
        fullyPaid.push(invoice.id);
      }
    }

    const paymentRows = await tx
      .insert(schema.payments)
      .values({
        companyId,
        customerId: input.customerId,
        paymentDate: input.paymentDate,
        amount,
        depositAccountId: input.depositAccountId,
        method: input.method,
        reference: input.reference,
        memo: input.memo,
        status: 'POSTED',
        createdBy: actorUserId,
      })
      .returning();
    const payment = paymentRows[0];
    if (payment === undefined) throw new Error('payment insert returned no row');

    await tx.insert(schema.paymentApplications).values(
      input.applications.map((a) => ({
        paymentId: payment.id,
        companyId,
        invoiceId: a.invoiceId,
        amountApplied: a.amountApplied,
      })),
    );

    // Post: Dr deposit = amount, Cr A/R = amount (A/R line tagged with the customer).
    const ledgerLines: PostJournalEntryInput['lines'] = [
      { accountId: input.depositAccountId, debit: amount, credit: '0' },
      { accountId: arAccountId, debit: '0', credit: amount, customerId: input.customerId },
    ];
    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(`payment ${payment.id} posting is unbalanced`);
    }
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: input.paymentDate,
      postingDate: input.paymentDate,
      description: input.reference !== undefined ? `Payment ${input.reference}` : 'Customer payment',
      sourceType: 'CUSTOMER_PAYMENT',
      sourceId: payment.id,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, input.paymentDate, undefined);

    if (fullyPaid.length > 0) {
      await tx
        .update(schema.invoices)
        .set({ status: 'PAID', updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.invoices.companyId, companyId),
            inArray(schema.invoices.id, fullyPaid),
            eq(schema.invoices.status, 'OPEN'),
          ),
        );
    }

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'PAYMENT_RECEIVED',
      entityType: 'payment',
      entityId: payment.id,
      after: { amount, applications: input.applications.length, paidInvoices: fullyPaid.length },
    });

    return await loadPayment(tx, companyId, payment.id);
  });
}

export async function voidPayment(
  actorUserId: string,
  companyId: string,
  paymentId: string,
  input: VoidPaymentInput,
): Promise<PaymentWithApplications> {
  await requirePermission(actorUserId, companyId, 'payment.create');

  const pre = await getDbTx()
    .select({ status: schema.payments.status })
    .from(schema.payments)
    .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.id, paymentId)))
    .limit(1);
  const preP = pre[0];
  if (preP === undefined) throw new PaymentError('PAYMENT_NOT_FOUND', 'Payment not found.');
  if (preP.status !== 'POSTED') {
    throw new PaymentError('PAYMENT_NOT_POSTED', 'Only a posted payment can be voided.');
  }

  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new PaymentError('PAYMENT_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.payments)
      .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.id, paymentId)))
      .for('update')
      .limit(1);
    const payment = rows[0];
    if (payment === undefined) throw new PaymentError('PAYMENT_NOT_FOUND', 'Payment not found.');
    if (payment.status !== 'POSTED') {
      throw new PaymentError('PAYMENT_NOT_POSTED', 'Only a posted payment can be voided.');
    }

    // Its posted entry — unique via the source-once index.
    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'CUSTOMER_PAYMENT'),
          eq(schema.journalEntries.sourceId, paymentId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      throw new Error(`posted payment ${paymentId} has no journal entry to reverse`);
    }

    // The invoices this payment applied to (to revert any that were fully paid).
    const applied = await tx
      .select({ invoiceId: schema.paymentApplications.invoiceId })
      .from(schema.paymentApplications)
      .where(
        and(
          eq(schema.paymentApplications.companyId, companyId),
          eq(schema.paymentApplications.paymentId, paymentId),
        ),
      );

    // Mark VOID first so this payment's applications drop out of applied totals,
    // then reverse the entry in THIS transaction (both commit together).
    await tx
      .update(schema.payments)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.id, paymentId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of payment ${payment.reference ?? paymentId}`,
      },
      reversalDate,
    );

    // Any invoice this payment had fully paid is no longer fully paid → back to OPEN.
    const appliedInvoiceIds = applied.map((a) => a.invoiceId);
    if (appliedInvoiceIds.length > 0) {
      await tx
        .update(schema.invoices)
        .set({ status: 'OPEN', updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.invoices.companyId, companyId),
            inArray(schema.invoices.id, appliedInvoiceIds),
            eq(schema.invoices.status, 'PAID'),
          ),
        );
    }

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'PAYMENT_VOIDED',
      entityType: 'payment',
      entityId: paymentId,
      before: { status: 'POSTED', amount: payment.amount },
      after: { status: 'VOID', reversalDate, reason: input.reason ?? null },
    });

    return await loadPayment(tx, companyId, paymentId);
  });
}

export async function getPayment(
  actorUserId: string,
  companyId: string,
  paymentId: string,
): Promise<PaymentWithApplications | null> {
  await requirePermission(actorUserId, companyId, 'payment.view');
  const rows = await getDbTx()
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.id, paymentId)))
    .limit(1);
  if (rows[0] === undefined) return null; // cross-company id reads as a genuine miss
  return await loadPayment(getDbTx(), companyId, paymentId);
}

/** Company-scoped listing (payment headers). `payment.view`. */
export async function listPayments(actorUserId: string, companyId: string): Promise<Payment[]> {
  await requirePermission(actorUserId, companyId, 'payment.view');
  return await getDbTx()
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.companyId, companyId))
    .orderBy(schema.payments.paymentDate, schema.payments.createdAt);
}

export interface OpenInvoice {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly customerId: string;
  readonly invoiceDate: string;
  readonly total: string;
  /** total − Σ(amount_applied from non-void payments). Derived, never stored. */
  readonly openBalance: string;
}

/**
 * OPEN invoices with their open balance, for the payment-application UI (and the
 * LL-046 aging report). The open balance is total − applied-by-non-void-payments,
 * computed with decimal.js (ADR-004) from the SQL-summed applied total — never a
 * stored balance (invariant 2). `invoice.view`.
 */
export async function listOpenInvoices(actorUserId: string, companyId: string): Promise<OpenInvoice[]> {
  await requirePermission(actorUserId, companyId, 'invoice.view');
  const rows = await getDbTx().execute<{
    id: string;
    invoice_number: string | null;
    customer_id: string;
    invoice_date: string;
    total: string;
    open_balance: string;
  }>(sql`
    select i.id, i.invoice_number, i.customer_id, i.invoice_date, i.total,
           (i.total - ${invoiceReductionsExpr(companyId)})::numeric(19,4)::text as open_balance
    from invoices i
    where i.company_id = ${companyId} and i.status = 'OPEN'
    order by i.invoice_date, i.created_at`);
  return rows.rows.map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    customerId: r.customer_id,
    invoiceDate: r.invoice_date,
    total: toMoney(r.total).toFixed(4),
    openBalance: toMoney(r.open_balance).toFixed(4),
  }));
}

async function loadPayment(
  tx: Tx | PoolDatabase,
  companyId: string,
  paymentId: string,
): Promise<PaymentWithApplications> {
  const paymentRows = await tx
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.companyId, companyId), eq(schema.payments.id, paymentId)))
    .limit(1);
  const payment = paymentRows[0];
  if (payment === undefined) throw new Error('payment vanished');
  const applications = await tx
    .select()
    .from(schema.paymentApplications)
    .where(eq(schema.paymentApplications.paymentId, paymentId))
    .orderBy(schema.paymentApplications.createdAt);
  return { payment, applications };
}

export { PaymentError } from './errors';
export type { PaymentErrorCode } from './errors';
