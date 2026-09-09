import 'server-only';

import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { sumMoney, toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Income Statement (Profit & Loss) — LL-072.
 *
 * Computed ENTIRELY from `journal_lines` over a date RANGE [fromDate, toDate] by POSTING
 * date (ADR-002). No balance or subtotal is stored (invariant 2). PostgreSQL does the
 * arithmetic, cast to NUMERIC(19,4)::text; money crosses every boundary as a `string`
 * (ADR-004) and JS only ever adds/subtracts through decimal.js.
 *
 *   Revenue − COGS = Gross profit ; Gross profit − Operating expenses = Net income.
 *
 * Only income-statement accounts (REVENUE / COGS / EXPENSE) participate. REVENUE is
 * credit-natural (credits − debits); COGS and EXPENSE are debit-natural (debits −
 * credits). A REVERSED entry and its reversal both count and net to zero, exactly like
 * the trial balance.
 */

export interface IncomeStatementRow {
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  /** Amount in the account's natural direction over the period, as a signed string. */
  readonly amount: string;
}

export interface IncomeStatementSection {
  readonly rows: readonly IncomeStatementRow[];
  readonly total: string;
}

export interface IncomeStatement {
  readonly fromDate: string;
  readonly toDate: string;
  readonly revenue: IncomeStatementSection;
  readonly cogs: IncomeStatementSection;
  /** Revenue − COGS. */
  readonly grossProfit: string;
  readonly expenses: IncomeStatementSection;
  /** Gross profit − operating expenses. */
  readonly netIncome: string;
}

type Row = {
  account_id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  amount: string;
};

function section(rows: Row[]): IncomeStatementSection {
  const mapped = rows.map((r) => ({
    accountId: r.account_id,
    accountNumber: r.account_number,
    accountName: r.account_name,
    amount: r.amount,
  }));
  return { rows: mapped, total: sumMoney(mapped.map((r) => r.amount)).toFixed(4) };
}

export async function getIncomeStatement(
  actorUserId: string,
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<IncomeStatement> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(fromDate)) {
    throw new Error(`Income statement fromDate must be a calendar date (YYYY-MM-DD): ${fromDate}`);
  }
  if (!isCalendarDate(toDate)) {
    throw new Error(`Income statement toDate must be a calendar date (YYYY-MM-DD): ${toDate}`);
  }
  // Calendar-date strings compare chronologically as plain strings.
  if (fromDate > toDate) {
    throw new Error(`Income statement fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  }

  const db = getDb();

  // Per-account amount in natural direction over the period. Debit-natural COGS/EXPENSE
  // take debits − credits; credit-natural REVENUE takes credits − debits.
  const perAccount = await db.execute<Row>(sql`
    select
      a.id::text            as account_id,
      a.account_number      as account_number,
      a.name                as account_name,
      a.account_type::text  as account_type,
      (case when a.account_type = 'REVENUE'
            then sum(l.credit) - sum(l.debit)
            else sum(l.debit) - sum(l.credit)
       end)::numeric(19,4)::text as amount
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id = ${companyId}
      and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date between ${fromDate} and ${toDate}
    group by a.id, a.account_number, a.name, a.account_type
    order by a.account_number nulls last, a.name`);

  const revenue = section(perAccount.rows.filter((r) => r.account_type === 'REVENUE'));
  const cogs = section(perAccount.rows.filter((r) => r.account_type === 'COGS'));
  const expenses = section(perAccount.rows.filter((r) => r.account_type === 'EXPENSE'));

  const grossProfit = toMoney(revenue.total).minus(toMoney(cogs.total));
  const netIncome = grossProfit.minus(toMoney(expenses.total));

  return {
    fromDate,
    toDate,
    revenue,
    cogs,
    grossProfit: grossProfit.toFixed(4),
    expenses,
    netIncome: netIncome.toFixed(4),
  };
}
