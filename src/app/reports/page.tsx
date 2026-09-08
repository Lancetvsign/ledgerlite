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
  { href: '/reports/trial-balance', testid: 'trial-balance-link', title: 'Trial Balance', blurb: 'Every account’s derived debit/credit balance as of a date, with the balanced check.' },
  { href: '/reports/aging', testid: 'aging-link', title: 'A/R Aging', blurb: 'Open receivables per customer, bucketed by age, reconciling to the A/R control.' },
  { href: '/reports/statement', testid: 'statement-link', title: 'Customer Statement', blurb: 'One customer’s opening balance, activity, and closing balance over a period.' },
  { href: '/reports/ap-aging', testid: 'ap-aging-link', title: 'A/P Aging', blurb: 'Open payables per vendor, bucketed by age, reconciling to the A/P control.' },
  { href: '/reports/vendor-statement', testid: 'vendor-statement-link', title: 'Vendor Statement', blurb: 'One vendor’s opening balance, activity, and closing balance over a period.' },
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
