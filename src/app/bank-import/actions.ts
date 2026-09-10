'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { BankImportError, postImportLines, stageImport } from '@/server/bank-import';
import { LedgerError } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { postImportLinesInput, stageImportInput } from '@/validation/bank-import';

/**
 * Bank-import actions — LL-076. The company comes from the server-authorized session context
 * (never a form field); the service re-authorizes (`journal.post`), validates every extracted
 * row, excludes control accounts, and enforces post-once regardless of what the client sent.
 * The uploaded file is read in memory and never stored.
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

export async function uploadStatementAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();

  const file = formData.get('file');
  const isPdf =
    file instanceof File &&
    file.size > 0 &&
    file.size <= MAX_UPLOAD_BYTES &&
    (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (!isPdf) redirect('/bank-import?error=invalid_file');

  // Read in memory and hand the bytes to the extractor, which reads the PDF's text layer
  // locally and sends only text to the model. The file is never persisted or logged.
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  const parsed = stageImportInput.safeParse({
    bankAccountId: formData.get('bankAccountId'),
    filename: file.name,
    fileBytes,
  });
  if (!parsed.success) redirect('/bank-import?error=invalid');

  let batchId: string;
  try {
    const batch = await stageImport(userId, companyId, parsed.data);
    batchId = batch.id;
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect('/bank-import?error=denied');
    if (error instanceof BankImportError) redirect(`/bank-import?error=${error.code}`);
    if (error instanceof LedgerError) redirect(`/bank-import?error=${error.code}`);
    throw error;
  }
  redirect(`/bank-import/${batchId}`);
}

export async function postImportLinesAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const batchId = opt(formData.get('batchId')) ?? '';

  // Parallel per-line arrays (the journal-form pattern), zipped by index.
  const lineIds = formData.getAll('lineId');
  const actions = formData.getAll('action');
  const accountIds = formData.getAll('accountId');
  const decisions = lineIds.map((lineId, i) => ({
    lineId: typeof lineId === 'string' ? lineId : '',
    action: typeof actions[i] === 'string' ? actions[i] : 'post',
    accountId: opt(accountIds[i] ?? null),
  }));

  const parsed = postImportLinesInput.safeParse({ decisions });
  if (!parsed.success) redirect(`/bank-import/${batchId}?error=invalid`);

  let result: { posted: number; ignored: number };
  try {
    result = await postImportLines(userId, companyId, batchId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(`/bank-import/${batchId}?error=denied`);
    if (error instanceof BankImportError) redirect(`/bank-import/${batchId}?error=${error.code}`);
    if (error instanceof LedgerError) redirect(`/bank-import/${batchId}?error=${error.code}`);
    throw error;
  }
  redirect(`/bank-import/${batchId}?ok=posted&posted=${String(result.posted)}&ignored=${String(result.ignored)}`);
}
