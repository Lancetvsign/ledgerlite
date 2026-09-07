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
 * Vendor credits — LL-063 (Accounts Payable) — the structural mirror of customer
 * credit memos (LL-051).
 *
 * A vendor credit (debit memo) reduces what we owe a vendor ON A SPECIFIC OPEN BILL —
 * a return or allowance — by posting Dr Accounts Payable (vendor-tagged) / Cr an
 * expense account, through LedgerService (source type VENDOR_CREDIT). It reduces the
 * bill's open balance in the A/P subsidiary — the open balance derives from bills
 * minus non-void bill payments AND vendor credits — so the future A/P aging⇔control
 * reconciliation keeps holding.
 *
 * Scope is credits APPLIED to a bill. Unapplied vendor credit and vendor refunds are
 * deferred. `amount` is a DOCUMENT amount, not a stored balance (invariant 2). Vendor
 * credits are never hard deleted (ADR-006); a mistaken one is VOIDed, which reverses
 * its entry and reopens the bill it had cleared.
 *
 * Tenancy is structural: composite FKs tie a vendor credit to a same-company bill,
 * vendor, and expense account.
 */

export const vendorCreditStatus = pgEnum('vendor_credit_status', ['POSTED', 'VOID']);

export const vendorCredits = pgTable(
  'vendor_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The bill being credited. Composite-FK'd to a same-company bill below. */
    billId: uuid('bill_id').notNull(),
    /** The bill's vendor, denormalized for the vendor-tag FK and reporting. */
    vendorId: uuid('vendor_id').notNull(),
    /** The expense/contra account credited (a return reduces an expense), EXPENSE. */
    expenseAccountId: uuid('expense_account_id').notNull(),
    creditDate: date('credit_date').notNull(),
    /** How much of the bill is credited. A document amount, not a balance. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    reason: text('reason'),
    status: vendorCreditStatus('status').notNull().default('POSTED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint.
    unique('vendor_credits_company_id_id_unique').on(table.companyId, table.id),
    // A vendor credit reduces A/P by a strictly positive amount.
    check('vendor_credits_amount_positive', sql`${table.amount} > 0`),
    // The bill must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.billId],
      foreignColumns: [bills.companyId, bills.id],
      name: 'vendor_credits_bill_same_company_fk',
    }).onDelete('restrict'),
    // The vendor must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.vendorId],
      foreignColumns: [vendors.companyId, vendors.id],
      name: 'vendor_credits_vendor_same_company_fk',
    }).onDelete('restrict'),
    // The expense account must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.expenseAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'vendor_credits_expense_account_same_company_fk',
    }).onDelete('restrict'),
    // The reductions query for a bill's open balance.
    index('vendor_credits_company_bill_idx').on(table.companyId, table.billId),
    index('vendor_credits_company_vendor_idx').on(table.companyId, table.vendorId),
    index('vendor_credits_company_status_idx').on(table.companyId, table.status),
  ],
);

export type VendorCredit = typeof vendorCredits.$inferSelect;
export type VendorCreditStatus = (typeof vendorCreditStatus.enumValues)[number];
