import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { companies, users } from './identity';

/**
 * Append-only audit log — LL-021.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ THIS TABLE IS IMMUTABLE AFTER INSERT.                                  │
 * │                                                                        │
 * │ A BEFORE UPDATE OR DELETE trigger (migration 0004) raises on any such  │
 * │ attempt, for EVERY role including the table owner. The value of an     │
 * │ audit record is precisely that it cannot be revised after the fact —   │
 * │ application discipline is not enough, so the database enforces it.     │
 * │ Erasing a record (retention, GDPR) is a deliberate, reviewed migration │
 * │ that drops the trigger, acts, and restores it — never an app write.    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Period close, journal posting, and reversal all record through this table,
 * and they do so INSIDE their own transaction (see src/server/audit) so a
 * rolled-back action leaves no audit row describing something that never
 * happened.
 */

/**
 * Audited actions. A Postgres enum, extended by migration as new financial
 * actions arrive. Seeded with the account actions LL-020's service can emit now
 * and the period actions LL-022 will (originally LL-046's ACCOUNTING_PERIOD_*).
 */
export const auditAction = pgEnum('audit_action', [
  'ACCOUNT_CREATED',
  'ACCOUNT_UPDATED',
  'ACCOUNT_DEACTIVATED',
  'ACCOUNTING_PERIOD_CLOSED',
  'ACCOUNTING_PERIOD_REOPENED',
  'JOURNAL_ENTRY_POSTED',
  'JOURNAL_ENTRY_REVERSED',
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_DEACTIVATED',
  'INVOICE_CREATED',
  'INVOICE_UPDATED',
]);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // Who acted. RESTRICT: an actor referenced by history can never be hard
    // deleted (ADR-006), so an audit row always resolves to a real user.
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: auditAction('action').notNull(),
    /** The kind of thing acted on, e.g. 'account', 'accounting_period'. */
    entityType: text('entity_type').notNull(),
    /** The specific row's id. Text, not a FK — audited entities vary. */
    entityId: text('entity_id').notNull(),
    /** State before and after, REDACTED before write (LL-004). Nullable: a */
    /** creation has no before, a deletion no after. */
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    /** Correlation id from the request context (LL-004), when present. */
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Standing tenancy constraint — every tenant-owned table carries it.
    unique('audit_events_company_id_id_unique').on(table.companyId, table.id),
    // "What happened to this entity" and "what happened in this company lately".
    index('audit_events_company_entity_idx').on(table.companyId, table.entityType, table.entityId),
    index('audit_events_company_created_idx').on(table.companyId, table.createdAt),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditAction = (typeof auditAction.enumValues)[number];
