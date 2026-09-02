import { sql } from 'drizzle-orm';
import {
  check,
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
 * Chart of accounts — LL-020.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ THERE IS NO BALANCE COLUMN, AND THERE MUST NEVER BE ONE.               │
 * │                                                                        │
 * │ Not `balance`, not `current_balance`, not `ytd_total`, not a cached    │
 * │ anything. An account's balance is DERIVED from posted journal lines,   │
 * │ every time (LL-034). A stored balance is a second source of truth, and │
 * │ the moment it diverges from the journal the product is lying with no   │
 * │ way to detect it. Adding a balance column requires a new ADR and       │
 * │ explicit approval — see ACCOUNTING_RULES.md invariant 2.               │
 * └───────────────────────────────────────────────────────────────────────┘
 */

export const accountType = pgEnum('account_type', [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'COGS',
  'EXPENSE',
]);

export const accountStatus = pgEnum('account_status', ['ACTIVE', 'INACTIVE']);

/**
 * Protected system accounts the product depends on structurally (Accounts
 * Receivable, Retained Earnings, Opening Balance Equity, …). The set grows in
 * LL-041's installer; the column is nullable text, and its value cannot be
 * reassigned once set (service-enforced, ACCOUNTING_RULES.md).
 *
 * ADR-006 status vocabulary: `status`, not an `active` boolean — accounts are
 * deactivated, never deleted, like every other entity. (The ticket said
 * `active`; the ADR is the higher authority and every other table already uses
 * `status`.)
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    accountNumber: text('account_number'),
    name: text('name').notNull(),
    accountType: accountType('account_type').notNull(),
    // Subtype is TEXT, not an enum: it must extend without a migration to a type.
    accountSubtype: text('account_subtype'),
    // Composite-FK'd to a same-company account below; single-col ref here only
    // documents intent — the real guarantee is the raw FK in the migration.
    parentAccountId: uuid('parent_account_id'),
    systemAccountType: text('system_account_type'),
    description: text('description'),
    status: accountStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — the hook every composite FK builds on.
    unique('accounts_company_id_id_unique').on(table.companyId, table.id),
    // Account numbers unique within a company, when present. A plain UNIQUE
    // suffices: Postgres treats every NULL as distinct, so any number of
    // accounts may have no number while a given number stays unique per company
    // (verified empirically). Declared here so Drizzle's snapshot stays honest.
    unique('accounts_company_number_unique').on(table.companyId, table.accountNumber),
    // The COMPOSITE parent FK — (company_id, parent_account_id) → (company_id, id),
    // making a cross-company parent structurally impossible — is written by hand
    // in migration 0003. Drizzle's single-column .references() cannot express a
    // two-column FK, so it is NOT declared here; `db:check` tolerates the extra
    // constraint. Do not model it in Drizzle. See the migration.
    // An account cannot be its own parent. Transitive cycles (A→B→A) are the
    // service's job — a recursive trigger on every insert is disproportionate.
    check('accounts_no_self_parent', sql`${table.parentAccountId} is distinct from ${table.id}`),
    // GL/reporting access patterns.
    index('accounts_company_type_idx').on(table.companyId, table.accountType),
    index('accounts_company_parent_idx').on(table.companyId, table.parentAccountId),
  ],
);

export type Account = typeof accounts.$inferSelect;
