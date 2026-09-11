import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { companyToday } from '@/server/companies';
import { listOpenBills } from '@/server/bill-payments';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { BillPaymentForm } from '../bill-payment-form';
import { billPaymentNotice } from '../notice';

/**
 * Pay bills — LL-065. Gates `bill_payment.create` for the form (a courtesy); `payBill`
 * re-authorizes and re-validates on the server. The cash-account options are active
 * ASSET accounts that are NOT a system control account (the service rejects paying
 * from A/R or A/P); vendors and open bills are company-scoped, so the pickers can't
 * surface another tenant's records. The A/P mirror of the receive-payment page.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function NewBillPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'bill_payment.create')) redirect('/bill-payments?error=notfound');

  const [vendors, openBills, accounts] = await Promise.all([
    listVendors(user.id, membership.companyId),
    listOpenBills(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);

  const vendorOptions = vendors
    .filter((v) => v.status === 'ACTIVE')
    .map((v) => ({ id: v.id, label: v.name }));
  const cashAccounts = accounts
    .filter((a) => a.status === 'ACTIVE' && a.accountType === 'ASSET' && a.systemAccountType === null)
    .map((a) => ({ id: a.id, label: a.name }));
  const openBillOptions = openBills.map((b) => ({
    id: b.id,
    billNumber: b.billNumber,
    vendorId: b.vendorId,
    billDate: b.billDate,
    openBalance: b.openBalance,
  }));

  const params = await searchParams;
  const today = await companyToday(user.id, membership.companyId); // the COMPANY's today (ADR-007)

  return (
    <BillPaymentForm
      vendors={vendorOptions}
      openBills={openBillOptions}
      cashAccounts={cashAccounts}
      defaultDate={today}
      idempotencyKey={crypto.randomUUID()}
      notice={billPaymentNotice(params.error)}
    />
  );
}
