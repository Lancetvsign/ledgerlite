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
  uuid,
  unique,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts';
import { customers } from './customers';
import { companies, users } from './identity';
import { invoices } from './invoices';

/**
 * Bad-debt write-offs — LL-050 (Sprint 5, Accounts Receivable).
 *
 * A write-off is the SANCTIONED way to reduce Accounts Receivable when a customer
 * will not pay: it targets ONE open invoice and posts Dr Bad Debt Expense / Cr
 * Accounts Receivable (customer-tagged), through LedgerService (source type
 * BAD_DEBT_WRITEOFF). Like a payment application, it reduces that invoice's open
 * balance in the A/R subsidiary — the open balance derives from invoices minus
 * non-void payment applications AND non-void write-offs — so the aging⇔control
 * reconciliation (GL-T018) keeps holding. This is why manual journal entries to A/R
 * are locked out (ADR-016 / LL-050): A/R moves only through document paths the
 * subsidiary can see.
 *
 * `amount` is a DOCUMENT amount, not a stored balance (invariant 2). Write-offs are
 * never hard deleted (ADR-006); a mistaken one is VOIDed, which reverses its entry
 * and reopens the invoice it had cleared.
 *
 * Tenancy is structural: composite FKs tie a write-off to a same-company invoice,
 * customer, and expense account.
 */

export const writeoffStatus = pgEnum('writeoff_status', ['POSTED', 'VOID']);

export const writeoffs = pgTable(
  'writeoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The invoice being written off. Composite-FK'd to a same-company invoice below. */
    invoiceId: uuid('invoice_id').notNull(),
    /** The invoice's customer, denormalized for the customer-tag FK and reporting. */
    customerId: uuid('customer_id').notNull(),
    /** The expense account debited (typically "Bad Debt Expense"), same-company, EXPENSE. */
    expenseAccountId: uuid('expense_account_id').notNull(),
    writeoffDate: date('writeoff_date').notNull(),
    /** How much of the invoice is written off. A document amount, not a balance. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    reason: text('reason'),
    status: writeoffStatus('status').notNull().default('POSTED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint.
    unique('writeoffs_company_id_id_unique').on(table.companyId, table.id),
    // A write-off reduces A/R by a strictly positive amount.
    check('writeoffs_amount_positive', sql`${table.amount} > 0`),
    // The invoice must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.invoiceId],
      foreignColumns: [invoices.companyId, invoices.id],
      name: 'writeoffs_invoice_same_company_fk',
    }).onDelete('restrict'),
    // The customer must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.customerId],
      foreignColumns: [customers.companyId, customers.id],
      name: 'writeoffs_customer_same_company_fk',
    }).onDelete('restrict'),
    // The expense account must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.expenseAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'writeoffs_expense_account_same_company_fk',
    }).onDelete('restrict'),
    // The reductions query for an invoice's open balance.
    index('writeoffs_company_invoice_idx').on(table.companyId, table.invoiceId),
    index('writeoffs_company_customer_idx').on(table.companyId, table.customerId),
    index('writeoffs_company_status_idx').on(table.companyId, table.status),
  ],
);

export type Writeoff = typeof writeoffs.$inferSelect;
export type WriteoffStatus = (typeof writeoffStatus.enumValues)[number];
