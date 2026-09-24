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

/**
 * Intercompany pairs whose two sides disagree (LL-098 / GL-T029): a company's "Due from B"
 * balance must equal B's "Due to <company>" balance — NET OF CASH IN TRANSIT (LL-099 / LL-101):
 * a bank transfer one company has MARKED from its own statement while the other has not yet
 * imported its side. "In transit" is defined narrowly: a single-sided INTERCOMPANY group whose
 * entry is the posting of a POSTED bank-import line of that company onto its pair account. Any
 * other single-sided grouped entry, a one-sided entry with no group, or an in-transit group older
 * than `maxTransitDays` (the transfer window plus a statement lag) is reported. NOT part of
 * `assertLedgerIntegrity`: integration fixtures legitimately seed one-sided rows to test the leave
 * rule. The release gate (GL-T029) and the intercompany report call it explicitly.
 */
export const DEFAULT_MAX_TRANSIT_DAYS = 33;

export async function findIntercompanyMismatches(
  exec: Executor,
  companyId?: string,
  options: { readonly maxTransitDays?: number; readonly asOf?: string } = {},
): Promise<string[]> {
  const maxDays = options.maxTransitDays ?? DEFAULT_MAX_TRANSIT_DAYS;
  const asOf = options.asOf === undefined ? sql`current_date` : sql`${options.asOf}::date`;
  const scope = companyId === undefined ? sql`true` : sql`(g.x = ${companyId} or g.y = ${companyId})`;
  const rows = await exec.execute<{ pair: string }>(sql`
    with bal as (
      select a.id as account_id, a.company_id, a.intercompany_company_id as counterpart_id, a.system_account_type as role,
             coalesce(sum(case when e.status in ('POSTED','REVERSED') and e.posting_date <= ${asOf} then (case when a.account_type = 'ASSET' then l.debit - l.credit else l.credit - l.debit end) else 0 end), 0) as balance
      from accounts a
      left join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
      left join journal_entries e on e.id = l.journal_entry_id
      where a.intercompany_company_id is not null
      group by a.id, a.company_id, a.intercompany_company_id, a.system_account_type
    ),
    single as (
      -- a MARK: the posting of this company's own POSTED statement line onto its pair account,
      -- whose group has no other side as of the date
      select e.id, e.company_id, e.transaction_date, pa.intercompany_company_id as counterpart_id
      from journal_entries e
      join bank_import_lines bl on bl.company_id = e.company_id and bl.id::text = e.source_id and bl.status = 'POSTED' and bl.journal_entry_id = e.id
      join accounts pa on pa.company_id = bl.company_id and pa.id = bl.chosen_account_id and pa.intercompany_company_id is not null
      where e.source_type = 'INTERCOMPANY' and e.status = 'POSTED' and e.intercompany_group_id is not null and e.posting_date <= ${asOf}
        and not exists (select 1 from journal_entries o where o.intercompany_group_id = e.intercompany_group_id and o.id <> e.id and o.posting_date <= ${asOf})
    ),
    transit as (
      select a.id as account_id,
             coalesce(sum(case when a.account_type = 'ASSET' then l.debit - l.credit else l.credit - l.debit end), 0) as amt
      from accounts a
      join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
      join single s on s.id = l.journal_entry_id
      where a.intercompany_company_id is not null
      group by a.id
    ),
    balt as (select b.*, coalesce(t.amt, 0) as transit from bal b left join transit t on t.account_id = b.account_id),
    g as (
      select coalesce(r.company_id, p.counterpart_id) as x, coalesce(r.counterpart_id, p.company_id) as y,
             (coalesce(r.balance, 0) - coalesce(p.balance, 0)) - (coalesce(r.transit, 0) - coalesce(p.transit, 0)) as gap
      from (select * from balt where role = 'INTERCOMPANY_RECEIVABLE') r
      full join (select * from balt where role = 'INTERCOMPANY_PAYABLE') p
        on p.company_id = r.counterpart_id and p.counterpart_id = r.company_id
    )
    select (g.x::text || '->' || g.y::text) as pair from g where g.gap <> 0 and ${scope}
    union all
    select ('stale:' || s.company_id::text || '->' || s.counterpart_id::text || ':' || s.id::text) as pair
    from single s
    where (${asOf} - s.transaction_date) > ${maxDays}
      and (${companyId === undefined ? sql`true` : sql`(s.company_id = ${companyId} or s.counterpart_id = ${companyId})`})`);
  return rows.rows.map((r) => r.pair);
}

/** Every intercompany pair mirrors net of fresh cash in transit — GL-T029. Explicit, not part of assertLedgerIntegrity (see above). */
export async function assertIntercompanyMirror(companyId?: string, exec: Executor = getDbTx(), options: { readonly maxTransitDays?: number; readonly asOf?: string } = {}): Promise<void> {
  const v = await findIntercompanyMismatches(exec, companyId, options);
  if (v.length > 0) throw new LedgerIntegrityError('intercompany-mirror', v);
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
