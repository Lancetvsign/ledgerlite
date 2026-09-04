import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts';
import { customers } from './customers';
import { companies, users } from './identity';
import { invoices } from './invoices';

/**
 * Customer payments — LL-043 (Sprint 4, Accounts Receivable).
 *
 * A payment records money received from a customer and applies it to one or more
 * of that customer's OPEN invoices (`payment_applications`). Posting is Dr deposit
 * account / Cr Accounts Receivable (ADR-015); a fully-paid invoice becomes PAID.
 *
 * `amount` is the SUM of the applications, ALWAYS service-derived — a DOCUMENT
 * amount, not an account balance (invariant 2). A customer's open receivable still
 * derives from posted journal lines against A/R, and a per-invoice open balance
 * derives from these applications; neither is stored. Payments are never hard
 * deleted (ADR-006); a mistaken one is VOIDed, which reverses its entry and
 * reverts the invoices it had paid.
 *
 * Tenancy is structural: composite FKs tie a payment to a same-company customer
 * and deposit account, and each application to a same-company payment and invoice.
 */

export const paymentStatus = pgEnum('payment_status', ['POSTED', 'VOID']);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Composite-FK'd to a same-company customer below. Required — a payment is from someone. */
    customerId: uuid('customer_id').notNull(),
    paymentDate: date('payment_date').notNull(),
    /** Σ of the applications, ALWAYS service-derived (ADR-015). A document amount, not a balance. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    /** The asset account the money lands in (Cash / Checking / Undeposited Funds), same-company. */
    depositAccountId: uuid('deposit_account_id').notNull(),
    /** How it was paid — free text (e.g. CHECK, CASH). Optional. */
    method: text('method'),
    /** e.g. a check number. Optional. */
    reference: text('reference'),
    memo: text('memo'),
    status: paymentStatus('status').notNull().default('POSTED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — the hook composite FKs (incl. applications) reference.
    unique('payments_company_id_id_unique').on(table.companyId, table.id),
    // A payment records money IN: its amount is strictly positive.
    check('payments_amount_positive', sql`${table.amount} > 0`),
    // The payment's customer must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.customerId],
      foreignColumns: [customers.companyId, customers.id],
      name: 'payments_customer_same_company_fk',
    }).onDelete('restrict'),
    // The deposit account must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.depositAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'payments_deposit_account_same_company_fk',
    }).onDelete('restrict'),
    index('payments_company_customer_idx').on(table.companyId, table.customerId),
    index('payments_company_status_idx').on(table.companyId, table.status),
  ],
);

export const paymentApplications = pgTable(
  'payment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: uuid('payment_id').notNull(),
    companyId: uuid('company_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    /** How much of this payment is applied to this invoice. Strictly positive. */
    amountApplied: numeric('amount_applied', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenancy: the application's payment and invoice must both be in its company.
    foreignKey({
      columns: [table.companyId, table.paymentId],
      foreignColumns: [payments.companyId, payments.id],
      name: 'payment_applications_payment_same_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.companyId, table.invoiceId],
      foreignColumns: [invoices.companyId, invoices.id],
      name: 'payment_applications_invoice_same_company_fk',
    }).onDelete('restrict'),
    check('payment_applications_amount_positive', sql`${table.amountApplied} > 0`),
    // One application row per (payment, invoice) — a payment applies to an invoice once.
    unique('payment_applications_payment_invoice_unique').on(table.paymentId, table.invoiceId),
    // Standing tenancy constraint.
    unique('payment_applications_company_id_id_unique').on(table.companyId, table.id),
    // The applied-total query for an invoice's open balance.
    index('payment_applications_company_invoice_idx').on(table.companyId, table.invoiceId),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type PaymentApplication = typeof paymentApplications.$inferSelect;
export type PaymentStatus = (typeof paymentStatus.enumValues)[number];
