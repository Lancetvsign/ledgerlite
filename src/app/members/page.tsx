import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listInvitations, listMembers } from '@/server/members';
import { capabilitiesForRole, roleCovers, ROLES } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { MembersView } from './members-view';

/**
 * Team — LL-086. A server component: authorizes (membership; the services enforce
 * `user.manage` for anything beyond the roster), loads members and pending
 * invitations, and passes COSMETIC flags: `canManage`, and the roles this actor
 * may grant (`roleCovers`). Every mutation re-authorizes on the server. The company
 * comes from the session context, never a URL or query param.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const canManage = capabilitiesForRole(membership.role).has('user.manage');
  const [members, invitations, sp] = await Promise.all([
    listMembers(user.id, membership.companyId),
    canManage ? listInvitations(user.id, membership.companyId) : Promise.resolve([]),
    searchParams,
  ]);
  const grantableRoles = ROLES.filter((r) => roleCovers(membership.role, r));

  return (
    <MembersView
      members={members}
      invitations={invitations}
      selfUserId={user.id}
      actorRole={membership.role}
      canManage={canManage}
      grantableRoles={grantableRoles}
      notice={noticeFrom(sp)}
    />
  );
}

function noticeFrom(sp: { ok?: string; error?: string }): { tone: 'ok' | 'error'; text: string } | null {
  if (sp.ok === 'member-added') return { tone: 'ok', text: 'Member added: they already had an account, so they have access now.' };
  if (sp.ok === 'member-invited') return { tone: 'ok', text: 'Invitation recorded. When that email signs up and opens LedgerLite, the membership appears automatically — let them know.' };
  if (sp.ok === 'role-changed') return { tone: 'ok', text: 'Role changed.' };
  if (sp.ok === 'member-removed') return { tone: 'ok', text: 'Member removed. Their history stays; they can be added again later.' };
  if (sp.ok === 'invitation-revoked') return { tone: 'ok', text: 'Invitation revoked.' };
  if (sp.error === undefined) return null;
  if (sp.error === 'ALREADY_MEMBER') return { tone: 'error', text: 'That person is already a member of this company.' };
  if (sp.error === 'ALREADY_INVITED') return { tone: 'error', text: 'That email already has a pending invitation.' };
  if (sp.error === 'LAST_OWNER') return { tone: 'error', text: 'Not allowed: nobody else would be able to administer the company. Add another owner first.' };
  if (sp.error === 'invalid-invite') return { tone: 'error', text: 'Enter a valid email address and choose a role.' };
  if (sp.error === 'invalid-role') return { tone: 'error', text: 'Choose a role.' };
  if (sp.error === 'denied') return { tone: 'error', text: 'You do not have permission for that.' };
  return { tone: 'error', text: 'That action could not be completed.' };
}
