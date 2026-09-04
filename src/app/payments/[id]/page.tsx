import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCustomers } from '@/server/customers';
import { listInvoices } from '@/server/invoices';
import { getPayment } from '@/server/payments';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { voidPaymentAction } from '../actions';
import { paymentNotice } from '../notice';

/**
 * Payment detail — LL-045. Read-only view plus Void for a POSTED payment (which
 * reverses its ledger entry and returns any invoice it fully paid to OPEN). The
 * button is a courtesy; `voidPayment` re-authorizes on the server. A cross-company
 * or missing id reads as not-found.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PaymentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; voided?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const { id } = await params;
  const loaded = await getPayment(user.id, membership.companyId, id);
  if (loaded === null) redirect('/payments?error=notfound');
  const { payment, applications } = loaded;

  const [customers, accounts, invoices] = await Promise.all([
    listCustomers(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
    listInvoices(user.id, membership.companyId),
  ]);
  const customerName = customers.find((c) => c.id === payment.customerId)?.name ?? '—';
  const depositName = accounts.find((a) => a.id === payment.depositAccountId)?.name ?? '—';
  const invoiceNumber = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
  const canVoid = roleHasCapability(membership.role, 'payment.create');

  const sp = await searchParams;
  const notice = paymentNotice(sp.voided ? 'voided' : sp.error);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Payment</h1>
        <Link href="/payments" className="text-sm text-neutral-500 underline">
          ← Payments
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {notice}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-neutral-500">Customer</dt>
        <dd data-testid="payment-customer-name" className="sm:col-span-3">{customerName}</dd>
        <dt className="text-neutral-500">Status</dt>
        <dd data-testid="payment-status" className="font-medium">{payment.status}</dd>
        <dt className="text-neutral-500">Amount</dt>
        <dd data-testid="payment-amount" className="tabular-nums">{payment.amount}</dd>
        <dt className="text-neutral-500">Date</dt>
        <dd>{payment.paymentDate}</dd>
        <dt className="text-neutral-500">Deposited to</dt>
        <dd>{depositName}</dd>
        <dt className="text-neutral-500">Method / ref</dt>
        <dd>{[payment.method, payment.reference].filter((v) => v !== null && v !== '').join(' · ') || '—'}</dd>
      </dl>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Applied to invoice</th>
            <th className="py-2 pr-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((a) => (
            <tr key={a.id} className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">{invoiceNumber.get(a.invoiceId) ?? '(invoice)'}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{a.amountApplied}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {payment.status === 'POSTED' && canVoid && (
        <form action={voidPaymentAction}>
          <input type="hidden" name="paymentId" value={payment.id} />
          <button type="submit" data-testid="void-payment"
            className="self-start rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
            Void payment
          </button>
        </form>
      )}
      <p className="text-xs text-neutral-400">
        Voiding reverses this payment’s ledger entry and returns any invoice it fully paid to OPEN.
      </p>
    </main>
  );
}
