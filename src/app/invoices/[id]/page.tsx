import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCustomers } from '@/server/customers';
import { getInvoice } from '@/server/invoices';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { finalizeInvoiceAction, voidInvoiceAction } from '../actions';
import { invoiceNotice } from '../notice';

/**
 * Invoice detail — LL-044. Read-only view plus the two lifecycle actions the
 * status allows: DRAFT → edit + finalize (posts to the GL), OPEN → void (reverses
 * it). The buttons are courtesies; `finalizeInvoice`/`voidInvoice` re-authorize
 * (`invoice.post`) on the server. A cross-company or missing id reads as not-found.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function InvoiceDetailPage({
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
  const loaded = await getInvoice(user.id, membership.companyId, id);
  if (loaded === null) redirect('/invoices?error=notfound');
  const { invoice, lines } = loaded;

  const [customers, accounts] = await Promise.all([
    listCustomers(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);
  const customerName = customers.find((c) => c.id === invoice.customerId)?.name ?? '—';
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const canPost = roleHasCapability(membership.role, 'invoice.post');
  const canEdit = roleHasCapability(membership.role, 'invoice.create');

  const sp = await searchParams;
  const notice = invoiceNotice(sp.finalized ? 'finalized' : sp.voided ? 'voided' : sp.error);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Invoice {invoice.invoiceNumber ?? '(draft)'}
        </h1>
        <Link href="/invoices" className="text-sm text-neutral-500 underline">
          ← Invoices
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {notice}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-neutral-500">Customer</dt>
        <dd data-testid="invoice-customer-name" className="sm:col-span-3">{customerName}</dd>
        <dt className="text-neutral-500">Status</dt>
        <dd data-testid="invoice-status" className="font-medium">{invoice.status}</dd>
        <dt className="text-neutral-500">Invoice date</dt>
        <dd>{invoice.invoiceDate}</dd>
        <dt className="text-neutral-500">Due date</dt>
        <dd>{invoice.dueDate ?? '—'}</dd>
        {invoice.memo !== null && invoice.memo !== '' && (
          <>
            <dt className="text-neutral-500">Memo</dt>
            <dd className="sm:col-span-3">{invoice.memo}</dd>
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
            <th className="py-2 pr-2 text-right">Tax %</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">{accountName.get(line.accountId) ?? '—'}</td>
              <td className="py-2 pr-2 text-neutral-500">{line.description ?? '—'}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{line.quantity}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{line.unitPrice}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{line.taxRate}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="py-1 pr-2 text-right text-neutral-500" colSpan={4}>Subtotal</td>
            <td className="py-1 pr-2 text-right tabular-nums">{invoice.subtotal}</td>
          </tr>
          <tr>
            <td className="py-1 pr-2 text-right text-neutral-500" colSpan={4}>Tax</td>
            <td className="py-1 pr-2 text-right tabular-nums">{invoice.taxTotal}</td>
          </tr>
          <tr className="font-medium">
            <td className="py-1 pr-2 text-right" colSpan={4}>Total</td>
            <td className="py-1 pr-2 text-right tabular-nums" data-testid="invoice-total">{invoice.total}</td>
          </tr>
        </tfoot>
      </table>

      <div className="flex items-center gap-2">
        {invoice.status === 'DRAFT' && canEdit && (
          <Link href={`/invoices/${invoice.id}/edit`} data-testid="edit-invoice"
            className="rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">Edit</Link>
        )}
        {invoice.status === 'DRAFT' && canPost && (
          <form action={finalizeInvoiceAction}>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <button type="submit" data-testid="finalize-invoice"
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Finalize &amp; post
            </button>
          </form>
        )}
        {invoice.status === 'OPEN' && canPost && (
          <form action={voidInvoiceAction}>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <button type="submit" data-testid="void-invoice"
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
              Void
            </button>
          </form>
        )}
      </div>
      <p className="text-xs text-neutral-400">
        Finalizing assigns a number and posts Dr Accounts Receivable / Cr Revenue (+ tax) to the ledger.
        Void reverses that entry; a paid invoice must have its payment voided first.
      </p>
    </main>
  );
}
