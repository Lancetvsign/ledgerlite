import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts';
import { companies, users } from './identity';
import { journalLines } from './ledger';

/**
 * Bank reconciliation — LL-078 (ADR-036). The month-end control that ties a cash account's
 * ledger to the bank: a reconciliation names the account, the statement date and the bank's
 * ending figure; the reviewer ticks the ledger lines the bank has cleared; completion is
 * allowed only when the cleared lines sum exactly to the statement figure.
 *
 * "Cleared" lives HERE, not on journal_lines: posted lines are immutable (the trigger rejects
 * any update), and a mark is reconciliation state, not ledger state. No figure is stored
 * other than the bank's own document amount — opening cleared, cleared-here, difference and
 * the ledger as-of are derived from journal_lines on every read (invariant 2).
 *
 * Structural guarantees: a ledger line clears at most once ever (unique on the line); a
 * cleared line belongs to the reconciliation's account (composite FKs carry the account);
 * one IN_PROGRESS reconciliation per account (partial unique); a completed header carries
 * who/when (CHECK).
 */

export const reconciliationStatus = pgEnum('reconciliation_status', ['IN_PROGRESS', 'COMPLETED']);

export const bankReconciliations = pgTable(
  'bank_reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The cash/bank account being reconciled (ACTIVE, ASSET, cashFlowCategory CASH). */
    bankAccountId: uuid('bank_account_id').notNull(),
    statementDate: date('statement_date').notNull(),
    /**
     * The bank's ending figure as printed on the statement, NUMERIC(19,4), signed (an
     * overdraft is negative). A document amount supplied by the user — never a ledger balance
     * (those are always derived; see the Gate-2 no-stored-balance scan).
     */
    statementEndingAmount: numeric('statement_ending_amount', { precision: 19, scale: 4 }).notNull(),
    status: reconciliationStatus('status').notNull().default('IN_PROGRESS'),
    startedBy: uuid('started_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'restrict' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('bank_reconciliations_company_id_id_unique').on(table.companyId, table.id),
    // Lets a cleared line carry the account structurally (see bank_reconciliation_lines).
    unique('bank_reconciliations_company_id_account_unique').on(table.companyId, table.id, table.bankAccountId),
    // One reconciliation per statement per account.
    unique('bank_reconciliations_account_statement_unique').on(table.companyId, table.bankAccountId, table.statementDate),
    foreignKey({
      columns: [table.companyId, table.bankAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'bank_reconciliations_account_same_company_fk',
    }).onDelete('restrict'),
    // At most one open reconciliation per account.
    uniqueIndex('bank_reconciliations_one_in_progress')
      .on(table.companyId, table.bankAccountId)
      .where(sql`${table.status} = 'IN_PROGRESS'`),
    check(
      'bank_reconciliations_completed_stamp',
      sql`(${table.status} = 'COMPLETED') = (${table.completedAt} is not null and ${table.completedBy} is not null)`,
    ),
    index('bank_reconciliations_company_account_idx').on(table.companyId, table.bankAccountId, table.statementDate),
  ],
);

export const bankReconciliationLines = pgTable(
  'bank_reconciliation_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    reconciliationId: uuid('reconciliation_id').notNull(),
    /** The cleared ledger line. Nothing about it is copied here — amounts stay on the line. */
    journalLineId: uuid('journal_line_id').notNull(),
    /** Redundant on purpose: lets both FKs below pin the line to the reconciliation's account. */
    bankAccountId: uuid('bank_account_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('bank_reconciliation_lines_company_id_id_unique').on(table.companyId, table.id),
    // A ledger line clears at most once, ever.
    unique('bank_reconciliation_lines_line_once_unique').on(table.companyId, table.journalLineId),
    foreignKey({
      columns: [table.companyId, table.reconciliationId, table.bankAccountId],
      foreignColumns: [bankReconciliations.companyId, bankReconciliations.id, bankReconciliations.bankAccountId],
      name: 'bank_reconciliation_lines_reconciliation_same_account_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.companyId, table.journalLineId, table.bankAccountId],
      foreignColumns: [journalLines.companyId, journalLines.id, journalLines.accountId],
      name: 'bank_reconciliation_lines_line_same_account_fk',
    }).onDelete('restrict'),
    index('bank_reconciliation_lines_recon_idx').on(table.companyId, table.reconciliationId),
  ],
);

export type BankReconciliation = typeof bankReconciliations.$inferSelect;
export type BankReconciliationLine = typeof bankReconciliationLines.$inferSelect;
export type ReconciliationStatus = (typeof reconciliationStatus.enumValues)[number];
