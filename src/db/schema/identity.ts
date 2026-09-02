import { sql } from 'drizzle-orm';
import {
  check,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { user as authUser } from './auth';

/**
 * Identity and tenancy — LL-011.
 *
 * These are OUR tables, so ADR-005 applies: instants are timestamptz. Status
 * columns are enums per ADR-006 — records are deactivated, never deleted, and
 * no table here has a delete path in the application.
 */

export const userStatus = pgEnum('user_status', ['ACTIVE', 'INACTIVE']);
export const companyStatus = pgEnum('company_status', ['ACTIVE', 'INACTIVE']);
export const membershipStatus = pgEnum('membership_status', ['ACTIVE', 'INACTIVE']);

/**
 * Membership roles. The names live here; what each may DO is deliberately
 * absent — capabilities arrive in LL-012, and business code will ask about
 * capabilities, never compare role names.
 */
export const membershipRole = pgEnum('membership_role', [
  'OWNER',
  'ADMIN',
  'BOOKKEEPER',
  'ACCOUNTANT',
  'READ_ONLY',
]);

/**
 * The application user — separate from the Better Auth identity on purpose.
 *
 * Better Auth's `user` table belongs to the auth library: its shape changes
 * when the library's does, and it holds nothing about what a person may do in
 * LedgerLite. This table is ours. The two link by `auth_user_id`, exactly once
 * (unique), and no credential material is ever duplicated here.
 *
 * ON DELETE RESTRICT: an auth identity cannot be removed out from under an
 * application user. Accounting trails will hang off this id; ADR-006 says
 * nothing financial is ever orphaned by a deletion.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  authUserId: text('auth_user_id')
    .notNull()
    .unique()
    .references(() => authUser.id, { onDelete: 'restrict' }),
  /** Display copy, refreshed at provisioning. The auth table owns the truth. */
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  status: userStatus('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legalName: text('legal_name').notNull(),
    dbaName: text('dba_name'),
    address: jsonb('address'),
    phone: text('phone'),
    email: text('email'),
    /**
     * PROTECTED. Never in a default select shape, never in a log (the LL-004
     * redactor removes `ein` keys by name), never returned by a service unless
     * a caller explicitly asks through a path that will justify itself.
     * Encryption at rest is out of scope for LL-011; the column is isolated
     * now so adding it later touches one place.
     */
    ein: text('ein'),
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    currencyCode: char('currency_code', { length: 3 }).notNull().default('USD'),
    timezone: text('timezone').notNull(),
    status: companyStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Invariants pushed to the strongest layer that can hold them.
    check('companies_fiscal_month_range', sql`${table.fiscalYearStartMonth} between 1 and 12`),
    check('companies_currency_format', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check('companies_legal_name_nonempty', sql`length(trim(${table.legalName})) > 0`),
  ],
);

/**
 * Membership: who belongs to which company, as which role.
 *
 * Carries the standing tenancy constraint `UNIQUE (company_id, id)` — see
 * docs/DATABASE.md. Every tenant-owned table gets it from now on, so later
 * tables can composite-FK on (company_id, ...) and a cross-company reference
 * becomes structurally impossible rather than merely tested against.
 */
export const companyMemberships = pgTable(
  'company_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: membershipRole('role').notNull(),
    status: membershipStatus('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('company_memberships_company_user_unique').on(table.companyId, table.userId),
    // "Which companies does this user belong to" runs on every request once
    // LL-013 lands; the (company_id, user_id) unique cannot serve a
    // user-id-first lookup.
    index('company_memberships_user_id_idx').on(table.userId),
    // The standing tenancy constraint. Named uniformly so future migrations
    // adding it elsewhere read as the same pattern.
    unique('company_memberships_company_id_id_unique').on(table.companyId, table.id),
  ],
);

export type AppUser = typeof users.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type CompanyMembership = typeof companyMemberships.$inferSelect;
