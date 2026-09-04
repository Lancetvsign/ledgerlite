import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCustomers } from '@/server/customers';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { createInvoiceAction } from '../actions';
import { InvoiceForm } from '../invoice-form';
import { invoiceNotice } from '../notice';

/**
 * New invoice (DRAFT) — LL-044. Gates `invoice.create` for the form (a courtesy);
 * `createInvoice` re-authorizes and re-derives on the server. The customer and
 * account options are already scoped to this company and active, so the pickers
 * cannot surface another tenant's or a deactivated record.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'invoice.create')) redirect('/invoices?error=notfound');

  const [customers, accounts] = await Promise.all([
    listCustomers(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);
  const customerOptions = customers
    .filter((c) => c.status === 'ACTIVE')
    .map((c) => ({ id: c.id, label: c.name }));
  const revenueAccounts = accounts
    .filter((a) => a.status === 'ACTIVE' && a.accountType === 'REVENUE')
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));

  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <InvoiceForm
      customers={customerOptions}
      accounts={revenueAccounts}
      defaultDate={today}
      action={createInvoiceAction}
      submitLabel="Create draft"
      notice={invoiceNotice(params.error)}
    />
  );
}
