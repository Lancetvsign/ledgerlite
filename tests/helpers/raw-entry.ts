import { sql } from 'drizzle-orm';

import type { PoolDatabase } from '@/db';

/**
 * The ONE raw-SQL shape that produces a posted entry — LL-104 / ADR-044.
 *
 * Since migration 0042 the `journal_lines` guard refuses any INSERT under a POSTED or
 * REVERSED entry, with no escape hatch. A fixture that bypasses LedgerService therefore
 * has to do what the engine does: insert the entry as a DRAFT, add the lines, then flip
 * it to POSTED. Every BEFORE UPDATE guard (closed period, control-account relabel) judges
 * the flip and the deferred balance trigger judges the commit — so a fixture that is
 * meant to be REFUSED is refused by the same rule as before, just on the transition or
 * at commit rather than on the insert.
 *
 * Returns the entry id. Runs the three statements on whatever executor it is given —
 * pass a transaction when the test needs the entry to roll back or to observe the
 * rejection at commit.
 */
export interface RawLine {
  readonly accountId: string;
  /** Strings only — a JS number never holds money (AGENTS §3), fixtures included. */
  readonly debit: string;
  readonly credit: string;
  readonly customerId?: string;
  readonly vendorId?: string;
}

export interface RawPostedEntryInput {
  readonly companyId: string;
  readonly userId: string;
  readonly sourceType: string;
  readonly lines: readonly RawLine[];
  readonly entryNumber?: number | null;
  readonly transactionDate?: string;
  readonly postingDate?: string;
  readonly description?: string | null;
  readonly sourceId?: string | null;
  readonly fingerprint?: string | null;
  readonly intercompanyGroupId?: string | null;
  readonly reversalOfId?: string | null;
}

type Executor = Pick<PoolDatabase, 'execute'>;

/** Inserts the DRAFT entry and its lines; returns the id without posting (a fixture for the transition itself). */
export async function rawDraftEntry(tx: Executor, input: RawPostedEntryInput): Promise<string> {
  const txnDate = input.transactionDate ?? '2026-01-10';
  const postingDate = input.postingDate ?? txnDate;
  const r = await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (company_id, transaction_date, posting_date, source_type, created_by, status, entry_number,
       description, source_id, idempotency_fingerprint, intercompany_group_id, reversal_of_id)
    values (${input.companyId}, ${txnDate}, ${postingDate}, ${input.sourceType}::journal_source_type, ${input.userId}, 'DRAFT',
            ${input.entryNumber ?? null}, ${input.description ?? null}, ${input.sourceId ?? null},
            ${input.fingerprint ?? null}, ${input.intercompanyGroupId ?? null}, ${input.reversalOfId ?? null})
    returning id`);
  const id = r.rows[0]!.id;
  let n = 1;
  for (const l of input.lines) {
    await tx.execute(sql`
      insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit, customer_id, vendor_id)
      values (${id}, ${input.companyId}, ${l.accountId}, ${n}, ${l.debit}, ${l.credit}, ${l.customerId ?? null}, ${l.vendorId ?? null})`);
    n += 1;
  }
  return id;
}

/** The DRAFT → POSTED transition, exactly as the engine performs it. */
export async function rawPost(tx: Executor, entryId: string): Promise<void> {
  await tx.execute(sql`update journal_entries set status = 'POSTED', posted_at = now() where id = ${entryId}`);
}

export async function rawPostedEntry(tx: Executor, input: RawPostedEntryInput): Promise<string> {
  const id = await rawDraftEntry(tx, input);
  await rawPost(tx, id);
  return id;
}
