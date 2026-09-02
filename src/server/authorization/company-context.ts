import 'server-only';

import { cookies } from 'next/headers';

import { AuthorizationDenied, requireCompanyMembership } from './index';

import type { CompanyMembership } from '@/db/schema';

/**
 * The active-company context.
 *
 * The cookie is a CONVENIENCE POINTER, not an authorization artifact: it names
 * which of the user's companies the UI is looking at, and it is attacker-
 * writable like any cookie. So every read revalidates membership from the
 * database, and a cookie that fails validation yields NULL —
 *
 * NEVER a fallback to some other company the user does belong to. Silent
 * fallback is the worst outcome this ticket names: a tenant quietly shown
 * another tenant's data. No company context means the caller shows a picker.
 */
export const ACTIVE_COMPANY_COOKIE = 'ledgerlite_company';

export async function getActiveCompanyMembership(
  userId: string,
): Promise<CompanyMembership | null> {
  const jar = await cookies();
  const claimed = jar.get(ACTIVE_COMPANY_COOKIE)?.value;
  if (claimed === undefined || claimed === '') return null;

  try {
    return await requireCompanyMembership(userId, claimed);
  } catch (error) {
    if (error instanceof AuthorizationDenied) return null;
    throw error;
  }
}

/**
 * Points the context at a company — AFTER proving membership. The cookie is
 * only ever written for a company the user was just verified to belong to,
 * and reads re-verify anyway.
 */
export async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await requireCompanyMembership(userId, companyId);
  const jar = await cookies();
  jar.set(ACTIVE_COMPANY_COOKIE, companyId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
