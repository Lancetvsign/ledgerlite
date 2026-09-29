import Link from 'next/link';

import { requireReportContext } from './report-context';

/**
 * Reports index — LL-055. A plain hub linking to the three read-only reports.
 * Every member holds `report.view`, so no per-link gating is needed; each report
 * page re-authorizes on the server regardless.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPORTS = [
  { href: '/reports/balance-sheet', testid: 'balance-sheet-link', title: 'Balance Sheet', blurb: 'Assets, liabilities, and equity as of a date — with net income derived into equity and the balanced check.' },
  { href: '/reports/income-statement', testid: 'income-statement-link', title: 'Income Statement', blurb: 'Revenue, COGS, gross profit, expenses, and net income over a period (P&L).' },
  { href: '/reports/cash-flow', testid: 'cash-flow-link', title: 'Cash-Flow Statement', blurb: 'Operating, investing, and financing cash flows over a period, reconciling beginning to ending cash.' },
  { href: '/reports/register', testid: 'register-link', title: 'Account Register', blurb: 'Every posted line for one account over a period, with a running balance and links to the source documents.' },
  { href: '/reports/trial-balance', testid: 'trial-balance-link', title: 'Trial Balance', blurb: 'Every account’s derived debit/credit balance as of a date, with the balanced check.' },
  { href: '/reports/aging', testid: 'aging-link', title: 'A/R Aging', blurb: 'Open receivables per customer, bucketed by age, reconciling to the A/R control.' },
  { href: '/reports/statement', testid: 'statement-link', title: 'Customer Statement', blurb: 'One customer’s opening balance, activity, and closing balance over a period.' },
  { href: '/reports/ap-aging', testid: 'ap-aging-link', title: 'A/P Aging', blurb: 'Open payables per vendor, bucketed by age, reconciling to the A/P control.' },
  { href: '/reports/vendor-statement', testid: 'vendor-statement-link', title: 'Vendor Statement', blurb: 'One vendor’s opening balance, activity, and closing balance over a period.' },
  { href: '/reports/intercompany', testid: 'intercompany-link', title: 'Intercompany Balances', blurb: 'What each company of your organization owes this one and is owed by it, checked against the other company’s books.' },
  { href: '/reports/consolidated-balance-sheet', testid: 'consolidated-balance-sheet-link', title: 'Consolidated Balance Sheet', blurb: 'Your whole organization’s position: every company side by side, intercompany balances eliminated.' },
  { href: '/reports/consolidated-income-statement', testid: 'consolidated-income-statement-link', title: 'Consolidated Income Statement', blurb: 'Your whole organization’s income and expenses over a period, every company side by side.' },
  { href: '/reports/consolidated-cash-flow', testid: 'consolidated-cash-flow-link', title: 'Consolidated Cash-Flow Statement', blurb: 'Your whole organization’s cash in and out over a period, every company side by side, transfers between them cancelled out.' },
] as const;

export default async function ReportsPage() {
  await requireReportContext();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Company
        </Link>
      </header>
      <ul className="flex flex-col gap-3" data-testid="reports-list">
        {REPORTS.map((r) => (
          <li key={r.href} className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
            <Link href={r.href} data-testid={r.testid} className="text-lg font-medium underline">
              {r.title}
            </Link>
            <p className="mt-1 text-sm text-neutral-500">{r.blurb}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
