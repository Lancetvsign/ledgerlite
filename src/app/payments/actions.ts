'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { LedgerError } from '@/server/ledger';
import { PaymentError, receivePayment, voidPayment } from '@/server/payments';
import { ensureAppUser } from '@/server/users';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';

/**
 * Payment UI actions — LL-045. Everything the browser sends is untrusted. The
 * company comes from the server-authorized session context (never a form field),
 * and the LL-043 service re-authorizes (`payment.create`) and re-validates every
 * application (open invoice, right customer, ≤ open balance) + re-derives the
 * amount, regardless of what the client rendered.
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
function str(v: FormDataEntryValue | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}
function idOf(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === 'string' ? v : '';
}

/** Zip the parallel per-invoice arrays; keep only rows the user actually paid. */
function applicationsFrom(formData: FormData): { invoiceId: string; amountApplied: string }[] {
  const ids = formData.getAll('applyInvoiceId');
  const amounts = formData.getAll('applyAmount');
  return ids
    .map((id, i) => ({
      invoiceId: typeof id === 'string' ? id : '',
      amountApplied: str(amounts[i]),
    }))
    // A blank or zero amount means "don't apply to this invoice" — a positive
    // amount (has a non-zero digit) is an application the server then validates.
    .filter((a) => /[1-9]/.test(a.amountApplied));
}

export async function receivePaymentAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = receivePaymentInput.safeParse({
    customerId: idOf(formData, 'customerId'),
    paymentDate: formData.get('paymentDate'),
    depositAccountId: idOf(formData, 'depositAccountId'),
    method: opt(formData.get('method')),
    reference: opt(formData.get('reference')),
    memo: opt(formData.get('memo')),
    applications: applicationsFrom(formData),
  });
  if (!parsed.success) redirect('/payments/new?error=invalid');

  let id: string;
  try {
    const { payment } = await receivePayment(userId, companyId, parsed.data);
    id = payment.id;
  } catch (error) {
    redirect(`/payments/new?error=${codeOf(error)}`);
  }
  redirect(`/payments/${id}`);
}

export async function voidPaymentAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const paymentId = idOf(formData, 'paymentId');
  const parsedReason = voidPaymentInput.safeParse({ reason: opt(formData.get('reason')) });
  const reason = parsedReason.success ? parsedReason.data : voidPaymentInput.parse({});
  try {
    await voidPayment(userId, companyId, paymentId, reason);
  } catch (error) {
    redirect(`/payments/${paymentId}?error=${codeOf(error)}`);
  }
  redirect(`/payments/${paymentId}?voided=1`);
}

/** Map a service error to a redirect code; rethrow anything unrecognized. */
function codeOf(error: unknown): string {
  if (error instanceof AuthorizationDenied) return 'denied';
  if (error instanceof PaymentError) return error.code;
  if (error instanceof LedgerError) return error.code;
  throw error;
}
