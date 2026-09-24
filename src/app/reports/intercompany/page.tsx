import Link from 'next/link';

import { formatMoney } from '@/lib/money-format';
import { getIntercompanyReport } from '@/server/reports';

import { AsOfForm } from '../as-of-form';
import { requireReportContext, resolveAsOf } from '../report-context';

/**
 * Intercompany Balances screen — LL-098. Pure presentation over `getIntercompanyReport`:
 * per counterpart, this company's Due from / Due to, the counterpart's mirror figure, and
 * the difference (always 0.00 when the books are consistent). Money is rendered straight
 * from the service's `string` values (ADR-004); nothing is recomputed here.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_CLASS = {
  mirrored: 'rounded bg-green-50 px-2 py-0.5 text-green-700 dark:bg-green-950 dark:text-green-300',
  in_transit: 'rounded bg-amber-50 px-2 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  mismatch: 'rounded bg-red-50 px-2 py-0.5 text-red-700 dark:bg-red-950 dark:text-red-300',
} as const;
const STATE_TEXT = {
  mirrored: 'Mirrored: every balance agrees with the other company’s books',
  in_transit: 'In transit: a transfer is marked on one statement and not yet matched on the other',
  mismatch: 'MISMATCH: a balance disagrees with the other company’s books',
} as const;

export default async function IntercompanyPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireReportContext();
  const { asOf: raw } = await searchParams;
  const { asOf, invalid } = resolveAsOf(raw, ctx.today);
  const report = invalid ? null : await getIntercompanyReport(ctx.userId, ctx.companyId, asOf);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Intercompany Balances</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">← Reports</Link>
      </header>

      <AsOfForm asOf={asOf} />

      {invalid || report === null ? (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date (YYYY-MM-DD).
        </p>
      ) : report.organizationName === null ? (
        <p role="status" data-testid="intercompany-empty" className="text-sm text-neutral-500">
          This company is not in an organization, so it has no intercompany balances.
        </p>
      ) : (
        <>
          <p className="text-sm text-neutral-500" data-testid="intercompany-summary">
            Organization <strong>{report.organizationName}</strong> · as of {report.asOfDate} ·{' '}
            <span data-testid="intercompany-mirrored" data-state={report.state} className={STATE_CLASS[report.state]}>
              {STATE_TEXT[report.state]}
            </span>
          </p>
          <table className="w-full border-collapse text-sm" data-testid="intercompany-table">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Company</th>
                <th className="py-2 pr-2 text-right">Due from them</th>
                <th className="py-2 pr-2 text-right">Their “Due to us”</th>
                <th className="py-2 pr-2 text-right">Difference</th>
                <th className="py-2 pr-2 text-right">In transit</th>
                <th className="py-2 pr-2 text-right">Due to them</th>
                <th className="py-2 pr-2 text-right">Their “Due from us”</th>
                <th className="py-2 pr-2 text-right">Difference</th>
                <th className="py-2 pr-2 text-right">In transit</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-neutral-500" data-testid="intercompany-no-rows">
                    No intercompany activity yet.
                  </td>
                </tr>
              ) : (
                report.rows.map((r) => (
                  <tr key={r.counterpartId} data-testid="intercompany-row" data-mirrored={r.mirrored ? '1' : '0'} data-state={r.state} className="border-b border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 pr-2">{r.counterpartLegalName}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(r.dueFrom)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-neutral-500">{formatMoney(r.counterpartDueTo)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-medium">{formatMoney(r.receivableDifference)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-neutral-500" data-testid="intercompany-receivable-in-transit">
                      {formatMoney(r.receivableInTransit)}
                      {r.inTransitOldestDays !== null && r.state === 'in_transit' && (
                        <span className="ml-1 text-xs" data-testid="intercompany-transit-age">(oldest {String(r.inTransitOldestDays)} d)</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(r.dueTo)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-neutral-500">{formatMoney(r.counterpartDueFrom)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-medium">{formatMoney(r.payableDifference)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums text-neutral-500">{formatMoney(r.payableInTransit)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-neutral-300 font-medium dark:border-neutral-700">
                <td className="py-2 pr-2">Total</td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid="intercompany-total-due-from">{formatMoney(report.totalDueFrom)}</td>
                <td colSpan={3} />
                <td className="py-2 pr-2 text-right tabular-nums" data-testid="intercompany-total-due-to">{formatMoney(report.totalDueTo)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
          <p className="text-xs text-neutral-400">
            A “Due from” here is the money another company owes this one for card charges it took (LL-097) or
            cash it received; the other company carries the same figure as a “Due to”. The two always agree
            unless the books have been damaged — except for cash in transit: a bank transfer one company has
            already marked from its statement while the other has not yet imported its own (LL-099).
          </p>
        </>
      )}
    </main>
  );
}
