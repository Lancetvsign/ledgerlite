import 'server-only';

import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { fiscalYearStart, isCalendarDate } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Balance Sheet — LL-072.
 *
 * Computed ENTIRELY from `journal_lines` as of a date (ADR-002). No balance is stored
 * (invariant 2); PostgreSQL does the arithmetic, cast to NUMERIC(19,4)::text, and money
 * crosses every boundary as a `string` (ADR-004).
 *
 * Assets = Liabilities + Equity. Because period-close posts NO closing entry (it only
 * flips a status flag), revenue/expense accounts accumulate across all time and the
 * Retained Earnings account is never written. So the statement DERIVES net income into
 * equity — otherwise the identity would not hold. Net income for income-statement
 * accounts is `Σ(credit − debit)`, split at the company's fiscal-year start (ADR-030)
 * into:
 *   - Retained earnings (prior years): Σ(credit − debit) for postings BEFORE fyStart
 *   - Net income (current year):       Σ(credit − debit) for postings on/after fyStart (≤ asOf)
 * The Retained Earnings account itself still appears as its own equity row (usually zero).
 */

export interface BalanceSheetRow {
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  /** Balance in the account's natural direction, as a signed string. */
  readonly balance: string;
}

export interface BalanceSheetSection {
  readonly rows: readonly BalanceSheetRow[];
  readonly total: string;
}

export interface BalanceSheetEquity {
  /** The EQUITY-type accounts (Owner equity, Opening Balance Equity, Retained Earnings, …). */
  readonly accountRows: readonly BalanceSheetRow[];
  /** Derived: net income accumulated before the current fiscal year. */
  readonly priorRetainedEarnings: string;
  /** Derived: net income from the fiscal-year start through the as-of date. */
  readonly currentNetIncome: string;
  /** Equity accounts + prior retained earnings + current net income. */
  readonly total: string;
}

export interface BalanceSheet {
  readonly asOfDate: string;
  /** First day of the fiscal year containing asOf (the earnings split boundary). */
  readonly fiscalYearStart: string;
  readonly assets: BalanceSheetSection;
  readonly liabilities: BalanceSheetSection;
  readonly equity: BalanceSheetEquity;
  /** Liabilities + Equity — the right-hand side, which equals assets when balanced. */
  readonly liabilitiesAndEquityTotal: string;
  /** Assets equal Liabilities + Equity, exactly. Always true for an intact ledger. */
  readonly balanced: boolean;
}

type AccountRow = {
  account_id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  balance: string;
};

function toRow(r: AccountRow): BalanceSheetRow {
  return { accountId: r.account_id, accountNumber: r.account_number, accountName: r.account_name, balance: r.balance };
}

function sectionOf(rows: AccountRow[]): BalanceSheetSection {
  const mapped = rows.map(toRow);
  return { rows: mapped, total: sumMoney(mapped.map((r) => r.balance)).toFixed(4) };
}

export async function getBalanceSheet(
  actorUserId: string,
  companyId: string,
  asOfDate: string,
): Promise<BalanceSheet> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(asOfDate)) {
    throw new Error(`Balance sheet asOfDate must be a calendar date (YYYY-MM-DD): ${asOfDate}`);
  }

  const db = getDb();

  // The fiscal-year start month drives the earnings split (labelling only; postings
  // resolve against plain calendar months).
  const companyRows = await db.execute<{ fiscal_year_start_month: number }>(
    sql`select fiscal_year_start_month from companies where id = ${companyId} limit 1`,
  );
  const startMonth = companyRows.rows[0]?.fiscal_year_start_month ?? 1;
  const fy = fiscalYearStart(asOfDate, startMonth);
  const fyStart = `${String(fy.year)}-${String(fy.month).padStart(2, '0')}-01`;

  // Balance-sheet accounts: ASSET is debit-natural (debits − credits); LIABILITY and
  // EQUITY are credit-natural (credits − debits).
  const perAccount = await db.execute<AccountRow>(sql`
    select
      a.id::text            as account_id,
      a.account_number      as account_number,
      a.name                as account_name,
      a.account_type::text  as account_type,
      (case when a.account_type = 'ASSET'
            then sum(l.debit) - sum(l.credit)
            else sum(l.credit) - sum(l.debit)
       end)::numeric(19,4)::text as balance
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id = ${companyId}
      and a.account_type in ('ASSET', 'LIABILITY', 'EQUITY')
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date <= ${asOfDate}
    group by a.id, a.account_number, a.name, a.account_type
    order by a.account_number nulls last, a.name`);

  // Derived earnings from income-statement accounts, split at the fiscal-year start.
  const earnings = await db.execute<{ prior: string; current: string }>(sql`
    select
      coalesce(sum(case when e.posting_date < ${fyStart}  then l.credit - l.debit else 0 end), 0)::numeric(19,4)::text as prior,
      coalesce(sum(case when e.posting_date >= ${fyStart} then l.credit - l.debit else 0 end), 0)::numeric(19,4)::text as current
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id = ${companyId}
      and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date <= ${asOfDate}`);

  const assets = sectionOf(perAccount.rows.filter((r) => r.account_type === 'ASSET'));
  const liabilities = sectionOf(perAccount.rows.filter((r) => r.account_type === 'LIABILITY'));
  const equityAccounts = perAccount.rows.filter((r) => r.account_type === 'EQUITY').map(toRow);

  const priorRetainedEarnings = earnings.rows[0]?.prior ?? '0.0000';
  const currentNetIncome = earnings.rows[0]?.current ?? '0.0000';

  const equityTotal = sumMoney(equityAccounts.map((r) => r.balance))
    .plus(toMoney(priorRetainedEarnings))
    .plus(toMoney(currentNetIncome));

  const liabilitiesAndEquity = toMoney(liabilities.total).plus(equityTotal);

  return {
    asOfDate,
    fiscalYearStart: fyStart,
    assets,
    liabilities,
    equity: {
      accountRows: equityAccounts,
      priorRetainedEarnings,
      currentNetIncome,
      total: equityTotal.toFixed(4),
    },
    liabilitiesAndEquityTotal: liabilitiesAndEquity.toFixed(4),
    balanced: moneyEquals(toMoney(assets.total), liabilitiesAndEquity),
  };
}
