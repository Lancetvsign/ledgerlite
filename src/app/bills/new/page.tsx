import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { companyToday } from '@/server/companies';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { BillForm } from '../bill-form';
import { billNotice } from '../notice';

/**
 * New bill (DRAFT) — LL-065. Gates `expense.create` for the form (a courtesy);
 * `createBill` re-authorizes and re-derives on the server. The vendor and account
 * options are already scoped to this company and active — and the account picker
 * offers only ORDINARY accounts (no system control account such as A/P), exactly the
 * set the service will accept — so the pickers cannot surface another tenant's, a
 * deactivated, or a control record.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'expense.create')) redirect('/bills?error=notfound');

  const [vendors, accounts] = await Promise.all([
    listVendors(user.id, membership.companyId),
    listAccounts(user.id, membership.companyId),
  ]);
  const vendorOptions = vendors
    .filter((v) => v.status === 'ACTIVE')
    .map((v) => ({ id: v.id, label: v.name }));
  const lineAccounts = accounts
    .filter((a) => a.status === 'ACTIVE' && a.systemAccountType === null)
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));

  const params = await searchParams;
  const today = await companyToday(user.id, membership.companyId); // the COMPANY's today (ADR-007)

  return (
    <BillForm
      vendors={vendorOptions}
      accounts={lineAccounts}
      defaultDate={today}
      notice={billNotice(params.error)}
    />
  );
}
