'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { LedgerError } from '@/server/ledger';
import { OpeningBalanceError, setOpeningBalances, voidOpeningBalances } from '@/server/opening-balances';
import { ensureAppUser } from '@/server/users';
import { setOpeningBalancesInput, voidOpeningBalancesInput } from '@/validation/opening-balance';

/**
 * Opening-balances actions — LL-071.
 *
 * Everything the browser sends is untrusted. The company comes from the server-authorized
 * session context, never a form field, and the service re-authorizes (`journal.post`),
 * re-validates the period and accounts, rejects A/R/A/P/OBE lines, and enforces set-once —
 * regardless of what the client computed or disabled.
 */

async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

/** '' → '0'; anything else passes through untouched for Zod to judge. */
function amount(v: FormDataEntryValue | undefined): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? '0' : s;
}

function isZeroish(s: string): boolean {
  return s === '' || /^-?0*(\.0*)?$/.test(s.trim());
}

function opt(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
}

export async function setOpeningBalancesAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();

  // Zip the parallel per-line arrays. A line the user never filled in (no account and no
  // amounts) is dropped; a line with an account but a bad amount is KEPT so the server
  // rejects it with a real message rather than silently swallowing it.
  const accountIds = formData.getAll('accountId');
  const debits = formData.getAll('debit');
  const credits = formData.getAll('credit');

  const lines = accountIds
    .map((accountId, i) => ({
      accountId: typeof accountId === 'string' ? accountId : '',
      debit: amount(debits[i]),
      credit: amount(credits[i]),
    }))
    .filter((l) => !(l.accountId === '' && isZeroish(l.debit) && isZeroish(l.credit)));

  const parsed = setOpeningBalancesInput.safeParse({
    companyId,
    actorUserId: userId,
    conversionDate: formData.get('conversionDate'),
    idempotencyKey: opt(formData.get('idempotencyKey')),
    lines,
  });
  if (!parsed.success) redirect('/opening-balances?error=invalid');

  try {
    await setOpeningBalances(userId, companyId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect('/opening-balances?error=denied');
    if (error instanceof OpeningBalanceError) redirect(`/opening-balances?error=${error.code}`);
    if (error instanceof LedgerError) redirect(`/opening-balances?error=${error.code}`);
    throw error;
  }
  redirect('/opening-balances?ok=set');
}

export async function voidOpeningBalancesAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();

  const parsed = voidOpeningBalancesInput.safeParse({
    reversalDate: opt(formData.get('reversalDate')),
    reason: opt(formData.get('reason')),
  });
  if (!parsed.success) redirect('/opening-balances?error=invalid');

  try {
    await voidOpeningBalances(userId, companyId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect('/opening-balances?error=denied');
    if (error instanceof OpeningBalanceError) redirect(`/opening-balances?error=${error.code}`);
    if (error instanceof LedgerError) redirect(`/opening-balances?error=${error.code}`);
    throw error;
  }
  redirect('/opening-balances?ok=voided');
}
