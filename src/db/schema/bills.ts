import {
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts';
import { companies, users } from './identity';
import { vendors } from './vendors';

/**
 * Bills — LL-061 (Sprint 6, Accounts Payable) — the structural mirror of invoices
 * (LL-041). A bill is a vendor's invoice to us: finalize posts Dr Expense / Cr A/P
 * (vendor-tagged) and opens the payable.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ STORED TOTAL, BUT NEVER CALLER-SET (ADR-013).                          │
 * │ `total` is stored on the bill but ALWAYS recomputed from the line items │
 * │ with decimal.js and frozen with the lines at finalize — a regression    │
 * │ test asserts stored == recomputed. This is a DOCUMENT total (a property │
 * │ of the bill), NOT an account balance: invariant 2 forbids storing       │
 * │ ACCOUNT balances, and a vendor's open balance is likewise never stored. │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * No tax leg (LL-061 scope): a bill's total is the sum of its expense lines;
 * input-tax tracking is a later ADR-gated ticket. Tenancy is structural: composite
 * FKs tie a bill to a vendor and each line to its bill and expense account, all
 * within one company. Bills are never hard deleted (ADR-006); a mistaken one is
 * VOIDed.
 */

export const billStatus = pgEnum('bill_status', ['DRAFT', 'OPEN', 'PAID', 'VOID']);

export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Composite-FK'd to a same-company vendor below. Required — a bill is owed to someone. */
    vendorId: uuid('vendor_id').notNull(),
    /** Assigned when the bill is finalized (DRAFT→OPEN); unique per company. */
    billNumber: text('bill_number'),
    status: billStatus('status').notNull().default('DRAFT'),
    billDate: date('bill_date').notNull(),
    dueDate: date('due_date'),
    memo: text('memo'),
    // Stored document total — ALWAYS service-derived from the lines (ADR-013).
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — the hook composite FKs (incl. bill_lines) reference.
    unique('bills_company_id_id_unique').on(table.companyId, table.id),
    // Bill numbers unique within a company, when present (NULLs distinct).
    unique('bills_company_number_unique').on(table.companyId, table.billNumber),
    // The bill's vendor must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.vendorId],
      foreignColumns: [vendors.companyId, vendors.id],
      name: 'bills_vendor_same_company_fk',
    }).onDelete('restrict'),
    index('bills_company_status_idx').on(table.companyId, table.status),
    index('bills_company_vendor_idx').on(table.companyId, table.vendorId),
  ],
);

export const billLines = pgTable(
  'bill_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    billId: uuid('bill_id').notNull(),
    companyId: uuid('company_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    description: text('description'),
    /** Quantity — a decimal (e.g. 2.5 hours), NUMERIC(19,4). */
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('1'),
    /** Unit price — money, NUMERIC(19,4). */
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    /** The expense account this line debits (composite-FK'd to a same-company account). */
    accountId: uuid('account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenancy: the line's bill and account must both be in the line's company.
    foreignKey({
      columns: [table.companyId, table.billId],
      foreignColumns: [bills.companyId, bills.id],
      name: 'bill_lines_bill_same_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.companyId, table.accountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'bill_lines_account_same_company_fk',
    }).onDelete('restrict'),
    // Deterministic ordering within a bill.
    unique('bill_lines_bill_line_number_unique').on(table.billId, table.lineNumber),
    // Standing tenancy constraint.
    unique('bill_lines_company_id_id_unique').on(table.companyId, table.id),
    index('bill_lines_company_bill_idx').on(table.companyId, table.billId),
  ],
);

export type Bill = typeof bills.$inferSelect;
export type BillLine = typeof billLines.$inferSelect;
export type BillStatus = (typeof billStatus.enumValues)[number];
