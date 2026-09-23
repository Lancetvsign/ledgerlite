import { sql } from 'drizzle-orm';
import {
  boolean,
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

/**
 * STAGED → POSTED (categorised in this company) | IGNORED | PERSONAL (posted to an owner
 * equity/asset account, LL-097) | ASSIGNED (posted INTERCOMPANY: this company's side against the
 * card, the other company's side against its expense — LL-097 / ADR-043).
 */
export const bankImportLineStatus = pgEnum('bank_import_line_status', ['STAGED', 'POSTED', 'IGNORED', 'ASSIGNED', 'PERSONAL']);

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
    /** LL-097: a CARD statement the other companies of the organization may take lines from. */
    sharedWithOrganization: boolean('shared_with_organization').notNull().default(false),
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
    /** The POSTED line on the OTHER statement account this line is the mirror of (LL-094/095). */
    mirrorOfLineId: uuid('mirror_of_line_id'),
    /**
     * LL-097: when ASSIGNED, the organization member that took the line and ITS entry
     * (Dr expense / Cr Due to <this company>). A by-design cross-company reference —
     * composite-FK'd to (company_id, id) of journal_entries so the entry provably belongs
     * to the assigned company. `journalEntryId` above stays THIS company's side.
     */
    assignedCompanyId: uuid('assigned_company_id').references(() => companies.id, { onDelete: 'restrict' }),
    assignedJournalEntryId: uuid('assigned_journal_entry_id'),
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
    // RESTRICT (LL-095): a batch with lines can only go through deleteImportBatch /
    // the company purge, which delete the lines first. A raw parent delete can no
    // longer take POSTED lines (and the dedup/reconciliation links they carry) with it.
    foreignKey({
      columns: [table.companyId, table.batchId],
      foreignColumns: [bankImportBatches.companyId, bankImportBatches.id],
      name: 'bank_import_lines_batch_same_company_fk',
    }).onDelete('restrict'),
    // One mirror per posted transfer line, structurally (LL-094 follow-up).
    foreignKey({
      columns: [table.companyId, table.mirrorOfLineId],
      foreignColumns: [table.companyId, table.id],
      name: 'bank_import_lines_mirror_same_company_fk',
    }).onDelete('restrict'),
    unique('bank_import_lines_mirror_of_line_id_unique').on(table.mirrorOfLineId),
    // Shape invariants the service always wrote; now the database holds them too (LL-095,
    // extended for PERSONAL / ASSIGNED in LL-097). Status compared as text: the enum values
    // arrive in the same migration transaction.
    check('bank_import_lines_posted_has_entry', sql`(${table.status}::text in ('POSTED', 'PERSONAL', 'ASSIGNED')) = (${table.journalEntryId} is not null)`),
    check('bank_import_lines_targets_only_when_posted', sql`${table.status}::text in ('POSTED', 'PERSONAL') or num_nonnulls(${table.chosenAccountId}, ${table.paymentId}, ${table.billPaymentId}, ${table.mirrorOfLineId}) = 0`),
    check('bank_import_lines_amount_nonzero', sql`${table.amount} <> 0`),
    check(
      'bank_import_lines_assigned_shape',
      sql`num_nonnulls(${table.assignedCompanyId}, ${table.assignedJournalEntryId}) = (case when ${table.status}::text = 'ASSIGNED' then 2 else 0 end) and (${table.assignedCompanyId} is null or ${table.assignedCompanyId} <> ${table.companyId}) and (${table.assignedJournalEntryId} is null or ${table.assignedJournalEntryId} <> ${table.journalEntryId})`,
    ),
    check('bank_import_lines_personal_has_account', sql`${table.status}::text <> 'PERSONAL' or ${table.chosenAccountId} is not null`),
    foreignKey({
      columns: [table.assignedCompanyId, table.assignedJournalEntryId],
      foreignColumns: [journalEntries.companyId, journalEntries.id],
      name: 'bank_import_lines_assigned_entry_same_assigned_company_fk',
    }).onDelete('restrict'),
    unique('bank_import_lines_assigned_journal_entry_id_unique').on(table.assignedJournalEntryId),
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
