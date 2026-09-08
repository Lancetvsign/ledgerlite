'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { BillError, createBill, finalizeBill, voidBill } from '@/server/bills';
import { LedgerError } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createBillInput, voidBillInput } from '@/validation/bill';

/**
 * Bill UI actions — LL-065, the A/P mirror of the invoice actions. Everything the
 * browser sends is untrusted. The company comes from the server-authorized session
 * context (never a form field), and the LL-061 service re-authorizes
 * (`expense.create` / `bill.void`) and re-derives the total + the posting regardless
 * of what the client rendered.
 */
async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

/** '' → undefined; else the trimmed string, for Zod to judge. */
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

/** Zip the parallel per-line arrays into the shape createBillInput expects. */
function billInputFrom(formData: FormData): unknown {
  const accountIds = formData.getAll('accountId');
  const descriptions = formData.getAll('lineDescription');
  const quantities = formData.getAll('quantity');
  const unitPrices = formData.getAll('unitPrice');

  const lines = accountIds
    .map((accountId, i) => ({
      accountId: typeof accountId === 'string' ? accountId : '',
      description: str(descriptions[i]),
      quantity: str(quantities[i]),
      unitPrice: str(unitPrices[i]),
    }))
    // Drop a wholly-blank row; keep a row with an account OR a price so the server
    // rejects a half-filled line with a real message instead of swallowing it.
    .filter((l) => !(l.accountId === '' && l.unitPrice === ''))
    .map((l) => ({
      accountId: l.accountId,
      description: l.description === '' ? undefined : l.description,
      // Default mirrors the Zod schema ('1' qty); the server re-validates.
      quantity: l.quantity === '' ? '1' : l.quantity,
      unitPrice: l.unitPrice,
    }));

  // The company is NEVER a form field — it comes from requireContext server-side.
  return {
    vendorId: idOf(formData, 'vendorId'),
    billDate: formData.get('billDate'),
    dueDate: opt(formData.get('dueDate')),
    memo: opt(formData.get('memo')),
    lines,
  };
}

export async function createBillAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = createBillInput.safeParse(billInputFrom(formData));
  if (!parsed.success) redirect('/bills/new?error=invalid');

  let id: string;
  try {
    const { bill } = await createBill(userId, companyId, parsed.data);
    id = bill.id;
  } catch (error) {
    redirect(`/bills/new?error=${codeOf(error)}`);
  }
  redirect(`/bills/${id}`);
}

export async function finalizeBillAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const billId = idOf(formData, 'billId');
  try {
    await finalizeBill(userId, companyId, billId);
  } catch (error) {
    redirect(`/bills/${billId}?error=${codeOf(error)}`);
  }
  redirect(`/bills/${billId}?finalized=1`);
}

export async function voidBillAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const billId = idOf(formData, 'billId');
  const parsedReason = voidBillInput.safeParse({ reason: opt(formData.get('reason')) });
  const reason = parsedReason.success ? parsedReason.data : voidBillInput.parse({});
  try {
    await voidBill(userId, companyId, billId, reason);
  } catch (error) {
    redirect(`/bills/${billId}?error=${codeOf(error)}`);
  }
  redirect(`/bills/${billId}?voided=1`);
}

/** Map a service error to a redirect code; rethrow anything unrecognized. */
function codeOf(error: unknown): string {
  if (error instanceof AuthorizationDenied) return 'denied';
  if (error instanceof BillError) return error.code;
  if (error instanceof LedgerError) return error.code;
  throw error;
}
