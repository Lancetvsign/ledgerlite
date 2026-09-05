import 'server-only';

import { eq, sql } from 'drizzle-orm';

import { schema } from '@/db';

import { LedgerError } from './errors';

import type { PoolDatabase } from '@/db';
import type { JournalEntry, JournalLine } from '@/db/schema';

/**
 * Shared posting primitives — used by BOTH the posting engine (LL-031) and the
 * reversal engine (LL-033). They live here, module-internal, rather than being
 * exported from the module barrel: a reversal is a posting, so it must allocate
 * a gapless number and load its result exactly as a first-hand posting does, but
 * feature modules still get only `LedgerService` (AGENTS §4.8), never these.
 */

export type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

export interface PostedEntry {
  readonly entry: JournalEntry;
  readonly lines: JournalLine[];
}

/**
 * Gapless per-company allocation via the locked counter row (ADR-003). The
 * UPDATE ... RETURNING takes a row lock for the life of the transaction, so
 * concurrent allocators for the SAME company serialise and a rolled-back
 * transaction reuses the number — the sequence never gaps. A reversal draws its
 * number from the same counter as any other posting; it is not a special series.
 */
export async function allocateEntryNumber(tx: Tx, companyId: string): Promise<number> {
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

/** Loads an entry and its lines (ordered), for the caller to return. */
export async function loadEntry(tx: Tx | PoolDatabase, entryId: string): Promise<PostedEntry> {
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

/**
 * Maps the LL-030 immutability trigger's raw rejection to a typed domain error.
 *
 * The triggers raise `POSTED_ENTRY_IMMUTABLE: …` with SQLSTATE `restrict_violation`
 * (23001) on any UPDATE/DELETE of a posted entry or its lines outside the one
 * permitted POSTED→REVERSED transition. Drizzle wraps the driver error and carries
 * the text on the CAUSE chain, not the top-level message — so we walk the chain
 * (a lesson this codebase keeps relearning). Anything else passes through untouched.
 */
export function toLedgerDomainError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  let text = '';
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    text += ' ' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  if (/POSTED_ENTRY_IMMUTABLE/.test(text)) {
    return new LedgerError(
      'POSTED_ENTRY_IMMUTABLE',
      'A posted entry cannot be modified; correct it with a reversal.',
    );
  }
  // The closed-period guard (migration 0010) raises this at INSERT time. It only
  // surfaces here in the rare race where a close commits between the service's own
  // period check and the insert — the service's early check catches the common
  // case first — but when it does, callers still get the typed PERIOD_CLOSED.
  if (/PERIOD_CLOSED/.test(text)) {
    return new LedgerError(
      'PERIOD_CLOSED',
      'The accounting period for this posting date is closed.',
    );
  }
  // The A/R control-account guard (migration 0018) raises this when a manual journal
  // entry tries to post to Accounts Receivable — A/R moves only through invoices,
  // payments, and write-offs, so the aging subsidiary always reconciles (ADR-018).
  if (/CONTROL_ACCOUNT_MANUAL_POST/.test(text)) {
    return new LedgerError(
      'CONTROL_ACCOUNT_MANUAL_POST',
      'A manual journal entry cannot post to the Accounts Receivable control account; use an invoice, payment, or write-off.',
    );
  }
  return error;
}
