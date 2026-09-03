import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { companies } from './identity';

/**
 * Customers — LL-040. The party an invoice bills (Sprint 4, Accounts Receivable).
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ NO BALANCE COLUMN. A customer's balance (what they owe) is DERIVED from │
 * │ posted journal lines against Accounts Receivable, never stored — same   │
 * │ rule as accounts (invariant 2). Do not add `balance`, `open_balance`,   │
 * │ `total_due`, or any cached total; that needs a new ADR.                 │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Tenancy is structural: `UNIQUE (company_id, id)` is the hook a composite FK
 * from `journal_lines (company_id, customer_id)` builds on (declared in the
 * ledger schema), so a journal line can never reference another tenant's
 * customer. Customers are deactivated, never deleted (ADR-006): `status` is the
 * vocabulary, and the company FK is `ON DELETE restrict`.
 */

export const customerStatus = pgEnum('customer_status', ['ACTIVE', 'INACTIVE']);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Optional human-facing customer number, unique per company when present. */
    customerNumber: text('customer_number'),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    /** Billing address as free text for now; structured fields can arrive later. */
    billingAddress: text('billing_address'),
    notes: text('notes'),
    status: customerStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — every tenant-owned table carries it, and it
    // is the target a composite FK references.
    unique('customers_company_id_id_unique').on(table.companyId, table.id),
    // Customer numbers unique within a company, when present. NULLs are distinct
    // in Postgres, so many customers may have no number (same as accounts).
    unique('customers_company_number_unique').on(table.companyId, table.customerNumber),
    // Listing / search access pattern.
    index('customers_company_name_idx').on(table.companyId, table.name),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type CustomerStatus = (typeof customerStatus.enumValues)[number];
