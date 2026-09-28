import { isCalendarDate } from '@/lib/dates';
import { ConsolidationError, getConsolidatedIncomeStatement, type ConsolidatedIncomeStatement } from '@/server/reports';

import { selfHref } from '../back';
import { ConsolidationUnavailable, ConsolidationWorksheet } from '../consolidation-table';
import { BackField, BackLinks } from '../drill';
import { requireReportContext } from '../report-context';

/**
 * Consolidated Income Statement — LL-122 (ADR-047). Pure presentation over
 * `getConsolidatedIncomeStatement`: every member company's income and expenses side by side. There is
 * no intercompany revenue or expense (intercompany exists only as balance-sheet pair accounts), so
 * nothing is eliminated.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ConsolidatedIncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; back?: string }>;
}) {
  const ctx = await requireReportContext();
  const params = await searchParams;
  const back = params.back;
  const to = params.to !== undefined && isCalendarDate(params.to) ? params.to : ctx.today;
  const from = params.from !== undefined && isCalendarDate(params.from) ? params.from : `${ctx.today.slice(0, 4)}-01-01`;
  const self = selfHref('/reports/consolidated-income-statement', { from, to }, back);
  const datesInvalid =
    (params.from !== undefined && params.from !== '' && !isCalendarDate(params.from)) ||
    (params.to !== undefined && params.to !== '' && !isCalendarDate(params.to)) ||
    from > to;

  let is: ConsolidatedIncomeStatement | null = null;
  let unavailable: ConsolidationError | null = null;
  if (!datesInvalid) {
    try {
      is = await getConsolidatedIncomeStatement(ctx.userId, ctx.companyId, from, to);
    } catch (error) {
      if (!(error instanceof ConsolidationError)) throw error;
      unavailable = error;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Consolidated Income Statement{is !== null && is.organizationName !== '' && <span className="ml-2 text-base font-normal text-neutral-500">{is.organizationName}</span>}
        </h1>
        <BackLinks back={back} />
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" data-testid="cis-form">
        <BackField back={back} />
        <label className="flex flex-col gap-1">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} data-testid="cis-from" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} data-testid="cis-to" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="cis-submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          View
        </button>
      </form>

      {datesInvalid && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">Enter a valid date range (From on or before To).</p>
      )}
      {unavailable !== null && <ConsolidationUnavailable code={unavailable.code} companies={unavailable.companies} />}

      {is !== null && (
        <>
          <p className="text-xs text-neutral-500">Intercompany activity sits only on the balance sheet, so no income or expense is eliminated.</p>
          <ConsolidationWorksheet
            testid="consolidated-income-statement"
            members={is.members}
            activeCompanyId={ctx.companyId}
            blocks={[
              { title: 'Revenue', testid: 'cis-revenue', section: is.revenue },
              { title: 'Cost of goods sold', testid: 'cis-cogs', section: is.cogs },
              { title: 'Expenses', testid: 'cis-expenses', section: is.expenses },
            ]}
            totals={[
              { label: 'Gross profit', testid: 'cis-gross-profit', byCompany: is.grossProfit.byCompany, total: is.grossProfit.total },
              { label: 'Net income', testid: 'cis-net-income', byCompany: is.netIncome.byCompany, total: is.netIncome.total },
            ]}
            drillFrom={from}
            drillTo={to}
            back={self}
          />
        </>
      )}
    </main>
  );
}
