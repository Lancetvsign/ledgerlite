import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

/**
 * Connectivity probe. Deliberately trivial and deliberately not an accounting
 * entity — it exists only so LL-002 can prove the migration path end to end
 * before any real schema is designed.
 *
 * Accounting entities begin in LL-020 (accounts) and LL-030 (the ledger).
 */
export const health = pgTable('_health', {
  id: integer('id').primaryKey(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type HealthRow = typeof health.$inferSelect;
