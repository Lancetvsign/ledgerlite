import Link from 'next/link';

import { getTrialBalance } from '@/server/reports';

import { AsOfForm } from '../as-of-form';
import { requireReportContext, resolveAsOf } from '../report-context';

/**
 * Trial Balance screen — LL-055. Pure presentation over `getTrialBalance`
 * (LL-034): every account's derived debit/credit balance as of a date, with the
 * balanced check shown explicitly. Money is rendered straight from the service's
 * `string` values — no JavaScript number ever touches it (ADR-004), and no total
 * is recomputed on the client (the service already sums in PostgreSQL).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const ctx = await requireReportContext();
  const { asOf: raw } = await searchParams;

  // Validate server-side: a bad date is rejected (notice, no table); absent → today.
  const { asOf, invalid } = resolveAsOf(raw, ctx.today);
  const tb = invalid ? null : await getTrialBalance(ctx.userId, ctx.companyId, asOf);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Trial Balance</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">
          ← Reports
        </Link>
      </header>

      <AsOfForm asOf={asOf} />

      {invalid ? (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date (YYYY-MM-DD).
        </p>
      ) : (
        <>
          <table className="w-full border-collapse text-sm" data-testid="trial-balance-table">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Account</th>
                <th className="py-2 pr-2">Name</th>
                <th className="py-2 pr-2">Type</th>
                <th className="py-2 pr-2 text-right">Debit</th>
                <th className="py-2 pr-2 text-right">Credit</th>
                <th className="py-2 pr-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {tb!.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-neutral-500">
                    No posted activity as of {asOf}.
                  </td>
                </tr>
              ) : (
                tb!.rows.map((r) => (
                  <tr key={r.accountId} data-testid="trial-balance-row" className="border-b border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 pr-2 tabular-nums">{r.accountNumber ?? '—'}</td>
                    <td className="py-2 pr-2">{r.accountName}</td>
                    <td className="py-2 pr-2 text-neutral-500">{r.accountType}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.debits}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.credits}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-medium">{r.balance}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-neutral-300 font-medium dark:border-neutral-700">
                <td className="py-2 pr-2" colSpan={3}>
                  Totals
                </td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid="tb-total-debits">
                  {tb!.totalDebits}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid="tb-total-credits">
                  {tb!.totalCredits}
                </td>
                <td className="py-2 pr-2" />
              </tr>
            </tfoot>
          </table>

          <p
            data-testid="tb-balanced"
            className={
              tb!.balanced
                ? 'rounded bg-green-100 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300'
                : 'rounded bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300'
            }
          >
            {tb!.balanced ? 'Balanced — debits equal credits.' : 'NOT balanced — debits do not equal credits.'}
          </p>
        </>
      )}
    </main>
  );
}
