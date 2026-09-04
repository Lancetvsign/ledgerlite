'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import {
  InvoiceError,
  createInvoice,
  finalizeInvoice,
  updateInvoice,
  voidInvoice,
} from '@/server/invoices';
import { LedgerError } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createInvoiceInput, voidInvoiceInput } from '@/validation/invoice';

/**
 * Invoice UI actions — LL-044. Everything the browser sends is untrusted. The
 * company comes from the server-authorized session context (never a form field),
 * and the LL-041/042 services re-authorize (`invoice.create` / `invoice.post`) and
 * re-derive totals + the posting regardless of what the client rendered. A client
 * that strips a disabled attribute and submits garbage lands here and is refused.
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

/** Zip the parallel per-line arrays into the shape createInvoiceInput expects. */
function invoiceInputFrom(formData: FormData): unknown {
  const accountIds = formData.getAll('accountId');
  const descriptions = formData.getAll('lineDescription');
  const quantities = formData.getAll('quantity');
  const unitPrices = formData.getAll('unitPrice');
  const taxRates = formData.getAll('taxRate');

  const lines = accountIds
    .map((accountId, i) => ({
      accountId: typeof accountId === 'string' ? accountId : '',
      description: str(descriptions[i]),
      quantity: str(quantities[i]),
      unitPrice: str(unitPrices[i]),
      taxRate: str(taxRates[i]),
    }))
    // Drop a wholly-blank row; keep a row with an account OR a price so the server
    // rejects a half-filled line with a real message instead of swallowing it.
    .filter((l) => !(l.accountId === '' && l.unitPrice === ''))
    .map((l) => ({
      accountId: l.accountId,
      description: l.description === '' ? undefined : l.description,
      // Defaults mirror the Zod schema ('1' qty, '0' tax); the server re-validates.
      quantity: l.quantity === '' ? '1' : l.quantity,
      unitPrice: l.unitPrice,
      taxRate: l.taxRate === '' ? '0' : l.taxRate,
    }));

  // The company is NEVER a form field — it comes from requireContext server-side.
  return {
    customerId: idOf(formData, 'customerId'),
    invoiceDate: formData.get('invoiceDate'),
    dueDate: opt(formData.get('dueDate')),
    memo: opt(formData.get('memo')),
    lines,
  };
}

export async function createInvoiceAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = createInvoiceInput.safeParse(invoiceInputFrom(formData));
  if (!parsed.success) redirect('/invoices/new?error=invalid');

  let id: string;
  try {
    const { invoice } = await createInvoice(userId, companyId, parsed.data);
    id = invoice.id;
  } catch (error) {
    redirect(`/invoices/new?error=${codeOf(error)}`);
  }
  redirect(`/invoices/${id}`);
}

export async function updateInvoiceAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const invoiceId = idOf(formData, 'invoiceId');
  const parsed = createInvoiceInput.safeParse(invoiceInputFrom(formData));
  if (!parsed.success) redirect(`/invoices/${invoiceId}/edit?error=invalid`);

  try {
    await updateInvoice(userId, companyId, invoiceId, parsed.data);
  } catch (error) {
    redirect(`/invoices/${invoiceId}/edit?error=${codeOf(error)}`);
  }
  redirect(`/invoices/${invoiceId}`);
}

export async function finalizeInvoiceAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const invoiceId = idOf(formData, 'invoiceId');
  try {
    await finalizeInvoice(userId, companyId, invoiceId);
  } catch (error) {
    redirect(`/invoices/${invoiceId}?error=${codeOf(error)}`);
  }
  redirect(`/invoices/${invoiceId}?finalized=1`);
}

export async function voidInvoiceAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const invoiceId = idOf(formData, 'invoiceId');
  const parsedReason = voidInvoiceInput.safeParse({ reason: opt(formData.get('reason')) });
  const reason = parsedReason.success ? parsedReason.data : voidInvoiceInput.parse({});
  try {
    await voidInvoice(userId, companyId, invoiceId, reason);
  } catch (error) {
    redirect(`/invoices/${invoiceId}?error=${codeOf(error)}`);
  }
  redirect(`/invoices/${invoiceId}?voided=1`);
}

/** Map a service error to a redirect code; rethrow anything unrecognized. */
function codeOf(error: unknown): string {
  if (error instanceof AuthorizationDenied) return 'denied';
  if (error instanceof InvoiceError) return error.code;
  if (error instanceof LedgerError) return error.code;
  throw error;
}
