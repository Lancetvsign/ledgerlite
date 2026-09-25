import Link from 'next/link';

import { formatMoney } from '@/lib/money-format';

/**
 * Drill-down — LL-108. Every figure on a report is a link to what makes it up: an account's
 * figure opens its register (ADR-040: the ledger-derived detail behind every balance) for the
 * report's window; a customer's or vendor's figure opens their statement; a computed line
 * (net income, retained earnings) opens the statement that computes it. The register's
 * closing balance equals the report's figure whatever the window's start, because its
 * opening balance carries everything before it. Money is rendered from the service's
 * `string`s (ADR-004).
 */
export function registerHref(accountId: string, from: string, to: string): string {
  return `/reports/register?accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;
}

export function incomeStatementHref(from: string, to: string): string {
  return `/reports/income-statement?from=${from}&to=${to}`;
}

/** January 1st of the date's year — a window start that is never after the date. */
export function yearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

/** The day before a calendar date (YYYY-MM-DD), for "everything before the fiscal year". */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/** Earlier than any posting the ledger can hold — the open start of an all-time window. */
export const BEGINNING_OF_TIME = '1970-01-01';

export function DrillLink({ href, amount, testid, className = '' }: { href: string; amount: string; testid?: string; className?: string }) {
  return (
    <Link
      href={href}
      title="Show the transactions behind this figure"
      {...(testid === undefined ? {} : { 'data-testid': testid })}
      className={`underline decoration-dotted underline-offset-2 hover:decoration-solid ${className}`}
    >
      {formatMoney(amount)}
    </Link>
  );
}
