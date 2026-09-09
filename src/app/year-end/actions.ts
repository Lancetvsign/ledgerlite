'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { LedgerError } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { closeFiscalYear, reopenFiscalYear, YearEndError } from '@/server/year-end';
import { closeFiscalYearInput, reopenFiscalYearInput } from '@/validation/year-end';

/**
 * Year-end closing actions — LL-073. The company comes from the server-authorized session
 * context (never a form field); the service re-authorizes (`period.close`), recomputes the
 * closing lines, and enforces set-once regardless of what the client sent.
 */

async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

function opt(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
}

export async function closeFiscalYearAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = closeFiscalYearInput.safeParse({
    fiscalYearStart: formData.get('fiscalYearStart'),
    idempotencyKey: opt(formData.get('idempotencyKey')),
  });
  if (!parsed.success) redirect('/year-end?error=invalid');

  try {
    await closeFiscalYear(userId, companyId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect('/year-end?error=denied');
    if (error instanceof YearEndError) redirect(`/year-end?error=${error.code}`);
    if (error instanceof LedgerError) redirect(`/year-end?error=${error.code}`);
    throw error;
  }
  redirect('/year-end?ok=closed');
}

export async function reopenFiscalYearAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = reopenFiscalYearInput.safeParse({
    fiscalYearStart: formData.get('fiscalYearStart'),
    reason: opt(formData.get('reason')),
  });
  if (!parsed.success) redirect('/year-end?error=invalid');

  try {
    await reopenFiscalYear(userId, companyId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect('/year-end?error=denied');
    if (error instanceof YearEndError) redirect(`/year-end?error=${error.code}`);
    if (error instanceof LedgerError) redirect(`/year-end?error=${error.code}`);
    throw error;
  }
  redirect('/year-end?ok=reopened');
}
