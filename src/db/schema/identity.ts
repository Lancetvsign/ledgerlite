import { sql } from 'drizzle-orm';
import {
  boolean,
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
  uniqueIndex,
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
    /**
     * The master company (LL-083 / ADR-039): its chart and settings seed every NEW
     * company created from the 'template' source. At most one instance-wide — the
     * partial unique index below is the arbiter, not a service check.
     */
    isTemplate: boolean('is_template').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Invariants pushed to the strongest layer that can hold them.
    check('companies_fiscal_month_range', sql`${table.fiscalYearStartMonth} between 1 and 12`),
    check('companies_currency_format', sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check('companies_legal_name_nonempty', sql`length(trim(${table.legalName})) > 0`),
    // At most one template company exists; a second designation is a unique
    // violation, which the service maps to TEMPLATE_EXISTS.
    uniqueIndex('companies_one_template').on(table.isTemplate).where(sql`${table.isTemplate} = true`),
    // The template slot is released on archive (LL-083); the database now holds that too (LL-095).
    check('companies_template_is_active', sql`not ${table.isTemplate} or ${table.status} = 'ACTIVE'`),
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

/**
 * Pending team invitations — LL-086 / ADR-041.
 *
 * A manager (`user.manage`) invites an email that has no LedgerLite user yet; the
 * row is the authorization for the membership that appears when that email first
 * enters the app (`ensureAppUser` → `claimPendingInvitations`). ADR-006 applies:
 * rows move to ACCEPTED or REVOKED, never deleted. The email is stored lower-cased
 * and trimmed (a CHECK enforces it) because Better Auth lower-cases emails at
 * sign-up and sign-in, so the claim lookup is a plain equality on the partial index.
 */
export const invitationStatus = pgEnum('invitation_status', ['PENDING', 'ACCEPTED', 'REVOKED']);

export const companyInvitations = pgTable(
  'company_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    role: membershipRole('role').notNull(),
    status: invitationStatus('status').notNull().default('PENDING'),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'restrict' }),
    /**
     * LL-090: the invitation's secret, stored as a SHA-256 hex hash — the link the
     * inviter hands over IS the authorization to join. Nullable only for rows created
     * before LL-090, which can never be claimed (revoke and re-invite).
     */
    tokenHash: text('token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    // The standing tenancy constraint.
    unique('company_invitations_company_id_id_unique').on(table.companyId, table.id),
    uniqueIndex('company_invitations_token_hash_unique').on(table.tokenHash).where(sql`${table.tokenHash} is not null`),
    check('company_invitations_email_lowercase', sql`${table.email} = lower(btrim(${table.email}))`),
    check('company_invitations_accepted_stamp', sql`(${table.status} = 'ACCEPTED') = (${table.acceptedUserId} is not null)`),
    check('company_invitations_resolved_stamp', sql`(${table.status} <> 'PENDING') = (${table.resolvedAt} is not null)`),
    // One live invitation per (company, email); resolved ones may pile up as history.
    uniqueIndex('company_invitations_pending_email_unique')
      .on(table.companyId, table.email)
      .where(sql`${table.status} = 'PENDING'`),
    // The claim lookup on every authenticated entry: "any pending invitation for this email?"
    index('company_invitations_pending_by_email_idx').on(table.email).where(sql`${table.status} = 'PENDING'`),
  ],
);

export type CompanyInvitation = typeof companyInvitations.$inferSelect;
