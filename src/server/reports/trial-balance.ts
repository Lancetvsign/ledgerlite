import 'server-only';

import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { moneyEquals, toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Trial balance — LL-034.
 *
 * Computed ENTIRELY from `journal_lines`. No balance is stored anywhere (invariant
 * 2); if you ever want a cached total here, that is the ADR-gated decision LL-020
 * warned about, not a shortcut to take. PostgreSQL does the arithmetic — we never
 * pull raw lines into JavaScript to sum them — and money crosses every boundary as
 * a `string` (ADR-004).
 *
 * "As of" a date means every entry posted on or before it (by POSTING date, which
 * determines the period — ADR-002). Entries in the ledger are `POSTED` or
 * `REVERSED`; drafts never appear. A reversed entry is NOT excluded — it and its
 * reversal both count and net to zero (see `invariants.ts`), which is the honest
 * presentation and the only one that balances.
 */

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  readonly accountType: string;
  readonly debits: string;
  readonly credits: string;
  /** Net balance in the account's natural direction, as a signed string. */
  readonly balance: string;
}

export interface TrialBalance {
  readonly asOfDate: string;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebits: string;
  readonly totalCredits: string;
  /** Debits equal credits exactly. Always true for an intact ledger. */
  readonly balanced: boolean;
}

export async function getTrialBalance(
  actorUserId: string,
  companyId: string,
  asOfDate: string,
): Promise<TrialBalance> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(asOfDate)) {
    throw new Error(`Trial balance asOfDate must be a calendar date (YYYY-MM-DD): ${asOfDate}`);
  }

  const db = getDb();

  // Per-account aggregation. Debit-natural accounts (ASSET, EXPENSE, COGS) carry a
  // debit balance; the rest (LIABILITY, EQUITY, REVENUE) carry a credit balance.
  const perAccount = await db.execute<{
    account_id: string;
    account_number: string | null;
    account_name: string;
    account_type: string;
    debits: string;
    credits: string;
    balance: string;
  }>(sql`
    select
      a.id::text            as account_id,
      a.account_number      as account_number,
      a.name                as account_name,
      a.account_type::text  as account_type,
      sum(l.debit)::numeric(19,4)::text  as debits,
      sum(l.credit)::numeric(19,4)::text as credits,
      (case when a.account_type in ('ASSET', 'EXPENSE', 'COGS')
            then sum(l.debit) - sum(l.credit)
            else sum(l.credit) - sum(l.debit)
       end)::numeric(19,4)::text as balance
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id = ${companyId}
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date <= ${asOfDate}
    group by a.id, a.account_number, a.name, a.account_type
    order by a.account_number nulls last, a.name`);

  // Company-wide totals, computed by the database (the authoritative engine) over
  // the same population — not by summing the rows above in JavaScript.
  const totals = await db.execute<{ debits: string | null; credits: string | null }>(sql`
    select
      sum(l.debit)::numeric(19,4)::text  as debits,
      sum(l.credit)::numeric(19,4)::text as credits
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    where l.company_id = ${companyId}
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date <= ${asOfDate}`);

  const totalDebits = totals.rows[0]?.debits ?? '0.0000';
  const totalCredits = totals.rows[0]?.credits ?? '0.0000';

  return {
    asOfDate,
    rows: perAccount.rows.map((r) => ({
      accountId: r.account_id,
      accountNumber: r.account_number,
      accountName: r.account_name,
      accountType: r.account_type,
      debits: r.debits,
      credits: r.credits,
      balance: r.balance,
    })),
    totalDebits,
    totalCredits,
    balanced: moneyEquals(toMoney(totalDebits), toMoney(totalCredits)),
  };
}
