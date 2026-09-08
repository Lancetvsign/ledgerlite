'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { isUuid } from '@/lib/uuid';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { BillPaymentError, payBill, voidBillPayment } from '@/server/bill-payments';
import { LedgerError } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { payBillInput, voidBillPaymentInput } from '@/validation/bill-payment';

/**
 * Bill-payment UI actions — LL-065, the A/P mirror of the payment actions.
 * Everything the browser sends is untrusted. The company comes from the
 * server-authorized session context (never a form field), and the LL-062 service
 * re-authorizes (`bill_payment.create` / `bill_payment.void`) and re-validates every
 * application (open bill, right vendor, ≤ open balance) + re-derives the amount,
 * regardless of what the client rendered.
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

/** Zip the parallel per-bill arrays; keep only rows the user actually paid. */
function applicationsFrom(formData: FormData): { billId: string; amountApplied: string }[] {
  const ids = formData.getAll('applyBillId');
  const amounts = formData.getAll('applyAmount');
  return ids
    .map((id, i) => ({
      billId: typeof id === 'string' ? id : '',
      amountApplied: str(amounts[i]),
    }))
    // A blank or zero amount means "don't apply to this bill" — a positive amount
    // (has a non-zero digit) is an application the server then validates.
    .filter((a) => /[1-9]/.test(a.amountApplied));
}

export async function payBillAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = payBillInput.safeParse({
    vendorId: idOf(formData, 'vendorId'),
    paymentDate: formData.get('paymentDate'),
    cashAccountId: idOf(formData, 'cashAccountId'),
    method: opt(formData.get('method')),
    reference: opt(formData.get('reference')),
    memo: opt(formData.get('memo')),
    idempotencyKey: opt(formData.get('idempotencyKey')),
    applications: applicationsFrom(formData),
  });
  if (!parsed.success) redirect('/bill-payments/new?error=invalid');

  let id: string;
  try {
    const { payment } = await payBill(userId, companyId, parsed.data);
    id = payment.id;
  } catch (error) {
    redirect(`/bill-payments/new?error=${codeOf(error)}`);
  }
  redirect(`/bill-payments/${id}`);
}

export async function voidBillPaymentAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const paymentId = idOf(formData, 'paymentId');
  if (!isUuid(paymentId)) redirect('/bill-payments?error=notfound'); // malformed id → not-found, not a 500
  const parsedReason = voidBillPaymentInput.safeParse({ reason: opt(formData.get('reason')) });
  const reason = parsedReason.success ? parsedReason.data : voidBillPaymentInput.parse({});
  try {
    await voidBillPayment(userId, companyId, paymentId, reason);
  } catch (error) {
    redirect(`/bill-payments/${paymentId}?error=${codeOf(error)}`);
  }
  redirect(`/bill-payments/${paymentId}?voided=1`);
}

/** Map a service error to a redirect code; rethrow anything unrecognized. */
function codeOf(error: unknown): string {
  if (error instanceof AuthorizationDenied) return 'denied';
  if (error instanceof BillPaymentError) return error.code;
  if (error instanceof LedgerError) return error.code;
  throw error;
}
