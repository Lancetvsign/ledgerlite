'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { clearActiveCompanyIf, getActiveCompanyMembership } from '@/server/authorization/company-context';
import { changeMemberRole, inviteMember, MemberError, removeMember, revokeInvitation } from '@/server/members';
import { ensureAppUser } from '@/server/users';
import { changeMemberRoleInput, inviteMemberInput } from '@/validation/member';

/**
 * Team actions — LL-086. Session first; the company comes from the SERVER
 * context (the active-company cookie, re-proven on read), never from the form.
 * Every service re-authorizes and applies the role ceiling; these only translate
 * outcomes into redirects with notice codes.
 */
async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

function str(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw : '';
}

function failWith(error: unknown): never {
  if (error instanceof MemberError) redirect(`/members?error=${error.code}`);
  if (error instanceof AuthorizationDenied) redirect('/members?error=denied');
  throw error;
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = inviteMemberInput.safeParse({ email: str(formData, 'email'), role: str(formData, 'role') });
  if (!parsed.success) redirect('/members?error=invalid-invite');
  let mode: 'added' | 'invited';
  try {
    ({ mode } = await inviteMember(userId, companyId, parsed.data));
  } catch (error) {
    failWith(error);
  }
  redirect(`/members?ok=member-${mode}`);
}

export async function changeMemberRoleAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = changeMemberRoleInput.safeParse({ membershipId: str(formData, 'membershipId'), role: str(formData, 'role') });
  if (!parsed.success) redirect('/members?error=invalid-role');
  try {
    await changeMemberRole(userId, companyId, parsed.data.membershipId, parsed.data.role);
  } catch (error) {
    failWith(error);
  }
  redirect('/members?ok=role-changed');
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = z.uuid().safeParse(str(formData, 'membershipId'));
  if (!parsed.success) redirect('/members?error=denied');
  let removedUserId: string;
  try {
    ({ userId: removedUserId } = await removeMember(userId, companyId, parsed.data));
  } catch (error) {
    failWith(error);
  }
  if (removedUserId === userId) {
    // Leaving the company: the pointer would yield no company anyway; clear it and go pick one.
    await clearActiveCompanyIf(companyId);
    redirect('/account?ok=you-left');
  }
  redirect('/members?ok=member-removed');
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = z.uuid().safeParse(str(formData, 'invitationId'));
  if (!parsed.success) redirect('/members?error=denied');
  try {
    await revokeInvitation(userId, companyId, parsed.data);
  } catch (error) {
    failWith(error);
  }
  redirect('/members?ok=invitation-revoked');
}
