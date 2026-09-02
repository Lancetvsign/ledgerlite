'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { closePeriod, reopenPeriod } from '@/server/periods';
import { ensureAppUser } from '@/server/users';

async function actorAndCompany(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const active = await getActiveCompanyMembership(user.id);
  if (active === null) redirect('/account');
  return { userId: user.id, companyId: active.companyId };
}

function periodId(formData: FormData): string {
  const raw = formData.get('periodId');
  return typeof raw === 'string' ? raw : '';
}

export async function closePeriodAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await actorAndCompany();
  try {
    await closePeriod(userId, companyId, periodId(formData));
  } catch (error) {
    if (!(error instanceof AuthorizationDenied)) throw error;
  }
  redirect('/periods');
}

export async function reopenPeriodAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await actorAndCompany();
  try {
    await reopenPeriod(userId, companyId, periodId(formData));
  } catch (error) {
    if (!(error instanceof AuthorizationDenied)) throw error;
  }
  redirect('/periods');
}
