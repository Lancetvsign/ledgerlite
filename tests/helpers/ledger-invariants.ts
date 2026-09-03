import { sql } from 'drizzle-orm';

import { getTestDb } from './database';

/**
 * The three assertions the LL-032 ticket demands after EVERY concurrency test:
 * every posted entry balances, each source posts exactly once, and no partial
 * journal exists. Reusable so no concurrency test can forget one.
 */
export async function assertLedgerIntact(companyId: string): Promise<void> {
  const db = await getTestDb();

  // 1. Every POSTED entry balances (sum debits == sum credits per entry).
  const unbalanced = await db.execute<{ id: string }>(sql`
    select e.id from journal_entries e
    join journal_lines l on l.journal_entry_id = e.id
    where e.company_id = ${companyId} and e.status = 'POSTED'
    group by e.id
    having sum(l.debit) <> sum(l.credit)`);
  if (unbalanced.rows.length > 0) {
    throw new Error(`Unbalanced POSTED entries: ${unbalanced.rows.map((r) => r.id).join(', ')}`);
  }

  // 2. Each source transaction posted exactly once.
  const dupSource = await db.execute<{ source_id: string; n: string }>(sql`
    select source_id, count(*)::text n from journal_entries
    where company_id = ${companyId} and status = 'POSTED' and source_id is not null
    group by source_type, source_id having count(*) > 1`);
  if (dupSource.rows.length > 0) {
    throw new Error(`Source posted more than once: ${JSON.stringify(dupSource.rows)}`);
  }

  // 3. No partial journal: no POSTED entry without lines, no line without an entry.
  const noLines = await db.execute<{ id: string }>(sql`
    select e.id from journal_entries e
    where e.company_id = ${companyId} and e.status = 'POSTED'
      and not exists (select 1 from journal_lines l where l.journal_entry_id = e.id)`);
  if (noLines.rows.length > 0) {
    throw new Error(`POSTED entries with no lines: ${noLines.rows.map((r) => r.id).join(', ')}`);
  }
  const orphanLines = await db.execute<{ id: string }>(sql`
    select l.id from journal_lines l
    where l.company_id = ${companyId}
      and not exists (select 1 from journal_entries e where e.id = l.journal_entry_id)`);
  if (orphanLines.rows.length > 0) {
    throw new Error(`Orphan journal lines: ${orphanLines.rows.map((r) => r.id).join(', ')}`);
  }
}

/** The set of entry_numbers for a company's POSTED entries, sorted. */
export async function entryNumbers(companyId: string): Promise<number[]> {
  const db = await getTestDb();
  const rows = await db.execute<{ entry_number: string }>(sql`
    select entry_number from journal_entries
    where company_id = ${companyId} and entry_number is not null
    order by entry_number`);
  return rows.rows.map((r) => Number(r.entry_number));
}
