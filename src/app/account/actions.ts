'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { setActiveCompany } from '@/server/authorization/company-context';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

/** Session first, always; these run with whatever the browser sent. */
async function requireAppUserId(): Promise<string> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  return user.id;
}

export async function switchCompanyAction(formData: FormData): Promise<void> {
  const userId = await requireAppUserId();
  const raw = formData.get('companyId');
  const companyId = typeof raw === 'string' ? raw : ''; // a File here is garbage in, denial out
  try {
    // Membership is proven inside; a forged id denies — it never falls back.
    await setActiveCompany(userId, companyId);
  } catch (error) {
    if (!(error instanceof AuthorizationDenied)) throw error;
  }
  redirect('/account');
}

export async function createCompanyAction(formData: FormData): Promise<void> {
  const userId = await requireAppUserId();
  const parsed = createCompanyInput.safeParse({
    legalName: formData.get('legalName'),
    timezone: formData.get('timezone') || 'America/Chicago',
  });
  if (!parsed.success) redirect('/account?error=invalid-company');

  // Chart choice from the form; defaults to the standard small-business chart.
  const chartRaw = formData.get('chart');
  const chart = chartRaw === 'system-only' ? 'system-only' : 'standard';
  const { company } = await createCompanyWithOwner(userId, parsed.data, chart);
  await setActiveCompany(userId, company.id);
  redirect('/account');
}
