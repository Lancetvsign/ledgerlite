import 'server-only';

import { and, eq } from 'drizzle-orm';

import { getDb, schema } from '@/db';
import { requirePermission } from '@/server/authorization';

import type { JournalEntry } from '@/db/schema';

/**
 * Journal read queries — LL-035. Reads go through the HTTP client (ADR-001).
 *
 * Every read is company-scoped and authorization-gated (`journal.view`), and an
 * entry that belongs to another company resolves to `null` exactly as a
 * non-existent one does — a detail page must not reveal that an id exists
 * elsewhere (AGENTS §6).
 */

export interface JournalEntryLineView {
  readonly id: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  readonly description: string | null;
  readonly debit: string;
  readonly credit: string;
}

export interface JournalEntryView {
  readonly entry: JournalEntry;
  readonly lines: readonly JournalEntryLineView[];
}

export async function getJournalEntry(
  actorUserId: string,
  companyId: string,
  entryId: string,
): Promise<JournalEntryView | null> {
  await requirePermission(actorUserId, companyId, 'journal.view');

  const db = getDb();
  const entryRows = await db
    .select()
    .from(schema.journalEntries)
    .where(
      and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.id, entryId)),
    )
    .limit(1);
  const entry = entryRows[0];
  if (entry === undefined) return null;

  // Join account name/number for display. The composite key (company_id, id)
  // keeps the join inside this company.
  const lines = await db
    .select({
      id: schema.journalLines.id,
      lineNumber: schema.journalLines.lineNumber,
      accountId: schema.journalLines.accountId,
      accountNumber: schema.accounts.accountNumber,
      accountName: schema.accounts.name,
      description: schema.journalLines.description,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.accounts,
      and(
        eq(schema.accounts.id, schema.journalLines.accountId),
        eq(schema.accounts.companyId, schema.journalLines.companyId),
      ),
    )
    .where(eq(schema.journalLines.journalEntryId, entryId))
    .orderBy(schema.journalLines.lineNumber);

  return { entry, lines };
}
