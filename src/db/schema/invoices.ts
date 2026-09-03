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
import { customers } from './customers';
import { companies, users } from './identity';

/**
 * Invoices — LL-041 (Sprint 4, Accounts Receivable).
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ STORED TOTALS, BUT NEVER CALLER-SET (ADR-013).                        │
 * │                                                                        │
 * │ subtotal / tax_total / total are stored on the invoice, but they are  │
 * │ ALWAYS recomputed from the line items with decimal.js by the service  │
 * │ and frozen with the lines at finalize — no input carries a total, and │
 * │ a regression test asserts stored == recomputed. This is a DOCUMENT    │
 * │ total (a property of the invoice), NOT an account balance: invariant  │
 * │ 2 forbids storing ACCOUNT balances (those still derive from journal   │
 * │ lines), and a customer's open balance is likewise never stored here.  │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Tenancy is structural: composite FKs tie an invoice to a customer, and each
 * line to its invoice and to the revenue account it credits, all within the same
 * company — a cross-tenant reference is impossible. Invoices are never hard
 * deleted (ADR-006); a mistaken one is VOIDed (LL-042).
 */

export const invoiceStatus = pgEnum('invoice_status', ['DRAFT', 'OPEN', 'PAID', 'VOID']);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Composite-FK'd to a same-company customer below. Required — an invoice bills someone. */
    customerId: uuid('customer_id').notNull(),
    /** Assigned when the invoice is finalized (DRAFT→OPEN, LL-042); unique per company. */
    invoiceNumber: text('invoice_number'),
    status: invoiceStatus('status').notNull().default('DRAFT'),
    invoiceDate: date('invoice_date').notNull(),
    dueDate: date('due_date'),
    memo: text('memo'),
    // Stored document totals — ALWAYS service-derived from the lines (ADR-013).
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — the hook composite FKs (incl. invoice_lines) reference.
    unique('invoices_company_id_id_unique').on(table.companyId, table.id),
    // Invoice numbers unique within a company, when present (NULLs distinct).
    unique('invoices_company_number_unique').on(table.companyId, table.invoiceNumber),
    // The invoice's customer must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.customerId],
      foreignColumns: [customers.companyId, customers.id],
      name: 'invoices_customer_same_company_fk',
    }).onDelete('restrict'),
    index('invoices_company_status_idx').on(table.companyId, table.status),
    index('invoices_company_customer_idx').on(table.companyId, table.customerId),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id').notNull(),
    companyId: uuid('company_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    description: text('description'),
    /** Quantity — a decimal (e.g. 2.5 hours), NUMERIC(19,4). */
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('1'),
    /** Unit price — money, NUMERIC(19,4). */
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    /** The revenue account this line credits (composite-FK'd to a same-company account). */
    accountId: uuid('account_id').notNull(),
    /** Tax rate as a percentage, e.g. 8.25 for 8.25%. NUMERIC(9,4). */
    taxRate: numeric('tax_rate', { precision: 9, scale: 4 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenancy: the line's invoice and account must both be in the line's company.
    foreignKey({
      columns: [table.companyId, table.invoiceId],
      foreignColumns: [invoices.companyId, invoices.id],
      name: 'invoice_lines_invoice_same_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.companyId, table.accountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'invoice_lines_account_same_company_fk',
    }).onDelete('restrict'),
    // Deterministic ordering within an invoice.
    unique('invoice_lines_invoice_line_number_unique').on(table.invoiceId, table.lineNumber),
    // Standing tenancy constraint.
    unique('invoice_lines_company_id_id_unique').on(table.companyId, table.id),
    index('invoice_lines_company_invoice_idx').on(table.companyId, table.invoiceId),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type InvoiceStatus = (typeof invoiceStatus.enumValues)[number];
