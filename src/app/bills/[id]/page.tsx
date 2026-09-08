import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getBill } from '@/server/bills';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { finalizeBillAction, voidBillAction } from '../actions';
import { billNotice } from '../notice';

/**
 * Bill detail — LL-065. Read-only view plus the lifecycle action the status allows:
 * DRAFT → finalize (posts Dr Expense / Cr A/P to the GL, `expense.create`), OPEN → void
 * (reverses it, `bill.void` — a ledger correction, LEDGER_WRITERS). The buttons are
 * courtesies; `finalizeBill`/`voidBill` re-authorize on the server. A cross-company or
 * missing id reads as not-found. The A/P mirror of the invoice detail.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; finalized?: string; voided?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const { id } = await params;
  const loaded = await getBill(user.id, membership.companyId, id);
  if (loaded === null) redirect('/bills?error=notfound');
  const { bill, lines } = loaded;

  const [vendors, accounts] = await Promise.all([
    listVendors(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);
  const vendorName = vendors.find((v) => v.id === bill.vendorId)?.name ?? '—';
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const canFinalize = roleHasCapability(membership.role, 'expense.create');
  const canVoid = roleHasCapability(membership.role, 'bill.void');

  const sp = await searchParams;
  const notice = billNotice(sp.finalized ? 'finalized' : sp.voided ? 'voided' : sp.error);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Bill {bill.billNumber ?? '(draft)'}
        </h1>
        <Link href="/bills" className="text-sm text-neutral-500 underline">
          ← Bills
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {notice}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-neutral-500">Vendor</dt>
        <dd data-testid="bill-vendor-name" className="sm:col-span-3">{vendorName}</dd>
        <dt className="text-neutral-500">Status</dt>
        <dd data-testid="bill-status" className="font-medium">{bill.status}</dd>
        <dt className="text-neutral-500">Bill date</dt>
        <dd>{bill.billDate}</dd>
        <dt className="text-neutral-500">Due date</dt>
        <dd>{bill.dueDate ?? '—'}</dd>
        {bill.memo !== null && bill.memo !== '' && (
          <>
            <dt className="text-neutral-500">Memo</dt>
            <dd className="sm:col-span-3">{bill.memo}</dd>
          </>
        )}
      </dl>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Account</th>
            <th className="py-2 pr-2">Description</th>
            <th className="py-2 pr-2 text-right">Qty</th>
            <th className="py-2 pr-2 text-right">Unit price</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">{accountName.get(line.accountId) ?? '—'}</td>
              <td className="py-2 pr-2 text-neutral-500">{line.description ?? '—'}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{line.quantity}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{line.unitPrice}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <td className="py-1 pr-2 text-right" colSpan={3}>Total</td>
            <td className="py-1 pr-2 text-right tabular-nums" data-testid="bill-total">{bill.total}</td>
          </tr>
        </tfoot>
      </table>

      <div className="flex items-center gap-2">
        {bill.status === 'DRAFT' && canFinalize && (
          <form action={finalizeBillAction}>
            <input type="hidden" name="billId" value={bill.id} />
            <button type="submit" data-testid="finalize-bill"
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Finalize &amp; post
            </button>
          </form>
        )}
        {bill.status === 'OPEN' && canVoid && (
          <form action={voidBillAction}>
            <input type="hidden" name="billId" value={bill.id} />
            <button type="submit" data-testid="void-bill"
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
              Void
            </button>
          </form>
        )}
      </div>
      <p className="text-xs text-neutral-400">
        Finalizing assigns a number and posts Dr Expense / Cr Accounts Payable to the ledger. Void reverses
        that entry; a bill with payments or vendor credits applied must have them voided first.
      </p>
    </main>
  );
}
