import Link from 'next/link';

import { isCalendarDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money-format';
import { isUuid } from '@/lib/uuid';
import { getVendorStatement } from '@/server/reports';
import { listVendors } from '@/server/vendors';

import { requireReportContext } from '../report-context';

/**
 * Vendor Statement screen — LL-065. Pure presentation over `getVendorStatement`
 * (LL-064): one vendor's opening balance, dated activity with a running balance, and
 * closing balance over a period. Money is rendered straight from the service's
 * `string` values — no JavaScript number touches it (ADR-004), and the running balance
 * is the service's, not recomputed here. A/P is credit-natural, so `charge` is a bill
 * (Cr A/P) and `payment` a payment or vendor credit (Dr A/P). The A/P mirror of the
 * Customer Statement screen.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function VendorStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ vendorId?: string; from?: string; to?: string }>;
}) {
  const ctx = await requireReportContext();
  const params = await searchParams;
  const vendors = await listVendors(ctx.userId, ctx.companyId);

  // Default to a year-to-date period ending on the company's today.
  const to = params.to !== undefined && isCalendarDate(params.to) ? params.to : ctx.today;
  const from =
    params.from !== undefined && isCalendarDate(params.from) ? params.from : `${ctx.today.slice(0, 4)}-01-01`;

  const vendorId = params.vendorId ?? '';
  const datesInvalid =
    (params.from !== undefined && params.from !== '' && !isCalendarDate(params.from)) ||
    (params.to !== undefined && params.to !== '' && !isCalendarDate(params.to)) ||
    from > to;

  // Only run the report once a vendor is chosen and the dates are sane. A
  // cross-company/unknown vendorId returns null (no existence leak, §6).
  // A malformed vendorId (crafted ?vendorId=abc) reads as not-found — the same notice a
  // real miss gets — never a 500 (Gate 5).
  const statement =
    vendorId !== '' && isUuid(vendorId) && !datesInvalid
      ? await getVendorStatement(ctx.userId, ctx.companyId, vendorId, from, to)
      : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Vendor Statement</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">
          ← Reports
        </Link>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" data-testid="vendor-statement-form">
        <label className="flex flex-col gap-1">
          <span>Vendor</span>
          <select
            name="vendorId"
            defaultValue={vendorId}
            data-testid="vendor-statement-vendor"
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">Select a vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} data-testid="vendor-statement-from" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} data-testid="vendor-statement-to" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="vendor-statement-submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          View
        </button>
      </form>

      {datesInvalid && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date range (From on or before To).
        </p>
      )}
      {vendorId !== '' && !datesInvalid && statement === null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          That vendor was not found.
        </p>
      )}

      {statement !== null && (
        <section className="flex flex-col gap-3" data-testid="vendor-statement">
          <p className="text-sm text-neutral-500">
            <span className="font-medium text-neutral-900 dark:text-neutral-100" data-testid="vendor-statement-name">
              {statement.vendorName}
            </span>{' '}
            · {statement.fromDate} to {statement.toDate}
          </p>

          <div className="flex justify-between rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
            <span>Opening balance</span>
            <span className="tabular-nums" data-testid="vendor-statement-opening">{formatMoney(statement.openingBalance)}</span>
          </div>

          <table className="w-full border-collapse text-sm" data-testid="vendor-statement-table">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Date</th>
                <th className="py-2 pr-2">Entry</th>
                <th className="py-2 pr-2">Type</th>
                <th className="py-2 pr-2">Description</th>
                <th className="py-2 pr-2 text-right">Charge</th>
                <th className="py-2 pr-2 text-right">Payment</th>
                <th className="py-2 pr-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-neutral-500">
                    No activity in this period.
                  </td>
                </tr>
              ) : (
                statement.lines.map((l, i) => (
                  <tr key={`${l.entryNumber}-${i}`} data-testid="vendor-statement-row" className="border-b border-neutral-100 dark:border-neutral-800">
                    <td className="py-2 pr-2 text-neutral-500">{l.date}</td>
                    <td className="py-2 pr-2 tabular-nums">{l.entryNumber}</td>
                    <td className="py-2 pr-2">{l.sourceType}</td>
                    <td className="py-2 pr-2">{l.description ?? '—'}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.charge)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.payment)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.balance)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <div className="flex justify-between rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
            <span>Closing balance</span>
            <span className="tabular-nums" data-testid="vendor-statement-closing">{formatMoney(statement.closingBalance)}</span>
          </div>
        </section>
      )}
    </main>
  );
}
