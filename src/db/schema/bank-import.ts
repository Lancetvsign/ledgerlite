import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts';
import { billPayments } from './bill-payments';
import { companies, users } from './identity';
import { journalEntries } from './ledger';
import { payments } from './payments';

/**
 * Bank-statement import — LL-076. A staging area between an uploaded statement and the
 * ledger: extracted transactions land here as `STAGED` lines, a human reviews and
 * confirms/re-categorises each, and confirming posts a categorised journal entry
 * (source_type BANK_IMPORT) — nothing reaches the ledger un-reviewed. No balance is
 * stored (invariant 2); the amount here is the raw statement figure, not an account
 * balance. The raw PDF is never persisted — only these extracted lines.
 *
 * Tenancy is structural: composite FKs tie a batch to its bank account, each line to its
 * batch, its suggested/chosen accounts, and its posted entry — all within one company.
 */

export const bankImportLineStatus = pgEnum('bank_import_line_status', ['STAGED', 'POSTED', 'IGNORED']);

export const bankImportBatches = pgTable(
  'bank_import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** The cash/bank account this statement is for (composite-FK'd to a same-company account). */
    bankAccountId: uuid('bank_account_id').notNull(),
    /** The uploaded file's name — for the user's reference. The file itself is NOT stored. */
    filename: text('filename'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('bank_import_batches_company_id_id_unique').on(table.companyId, table.id),
    foreignKey({
      columns: [table.companyId, table.bankAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'bank_import_batches_account_same_company_fk',
    }).onDelete('restrict'),
    index('bank_import_batches_company_idx').on(table.companyId, table.createdAt),
  ],
);

export const bankImportLines = pgTable(
  'bank_import_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id').notNull(),
    companyId: uuid('company_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    txnDate: date('txn_date').notNull(),
    description: text('description'),
    /** Signed statement amount, NUMERIC(19,4): positive = money INTO the bank, negative = out. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    /** The category the extractor proposed (free text) — for reference and mapping. */
    aiCategory: text('ai_category'),
    /** The account initially suggested (AI-mapped, else history). Composite-FK'd, nullable. */
    suggestedAccountId: uuid('suggested_account_id'),
    /** The account the user confirmed to post against. Composite-FK'd, nullable until posted. */
    chosenAccountId: uuid('chosen_account_id'),
    status: bankImportLineStatus('status').notNull().default('STAGED'),
    /** Hash of (bankAccount, date, amount, normalised description) for duplicate detection. */
    dedupHash: text('dedup_hash').notNull(),
    /** The posted entry, once this line is confirmed. Composite-FK'd, nullable. */
    journalEntryId: uuid('journal_entry_id'),
    /**
     * LL-077 (ADR-035): a line applied to an open invoice creates a real customer payment
     * (this is it) instead of a categorised entry; `journalEntryId` is that payment's entry.
     */
    paymentId: uuid('payment_id'),
    /** The A/P mirror: a line applied to an open bill creates a real bill payment. */
    billPaymentId: uuid('bill_payment_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyId, table.batchId],
      foreignColumns: [bankImportBatches.companyId, bankImportBatches.id],
      name: 'bank_import_lines_batch_same_company_fk',
    }).onDelete('cascade'),
    // Nullable composite FKs (MATCH SIMPLE: unchecked while the account id is null).
    foreignKey({
      columns: [table.companyId, table.suggestedAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'bank_import_lines_suggested_account_same_company_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.companyId, table.chosenAccountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'bank_import_lines_chosen_account_same_company_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.companyId, table.journalEntryId],
      foreignColumns: [journalEntries.companyId, journalEntries.id],
      name: 'bank_import_lines_entry_same_company_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.companyId, table.paymentId],
      foreignColumns: [payments.companyId, payments.id],
      name: 'bank_import_lines_payment_same_company_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.companyId, table.billPaymentId],
      foreignColumns: [billPayments.companyId, billPayments.id],
      name: 'bank_import_lines_bill_payment_same_company_fk',
    }).onDelete('restrict'),
    // A line settles in exactly one way: a category account, a customer payment, or a bill
    // payment — never two of them (structural, not just service logic).
    check(
      'bank_import_lines_one_target',
      sql`num_nonnulls(${table.chosenAccountId}, ${table.paymentId}, ${table.billPaymentId}) <= 1`,
    ),
    unique('bank_import_lines_batch_line_number_unique').on(table.batchId, table.lineNumber),
    unique('bank_import_lines_company_id_id_unique').on(table.companyId, table.id),
    index('bank_import_lines_company_batch_idx').on(table.companyId, table.batchId),
  ],
);

export type BankImportBatch = typeof bankImportBatches.$inferSelect;
export type BankImportLine = typeof bankImportLines.$inferSelect;
export type BankImportLineStatus = (typeof bankImportLineStatus.enumValues)[number];
