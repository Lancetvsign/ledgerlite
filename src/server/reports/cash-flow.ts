import 'server-only';

import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

import { getIncomeStatement } from './income-statement';

/**
 * Cash-Flow Statement (indirect method) — LL-074.
 *
 * Derived from `journal_lines`, no stored figure (invariant 2). The identity, from
 * differencing the balance-sheet identity over a period:
 *
 *   ΔCash = NetIncome + Σ adjustments
 *
 * where each non-cash BALANCE-SHEET account's adjustment over the period is
 * `−Σ(debit − credit)` (an asset increase uses cash; a liability/equity increase provides
 * it). Adjustments are grouped by the account's `cashFlowCategory` into Operating /
 * Investing / Financing, with a visible Uncategorized bucket for any null-category
 * balance-sheet account so the total still reconciles. Income-statement accounts are NOT
 * adjusted — their effect IS net income. Closing entries and their reversals are excluded
 * from every delta (as the Income Statement is, LL-073), so a year-end close does not
 * double-count net income via Retained Earnings. Money is a `string`; arithmetic in
 * PostgreSQL / decimal.js only.
 */

export interface CashFlowLine {
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  /** Cash effect of the account's period change (signed). */
  readonly amount: string;
}

export interface CashFlowSection {
  readonly rows: readonly CashFlowLine[];
  readonly total: string;
}

export interface CashFlowStatement {
  readonly fromDate: string;
  readonly toDate: string;
  /** Operating = net income + working-capital adjustments. */
  readonly netIncome: string;
  readonly operatingAdjustments: readonly CashFlowLine[];
  readonly operatingTotal: string;
  readonly investing: CashFlowSection;
  readonly financing: CashFlowSection;
  /** Null-category balance-sheet accounts — should be empty on a well-classified chart. */
  readonly uncategorized: CashFlowSection;
  readonly netChangeInCash: string;
  readonly beginningCash: string;
  readonly endingCash: string;
  /** netChangeInCash equals endingCash − beginningCash, exactly. */
  readonly reconciled: boolean;
}

type DeltaRow = {
  account_id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  cash_flow_category: string | null;
  raw_delta: string;
};

/** Cash / cash-equivalents are definitionally assets categorised CASH. */
function isCashRow(r: DeltaRow): boolean {
  return r.account_type === 'ASSET' && r.cash_flow_category === 'CASH';
}

/** Adjustment (cash effect) of a non-cash account = −rawΔ. */
function toAdjustment(r: DeltaRow): CashFlowLine {
  return {
    accountId: r.account_id,
    accountNumber: r.account_number,
    accountName: r.account_name,
    amount: toMoney(r.raw_delta).negated().toFixed(4),
  };
}

function section(rows: DeltaRow[]): CashFlowSection {
  const lines = rows.map(toAdjustment);
  return { rows: lines, total: sumMoney(lines.map((l) => l.amount)).toFixed(4) };
}

export async function getCashFlowStatement(
  actorUserId: string,
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<CashFlowStatement> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(fromDate)) {
    throw new Error(`Cash-flow fromDate must be a calendar date (YYYY-MM-DD): ${fromDate}`);
  }
  if (!isCalendarDate(toDate)) {
    throw new Error(`Cash-flow toDate must be a calendar date (YYYY-MM-DD): ${toDate}`);
  }
  if (fromDate > toDate) {
    throw new Error(`Cash-flow fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  }

  const db = getDb();

  const income = await getIncomeStatement(actorUserId, companyId, fromDate, toDate);
  const netIncome = income.netIncome;

  // Period change per BALANCE-SHEET account, excluding closing entries and their reversals
  // (so net income is not double-counted through Retained Earnings on a closed year).
  const deltas = await db.execute<DeltaRow>(sql`
    select
      a.id::text                as account_id,
      a.account_number          as account_number,
      a.name                    as account_name,
      a.account_type::text      as account_type,
      a.cash_flow_category::text as cash_flow_category,
      (sum(l.debit) - sum(l.credit))::numeric(19,4)::text as raw_delta
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id = ${companyId}
      and a.account_type in ('ASSET', 'LIABILITY', 'EQUITY')
      and e.status in ('POSTED', 'REVERSED')
      and e.source_type <> 'CLOSING'
      and not exists (
        select 1 from journal_entries oe
        where oe.id = e.reversal_of_id and oe.source_type = 'CLOSING'
      )
      and e.posting_date between ${fromDate} and ${toDate}
    group by a.id, a.account_number, a.name, a.account_type, a.cash_flow_category
    having (sum(l.debit) - sum(l.credit)) <> 0
    order by a.account_number nulls last, a.name`);

  // Cash (ASSET + CASH) is the reconciliation target, not an adjustment; every OTHER
  // balance-sheet account is an adjustment grouped by category. Anything left over — a
  // null category, or a CASH tag mistakenly put on a non-asset — lands in Uncategorized
  // so the statement still reconciles rather than silently dropping a movement.
  const nonCash = deltas.rows.filter((r) => !isCashRow(r));
  const operatingAdjRows = nonCash.filter((r) => r.cash_flow_category === 'OPERATING');
  const investing = section(nonCash.filter((r) => r.cash_flow_category === 'INVESTING'));
  const financing = section(nonCash.filter((r) => r.cash_flow_category === 'FINANCING'));
  const uncategorized = section(
    nonCash.filter((r) => !['OPERATING', 'INVESTING', 'FINANCING'].includes(r.cash_flow_category ?? '')),
  );

  const operatingAdjustments = operatingAdjRows.map(toAdjustment);
  const operatingTotal = toMoney(netIncome)
    .plus(sumMoney(operatingAdjustments.map((l) => l.amount)))
    .toFixed(4);

  const netChangeInCash = toMoney(operatingTotal)
    .plus(toMoney(investing.total))
    .plus(toMoney(financing.total))
    .plus(toMoney(uncategorized.total))
    .toFixed(4);

  // Cash balances at the period boundaries, for display and the reconciliation check.
  // Cash accounts are marked cashFlowCategory = 'CASH'; closing never touches cash.
  const cash = await db.execute<{ beginning: string; ending: string }>(sql`
    select
      coalesce(sum(case when e.posting_date <  ${fromDate} then l.debit - l.credit else 0 end), 0)::numeric(19,4)::text as beginning,
      coalesce(sum(case when e.posting_date <= ${toDate}   then l.debit - l.credit else 0 end), 0)::numeric(19,4)::text as ending
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id = ${companyId}
      and a.account_type = 'ASSET'
      and a.cash_flow_category = 'CASH'
      and e.status in ('POSTED', 'REVERSED')`);

  const beginningCash = cash.rows[0]?.beginning ?? '0.0000';
  const endingCash = cash.rows[0]?.ending ?? '0.0000';

  return {
    fromDate,
    toDate,
    netIncome,
    operatingAdjustments,
    operatingTotal,
    investing,
    financing,
    uncategorized,
    netChangeInCash,
    beginningCash,
    endingCash,
    reconciled: moneyEquals(toMoney(netChangeInCash), toMoney(endingCash).minus(toMoney(beginningCash))),
  };
}
