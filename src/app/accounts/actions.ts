'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AccountError, createAccount, deactivateAccount, updateAccount } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { ensureAppUser } from '@/server/users';
import { createAccountInput, updateAccountInput } from '@/validation/account';

/**
 * Resolve (userId, active companyId) from the session, or redirect. Every action
 * re-derives this server-side — the browser never says which company it is.
 */
async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account'); // no company selected → switcher
  return { userId: user.id, companyId: membership.companyId };
}

function backTo(params: string): never {
  redirect(`/accounts${params}`);
}

export async function createAccountAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = createAccountInput.safeParse({
    name: formData.get('name'),
    accountType: formData.get('accountType'),
    accountNumber: emptyToUndefined(formData.get('accountNumber')),
    accountSubtype: emptyToUndefined(formData.get('accountSubtype')),
    description: emptyToUndefined(formData.get('description')),
  });
  if (!parsed.success) backTo('?error=invalid');

  try {
    // The server authorizes (account.manage) — a READ_ONLY user reaching this
    // action by any means is refused here regardless of what the page rendered.
    await createAccount(userId, companyId, parsed.data);
  } catch (error) {
    return handle(error);
  }
  backTo('?created=1');
}

export async function updateAccountAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const rawId = formData.get('accountId');
  const accountId = typeof rawId === 'string' ? rawId : '';
  const parsed = updateAccountInput.safeParse({
    name: emptyToUndefined(formData.get('name')),
    accountSubtype: emptyToUndefined(formData.get('accountSubtype')),
    description: emptyToUndefined(formData.get('description')),
  });
  if (!parsed.success) backTo('?error=invalid');

  try {
    await updateAccount(userId, companyId, accountId, parsed.data);
  } catch (error) {
    return handle(error);
  }
  backTo('?updated=1');
}

export async function deactivateAccountAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const rawId = formData.get('accountId');
  const accountId = typeof rawId === 'string' ? rawId : '';
  try {
    await deactivateAccount(userId, companyId, accountId);
  } catch (error) {
    return handle(error);
  }
  backTo('?deactivated=1');
}

function handle(error: unknown): never {
  // Authorization denials and domain errors both become a generic banner — the
  // page never distinguishes "not permitted" from "no such account", matching
  // the not-found-for-forbidden rule.
  if (error instanceof AuthorizationDenied) backTo('?error=denied');
  if (error instanceof AccountError) backTo(`?error=${error.code}`);
  throw error;
}

function emptyToUndefined(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
}
