import Link from 'next/link';

import { isCalendarDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money-format';
import { getIncomeStatement } from '@/server/reports';

import { requireReportContext } from '../report-context';

/**
 * Income Statement (P&L) screen — LL-072. Pure presentation over `getIncomeStatement`
 * for a period [from, to]: Revenue − COGS = Gross profit; − Operating expenses = Net
 * income. Money is rendered straight from the service's `string` values (ADR-004); the
 * service sums in PostgreSQL. A period report, so it takes a From/To range (client-free
 * GET form), unlike the as-of reports.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requireReportContext();
  const params = await searchParams;

  // Default to a year-to-date period ending on the company's today.
  const to = params.to !== undefined && isCalendarDate(params.to) ? params.to : ctx.today;
  const from =
    params.from !== undefined && isCalendarDate(params.from) ? params.from : `${ctx.today.slice(0, 4)}-01-01`;

  const datesInvalid =
    (params.from !== undefined && params.from !== '' && !isCalendarDate(params.from)) ||
    (params.to !== undefined && params.to !== '' && !isCalendarDate(params.to)) ||
    from > to;

  const is = datesInvalid ? null : await getIncomeStatement(ctx.userId, ctx.companyId, from, to);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Income Statement</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">
          ← Reports
        </Link>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" data-testid="income-statement-form">
        <label className="flex flex-col gap-1">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} data-testid="is-from" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} data-testid="is-to" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="is-submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          View
        </button>
      </form>

      {is === null ? (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date range (From on or before To).
        </p>
      ) : (
        <table className="w-full border-collapse text-sm" data-testid="income-statement-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <SectionHeader label="Revenue" />
            {is.revenue.rows.map((r) => (
              <AccountLine key={r.accountId} number={r.accountNumber} name={r.accountName} amount={r.amount} />
            ))}
            <SubtotalLine label="Total revenue" amount={is.revenue.total} testid="is-revenue-total" />

            <SectionHeader label="Cost of goods sold" />
            {is.cogs.rows.map((r) => (
              <AccountLine key={r.accountId} number={r.accountNumber} name={r.accountName} amount={r.amount} />
            ))}
            <SubtotalLine label="Total COGS" amount={is.cogs.total} testid="is-cogs-total" />

            <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-2 pr-2">Gross profit</td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="is-gross-profit">{formatMoney(is.grossProfit)}</td>
            </tr>

            <SectionHeader label="Operating expenses" />
            {is.expenses.rows.map((r) => (
              <AccountLine key={r.accountId} number={r.accountNumber} name={r.accountName} amount={r.amount} />
            ))}
            <SubtotalLine label="Total operating expenses" amount={is.expenses.total} testid="is-expenses-total" />
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-semibold dark:border-neutral-700">
              <td className="py-2 pr-2">Net income</td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="is-net-income">{formatMoney(is.netIncome)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </main>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <tr className="bg-neutral-50 dark:bg-neutral-900">
      <td colSpan={2} className="py-1 pr-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </td>
    </tr>
  );
}

function AccountLine({ number, name, amount }: { number: string | null; name: string; amount: string }) {
  return (
    <tr data-testid="income-statement-row" className="border-b border-neutral-100 dark:border-neutral-800">
      <td className="py-2 pr-2">
        <span className="tabular-nums text-neutral-500">{number ?? '—'}</span> {name}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(amount)}</td>
    </tr>
  );
}

function SubtotalLine({ label, amount, testid }: { label: string; amount: string; testid: string }) {
  return (
    <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
      <td className="py-2 pr-2">{label}</td>
      <td className="py-2 pr-2 text-right tabular-nums" data-testid={testid}>{formatMoney(amount)}</td>
    </tr>
  );
}
