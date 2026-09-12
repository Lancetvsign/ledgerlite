import Link from 'next/link';
import { formatMoney } from '@/lib/money-format';

import { getBalanceSheet } from '@/server/reports';

import { AsOfForm } from '../as-of-form';
import { requireReportContext, resolveAsOf } from '../report-context';

/**
 * Balance Sheet screen — LL-072. Pure presentation over `getBalanceSheet`: Assets =
 * Liabilities + Equity as of a date. Equity shows the equity ACCOUNTS plus the two
 * DERIVED earnings lines (prior retained earnings + current-year net income), because
 * the ledger posts no closing entry (ADR-030). Money is rendered straight from the
 * service's `string` values — no JavaScript number touches it (ADR-004), and no total is
 * recomputed on the client (the service sums in PostgreSQL).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const ctx = await requireReportContext();
  const { asOf: raw } = await searchParams;
  const { asOf, invalid } = resolveAsOf(raw, ctx.today);
  const bs = invalid ? null : await getBalanceSheet(ctx.userId, ctx.companyId, asOf);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Balance Sheet</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">
          ← Reports
        </Link>
      </header>

      <AsOfForm asOf={asOf} />

      {invalid || bs === null ? (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date (YYYY-MM-DD).
        </p>
      ) : (
        <table className="w-full border-collapse text-sm" data-testid="balance-sheet-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2 text-right">Balance</th>
            </tr>
          </thead>

          <tbody>
            <SectionHeader label="Assets" />
            {bs.assets.rows.map((r) => (
              <AccountLine key={r.accountId} number={r.accountNumber} name={r.accountName} amount={r.balance} />
            ))}
            <SubtotalLine label="Total assets" amount={bs.assets.total} testid="bs-assets-total" />

            <SectionHeader label="Liabilities" />
            {bs.liabilities.rows.map((r) => (
              <AccountLine key={r.accountId} number={r.accountNumber} name={r.accountName} amount={r.balance} />
            ))}
            <SubtotalLine label="Total liabilities" amount={bs.liabilities.total} testid="bs-liabilities-total" />

            <SectionHeader label="Equity" />
            {bs.equity.accountRows.map((r) => (
              <AccountLine key={r.accountId} number={r.accountNumber} name={r.accountName} amount={r.balance} />
            ))}
            <tr data-testid="balance-sheet-row" className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">Retained earnings (prior years)</td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="bs-prior-retained">{formatMoney(bs.equity.priorRetainedEarnings)}</td>
            </tr>
            <tr data-testid="balance-sheet-row" className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">Net income (current year)</td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="bs-current-net-income">{formatMoney(bs.equity.currentNetIncome)}</td>
            </tr>
            <SubtotalLine label="Total equity" amount={bs.equity.total} testid="bs-equity-total" />
          </tbody>

          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-2 pr-2">Total liabilities &amp; equity</td>
              <td className="py-2 pr-2 text-right tabular-nums" data-testid="bs-liabilities-equity-total">
                {formatMoney(bs.liabilitiesAndEquityTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      {bs !== null && (
        <p
          data-testid="bs-balanced"
          className={
            bs.balanced
              ? 'rounded bg-green-100 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300'
              : 'rounded bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300'
          }
        >
          {bs.balanced
            ? 'Balanced — assets equal liabilities plus equity.'
            : 'NOT balanced — assets do not equal liabilities plus equity.'}
        </p>
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
    <tr data-testid="balance-sheet-row" className="border-b border-neutral-100 dark:border-neutral-800">
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
