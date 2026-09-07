import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { capabilitiesForRole } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { VendorsView } from './vendors-view';

/**
 * Vendors — LL-065. A server component: it authorizes (membership + the
 * `vendor.view` the service enforces), loads this company's vendors, and passes a
 * COSMETIC `canManage` flag. Every mutation re-authorizes on the server (AGENTS §6).
 * Company comes from the session context, never a URL/query param. The A/P mirror of
 * the customers page.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const vendors = await listVendors(user.id, membership.companyId);
  const canManage = capabilitiesForRole(membership.role).has('vendor.manage');

  const params = await searchParams;
  return <VendorsView vendors={vendors} canManage={canManage} notice={noticeFrom(params)} />;
}

function noticeFrom(p: { error?: string; created?: string }): string | null {
  if (p.created) return 'Vendor created.';
  if (p.error === 'invalid') return 'Please check the form and try again.';
  if (p.error === 'denied') return 'You do not have permission to manage vendors.';
  if (p.error) return 'That action could not be completed.';
  return null;
}
