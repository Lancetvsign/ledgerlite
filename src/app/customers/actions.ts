'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { CustomerError, createCustomer } from '@/server/customers';
import { ensureAppUser } from '@/server/users';
import { createCustomerInput } from '@/validation/customer';

/**
 * Customer UI actions — LL-044. Everything the browser sends is untrusted; the
 * company comes from the server-authorized session context (never a form field),
 * and `createCustomer` re-authorizes (`customer.manage`) regardless of what the
 * page rendered. A READ_ONLY user reaching this action is refused here.
 */
async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

function backTo(params: string): never {
  redirect(`/customers${params}`);
}

export async function createCustomerAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = createCustomerInput.safeParse({
    name: formData.get('name'),
    email: emptyToUndefined(formData.get('email')),
    phone: emptyToUndefined(formData.get('phone')),
    customerNumber: emptyToUndefined(formData.get('customerNumber')),
    billingAddress: emptyToUndefined(formData.get('billingAddress')),
  });
  if (!parsed.success) backTo('?error=invalid');

  try {
    await createCustomer(userId, companyId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) backTo('?error=denied');
    if (error instanceof CustomerError) backTo(`?error=${error.code}`);
    throw error;
  }
  backTo('?created=1');
}

function emptyToUndefined(v: FormDataEntryValue | null): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
}
