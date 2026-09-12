import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money-format';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listBillPayments } from '@/server/bill-payments';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

/**
 * Bill payments list — LL-065. Server component: authorizes (membership + the
 * `bill_payment.view` the service enforces), loads this company's bill payments, and
 * shows a Pay-bills link only when the viewer can create. Company comes from the
 * session context, never a URL/query param. The A/P mirror of the payments list.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES = ['POSTED', 'VOID'] as const;

export default async function BillPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const [payments, vendors] = await Promise.all([
    listBillPayments(user.id, membership.companyId),
    listVendors(user.id, membership.companyId),
  ]);
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
  const canCreate = roleHasCapability(membership.role, 'bill_payment.create');

  const params = await searchParams;
  const status = STATUSES.find((s) => s === params.status);
  const rows = status === undefined ? payments : payments.filter((p) => p.status === status);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bill Payments</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Company
        </Link>
      </header>

      {params.error === 'notfound' && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          That bill payment was not found.
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <form method="get" className="flex items-center gap-2 text-sm">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            name="status"
            defaultValue={status ?? ''}
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">
            Filter
          </button>
        </form>
        {canCreate && (
          <Link
            href="/bill-payments/new"
            data-testid="new-bill-payment-link"
            className="rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Pay bills
          </Link>
        )}
      </div>

      <table className="w-full border-collapse text-sm" data-testid="bill-payments-table">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Date</th>
            <th className="py-2 pr-2">Vendor</th>
            <th className="py-2 pr-2">Reference</th>
            <th className="py-2 pr-2">Status</th>
            <th className="py-2 pr-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-6 text-center text-neutral-500">
                No bill payments{status !== undefined ? ` with status ${status}` : ' yet'}.
              </td>
            </tr>
          ) : (
            rows.map((payment) => (
              <tr key={payment.id} data-testid="bill-payment-row" className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2 pr-2 text-neutral-500">{payment.paymentDate}</td>
                <td className="py-2 pr-2">
                  <Link href={`/bill-payments/${payment.id}`} className="underline">
                    {vendorName.get(payment.vendorId) ?? '—'}
                  </Link>
                </td>
                <td className="py-2 pr-2 text-neutral-500">{payment.reference ?? '—'}</td>
                <td className="py-2 pr-2">{payment.status}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(payment.amount)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  );
}
