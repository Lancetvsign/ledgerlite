'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { clearActiveCompanyIf, getActiveCompanyMembership } from '@/server/authorization/company-context';
import { resolveBaseUrl } from '@/lib/auth/origins';
import {
  changeMemberRole,
  claimInvitation,
  describeInvitation,
  inviteMember,
  issueInvitationLink,
  MemberError,
  removeMember,
  revokeInvitation,
} from '@/server/members';
import { JOIN_COOKIE, JOIN_COOKIE_TTL_SECONDS } from '@/server/members/token';
import { setActiveCompany } from '@/server/authorization/company-context';
import { cookies } from 'next/headers';
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

export interface IssueLinkState {
  readonly url?: string;
  readonly expiresAt?: string;
  readonly error?: string;
}

/**
 * Issues a fresh join link for a pending invitation (LL-090). Returns the URL to the
 * client (useActionState) instead of redirecting: the secret must never ride in a
 * redirect URL. The origin is environment configuration, never the Host header.
 */
export async function issueInvitationLinkAction(_prev: IssueLinkState, formData: FormData): Promise<IssueLinkState> {
  const { userId, companyId } = await requireContext();
  const parsed = z.uuid().safeParse(str(formData, 'invitationId'));
  if (!parsed.success) return { error: 'That invitation could not be found.' };
  try {
    const { token, expiresAt } = await issueInvitationLink(userId, companyId, parsed.data);
    return { url: `${resolveBaseUrl(process.env)}/join/${token}`, expiresAt: expiresAt.toISOString().slice(0, 10) };
  } catch (error) {
    if (error instanceof AuthorizationDenied) return { error: 'That invitation could not be found.' };
    throw error;
  }
}

/**
 * Step one of joining without an account (LL-090): after validating the link, set the
 * short-lived join cookie that lets the sign-up endpoint admit this browser. Grants
 * nothing; the membership arrives when the signed-in user claims the link.
 */
export async function prepareJoinAction(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const described = await describeInvitation(token);
  if (described === null) return { ok: false, error: 'This invitation link is not valid or has expired.' };
  const jar = await cookies();
  jar.set(JOIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: JOIN_COOKIE_TTL_SECONDS,
  });
  return { ok: true };
}

/** Step two: the signed-in user claims the link; the join cookie is cleared either way. */
export async function claimInvitationAction(formData: FormData): Promise<void> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const token = str(formData, 'token');
  if (session === null) redirect(`/join/${encodeURIComponent(token)}`);
  const user = await ensureAppUser(session.user);
  const jar = await cookies();
  jar.delete(JOIN_COOKIE);
  let companyId: string;
  let alreadyMember: boolean;
  try {
    ({ companyId, alreadyMember } = await claimInvitation(user.id, token));
  } catch (error) {
    if (error instanceof MemberError) redirect(`/join/${encodeURIComponent(token)}?error=${error.code}`);
    throw error;
  }
  await setActiveCompany(user.id, companyId);
  redirect(`/account?ok=${alreadyMember ? 'already-member' : 'joined'}`);
}
