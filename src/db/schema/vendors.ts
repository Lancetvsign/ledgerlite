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
 * Vendors — LL-060. The party a **bill** owes (Sprint 6, Accounts Payable) — the
 * structural mirror of customers (LL-040).
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ NO BALANCE COLUMN. A vendor's balance (what we owe) is DERIVED from     │
 * │ posted journal lines against Accounts Payable, never stored — same rule │
 * │ as accounts and customers (invariant 2). Do not add `balance`,          │
 * │ `open_balance`, `total_owed`, or any cached total; that needs a new ADR. │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Tenancy is structural: `UNIQUE (company_id, id)` is the hook the composite FK
 * from `journal_lines (company_id, vendor_id)` builds on (declared in the ledger
 * schema, added alongside this table in LL-060), so a journal line can never
 * reference another tenant's vendor. Vendors are deactivated, never deleted
 * (ADR-006): `status` is the vocabulary, and the company FK is `ON DELETE restrict`.
 */

export const vendorStatus = pgEnum('vendor_status', ['ACTIVE', 'INACTIVE']);

export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Optional human-facing vendor number, unique per company when present. */
    vendorNumber: text('vendor_number'),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    /** Remit-to address as free text for now; structured fields can arrive later. */
    address: text('address'),
    notes: text('notes'),
    status: vendorStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — every tenant-owned table carries it, and it
    // is the target a composite FK references (here, journal_lines.vendor_id).
    unique('vendors_company_id_id_unique').on(table.companyId, table.id),
    // Vendor numbers unique within a company, when present. NULLs are distinct in
    // Postgres, so many vendors may have no number (same as customers / accounts).
    unique('vendors_company_number_unique').on(table.companyId, table.vendorNumber),
    // Listing / search access pattern.
    index('vendors_company_name_idx').on(table.companyId, table.name),
  ],
);

export type Vendor = typeof vendors.$inferSelect;
export type VendorStatus = (typeof vendorStatus.enumValues)[number];
