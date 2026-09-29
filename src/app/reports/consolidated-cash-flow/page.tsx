import { isCalendarDate } from '@/lib/dates';
import { ConsolidationError, getConsolidatedCashFlow, type ConsolidatedCashFlow } from '@/server/reports';

import { selfHref } from '../back';
import { ConsolidationUnavailable, ConsolidationWorksheet } from '../consolidation-table';
import { BackField, BackLinks } from '../drill';
import { requireReportContext } from '../report-context';

/**
 * Consolidated Cash-Flow Statement — LL-125 (ADR-047 amendment). Pure presentation over
 * `getConsolidatedCashFlow`: every member company's cash flow side by side (indirect method), the
 * intercompany balance changes eliminated and any transfer still in transit shown on its own line.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ConsolidatedCashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; back?: string }>;
}) {
  const ctx = await requireReportContext();
  const params = await searchParams;
  const back = params.back;
  const to = params.to !== undefined && isCalendarDate(params.to) ? params.to : ctx.today;
  const from = params.from !== undefined && isCalendarDate(params.from) ? params.from : `${ctx.today.slice(0, 4)}-01-01`;
  const self = selfHref('/reports/consolidated-cash-flow', { from, to }, back);
  const datesInvalid =
    (params.from !== undefined && params.from !== '' && !isCalendarDate(params.from)) ||
    (params.to !== undefined && params.to !== '' && !isCalendarDate(params.to)) ||
    from > to;

  let cf: ConsolidatedCashFlow | null = null;
  let unavailable: ConsolidationError | null = null;
  if (!datesInvalid) {
    try {
      cf = await getConsolidatedCashFlow(ctx.userId, ctx.companyId, from, to);
    } catch (error) {
      if (!(error instanceof ConsolidationError)) throw error;
      unavailable = error;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Consolidated Cash-Flow Statement{cf !== null && cf.organizationName !== '' && <span className="ml-2 text-base font-normal text-neutral-500">{cf.organizationName}</span>}
        </h1>
        <BackLinks back={back} />
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" data-testid="ccf-form">
        <BackField back={back} />
        <label className="flex flex-col gap-1">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} data-testid="ccf-from" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} data-testid="ccf-to" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="ccf-submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          View
        </button>
      </form>

      {datesInvalid && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">Enter a valid date range (From on or before To).</p>
      )}
      {unavailable !== null && <ConsolidationUnavailable code={unavailable.code} companies={unavailable.companies} />}

      {cf !== null && (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span
              data-testid="consolidated-reconciled"
              className={`rounded px-2 py-0.5 text-xs font-medium ${cf.reconciled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}
            >
              {cf.reconciled ? 'Reconciled to cash' : 'Does not reconcile to cash'}
            </span>
            <span className="text-xs text-neutral-500">
              Cash moving between your companies cancels out across the group; a transfer one company has recorded and the other not yet is
              shown as in transit.
            </span>
          </p>
          <ConsolidationWorksheet
            testid="consolidated-cash-flow"
            members={cf.members}
            activeCompanyId={ctx.companyId}
            blocks={[
              { title: 'Operating activities', testid: 'ccf-operating', section: cf.operating },
              { title: 'Investing activities', testid: 'ccf-investing', section: cf.investing },
              { title: 'Financing activities', testid: 'ccf-financing', section: cf.financing },
              ...(cf.uncategorized.rows.length > 0 ? [{ title: 'Uncategorized', testid: 'ccf-uncategorized', section: cf.uncategorized }] : []),
            ]}
            totals={[
              { label: 'Net change in cash', testid: 'ccf-net-change', byCompany: cf.netChangeInCash.byCompany, total: cf.netChangeInCash.total },
              { label: 'Cash at the start', testid: 'ccf-beginning-cash', byCompany: cf.beginningCash.byCompany, total: cf.beginningCash.total },
              { label: 'Cash at the end', testid: 'ccf-ending-cash', byCompany: cf.endingCash.byCompany, total: cf.endingCash.total },
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
