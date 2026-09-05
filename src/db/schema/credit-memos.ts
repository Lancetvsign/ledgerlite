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
 * Customer credit memos — LL-051 (Sprint 5, Accounts Receivable).
 *
 * A credit memo reduces what a customer owes ON A SPECIFIC OPEN INVOICE — a return
 * or allowance — by posting Dr Sales Returns & Allowances (a revenue/contra account)
 * / Cr Accounts Receivable (customer-tagged), through LedgerService (source type
 * CREDIT_MEMO). Structurally it is the sibling of a bad-debt write-off (LL-050): it
 * reduces the invoice's open balance in the A/R subsidiary — the open balance derives
 * from invoices minus non-void payments, write-offs, AND credit memos — so the
 * aging⇔control reconciliation (GL-T018) keeps holding.
 *
 * Scope is credit memos APPLIED to an invoice. Unapplied customer credit and cash
 * refunds are deferred (they would need the aging subsidiary to carry credit balances;
 * see ADR-019). `amount` is a DOCUMENT amount, not a stored balance (invariant 2).
 * Credit memos are never hard deleted (ADR-006); a mistaken one is VOIDed, which
 * reverses its entry and reopens the invoice it had cleared.
 *
 * Tenancy is structural: composite FKs tie a credit memo to a same-company invoice,
 * customer, and revenue account.
 */

export const creditMemoStatus = pgEnum('credit_memo_status', ['POSTED', 'VOID']);

export const creditMemos = pgTable(
  'credit_memos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The invoice being credited. Composite-FK'd to a same-company invoice below. */
    invoiceId: uuid('invoice_id').notNull(),
    /** The invoice's customer, denormalized for the customer-tag FK and reporting. */
    customerId: uuid('customer_id').notNull(),
    /** The revenue/contra account debited (typically "Sales Returns & Allowances"), REVENUE. */
    revenueAccountId: uuid('revenue_account_id').notNull(),
    creditDate: date('credit_date').notNull(),
    /** How much of the invoice is credited. A document amount, not a balance. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    reason: text('reason'),
    status: creditMemoStatus('status').notNull().default('POSTED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint.
    unique('credit_memos_company_id_id_unique').on(table.companyId, table.id),
    // A credit memo reduces A/R by a strictly positive amount.
    check('credit_memos_amount_positive', sql`${table.amount} > 0`),
    // The invoice must belong to the SAME company (invariant 4, structural).
    foreignKey({
      columns: [table.companyId, table.invoiceId],
      foreignColumns: [invoices.companyId, invoices.id],
      name: 'credit_memos_invoice_same_company_fk',
    }).onDelete('restrict'),
    // The customer must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.customerId],
      foreignColumns: [customers.companyId, customers.id],
      name: 'credit_memos_customer_same_company_fk',
    }).onDelete('restrict'),
    // The revenue account must belong to the SAME company (structural).
    foreignKey({
      columns: [table.companyId, table.revenueAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'credit_memos_revenue_account_same_company_fk',
    }).onDelete('restrict'),
    // The reductions query for an invoice's open balance.
    index('credit_memos_company_invoice_idx').on(table.companyId, table.invoiceId),
    index('credit_memos_company_customer_idx').on(table.companyId, table.customerId),
    index('credit_memos_company_status_idx').on(table.companyId, table.status),
  ],
);

export type CreditMemo = typeof creditMemos.$inferSelect;
export type CreditMemoStatus = (typeof creditMemoStatus.enumValues)[number];
