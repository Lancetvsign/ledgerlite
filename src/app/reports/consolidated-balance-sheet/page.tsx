import Link from 'next/link';

import { formatMoney } from '@/lib/money-format';
import { ConsolidationError, getConsolidatedBalanceSheet, type ConsolidatedBalanceSheet } from '@/server/reports';

import { AsOfForm } from '../as-of-form';
import { selfHref } from '../back';
import { ConsolidationUnavailable, ConsolidationWorksheet } from '../consolidation-table';
import { BackLinks } from '../drill';
import { requireReportContext, resolveAsOf } from '../report-context';

/**
 * Consolidated Balance Sheet — LL-122 (ADR-047). Pure presentation over
 * `getConsolidatedBalanceSheet`: every member company side by side, intercompany balances
 * eliminated, whatever did not net shown on its own "in transit" line.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ConsolidatedBalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; back?: string }>;
}) {
  const ctx = await requireReportContext();
  const { asOf: raw, back } = await searchParams;
  const { asOf, invalid } = resolveAsOf(raw, ctx.today);
  const self = selfHref('/reports/consolidated-balance-sheet', { asOf }, back);

  let bs: ConsolidatedBalanceSheet | null = null;
  let unavailable: ConsolidationError | null = null;
  if (!invalid) {
    try {
      bs = await getConsolidatedBalanceSheet(ctx.userId, ctx.companyId, asOf);
    } catch (error) {
      if (!(error instanceof ConsolidationError)) throw error;
      unavailable = error;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Consolidated Balance Sheet{bs !== null && bs.organizationName !== '' && <span className="ml-2 text-base font-normal text-neutral-500">{bs.organizationName}</span>}
        </h1>
        <BackLinks back={back} />
      </header>

      <AsOfForm asOf={asOf} back={back} />

      {invalid && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">Enter a valid date.</p>
      )}
      {unavailable !== null && <ConsolidationUnavailable code={unavailable.code} companies={unavailable.companies} />}

      {bs !== null && (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span
              data-testid="consolidated-balanced"
              className={`rounded px-2 py-0.5 text-xs font-medium ${bs.balanced ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}
            >
              {bs.balanced ? 'Balanced' : 'Out of balance'}
            </span>
            {bs.intercompanyState !== 'mirrored' && (
              <span
                data-testid="consolidated-intercompany-state"
                data-state={bs.intercompanyState}
                className={`rounded px-2 py-0.5 text-xs font-medium ${bs.intercompanyState === 'in_transit' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}`}
              >
                {bs.intercompanyState === 'in_transit'
                  ? `${formatMoney(bs.intercompanyInTransit)} intercompany in transit`
                  : 'Intercompany balances do not match'}{' '}
                — <Link href="/reports/intercompany" className="underline">see Intercompany Balances</Link>
              </span>
            )}
            <span className="text-xs text-neutral-500">
              Earnings split at the group&apos;s fiscal-year start, {bs.fiscalYearStart}
              {bs.otherFiscalMonths.length > 0 && ` (${bs.otherFiscalMonths.join(', ')} ${bs.otherFiscalMonths.length === 1 ? 'uses' : 'use'} another fiscal month)`}.
            </span>
          </p>
          <ConsolidationWorksheet
            testid="consolidated-balance-sheet"
            members={bs.members}
            activeCompanyId={ctx.companyId}
            blocks={[
              { title: 'Assets', testid: 'cbs-assets', section: bs.assets },
              { title: 'Liabilities', testid: 'cbs-liabilities', section: bs.liabilities },
              { title: 'Equity', testid: 'cbs-equity', section: bs.equity },
            ]}
            totals={[
              {
                label: 'Total liabilities and equity',
                testid: 'cbs-liabilities-and-equity-total',
                byCompany: bs.liabilitiesAndEquity.byCompany,
                elimination: bs.liabilities.elimination,
                total: bs.liabilitiesAndEquity.total,
              },
            ]}
            drillFrom={bs.fiscalYearStart}
            drillTo={bs.asOfDate}
            back={self}
          />
        </>
      )}
    </main>
  );
}
