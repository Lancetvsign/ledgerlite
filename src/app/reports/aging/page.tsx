import Link from 'next/link';
import { formatMoney } from '@/lib/money-format';

import { getArAging } from '@/server/reports';

import { AsOfForm } from '../as-of-form';
import { requireReportContext, resolveAsOf } from '../report-context';

/**
 * A/R Aging screen — LL-055. Pure presentation over `getArAging` (LL-046): the
 * subsidiary ledger of open receivables per customer, bucketed by age, whose
 * grand total reconciles to the GL A/R control (GL-T018). Money is rendered
 * straight from the service's `string` values — no JavaScript number touches it
 * (ADR-004), and no bucket or total is recomputed on the client.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const ctx = await requireReportContext();
  const { asOf: raw } = await searchParams;

  const { asOf, invalid } = resolveAsOf(raw, ctx.today);
  const aging = invalid ? null : await getArAging(ctx.userId, ctx.companyId, asOf);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">A/R Aging</h1>
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
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="aging-table">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Customer</th>
                <th className="py-2 pr-2 text-right">Current</th>
                <th className="py-2 pr-2 text-right">1–30</th>
                <th className="py-2 pr-2 text-right">31–60</th>
                <th className="py-2 pr-2 text-right">61–90</th>
                <th className="py-2 pr-2 text-right">90+</th>
                <th className="py-2 pr-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {aging!.customers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-neutral-500">
                    No open receivables as of {asOf}.
                  </td>
                </tr>
              ) : (
                aging!.customers.map((c) => (
                  <tr key={c.customerId} data-testid="aging-row" className="border-b border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 pr-2">{c.customerName}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(c.buckets.current)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(c.buckets.d1to30)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(c.buckets.d31to60)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(c.buckets.d61to90)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(c.buckets.d90plus)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-medium">{formatMoney(c.total)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-neutral-300 font-medium dark:border-neutral-700">
                <td className="py-2 pr-2">Grand total</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(aging!.totals.current)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(aging!.totals.d1to30)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(aging!.totals.d31to60)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(aging!.totals.d61to90)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(aging!.totals.d90plus)}</td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid="aging-total">
                  {aging!.totals.total}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </main>
  );
}
