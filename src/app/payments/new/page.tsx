import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCustomers } from '@/server/customers';
import { listOpenInvoices } from '@/server/payments';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { paymentNotice } from '../notice';
import { PaymentForm } from '../payment-form';

/**
 * Receive a payment — LL-045. Gates `payment.create` for the form (a courtesy);
 * `receivePayment` re-authorizes and re-validates on the server. The deposit-account
 * options are active ASSET accounts EXCEPT Accounts Receivable (the service rejects
 * depositing there); customers and open invoices are company-scoped, so the pickers
 * can't surface another tenant's records.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function NewPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'payment.create')) redirect('/payments?error=notfound');

  const [customers, openInvoices, accounts] = await Promise.all([
    listCustomers(user.id, membership.companyId),
    listOpenInvoices(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);

  const customerOptions = customers
    .filter((c) => c.status === 'ACTIVE')
    .map((c) => ({ id: c.id, label: c.name }));
  const depositAccounts = accounts
    .filter(
      (a) => a.status === 'ACTIVE' && a.accountType === 'ASSET' && a.systemAccountType !== 'ACCOUNTS_RECEIVABLE',
    )
    .map((a) => ({ id: a.id, label: a.name }));
  const openInvoiceOptions = openInvoices.map((i) => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    customerId: i.customerId,
    invoiceDate: i.invoiceDate,
    openBalance: i.openBalance,
  }));

  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <PaymentForm
      customers={customerOptions}
      openInvoices={openInvoiceOptions}
      depositAccounts={depositAccounts}
      defaultDate={today}
      notice={paymentNotice(params.error)}
    />
  );
}
