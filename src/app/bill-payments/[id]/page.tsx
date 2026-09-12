import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money-format';
import { isUuid } from '@/lib/uuid';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getBillPayment } from '@/server/bill-payments';
import { listBills } from '@/server/bills';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { voidBillPaymentAction } from '../actions';
import { billPaymentNotice } from '../notice';

/**
 * Bill-payment detail — LL-065. Read-only view plus Void for a POSTED payment (which
 * reverses its ledger entry and returns any bill it fully paid to OPEN). The button is
 * a courtesy; `voidBillPayment` re-authorizes (`bill_payment.void`, LEDGER_WRITERS) on
 * the server. A cross-company or missing id reads as not-found. The A/P mirror of the
 * payment detail.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BillPaymentDetailPage({
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
  if (!isUuid(id)) redirect('/bill-payments?error=notfound'); // malformed id → not-found, not a 500
  const loaded = await getBillPayment(user.id, membership.companyId, id);
  if (loaded === null) redirect('/bill-payments?error=notfound');
  const { payment, applications } = loaded;

  const [vendors, accounts, bills] = await Promise.all([
    listVendors(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
    listBills(user.id, membership.companyId),
  ]);
  const vendorName = vendors.find((v) => v.id === payment.vendorId)?.name ?? '—';
  const cashName = accounts.find((a) => a.id === payment.cashAccountId)?.name ?? '—';
  const billNumber = new Map(bills.map((b) => [b.id, b.billNumber]));
  const canVoid = roleHasCapability(membership.role, 'bill_payment.void');

  const sp = await searchParams;
  const notice = billPaymentNotice(sp.voided ? 'voided' : sp.error);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bill Payment</h1>
        <Link href="/bill-payments" className="text-sm text-neutral-500 underline">
          ← Bill payments
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {notice}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-neutral-500">Vendor</dt>
        <dd data-testid="bill-payment-vendor-name" className="sm:col-span-3">{vendorName}</dd>
        <dt className="text-neutral-500">Status</dt>
        <dd data-testid="bill-payment-status" className="font-medium">{payment.status}</dd>
        <dt className="text-neutral-500">Amount</dt>
        <dd data-testid="bill-payment-amount" className="tabular-nums">{formatMoney(payment.amount)}</dd>
        <dt className="text-neutral-500">Date</dt>
        <dd>{payment.paymentDate}</dd>
        <dt className="text-neutral-500">Paid from</dt>
        <dd>{cashName}</dd>
        <dt className="text-neutral-500">Method / ref</dt>
        <dd>{[payment.method, payment.reference].filter((v) => v !== null && v !== '').join(' · ') || '—'}</dd>
      </dl>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Applied to bill</th>
            <th className="py-2 pr-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((a) => (
            <tr key={a.id} className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">{billNumber.get(a.billId) ?? '(bill)'}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(a.amountApplied)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {payment.status === 'POSTED' && canVoid && (
        <form action={voidBillPaymentAction}>
          <input type="hidden" name="paymentId" value={payment.id} />
          <button type="submit" data-testid="void-bill-payment"
            className="self-start rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
            Void payment
          </button>
        </form>
      )}
      <p className="text-xs text-neutral-400">
        Voiding reverses this payment’s ledger entry and returns any bill it fully paid to OPEN.
      </p>
    </main>
  );
}
