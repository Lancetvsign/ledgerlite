import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { capabilitiesForRole } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { AccountsView } from './accounts-view';

/**
 * Chart of accounts — LL-024.
 *
 * A server component: it authorizes, loads the company's accounts, and passes a
 * `canManage` flag to the client. That flag is COSMETIC — every mutation action
 * re-authorizes on the server (LL-024/AGENTS §6), so hiding a button is a
 * courtesy, never the control.
 *
 * Displays account number, name, type, subtype, status. NO balances — there are
 * none; they derive from journal lines in LL-034.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; error?: string; created?: string; updated?: string; deactivated?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account'); // pick a company first

  // Company comes from the SERVER-authorized context, never a URL/query param —
  // so there is no company id to manipulate in the address bar.
  const accounts = await listAccounts(user.id, membership.companyId);
  const canManage = capabilitiesForRole(membership.role).has('account.manage');

  const params = await searchParams;
  const query = (params.q ?? '').trim().toLowerCase();
  const filtered =
    query === ''
      ? accounts
      : accounts.filter(
          (a) =>
            a.name.toLowerCase().includes(query) ||
            (a.accountNumber ?? '').toLowerCase().includes(query) ||
            a.accountType.toLowerCase().includes(query) ||
            (a.accountSubtype ?? '').toLowerCase().includes(query),
        );

  return (
    <AccountsView
      accounts={filtered}
      total={accounts.length}
      canManage={canManage}
      query={params.q ?? ''}
      notice={noticeFrom(params)}
    />
  );
}

function noticeFrom(p: { error?: string; created?: string; updated?: string; deactivated?: string }): string | null {
  if (p.created) return 'Account created.';
  if (p.updated) return 'Account updated.';
  if (p.deactivated) return 'Account deactivated.';
  if (p.error === 'invalid') return 'Please check the form and try again.';
  if (p.error === 'denied') return 'Not found.'; // forbidden reads as not-found
  if (p.error) return 'That action could not be completed.';
  return null;
}
