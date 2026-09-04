import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCustomers } from '@/server/customers';
import { capabilitiesForRole } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { CustomersView } from './customers-view';

/**
 * Customers — LL-044. A server component: it authorizes (membership + the
 * `customer.view` the service enforces), loads this company's customers, and
 * passes a COSMETIC `canManage` flag. Every mutation re-authorizes on the server
 * (AGENTS §6). Company comes from the session context, never a URL/query param.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const customers = await listCustomers(user.id, membership.companyId);
  const canManage = capabilitiesForRole(membership.role).has('customer.manage');

  const params = await searchParams;
  return <CustomersView customers={customers} canManage={canManage} notice={noticeFrom(params)} />;
}

function noticeFrom(p: { error?: string; created?: string }): string | null {
  if (p.created) return 'Customer created.';
  if (p.error === 'invalid') return 'Please check the form and try again.';
  if (p.error === 'denied') return 'You do not have permission to manage customers.';
  if (p.error) return 'That action could not be completed.';
  return null;
}
