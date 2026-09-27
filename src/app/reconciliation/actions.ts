'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { isUuid } from '@/lib/uuid';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import {
  clearImportedLines,
  completeReconciliation,
  ReconciliationError,
  setCleared,
  startReconciliation,
  updateReconciliation,
} from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';
import { setClearedInput, startReconciliationInput, updateReconciliationInput } from '@/validation/reconciliation';

import { changedUpdateFields } from './update-fields';

/**
 * Bank-reconciliation actions — LL-078. The company comes from the server-authorized session
 * (never a form field); every service call re-authorizes (`reconciliation.complete`) and
 * re-validates, so the UI's gating is a convenience, not the enforcement point.
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

function failTo(path: string, error: unknown): never {
  if (error instanceof AuthorizationDenied) redirect(`${path}?error=denied`);
  if (error instanceof ReconciliationError) redirect(`${path}?error=${error.code}`);
  throw error;
}

export async function startReconciliationAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const parsed = startReconciliationInput.safeParse({
    bankAccountId: formData.get('bankAccountId'),
    statementDate: formData.get('statementDate'),
    statementEndingAmount: opt(formData.get('statementEndingAmount')),
  });
  // LL-111: started from an imported statement — its posted lines are ticked right after the start.
  const fromImport = opt(formData.get('fromImport'));
  const back = fromImport !== undefined && isUuid(fromImport) ? `/reconciliation?fromImport=${fromImport}&error=` : '/reconciliation?error=';
  if (!parsed.success) redirect(`${back}invalid`);

  let id: string;
  try {
    id = (await startReconciliation(userId, companyId, parsed.data)).id;
  } catch (error) {
    if (error instanceof ReconciliationError) redirect(`${back}${error.code}`);
    failTo('/reconciliation', error);
  }
  if (fromImport === undefined || !isUuid(fromImport)) redirect(`/reconciliation/${id}`);
  let result: { cleared: number; skipped: number } = { cleared: 0, skipped: 0 };
  try {
    result = await clearImportedLines(userId, companyId, id, fromImport);
  } catch (error) {
    // The reconciliation exists; a pre-tick failure (another account's statement) is reported there.
    failTo(`/reconciliation/${id}`, error);
  }
  redirect(`/reconciliation/${id}?ok=prefilled&cleared=${String(result.cleared)}&skipped=${String(result.skipped)}`);
}

/** LL-111: tick an imported statement's posted lines in a reconciliation already in progress. */
export async function addImportedLinesAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const id = opt(formData.get('reconciliationId')) ?? '';
  const batchId = opt(formData.get('batchId')) ?? '';
  if (!isUuid(id)) redirect('/reconciliation?error=NOT_FOUND');
  if (!isUuid(batchId)) redirect(`/reconciliation/${id}?error=IMPORT_NOT_FOR_ACCOUNT`);
  let result: { cleared: number; skipped: number } = { cleared: 0, skipped: 0 };
  try {
    result = await clearImportedLines(userId, companyId, id, batchId);
  } catch (error) {
    failTo(`/reconciliation/${id}`, error);
  }
  redirect(`/reconciliation/${id}?ok=prefilled&cleared=${String(result.cleared)}&skipped=${String(result.skipped)}`);
}

export async function updateReconciliationAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const id = opt(formData.get('reconciliationId')) ?? '';
  if (!isUuid(id)) redirect('/reconciliation?error=NOT_FOUND');
  // Only fields the reviewer changed are sent, so an untouched two-decimal display
  // never rewrites the stored four-decimal figure (LL-093).
  const changed = changedUpdateFields({
    statementDate: opt(formData.get('statementDate')),
    statementEndingAmount: opt(formData.get('statementEndingAmount')),
    shownDate: opt(formData.get('shownStatementDate')),
    shownAmount: opt(formData.get('shownStatementEndingAmount')),
  });
  if (changed.statementDate === undefined && changed.statementEndingAmount === undefined) {
    redirect(`/reconciliation/${id}?ok=updated`); // nothing changed — nothing to write
  }
  const parsed = updateReconciliationInput.safeParse(changed);
  if (!parsed.success) redirect(`/reconciliation/${id}?error=invalid`);
  try {
    await updateReconciliation(userId, companyId, id, parsed.data);
  } catch (error) {
    failTo(`/reconciliation/${id}`, error);
  }
  redirect(`/reconciliation/${id}?ok=updated`);
}

export async function setClearedAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const id = opt(formData.get('reconciliationId')) ?? '';
  if (!isUuid(id)) redirect('/reconciliation?error=NOT_FOUND');
  // Unticked boxes are simply absent; the service replaces the whole set with what is ticked.
  const parsed = setClearedInput.safeParse({
    journalLineIds: formData.getAll('journalLineId').filter((v): v is string => typeof v === 'string'),
  });
  if (!parsed.success) redirect(`/reconciliation/${id}?error=invalid`);
  let cleared: number;
  try {
    cleared = (await setCleared(userId, companyId, id, parsed.data)).cleared;
  } catch (error) {
    failTo(`/reconciliation/${id}`, error);
  }
  redirect(`/reconciliation/${id}?ok=saved&cleared=${String(cleared)}`);
}

export async function completeReconciliationAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const id = opt(formData.get('reconciliationId')) ?? '';
  if (!isUuid(id)) redirect('/reconciliation?error=NOT_FOUND');
  try {
    await completeReconciliation(userId, companyId, id);
  } catch (error) {
    failTo(`/reconciliation/${id}`, error);
  }
  redirect(`/reconciliation/${id}?ok=completed`);
}
