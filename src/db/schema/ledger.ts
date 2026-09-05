import { sql } from 'drizzle-orm';
import {
  bigint,
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { accounts } from './accounts';
import { customers } from './customers';
import { companies, users } from './identity';

/**
 * The general ledger — LL-030. The foundation of the product.
 *
 * The invariants below are enforced BY THE DATABASE (constraints + triggers in
 * migration 0005), not by application code. Application code can be wrong; a
 * future feature module can forget; the database cannot. Read the migration in
 * full before trusting anything here — the triggers (deferred balance check and
 * posted-immutability in 0006; the closed-period guard in 0010; the A/R
 * control-account guard in 0018, which blocks a manual journal entry from posting to
 * Accounts Receivable so the aging subsidiary always reconciles) are hand-written SQL
 * the schema file cannot express.
 */

/** DRAFT may be unbalanced/empty; POSTED is balanced and immutable; REVERSED is a posted entry undone by a reversal. */
export const journalStatus = pgEnum('journal_status', ['DRAFT', 'POSTED', 'REVERSED']);

/** Where an entry came from. Extended by migration as new sources arrive. */
export const journalSourceType = pgEnum('journal_source_type', [
  'INVOICE',
  'CUSTOMER_PAYMENT',
  'CUSTOMER_REFUND',
  'CREDIT_MEMO',
  'EXPENSE',
  'DEPOSIT',
  'TRANSFER',
  'JOURNAL_ENTRY',
  'OPENING_BALANCE',
  'REVERSAL',
  'BAD_DEBT_WRITEOFF',
]);

/**
 * Per-company gapless entry-number counter (ADR-003). One row per company,
 * allocated with SELECT … FOR UPDATE inside the posting transaction (LL-031),
 * so a rolled-back posting reuses the number and the sequence stays gapless. A
 * Postgres SEQUENCE is deliberately NOT used — sequences burn numbers on
 * rollback. Seeded atomically with the company (createCompanyWithOwner).
 */
export const companyCounters = pgTable('company_counters', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'restrict' }),
  nextEntryNumber: bigint('next_entry_number', { mode: 'number' }).notNull().default(1),
  /**
   * Per-company invoice-number counter (LL-042). Unlike entry numbers (gapless,
   * SELECT … FOR UPDATE), invoice numbers ALLOW gaps: this is bumped with a plain
   * atomic increment at finalize, so a rolled-back finalize may skip a number.
   */
  nextInvoiceNumber: bigint('next_invoice_number', { mode: 'number' }).notNull().default(1),
});

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Gapless per company (ADR-003). Nullable until POSTED — a draft has no number yet. */
    entryNumber: bigint('entry_number', { mode: 'number' }),
    transactionDate: date('transaction_date').notNull(),
    postingDate: date('posting_date').notNull(),
    description: text('description'),
    status: journalStatus('status').notNull().default('DRAFT'),
    sourceType: journalSourceType('source_type').notNull(),
    /** The originating record's id (an invoice, payment, …). Text — sources vary. */
    sourceId: text('source_id'),
    /** Idempotency key: one posting per (company, key). */
    idempotencyKey: text('idempotency_key'),
    /** A stable hash of the posting's material content (ADR-003 / LL-032). On a
     *  retry with the SAME key, a matching fingerprint means an identical
     *  request (return the existing entry); a differing one is a
     *  IDEMPOTENCY_KEY_CONFLICT — a caller bug reusing a key for new content. */
    idempotencyFingerprint: text('idempotency_fingerprint'),
    /** If this entry reverses another, the original's id. */
    reversalOfId: uuid('reversal_of_id'),
    /** If this entry has been reversed, the reversing entry's id. */
    reversedById: uuid('reversed_by_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
  },
  (table) => [
    // Composite-FK target: lines reference (company_id, id), making a
    // cross-company line structurally impossible.
    unique('journal_entries_company_id_id_unique').on(table.companyId, table.id),
    // Idempotency — invariant 3. Partial: only when a key is present.
    uniqueIndex('journal_entries_idempotency_unique')
      .on(table.companyId, table.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    // One POSTED entry per source transaction — invariant 4.
    uniqueIndex('journal_entries_source_posted_once')
      .on(table.companyId, table.sourceType, table.sourceId)
      .where(sql`status = 'POSTED' and source_id is not null`),
    // Reporting indexes (trial balance, GL).
    index('journal_entries_company_txn_date_idx').on(table.companyId, table.transactionDate),
    index('journal_entries_company_status_idx').on(table.companyId, table.status),
    // Self-references, declared as FKs after the table exists.
    foreignKey({
      columns: [table.reversalOfId],
      foreignColumns: [table.id],
      name: 'journal_entries_reversal_of_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.reversedById],
      foreignColumns: [table.id],
      name: 'journal_entries_reversed_by_fk',
    }).onDelete('restrict'),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    companyId: uuid('company_id').notNull(),
    accountId: uuid('account_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    customerId: uuid('customer_id'),
    vendorId: uuid('vendor_id'),
    description: text('description'),
    debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Invariant 1 — sign discipline: exactly one of debit/credit positive.
    check('journal_lines_sign', sql`
      ${table.debit} >= 0 and ${table.credit} >= 0
      and (${table.debit} > 0) <> (${table.credit} > 0)
    `),
    // Invariant 2 — tenancy: the account AND the parent entry must belong to the
    // SAME company as the line. Composite FKs make a cross-company reference
    // impossible in the database.
    foreignKey({
      columns: [table.companyId, table.accountId],
      foreignColumns: [accounts.companyId, accounts.id],
      name: 'journal_lines_account_same_company_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.companyId, table.journalEntryId],
      foreignColumns: [journalEntries.companyId, journalEntries.id],
      name: 'journal_lines_entry_same_company_fk',
    }).onDelete('cascade'),
    // Invariant 2 (tenancy) for the optional customer tag — LL-040. Composite FK,
    // so a line can never reference another company's customer. customer_id is
    // nullable and Postgres MATCH SIMPLE skips the check when it is NULL, so
    // untagged lines are unaffected; a tagged line must resolve in THIS company.
    foreignKey({
      columns: [table.companyId, table.customerId],
      foreignColumns: [customers.companyId, customers.id],
      name: 'journal_lines_customer_same_company_fk',
    }).onDelete('restrict'),
    // Invariant 5 — deterministic line ordering within an entry.
    unique('journal_lines_entry_line_number_unique').on(table.journalEntryId, table.lineNumber),
    // Standing tenancy constraint (future composite FKs into lines).
    unique('journal_lines_company_id_id_unique').on(table.companyId, table.id),
    // Reporting index for trial balance / GL by account.
    index('journal_lines_company_account_idx').on(table.companyId, table.accountId),
  ],
);

export type CompanyCounter = typeof companyCounters.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;
export type JournalStatus = (typeof journalStatus.enumValues)[number];
export type JournalSourceType = (typeof journalSourceType.enumValues)[number];
