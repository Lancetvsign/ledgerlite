import 'server-only';

import { sql } from 'drizzle-orm';

import { getDbTx } from '@/db';

import type { PoolDatabase } from '@/db';

/**
 * Ledger integrity assertions — LL-034.
 *
 * These prove, from the raw tables, that the ledger has not been corrupted. They
 * are the reusable audit the rest of the product leans on: every gate runs them,
 * and the integration suite runs all four after EVERY test (see
 * `tests/helpers/integration-setup.ts`), so any test that corrupts the ledger —
 * even one written to check something else entirely — fails loudly.
 *
 * WHAT "IN THE LEDGER" MEANS. A journal entry counts toward balances when its
 * status is `POSTED` or `REVERSED`, and is excluded only when `DRAFT`. A reversed
 * entry is NOT removed from the books: LL-033 leaves the original exactly as
 * posted and adds an offsetting entry, and the two net to zero only if BOTH are
 * counted. Excluding `REVERSED` would drop the original and leave the reversal
 * standing alone — the opposite of a correction. This is why every query below
 * says `status in ('POSTED','REVERSED')`, never `= 'POSTED'`.
 *
 * Reads go through the pool client so a caller can inject its own transaction
 * (the corruption tests do, to observe deliberately-broken state before rolling
 * it back). That mirrors `getAccountingPeriod`'s executor pattern.
 */

/** A pool client or an open transaction on one. */
export type Executor =
  | PoolDatabase
  | Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/** Thrown when an integrity check finds violations. Carries the offending ids. */
export class LedgerIntegrityError extends Error {
  public override readonly name = 'LedgerIntegrityError';
  constructor(
    public readonly check: string,
    public readonly violations: readonly string[],
  ) {
    super(`Ledger integrity violation [${check}]: ${String(violations.length)} row(s): ${violations.join(', ')}`);
  }
}

/** SQL fragment scoping a query to one company, or to all when undefined. */
function only(companyId: string | undefined, column: string): ReturnType<typeof sql> {
  return companyId === undefined ? sql`true` : sql`${sql.raw(column)} = ${companyId}`;
}

/** POSTED entries (and REVERSED — still in the ledger) whose debits ≠ credits. */
export async function findUnbalancedEntries(
  exec: Executor,
  companyId?: string,
): Promise<string[]> {
  const rows = await exec.execute<{ id: string }>(sql`
    select e.id::text as id
    from journal_entries e
    join journal_lines l on l.journal_entry_id = e.id
    where e.status in ('POSTED', 'REVERSED') and ${only(companyId, 'e.company_id')}
    group by e.id
    having sum(l.debit) <> sum(l.credit)`);
  return rows.rows.map((r) => r.id);
}

/** Ledger entries with no lines, and lines whose entry does not exist. */
export async function findOrphans(exec: Executor, companyId?: string): Promise<string[]> {
  const entriesWithoutLines = await exec.execute<{ id: string }>(sql`
    select e.id::text as id
    from journal_entries e
    where e.status in ('POSTED', 'REVERSED') and ${only(companyId, 'e.company_id')}
      and not exists (select 1 from journal_lines l where l.journal_entry_id = e.id)`);
  const linesWithoutEntry = await exec.execute<{ id: string }>(sql`
    select l.id::text as id
    from journal_lines l
    where ${only(companyId, 'l.company_id')}
      and not exists (select 1 from journal_entries e where e.id = l.journal_entry_id)`);
  return [
    ...entriesWithoutLines.rows.map((r) => `entry:${r.id}`),
    ...linesWithoutEntry.rows.map((r) => `line:${r.id}`),
  ];
}

/** Lines whose account is missing or belongs to a different company (invariant 4). */
export async function findCrossCompanyLines(
  exec: Executor,
  companyId?: string,
): Promise<string[]> {
  const rows = await exec.execute<{ id: string }>(sql`
    select l.id::text as id
    from journal_lines l
    left join accounts a on a.id = l.account_id
    where ${only(companyId, 'l.company_id')}
      and (a.id is null or a.company_id <> l.company_id)`);
  return rows.rows.map((r) => r.id);
}

/** Companies whose ledger-wide debits ≠ credits. */
export async function findTrialBalanceImbalances(
  exec: Executor,
  companyId?: string,
): Promise<string[]> {
  const rows = await exec.execute<{ company_id: string }>(sql`
    select e.company_id::text as company_id
    from journal_entries e
    join journal_lines l on l.journal_entry_id = e.id
    where e.status in ('POSTED', 'REVERSED') and ${only(companyId, 'e.company_id')}
    group by e.company_id
    having sum(l.debit) <> sum(l.credit)`);
  return rows.rows.map((r) => r.company_id);
}

/** Every POSTED/REVERSED entry's debits equal its credits, individually. */
export async function assertLedgerBalanced(companyId?: string, exec: Executor = getDbTx()): Promise<void> {
  const v = await findUnbalancedEntries(exec, companyId);
  if (v.length > 0) throw new LedgerIntegrityError('ledger-balanced', v);
}

/** No entry without lines, no line without an entry. */
export async function assertNoOrphanedLines(companyId?: string, exec: Executor = getDbTx()): Promise<void> {
  const v = await findOrphans(exec, companyId);
  if (v.length > 0) throw new LedgerIntegrityError('no-orphaned-lines', v);
}

/** No line references an account of another company (invariant 4). */
export async function assertAccountOwnership(companyId?: string, exec: Executor = getDbTx()): Promise<void> {
  const v = await findCrossCompanyLines(exec, companyId);
  if (v.length > 0) throw new LedgerIntegrityError('account-ownership', v);
}

/** Company-wide debits equal credits — a consequence of every entry balancing. */
export async function assertTrialBalanceBalanced(companyId?: string, exec: Executor = getDbTx()): Promise<void> {
  const v = await findTrialBalanceImbalances(exec, companyId);
  if (v.length > 0) throw new LedgerIntegrityError('trial-balance-balanced', v);
}

/**
 * All four checks at once, across every company (or one). This is what the test
 * teardown calls, turning the whole integration suite into a continuous audit.
 */
export async function assertLedgerIntegrity(companyId?: string, exec: Executor = getDbTx()): Promise<void> {
  await Promise.all([
    assertLedgerBalanced(companyId, exec),
    assertNoOrphanedLines(companyId, exec),
    assertAccountOwnership(companyId, exec),
    assertTrialBalanceBalanced(companyId, exec),
  ]);
}
