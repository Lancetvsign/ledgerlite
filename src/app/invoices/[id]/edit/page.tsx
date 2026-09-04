import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCustomers } from '@/server/customers';
import { getInvoice } from '@/server/invoices';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { updateInvoiceAction } from '../../actions';
import { accountLabel } from '../../format';
import { InvoiceForm, type InvoiceFormInitial } from '../../invoice-form';
import { invoiceNotice } from '../../notice';

/**
 * Edit a DRAFT invoice — LL-044. Only a DRAFT is editable; anything else redirects
 * to its detail. Reuses the create form prefilled, posting `updateInvoiceAction`,
 * which re-authorizes and re-derives on the server.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function EditInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'invoice.create')) redirect('/invoices?error=notfound');

  const { id } = await params;
  const loaded = await getInvoice(user.id, membership.companyId, id);
  if (loaded === null) redirect('/invoices?error=notfound');
  if (loaded.invoice.status !== 'DRAFT') redirect(`/invoices/${id}`); // only a draft is editable

  const [customers, accounts] = await Promise.all([
    listCustomers(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);
  const labelById = new Map(accounts.map((a) => [a.id, accountLabel(a)]));
  const customerOptions = customers
    .filter((c) => c.status === 'ACTIVE')
    .map((c) => ({ id: c.id, label: c.name }));
  const revenueAccounts = accounts
    .filter((a) => a.status === 'ACTIVE' && a.accountType === 'REVENUE')
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));

  const initial: InvoiceFormInitial = {
    invoiceId: loaded.invoice.id,
    customerText: customers.find((c) => c.id === loaded.invoice.customerId)?.name ?? '',
    invoiceDate: loaded.invoice.invoiceDate,
    dueDate: loaded.invoice.dueDate ?? '',
    memo: loaded.invoice.memo ?? '',
    lines: loaded.lines.map((l) => ({
      accountText: labelById.get(l.accountId) ?? '',
      accountId: l.accountId,
      description: l.description ?? '',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate,
    })),
  };

  const params2 = await searchParams;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <InvoiceForm
      customers={customerOptions}
      accounts={revenueAccounts}
      defaultDate={today}
      action={updateInvoiceAction}
      submitLabel="Save draft"
      notice={invoiceNotice(params2.error)}
      initial={initial}
    />
  );
}
