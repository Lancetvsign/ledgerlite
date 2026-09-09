import Link from 'next/link';

import { isCalendarDate } from '@/lib/dates';
import { getCashFlowStatement } from '@/server/reports';

import { requireReportContext } from '../report-context';

/**
 * Cash-Flow Statement (indirect) — LL-074. Operating (net income + working-capital
 * adjustments), Investing, Financing, reconciling beginning → ending cash. Pure
 * presentation over `getCashFlowStatement`; money rendered straight from its `string`
 * values (ADR-004). A period report, so it takes a From/To range (client-free GET form).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requireReportContext();
  const params = await searchParams;

  const to = params.to !== undefined && isCalendarDate(params.to) ? params.to : ctx.today;
  const from =
    params.from !== undefined && isCalendarDate(params.from) ? params.from : `${ctx.today.slice(0, 4)}-01-01`;
  const datesInvalid =
    (params.from !== undefined && params.from !== '' && !isCalendarDate(params.from)) ||
    (params.to !== undefined && params.to !== '' && !isCalendarDate(params.to)) ||
    from > to;

  const cf = datesInvalid ? null : await getCashFlowStatement(ctx.userId, ctx.companyId, from, to);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cash-Flow Statement</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">← Reports</Link>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" data-testid="cash-flow-form">
        <label className="flex flex-col gap-1">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} data-testid="cf-from" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} data-testid="cf-to" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="cf-submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">View</button>
      </form>

      {cf === null ? (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date range (From on or before To).
        </p>
      ) : (
        <table className="w-full border-collapse text-sm" data-testid="cash-flow-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Line</th>
              <th className="py-2 pr-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <SectionHeader label="Operating activities" />
            <Line label="Net income" amount={cf.netIncome} />
            {cf.operatingAdjustments.map((l) => (
              <Line key={l.accountId} label={adjLabel(l)} amount={l.amount} />
            ))}
            <Subtotal label="Net cash from operating" amount={cf.operatingTotal} testid="cf-operating-total" />

            <SectionHeader label="Investing activities" />
            {cf.investing.rows.map((l) => (
              <Line key={l.accountId} label={adjLabel(l)} amount={l.amount} />
            ))}
            <Subtotal label="Net cash from investing" amount={cf.investing.total} testid="cf-investing-total" />

            <SectionHeader label="Financing activities" />
            {cf.financing.rows.map((l) => (
              <Line key={l.accountId} label={adjLabel(l)} amount={l.amount} />
            ))}
            <Subtotal label="Net cash from financing" amount={cf.financing.total} testid="cf-financing-total" />

            {cf.uncategorized.rows.length > 0 && (
              <>
                <SectionHeader label="Uncategorized (assign a cash-flow category to these accounts)" />
                {cf.uncategorized.rows.map((l) => (
                  <Line key={l.accountId} label={adjLabel(l)} amount={l.amount} />
                ))}
                <Subtotal label="Uncategorized total" amount={cf.uncategorized.total} testid="cf-uncategorized-total" />
              </>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-semibold dark:border-neutral-700">
              <td className="py-2 pr-2">Net change in cash</td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="cf-net-change">{cf.netChangeInCash}</td>
            </tr>
            <tr>
              <td className="py-1 pr-2 text-neutral-500">Cash at beginning of period</td>
              <td className="py-1 pr-2 text-right tabular-nums" data-testid="cf-beginning">{cf.beginningCash}</td>
            </tr>
            <tr className="font-medium">
              <td className="py-1 pr-2">Cash at end of period</td>
              <td className="py-1 pr-2 text-right tabular-nums" data-testid="cf-ending">{cf.endingCash}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {cf !== null && (
        <p
          data-testid="cash-flow-reconciled"
          className={
            cf.reconciled
              ? 'rounded bg-green-100 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300'
              : 'rounded bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300'
          }
        >
          {cf.reconciled
            ? 'Reconciled — net change in cash equals ending minus beginning cash.'
            : 'NOT reconciled — net change does not equal the change in cash balances.'}
        </p>
      )}
    </main>
  );
}

function adjLabel(l: { accountNumber: string | null; accountName: string }): string {
  return l.accountNumber !== null && l.accountNumber !== '' ? `${l.accountNumber} · ${l.accountName}` : l.accountName;
}

function SectionHeader({ label }: { label: string }) {
  return (
    <tr className="bg-neutral-50 dark:bg-neutral-900">
      <td colSpan={2} className="py-1 pr-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</td>
    </tr>
  );
}

function Line({ label, amount }: { label: string; amount: string }) {
  return (
    <tr data-testid="cash-flow-row" className="border-b border-neutral-100 dark:border-neutral-800">
      <td className="py-2 pr-2">{label}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{amount}</td>
    </tr>
  );
}

function Subtotal({ label, amount, testid }: { label: string; amount: string; testid: string }) {
  return (
    <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
      <td className="py-2 pr-2">{label}</td>
      <td className="py-2 pr-2 text-right tabular-nums" data-testid={testid}>{amount}</td>
    </tr>
  );
}
