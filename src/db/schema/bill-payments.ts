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
import { bills } from './bills';
import { companies, users } from './identity';
import { vendors } from './vendors';

/**
 * Bill payments — LL-062 (Accounts Payable) — the structural mirror of customer
 * payments (LL-043).
 *
 * A bill payment records money paid to a vendor and applies it to one or more of
 * that vendor's OPEN bills (`bill_payment_applications`). Posting is Dr Accounts
 * Payable / Cr the cash (asset) account the money leaves; a fully-paid bill becomes
 * PAID.
 *
 * `amount` is the SUM of the applications, ALWAYS service-derived — a DOCUMENT
 * amount, not an account balance (invariant 2). A vendor's open payable still
 * derives from posted journal lines against A/P, and a per-bill open balance
 * derives from these applications; neither is stored. Bill payments are never hard
 * deleted (ADR-006); a mistaken one is VOIDed, which reverses its entry and reverts
 * the bills it had paid.
 *
 * Tenancy is structural: composite FKs tie a payment to a same-company vendor and
 * cash account, and each application to a same-company payment and bill.
 */

export const billPaymentStatus = pgEnum('bill_payment_status', ['POSTED', 'VOID']);

export const billPayments = pgTable(
  'bill_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Composite-FK'd to a same-company vendor below. Required — a payment is to someone. */
    vendorId: uuid('vendor_id').notNull(),
    paymentDate: date('payment_date').notNull(),
    /** Σ of the applications, ALWAYS service-derived. A document amount, not a balance. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    /** The asset account the money leaves (Cash / Checking), same-company. */
    cashAccountId: uuid('cash_account_id').notNull(),
    /** How it was paid — free text (e.g. CHECK, ACH). Optional. */
    method: text('method'),
    /** e.g. a check number. Optional. */
    reference: text('reference'),
    memo: text('memo'),
    status: billPaymentStatus('status').notNull().default('POSTED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — the hook composite FKs (incl. applications) reference.
    unique('bill_payments_company_id_id_unique').on(table.companyId, table.id),
    // A bill payment records money OUT: its amount is strictly positive.
    check('bill_payments_amount_positive', sql`${table.amount} > 0`),
    // The payment's vendor must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.vendorId],
      foreignColumns: [vendors.companyId, vendors.id],
      name: 'bill_payments_vendor_same_company_fk',
    }).onDelete('restrict'),
    // The cash account must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.cashAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'bill_payments_cash_account_same_company_fk',
    }).onDelete('restrict'),
    index('bill_payments_company_vendor_idx').on(table.companyId, table.vendorId),
    index('bill_payments_company_status_idx').on(table.companyId, table.status),
  ],
);

export const billPaymentApplications = pgTable(
  'bill_payment_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    billPaymentId: uuid('bill_payment_id').notNull(),
    companyId: uuid('company_id').notNull(),
    billId: uuid('bill_id').notNull(),
    /** How much of this payment is applied to this bill. Strictly positive. */
    amountApplied: numeric('amount_applied', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenancy: the application's payment and bill must both be in its company.
    foreignKey({
      columns: [table.companyId, table.billPaymentId],
      foreignColumns: [billPayments.companyId, billPayments.id],
      name: 'bill_payment_applications_payment_same_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.companyId, table.billId],
      foreignColumns: [bills.companyId, bills.id],
      name: 'bill_payment_applications_bill_same_company_fk',
    }).onDelete('restrict'),
    check('bill_payment_applications_amount_positive', sql`${table.amountApplied} > 0`),
    // One application row per (payment, bill) — a payment applies to a bill once.
    unique('bill_payment_applications_payment_bill_unique').on(table.billPaymentId, table.billId),
    // Standing tenancy constraint.
    unique('bill_payment_applications_company_id_id_unique').on(table.companyId, table.id),
    // The applied-total query for a bill's open balance.
    index('bill_payment_applications_company_bill_idx').on(table.companyId, table.billId),
  ],
);

export type BillPayment = typeof billPayments.$inferSelect;
export type BillPaymentApplication = typeof billPaymentApplications.$inferSelect;
export type BillPaymentStatus = (typeof billPaymentStatus.enumValues)[number];
