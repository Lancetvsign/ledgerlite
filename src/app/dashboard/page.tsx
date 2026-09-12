import Link from 'next/link';
import { formatMoney } from '@/lib/money-format';

import { listRecentEntries } from '@/server/ledger';
import {
  getApAging,
  getArAging,
  getBalanceSheet,
  getCashFlowStatement,
} from '@/server/reports';

import { requireReportContext } from '../reports/report-context';

/**
 * Dashboard — LL-075. A read-only financial home screen composed from the existing report
 * services: an as-of-today snapshot (cash, A/R, A/P, position) plus fiscal-year-to-date
 * performance (net income, cash change) and a recent-activity feed. Every figure is
 * rendered straight from a service `string` — no JavaScript number touches money (ADR-004),
 * and nothing is recomputed on the client. Redirects to /account when no company is active
 * (via requireReportContext).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const ctx = await requireReportContext();

  // The balance sheet gives us the fiscal-year start, which bounds the "year-to-date"
  // performance figures; then fetch the rest in parallel.
  const balanceSheet = await getBalanceSheet(ctx.userId, ctx.companyId, ctx.today);
  const fyStart = balanceSheet.fiscalYearStart;
  // getCashFlowStatement already computes net income (it composes the income statement),
  // so read it from there rather than recomputing the P&L separately.
  const [cashFlow, arAging, apAging, recent] = await Promise.all([
    getCashFlowStatement(ctx.userId, ctx.companyId, fyStart, ctx.today),
    getArAging(ctx.userId, ctx.companyId, ctx.today),
    getApAging(ctx.userId, ctx.companyId, ctx.today),
    listRecentEntries(ctx.userId, ctx.companyId, 10),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">← Company</Link>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-3" data-testid="dashboard-stats">
        <Stat label={`Cash on hand (as of ${ctx.today})`} value={cashFlow.endingCash} testid="dashboard-cash" />
        <Stat label="Accounts receivable" value={arAging.totals.total} testid="dashboard-ar" />
        <Stat label="Accounts payable" value={apAging.totals.total} testid="dashboard-ap" />
        <Stat label={`Net income (since ${fyStart})`} value={cashFlow.netIncome} testid="dashboard-net-income" />
        <Stat label={`Cash change (since ${fyStart})`} value={cashFlow.netChangeInCash} testid="dashboard-cash-change" />
        <Stat label="Total assets" value={balanceSheet.assets.total} testid="dashboard-assets" />
        <Stat label="Total liabilities" value={balanceSheet.liabilities.total} testid="dashboard-liabilities" />
        <Stat label="Total equity" value={balanceSheet.equity.total} testid="dashboard-equity" />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Recent activity</h2>
          <Link href="/reports" className="text-sm text-neutral-500 underline">All reports →</Link>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="dashboard-recent-empty">No posted activity yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="dashboard-recent">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">#</th>
                <th className="py-2 pr-2">Description</th>
                <th className="py-2 pr-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id} data-testid="dashboard-recent-row" className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 pr-2 tabular-nums">{e.postingDate}</td>
                  <td className="py-2 pr-2 tabular-nums">{e.entryNumber ?? '—'}</td>
                  <td className="py-2 pr-2">
                    {e.description ?? e.sourceType.replace(/_/g, ' ').toLowerCase()}
                    {e.status === 'REVERSED' && <span className="ml-2 text-xs text-neutral-400">reversed</span>}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(e.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href="/reports/balance-sheet" className="underline">Balance Sheet</Link>
        <Link href="/reports/income-statement" className="underline">Income Statement</Link>
        <Link href="/reports/cash-flow" className="underline">Cash Flow</Link>
        <Link href="/reports/aging" className="underline">A/R Aging</Link>
        <Link href="/reports/ap-aging" className="underline">A/P Aging</Link>
      </nav>
    </main>
  );
}

function Stat({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" data-testid={testid}>{formatMoney(value)}</div>
    </div>
  );
}
