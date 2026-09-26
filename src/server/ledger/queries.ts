import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

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
  /** LL-110: the other end of a reversal (this entry's reversal, or the entry it reverses), by number. */
  readonly reversedByNumber: number | null;
  readonly reversalOfNumber: number | null;
  /** LL-110: the statement batch of a BANK_IMPORT / INTERCOMPANY posting, where its Undo lives. */
  readonly bankImportBatchId: string | null;
  /**
   * LL-110: the source that owns this entry's correction when a manual reversal is refused — the
   * entry itself for a manual entry (or a reversal rooted in one), else the document / statement.
   */
  readonly rootSourceType: string;
}

/** A recent posted entry, summarised for the dashboard feed (LL-075). */
export interface RecentEntry {
  readonly id: string;
  readonly entryNumber: number | null;
  readonly postingDate: string;
  readonly description: string | null;
  readonly sourceType: string;
  readonly status: string;
  /** The entry's size = its total debits (= total credits), as a money string. */
  readonly total: string;
}

type RecentEntryRow = {
  id: string;
  entry_number: number | null;
  posting_date: string;
  description: string | null;
  source_type: string;
  status: string;
  total: string;
};

/**
 * The most recent posted/reversed entries for the dashboard's activity feed (LL-075).
 * Gated on `report.view` (a summary surface, granted to every member), not `journal.view`,
 * so the whole dashboard is consistently viewable. Read-only via the HTTP client.
 */
export async function listRecentEntries(
  actorUserId: string,
  companyId: string,
  limit = 10,
): Promise<RecentEntry[]> {
  await requirePermission(actorUserId, companyId, 'report.view');

  const rows = await getDb().execute<RecentEntryRow>(sql`
    select
      e.id::text            as id,
      e.entry_number::int   as entry_number,
      e.posting_date        as posting_date,
      e.description         as description,
      e.source_type::text   as source_type,
      e.status::text        as status,
      coalesce(
        (select sum(l.debit) from journal_lines l where l.journal_entry_id = e.id), 0
      )::numeric(19,4)::text as total
    from journal_entries e
    where e.company_id = ${companyId}
      and e.status in ('POSTED', 'REVERSED')
    order by e.posting_date desc, e.entry_number desc nulls last
    limit ${limit}`);

  return rows.rows.map((r) => ({
    id: r.id,
    entryNumber: r.entry_number,
    postingDate: r.posting_date,
    description: r.description,
    sourceType: r.source_type,
    status: r.status,
    total: r.total,
  }));
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

  const numberOf = async (id: string | null): Promise<number | null> =>
    id === null
      ? null
      : ((await db.select({ n: schema.journalEntries.entryNumber }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.id, id))).limit(1))[0]?.n ?? null);
  // Walk a reversal chain to its root (the same rule the manual reversal applies — LL-066).
  let rootSourceType: string = entry.sourceType;
  let parent = entry.reversalOfId;
  const seen = new Set<string>([entry.id]);
  while (rootSourceType === 'REVERSAL' && parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const p = (await db.select({ sourceType: schema.journalEntries.sourceType, reversalOfId: schema.journalEntries.reversalOfId }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.id, parent))).limit(1))[0];
    if (p === undefined) break;
    rootSourceType = p.sourceType;
    parent = p.reversalOfId;
  }
  const batch =
    entry.sourceType === 'BANK_IMPORT' || entry.sourceType === 'INTERCOMPANY'
      ? ((await db.select({ batchId: schema.bankImportLines.batchId }).from(schema.bankImportLines).where(and(eq(schema.bankImportLines.companyId, companyId), sql`${schema.bankImportLines.id}::text = ${entry.sourceId ?? ''}`)).limit(1))[0]?.batchId ?? null)
      : null;

  return {
    entry,
    lines,
    reversedByNumber: await numberOf(entry.reversedById),
    reversalOfNumber: await numberOf(entry.reversalOfId),
    bankImportBatchId: batch,
    rootSourceType,
  };
}
