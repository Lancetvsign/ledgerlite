import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { moneyEquals, sumMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { getAccountingPeriod } from '@/server/periods';

import { LedgerError } from './errors';

import type { PoolDatabase } from '@/db';
import type { JournalEntry, JournalLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

export interface PostedEntry {
  readonly entry: JournalEntry;
  readonly lines: JournalLine[];
}

/**
 * LedgerService — the ONLY approved mechanism for creating posted journal
 * entries. No feature module inserts into journal_entries or journal_lines
 * directly (AGENTS §4.8). The database (LL-030) will reject a bad posting; this
 * service is what makes the application produce only good ones, atomically, and
 * report exactly why when it cannot.
 *
 * Every posting runs in ONE transaction on the POOL client (ADR-001). The HTTP
 * client cannot open a transaction; simulating one with compensating deletes is
 * prohibited. A failure at any point leaves NOTHING behind — no entry, no lines,
 * no audit row.
 */
export async function postJournalEntry(input: PostJournalEntryInput): Promise<PostedEntry> {
  const postingDate = input.postingDate ?? input.transactionDate;

  // ---- 1. Authorization -----------------------------------------------------
  await requirePermission(input.actorUserId, input.companyId, 'journal.post');

  // ---- 5 & 6. Balance and structural validation (pure — before any I/O) -----
  // Done early: no reason to touch the database for input that cannot post.
  validateStructure(input);
  validateBalance(input);

  return await getDbTx().transaction(async (tx) => {
    // ---- 7. Idempotency (first, inside the tx) ------------------------------
    // If this key already produced an entry, return it — the posting already
    // happened. A conflicting payload under the same key is LL-032's concern;
    // here the unique index is the backstop against a duplicate.
    if (input.idempotencyKey !== undefined) {
      const existing = await tx
        .select()
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.companyId, input.companyId),
            eq(schema.journalEntries.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const priorEntry = existing[0];
      if (priorEntry !== undefined) {
        return await loadEntry(tx, priorEntry.id);
      }
    }

    // ---- 2. Company exists and is active ------------------------------------
    const company = await tx
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(
        and(eq(schema.companies.id, input.companyId), eq(schema.companies.status, 'ACTIVE')),
      )
      .limit(1);
    if (company[0] === undefined) {
      throw new LedgerError('COMPANY_NOT_FOUND', 'Company not found or inactive.');
    }

    // ---- 3. Every account exists, belongs here, and is active ---------------
    const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const accounts = await tx
      .select({ id: schema.accounts.id, status: schema.accounts.status })
      .from(schema.accounts)
      .where(
        and(eq(schema.accounts.companyId, input.companyId), inArray(schema.accounts.id, accountIds)),
      );
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const account = byId.get(id);
      if (account === undefined) {
        throw new LedgerError('ACCOUNT_NOT_FOUND', 'A referenced account does not exist in this company.');
      }
      if (account.status !== 'ACTIVE') {
        throw new LedgerError('INACTIVE_ACCOUNT', 'A referenced account is inactive.');
      }
    }

    // ---- 4. Period is open (resolved on posting_date, ADR-002) --------------
    const period = await getAccountingPeriod(input.companyId, postingDate, tx);
    if (period.status !== 'OPEN') {
      throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${postingDate} is closed.`);
    }

    // ---- Allocate the gapless entry number (ADR-003) ------------------------
    // SELECT … FOR UPDATE inside this transaction, so a rollback reuses the
    // number and the sequence stays gapless. Serialises concurrent postings to
    // THIS company only.
    const entryNumber = await allocateEntryNumber(tx, input.companyId);

    // ---- Insert the posted entry and its lines ------------------------------
    const entryRows = await tx
      .insert(schema.journalEntries)
      .values({
        companyId: input.companyId,
        entryNumber,
        transactionDate: input.transactionDate,
        postingDate,
        description: input.description,
        status: 'POSTED',
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.actorUserId,
        postedAt: sql`now()`,
      })
      .returning();
    const entry = entryRows[0];
    if (entry === undefined) throw new Error('journal entry insert returned no row');

    await tx.insert(schema.journalLines).values(
      input.lines.map((line, index) => ({
        journalEntryId: entry.id,
        companyId: input.companyId,
        accountId: line.accountId,
        lineNumber: index + 1,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        customerId: line.customerId,
        vendorId: line.vendorId,
      })),
    );

    // ---- Audit, INSIDE the transaction --------------------------------------
    // A record written in a separate transaction could survive a rolled-back
    // posting and describe something that never happened.
    await recordAuditEvent({
      tx,
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: 'JOURNAL_ENTRY_POSTED',
      entityType: 'journal_entry',
      entityId: entry.id,
      after: { entryNumber, sourceType: input.sourceType, lineCount: input.lines.length },
    });

    // The deferred balance trigger validates debits=credits AT COMMIT (LL-030).
    return await loadEntry(tx, entry.id);
  });
}

/** Structural validation (invariant 6's line rules, in the app for a clear error). */
function validateStructure(input: PostJournalEntryInput): void {
  if (input.lines.length < 2) {
    throw new LedgerError('INSUFFICIENT_LINES', 'A journal entry needs at least two lines.');
  }
  for (const line of input.lines) {
    const debit = sumMoney([line.debit]);
    const credit = sumMoney([line.credit]);
    const debitPos = debit.greaterThan(0);
    const creditPos = credit.greaterThan(0);
    if (debit.isNegative() || credit.isNegative() || debitPos === creditPos) {
      throw new LedgerError(
        'INVALID_LINE',
        'Each line must have exactly one positive amount, debit or credit.',
      );
    }
  }
}

/** Balance validation — exact equality at NUMERIC(19,4), decimal.js (ADR-004). */
function validateBalance(input: PostJournalEntryInput): void {
  const debits = sumMoney(input.lines.map((l) => l.debit));
  const credits = sumMoney(input.lines.map((l) => l.credit));
  if (!moneyEquals(debits, credits)) {
    throw new LedgerError(
      'UNBALANCED_JOURNAL_ENTRY',
      `Debits (${debits.toString()}) must equal credits (${credits.toString()}).`,
    );
  }
}

/** Gapless per-company allocation via the locked counter row (ADR-003). */
async function allocateEntryNumber(tx: Tx, companyId: string): Promise<number> {
  const rows = await tx.execute<{ next_entry_number: string }>(sql`
    update company_counters
    set next_entry_number = next_entry_number + 1
    where company_id = ${companyId}
    returning next_entry_number - 1 as next_entry_number`);
  const value = rows.rows[0]?.next_entry_number;
  if (value === undefined) {
    throw new LedgerError('COMPANY_NOT_FOUND', 'No entry-number counter for this company.');
  }
  return Number(value);
}

async function loadEntry(tx: Tx, entryId: string): Promise<PostedEntry> {
  const entryRows = await tx
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, entryId))
    .limit(1);
  const entry = entryRows[0];
  if (entry === undefined) throw new Error('posted entry vanished');
  const lines = await tx
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.journalEntryId, entryId))
    .orderBy(schema.journalLines.lineNumber);
  return { entry, lines };
}

export { LedgerError } from './errors';
export type { LedgerErrorCode } from './errors';
