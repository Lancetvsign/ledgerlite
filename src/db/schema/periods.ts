import {
  date,
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { companies, users } from './identity';

/**
 * Accounting periods — LL-022.
 *
 * Dates are DATE columns carried as 'YYYY-MM-DD' strings (ADR-005) — never a
 * JS Date, so server-local time can never shift a boundary. Periods are monthly
 * and generated lazily: the month containing a date springs into existence the
 * first time something looks it up (getAccountingPeriod), inside a transaction,
 * with the exclusion constraint below making concurrent creation safe.
 *
 * OVERLAP IS IMPOSSIBLE AT THE DATABASE. Migration 0005 adds
 *   EXCLUDE USING gist (company_id WITH =, daterange(start,end,'[]') WITH &&)
 * so two overlapping periods in one company cannot both exist even under
 * concurrent inserts — a race an application-level check cannot win. Drizzle
 * cannot express an exclusion constraint, so it is hand-written.
 */

export const periodStatus = pgEnum('period_status', ['OPEN', 'CLOSED']);

export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    // Inclusive [start_date, end_date] — first and last calendar day of the month.
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: periodStatus('status').notNull().default('OPEN'),
    // Who/when for each transition. Nullable until the transition happens;
    // RESTRICT so an actor referenced by a closed period is never hard deleted.
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'restrict' }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('accounting_periods_company_id_id_unique').on(table.companyId, table.id),
    // The lookup getAccountingPeriod / assertPeriodOpen run on every posting.
    index('accounting_periods_company_dates_idx').on(
      table.companyId,
      table.startDate,
      table.endDate,
    ),
  ],
);

export type AccountingPeriod = typeof accountingPeriods.$inferSelect;
