'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { isUuid } from '@/lib/uuid';
import { AccountError } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { assignSharedLines, BankImportError, PeriodClosedInCompanyError, unassignSharedLine } from '@/server/bank-import';
import { LedgerError } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { assignSharedLinesInput } from '@/validation/bank-import';

/**
 * Shared-statement actions — LL-097. The VIEWING company comes from the session context; the
 * cardholder company is whatever owns the batch. The service re-proves `journal.post` in both.
 */
async function requireContext(): Promise<{ userId: string; companyId: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  return { userId: user.id, companyId: membership.companyId };
}

function str(v: FormDataEntryValue | null | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function redirectOnFailure(batchId: string, error: unknown): never {
  if (error instanceof AuthorizationDenied) redirect(`/bank-import/shared/${batchId}?error=denied`);
  if (error instanceof BankImportError || error instanceof LedgerError || error instanceof AccountError) {
    // A closed period is reported by company ID; the page resolves the name itself (Gate 7 L1).
    const closedIn = error instanceof PeriodClosedInCompanyError ? `&closedIn=${error.companyId}` : '';
    redirect(`/bank-import/shared/${batchId}?error=${error.code}${closedIn}`);
  }
  throw error;
}

/** Takes the ticked lines into the viewing company. */
export async function assignSharedLinesAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const batchId = str(formData.get('batchId'));
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');

  // Parallel per-row arrays zipped by index; the page emits lineId, take and accountId for
  // EVERY untaken row (the checkbox as a hidden 0/1 pair so the arrays stay aligned).
  const lineIds = formData.getAll('lineId');
  const takes = formData.getAll('take');
  const accountIds = formData.getAll('accountId');
  const decisions = lineIds.flatMap((lineId, i) =>
    str(takes[i]) === '1' ? [{ lineId: str(lineId), accountId: str(accountIds[i]) }] : [],
  );
  if (decisions.length === 0) redirect(`/bank-import/shared/${batchId}?error=nothing`);
  const parsed = assignSharedLinesInput.safeParse({ decisions });
  if (!parsed.success) redirect(`/bank-import/shared/${batchId}?error=ACCOUNT_REQUIRED`);

  let assigned = 0;
  try {
    ({ assigned } = await assignSharedLines(userId, companyId, batchId, parsed.data));
  } catch (error) {
    redirectOnFailure(batchId, error);
  }
  redirect(`/bank-import/shared/${batchId}?ok=assigned&assigned=${String(assigned)}`);
}

/** Gives one taken line back to the cardholder company. */
export async function unassignSharedLineAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const batchId = str(formData.get('batchId'));
  const lineId = str(formData.get('lineId'));
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  if (!isUuid(lineId)) redirect(`/bank-import/shared/${batchId}?error=LINE_NOT_FOUND`);
  try {
    await unassignSharedLine(userId, companyId, batchId, lineId);
  } catch (error) {
    redirectOnFailure(batchId, error);
  }
  redirect(`/bank-import/shared/${batchId}?ok=unassigned`);
}
