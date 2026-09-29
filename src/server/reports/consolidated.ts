import 'server-only';

import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { fiscalYearStart, isCalendarDate } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { AuthorizationDenied, requirePermission } from '@/server/authorization';

import { assembleRows, INTERCOMPANY_ROLES, numbersSharedAcrossTypes, type AmountedAccount, type ConsolidatedRow } from './consolidation-rows';
import { cashBasisPnlQuery } from './cash-basis';
import { getIntercompanyReport } from './intercompany';

import type { ReportBasis } from './income-statement';

/**
 * Consolidated organization statements — LL-122 (ADR-047). Reads only.
 *
 * A worksheet over every ACTIVE member of the active company's organization: one column per
 * company, an eliminations column, a consolidated total. Computed from `journal_lines` exactly as
 * the single-company statements are (POSTED and REVERSED entries, balances in each account's natural
 * direction, money as NUMERIC(19,4) strings — ADR-004), so each company's column equals its own
 * statement.
 *
 * Access (owner's decision): `report.view` in EVERY member — there is no organization-level role
 * (ADR-043); a viewer who lacks one member sees nothing but the list of companies they need.
 * Eliminations: intercompany exists only as the balance-sheet pair accounts ("Due from X" /
 * "Due to X"), which are eliminated in full; whatever does not net (a transfer one side has posted
 * and the other not yet matched — LL-099) is shown on its own "Intercompany in transit" line, never
 * hidden. There is no intercompany revenue or expense, so the income statement eliminates nothing.
 */

export type ConsolidationErrorCode = 'NOT_IN_ORGANIZATION' | 'MEMBER_ACCESS_REQUIRED';

export class ConsolidationError extends Error {
  public override readonly name = 'ConsolidationError';
  constructor(
    public readonly code: ConsolidationErrorCode,
    message: string,
    /** MEMBER_ACCESS_REQUIRED: the member companies the viewer cannot see (legal names). */
    public readonly companies: readonly string[] = [],
  ) {
    super(message);
  }
}

export interface ConsolidationMember {
  readonly id: string;
  readonly legalName: string;
  readonly fiscalYearStartMonth: number;
}

interface Scope {
  readonly organizationName: string;
  /** The active company first, then by legal name. */
  readonly members: readonly ConsolidationMember[];
}

async function consolidationScope(actorUserId: string, companyId: string): Promise<Scope> {
  await requirePermission(actorUserId, companyId, 'report.view');
  const db = getDb();
  const org = await db.execute<{ organization_id: string | null; organization_name: string | null }>(sql`
    select c.organization_id::text as organization_id, o.name as organization_name
    from companies c left join organizations o on o.id = c.organization_id
    where c.id = ${companyId} limit 1`);
  const orgId = org.rows[0]?.organization_id ?? null;
  if (orgId === null) {
    throw new ConsolidationError('NOT_IN_ORGANIZATION', 'This company is not in an organization, so there is nothing to consolidate.');
  }
  const memberRows = await db.execute<{ id: string; legal_name: string; fiscal_year_start_month: number }>(sql`
    select id::text as id, legal_name, fiscal_year_start_month
    from companies
    where organization_id = ${orgId} and status = 'ACTIVE'
    order by (id = ${companyId}) desc, legal_name, id`);
  const members = memberRows.rows.map((r) => ({ id: r.id, legalName: r.legal_name, fiscalYearStartMonth: r.fiscal_year_start_month }));
  const denied: string[] = [];
  for (const m of members) {
    if (m.id === companyId) continue;
    try {
      await requirePermission(actorUserId, m.id, 'report.view');
    } catch (error) {
      if (!(error instanceof AuthorizationDenied)) throw error;
      denied.push(m.legalName);
    }
  }
  if (denied.length > 0) {
    throw new ConsolidationError(
      'MEMBER_ACCESS_REQUIRED',
      `Consolidating needs access to every company in the organization; you cannot view ${denied.join(', ')}.`,
      denied,
    );
  }
  return { organizationName: org.rows[0]?.organization_name ?? '', members };
}

function memberIdsSql(members: readonly ConsolidationMember[]) {
  return sql.join(members.map((m) => sql`${m.id}`), sql`, `);
}

/** Every member's chart (numbers and types), for the "number also used for another type" flag. */
async function sharedNumbersOf(members: readonly ConsolidationMember[]): Promise<ReadonlySet<string>> {
  const chart = await getDb().execute<{ account_number: string | null; account_type: string; system_account_type: string | null }>(sql`
    select account_number, account_type::text as account_type, system_account_type
    from accounts where company_id in (${memberIdsSql(members)})`);
  return numbersSharedAcrossTypes(chart.rows.map((r) => ({ accountNumber: r.account_number, accountType: r.account_type, systemAccountType: r.system_account_type })));
}

type AccountSqlRow = {
  company_id: string;
  account_id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  system_account_type: string | null;
  amount: string;
};

function toAmounted(r: AccountSqlRow): AmountedAccount {
  return {
    companyId: r.company_id,
    accountId: r.account_id,
    accountNumber: r.account_number,
    accountName: r.account_name,
    accountType: r.account_type,
    systemAccountType: r.system_account_type,
    amount: r.amount,
  };
}

export interface ConsolidatedSection {
  readonly rows: readonly ConsolidatedRow[];
  readonly byCompany: Readonly<Record<string, string>>;
  readonly elimination: string;
  readonly total: string;
}

function sectionOf(rows: readonly ConsolidatedRow[], members: readonly ConsolidationMember[]): ConsolidatedSection {
  const byCompany: Record<string, string> = {};
  for (const m of members) byCompany[m.id] = sumMoney(rows.map((r) => r.byCompany[m.id] ?? '0')).toFixed(4);
  return {
    rows,
    byCompany,
    elimination: sumMoney(rows.map((r) => r.elimination)).toFixed(4),
    total: sumMoney(rows.map((r) => r.total)).toFixed(4),
  };
}

function syntheticRow(key: string, label: string, byCompany: Record<string, string>, elimination: string): ConsolidatedRow {
  return {
    key,
    label,
    accountNumber: null,
    names: [label],
    numberSharedAcrossTypes: false,
    byCompany,
    elimination,
    total: sumMoney([...Object.values(byCompany), elimination]).toFixed(4),
    drillAccountId: null,
  };
}

function fiscalStartFor(asOfDate: string, month: number): string {
  const fy = fiscalYearStart(asOfDate, month);
  return `${String(fy.year)}-${String(fy.month).padStart(2, '0')}-01`;
}

export type IntercompanyState = 'mirrored' | 'in_transit' | 'mismatch';

export interface ConsolidatedBalanceSheet {
  readonly asOfDate: string;
  readonly organizationName: string;
  readonly members: readonly ConsolidationMember[];
  /** The group's fiscal-year start — the active company's month (the earnings split boundary). */
  readonly fiscalYearStart: string;
  /** Members whose own fiscal year starts in another month (their split follows the group's here). */
  readonly otherFiscalMonths: readonly string[];
  readonly assets: ConsolidatedSection;
  readonly liabilities: ConsolidatedSection;
  readonly equity: ConsolidatedSection;
  readonly liabilitiesAndEquity: { readonly byCompany: Readonly<Record<string, string>>; readonly total: string };
  /** Σ receivables − Σ payables across the group: what did not eliminate (0 when every pair mirrors). */
  readonly intercompanyInTransit: string;
  /** The worst pair state across the members (LL-101). */
  readonly intercompanyState: IntercompanyState;
  /** Consolidated assets = liabilities + equity, and every company's own column too. */
  readonly balanced: boolean;
}

export async function getConsolidatedBalanceSheet(
  actorUserId: string,
  companyId: string,
  asOfDate: string,
): Promise<ConsolidatedBalanceSheet> {
  if (!isCalendarDate(asOfDate)) {
    throw new Error(`Consolidated balance sheet asOfDate must be a calendar date (YYYY-MM-DD): ${asOfDate}`);
  }
  const { organizationName, members } = await consolidationScope(actorUserId, companyId);
  const lead = members[0]!;
  const fyStart = fiscalStartFor(asOfDate, lead.fiscalYearStartMonth);
  const db = getDb();

  const perAccount = await db.execute<AccountSqlRow>(sql`
    select
      a.company_id::text         as company_id,
      a.id::text                 as account_id,
      a.account_number           as account_number,
      a.name                     as account_name,
      a.account_type::text       as account_type,
      a.system_account_type      as system_account_type,
      (case when a.account_type = 'ASSET'
            then sum(l.debit) - sum(l.credit)
            else sum(l.credit) - sum(l.debit)
       end)::numeric(19,4)::text as amount
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id in (${memberIdsSql(members)})
      and a.account_type in ('ASSET', 'LIABILITY', 'EQUITY')
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date <= ${asOfDate}
    group by a.company_id, a.id, a.account_number, a.name, a.account_type, a.system_account_type`);

  const earnings = await db.execute<{ company_id: string; prior: string; current: string }>(sql`
    select
      a.company_id::text as company_id,
      coalesce(sum(case when e.posting_date < ${fyStart}  then l.credit - l.debit else 0 end), 0)::numeric(19,4)::text as prior,
      coalesce(sum(case when e.posting_date >= ${fyStart} then l.credit - l.debit else 0 end), 0)::numeric(19,4)::text as current
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id in (${memberIdsSql(members)})
      and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date <= ${asOfDate}
    group by a.company_id`);

  const accounts = perAccount.rows.map(toAmounted);
  const shared = await sharedNumbersOf(members);
  const ofType = (t: string) => accounts.filter((a) => a.accountType === t);
  const icTotals = (role: string) => {
    const byCompany: Record<string, string> = {};
    for (const a of accounts.filter((x) => x.systemAccountType === role)) {
      byCompany[a.companyId] = toMoney(byCompany[a.companyId] ?? '0').plus(toMoney(a.amount)).toFixed(4);
    }
    return byCompany;
  };

  // Intercompany: every pair account is eliminated in full; what does not net is in transit.
  const receivables = icTotals('INTERCOMPANY_RECEIVABLE');
  const payables = icTotals('INTERCOMPANY_PAYABLE');
  const sumReceivable = sumMoney(Object.values(receivables));
  const sumPayable = sumMoney(Object.values(payables));
  const inTransit = sumReceivable.minus(sumPayable);
  const hasIntercompany = Object.keys(receivables).length > 0 || Object.keys(payables).length > 0;

  const assetRows = assembleRows(ofType('ASSET'), members, companyId, shared);
  if (hasIntercompany) {
    assetRows.push(syntheticRow('ic:receivable', 'Intercompany receivables (Due from members)', receivables, sumReceivable.negated().toFixed(4)));
    if (inTransit.isPositive() && !inTransit.isZero()) assetRows.push(syntheticRow('ic:in-transit', 'Intercompany in transit', {}, inTransit.toFixed(4)));
  }
  const liabilityRows = assembleRows(ofType('LIABILITY'), members, companyId, shared);
  if (hasIntercompany) {
    liabilityRows.push(syntheticRow('ic:payable', 'Intercompany payables (Due to members)', payables, sumPayable.negated().toFixed(4)));
    if (inTransit.isNegative()) liabilityRows.push(syntheticRow('ic:in-transit', 'Intercompany difference (unmatched)', {}, inTransit.negated().toFixed(4)));
  }
  const prior: Record<string, string> = {};
  const current: Record<string, string> = {};
  for (const r of earnings.rows) {
    prior[r.company_id] = r.prior;
    current[r.company_id] = r.current;
  }
  const equityRows = [
    ...assembleRows(ofType('EQUITY'), members, companyId, shared),
    syntheticRow('derived:prior', 'Retained earnings (prior years)', prior, '0.0000'),
    syntheticRow('derived:current', 'Net income (current year)', current, '0.0000'),
  ];

  const assets = sectionOf(assetRows, members);
  const liabilities = sectionOf(liabilityRows, members);
  const equity = sectionOf(equityRows, members);
  const lAndE: Record<string, string> = {};
  for (const m of members) lAndE[m.id] = toMoney(liabilities.byCompany[m.id] ?? '0').plus(toMoney(equity.byCompany[m.id] ?? '0')).toFixed(4);
  const lAndETotal = toMoney(liabilities.total).plus(toMoney(equity.total));
  const balanced =
    moneyEquals(toMoney(assets.total), lAndETotal) &&
    members.every((m) => moneyEquals(toMoney(assets.byCompany[m.id] ?? '0'), toMoney(lAndE[m.id] ?? '0')));

  // The pair states come from the intercompany report of each member (LL-101: in transit is never mirrored).
  let state: IntercompanyState = 'mirrored';
  if (hasIntercompany) {
    for (const m of members) {
      const report = await getIntercompanyReport(actorUserId, m.id, asOfDate);
      if (report.state === 'mismatch') state = 'mismatch';
      else if (report.state === 'in_transit' && state === 'mirrored') state = 'in_transit';
    }
    if (!inTransit.isZero() && state === 'mirrored') state = 'mismatch'; // cannot happen with an intact ledger
  }

  return {
    asOfDate,
    organizationName,
    members,
    fiscalYearStart: fyStart,
    otherFiscalMonths: members.filter((m) => m.fiscalYearStartMonth !== lead.fiscalYearStartMonth).map((m) => m.legalName),
    assets,
    liabilities,
    equity,
    liabilitiesAndEquity: { byCompany: lAndE, total: lAndETotal.toFixed(4) },
    intercompanyInTransit: inTransit.toFixed(4),
    intercompanyState: state,
    balanced,
  };
}

export interface ConsolidatedIncomeStatement {
  readonly fromDate: string;
  readonly toDate: string;
  /** LL-126: accrual (as posted) or cash (invoices and bills when paid). */
  readonly basis: ReportBasis;
  readonly organizationName: string;
  readonly members: readonly ConsolidationMember[];
  readonly revenue: ConsolidatedSection;
  readonly cogs: ConsolidatedSection;
  readonly expenses: ConsolidatedSection;
  /** Revenue − COGS, per company and consolidated. */
  readonly grossProfit: { readonly byCompany: Readonly<Record<string, string>>; readonly total: string };
  /** Gross profit − expenses, per company and consolidated. */
  readonly netIncome: { readonly byCompany: Readonly<Record<string, string>>; readonly total: string };
}

export async function getConsolidatedIncomeStatement(
  actorUserId: string,
  companyId: string,
  fromDate: string,
  toDate: string,
  basis: ReportBasis = 'accrual',
): Promise<ConsolidatedIncomeStatement> {
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate)) {
    throw new Error(`Consolidated income statement dates must be calendar dates (YYYY-MM-DD): ${fromDate} – ${toDate}`);
  }
  if (fromDate > toDate) throw new Error(`Consolidated income statement fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  const { organizationName, members } = await consolidationScope(actorUserId, companyId);

  // As `income-statement.ts`: natural direction, year-end CLOSING entries and their reversals excluded;
  // LL-126: on a cash basis, invoices and bills count when paid (cash-basis.ts).
  const perAccount = basis === 'cash' ? await getDb().execute<AccountSqlRow>(cashBasisPnlQuery(members.map((m) => m.id), fromDate, toDate)) : await getDb().execute<AccountSqlRow>(sql`
    select
      a.company_id::text         as company_id,
      a.id::text                 as account_id,
      a.account_number           as account_number,
      a.name                     as account_name,
      a.account_type::text       as account_type,
      a.system_account_type      as system_account_type,
      (case when a.account_type = 'REVENUE'
            then sum(l.credit) - sum(l.debit)
            else sum(l.debit) - sum(l.credit)
       end)::numeric(19,4)::text as amount
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id in (${memberIdsSql(members)})
      and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
      and e.status in ('POSTED', 'REVERSED')
      and e.source_type <> 'CLOSING'
      and not exists (select 1 from journal_entries oe where oe.id = e.reversal_of_id and oe.source_type = 'CLOSING')
      and e.posting_date between ${fromDate} and ${toDate}
    group by a.company_id, a.id, a.account_number, a.name, a.account_type, a.system_account_type`);

  const accounts = perAccount.rows.map(toAmounted).filter((a) => a.systemAccountType === null || !INTERCOMPANY_ROLES.has(a.systemAccountType));
  const shared = await sharedNumbersOf(members);
  const section = (t: string) => sectionOf(assembleRows(accounts.filter((a) => a.accountType === t), members, companyId, shared), members);
  const revenue = section('REVENUE');
  const cogs = section('COGS');
  const expenses = section('EXPENSE');
  const gp: Record<string, string> = {};
  const ni: Record<string, string> = {};
  for (const m of members) {
    const gross = toMoney(revenue.byCompany[m.id] ?? '0').minus(toMoney(cogs.byCompany[m.id] ?? '0'));
    gp[m.id] = gross.toFixed(4);
    ni[m.id] = gross.minus(toMoney(expenses.byCompany[m.id] ?? '0')).toFixed(4);
  }
  const gpTotal = toMoney(revenue.total).minus(toMoney(cogs.total));
  return {
    fromDate,
    toDate,
    basis,
    organizationName,
    members,
    revenue,
    cogs,
    expenses,
    grossProfit: { byCompany: gp, total: gpTotal.toFixed(4) },
    netIncome: { byCompany: ni, total: gpTotal.minus(toMoney(expenses.total)).toFixed(4) },
  };
}

export interface ConsolidatedCashFlow {
  readonly fromDate: string;
  readonly toDate: string;
  readonly organizationName: string;
  readonly members: readonly ConsolidationMember[];
  /** Net income (first row) + working-capital adjustments + the intercompany rows. */
  readonly operating: ConsolidatedSection;
  readonly investing: ConsolidatedSection;
  readonly financing: ConsolidatedSection;
  /** Balance-sheet accounts without a cash-flow category — should be empty on a well-classified chart. */
  readonly uncategorized: ConsolidatedSection;
  readonly netChangeInCash: { readonly byCompany: Readonly<Record<string, string>>; readonly total: string };
  readonly beginningCash: { readonly byCompany: Readonly<Record<string, string>>; readonly total: string };
  readonly endingCash: { readonly byCompany: Readonly<Record<string, string>>; readonly total: string };
  /** For the group and every company: net change = ending − beginning cash, exactly. */
  readonly reconciled: boolean;
}

type DeltaSqlRow = AccountSqlRow & { cash_flow_category: string | null };

/**
 * LL-125 — the consolidated cash-flow statement (indirect method, as `cash-flow.ts`): per company,
 * net income + the cash effect of every non-cash balance-sheet account's change (−Δ(debit − credit)),
 * by the account's cash-flow category; cash accounts are the reconciliation target. Intercompany pair
 * accounts (all OPERATING) move in opposite directions in the two companies of a transfer, so across
 * the group their effects cancel: they are eliminated, and whatever does not cancel — a transfer one
 * side has posted and the other not yet (LL-099) — is the change in cash in transit, shown on its own
 * line. The consolidated column therefore equals the sum of the companies' columns, and it reconciles
 * to the group's cash.
 */
export async function getConsolidatedCashFlow(
  actorUserId: string,
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<ConsolidatedCashFlow> {
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate)) {
    throw new Error(`Consolidated cash flow dates must be calendar dates (YYYY-MM-DD): ${fromDate} – ${toDate}`);
  }
  if (fromDate > toDate) throw new Error(`Consolidated cash flow fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  const { organizationName, members } = await consolidationScope(actorUserId, companyId);
  const income = await getConsolidatedIncomeStatement(actorUserId, companyId, fromDate, toDate);
  const db = getDb();

  // As `cash-flow.ts`: balance-sheet deltas over the period, CLOSING entries and their reversals excluded.
  const deltas = await db.execute<DeltaSqlRow>(sql`
    select
      a.company_id::text          as company_id,
      a.id::text                  as account_id,
      a.account_number            as account_number,
      a.name                      as account_name,
      a.account_type::text        as account_type,
      a.system_account_type       as system_account_type,
      a.cash_flow_category::text  as cash_flow_category,
      (sum(l.debit) - sum(l.credit))::numeric(19,4)::text as amount
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id in (${memberIdsSql(members)})
      and a.account_type in ('ASSET', 'LIABILITY', 'EQUITY')
      and e.status in ('POSTED', 'REVERSED')
      and e.source_type <> 'CLOSING'
      and not exists (select 1 from journal_entries oe where oe.id = e.reversal_of_id and oe.source_type = 'CLOSING')
      and e.posting_date between ${fromDate} and ${toDate}
    group by a.company_id, a.id, a.account_number, a.name, a.account_type, a.system_account_type, a.cash_flow_category
    having (sum(l.debit) - sum(l.credit)) <> 0`);

  const shared = await sharedNumbersOf(members);
  // The cash effect of a non-cash account is −Δ(debit − credit).
  const adjustments = deltas.rows
    .filter((r) => !(r.account_type === 'ASSET' && r.cash_flow_category === 'CASH'))
    .map((r) => ({ ...toAmounted(r), amount: toMoney(r.amount).negated().toFixed(4), category: r.cash_flow_category }));
  const isIntercompany = (a: { systemAccountType: string | null }) => a.systemAccountType !== null && INTERCOMPANY_ROLES.has(a.systemAccountType);
  const rowsOf = (category: string) => assembleRows(adjustments.filter((a) => a.category === category), members, companyId, shared);

  const icByCompany: Record<string, string> = {};
  for (const a of adjustments.filter(isIntercompany)) {
    icByCompany[a.companyId] = toMoney(icByCompany[a.companyId] ?? '0').plus(toMoney(a.amount)).toFixed(4);
  }
  const icTotal = sumMoney(Object.values(icByCompany));
  const operatingRows: ConsolidatedRow[] = [
    syntheticRow('derived:net-income', 'Net income', { ...income.netIncome.byCompany }, '0.0000'),
    ...rowsOf('OPERATING'),
  ];
  if (Object.keys(icByCompany).length > 0) {
    operatingRows.push(syntheticRow('ic:balances', 'Intercompany balances (change)', icByCompany, icTotal.negated().toFixed(4)));
    if (!icTotal.isZero()) operatingRows.push(syntheticRow('ic:in-transit', 'Intercompany transfers in transit (change)', {}, icTotal.toFixed(4)));
  }
  const operating = sectionOf(operatingRows, members);
  const investing = sectionOf(rowsOf('INVESTING'), members);
  const financing = sectionOf(rowsOf('FINANCING'), members);
  const uncategorized = sectionOf(
    assembleRows(adjustments.filter((a) => !['OPERATING', 'INVESTING', 'FINANCING'].includes(a.category ?? '')), members, companyId, shared),
    members,
  );

  const cash = await db.execute<{ company_id: string; beginning: string; ending: string }>(sql`
    select
      a.company_id::text as company_id,
      coalesce(sum(case when e.posting_date <  ${fromDate} then l.debit - l.credit else 0 end), 0)::numeric(19,4)::text as beginning,
      coalesce(sum(case when e.posting_date <= ${toDate}   then l.debit - l.credit else 0 end), 0)::numeric(19,4)::text as ending
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id
    where a.company_id in (${memberIdsSql(members)})
      and a.account_type = 'ASSET'
      and a.cash_flow_category = 'CASH'
      and e.status in ('POSTED', 'REVERSED')
    group by a.company_id`);

  const change: Record<string, string> = {};
  const beginning: Record<string, string> = {};
  const ending: Record<string, string> = {};
  for (const m of members) {
    change[m.id] = [operating, investing, financing, uncategorized]
      .reduce((sum, s) => sum.plus(toMoney(s.byCompany[m.id] ?? '0')), toMoney('0'))
      .toFixed(4);
    const c = cash.rows.find((r) => r.company_id === m.id);
    beginning[m.id] = c?.beginning ?? '0.0000';
    ending[m.id] = c?.ending ?? '0.0000';
  }
  const changeTotal = sumMoney([operating.total, investing.total, financing.total, uncategorized.total]);
  const beginningTotal = sumMoney(Object.values(beginning));
  const endingTotal = sumMoney(Object.values(ending));
  const reconciled =
    moneyEquals(changeTotal, endingTotal.minus(beginningTotal)) &&
    members.every((m) => moneyEquals(toMoney(change[m.id] ?? '0'), toMoney(ending[m.id] ?? '0').minus(toMoney(beginning[m.id] ?? '0'))));

  return {
    fromDate,
    toDate,
    organizationName,
    members,
    operating,
    investing,
    financing,
    uncategorized,
    netChangeInCash: { byCompany: change, total: changeTotal.toFixed(4) },
    beginningCash: { byCompany: beginning, total: beginningTotal.toFixed(4) },
    endingCash: { byCompany: ending, total: endingTotal.toFixed(4) },
    reconciled,
  };
}
