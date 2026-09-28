'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied } from '@/server/authorization';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { amendImportLine, amendStatementSummary, BankImportError, deleteImportBatch, unpostImportLine, postImportLines, saveReviewDrafts, setBatchSharing, stageImport, unmarkIntercompanyTransfer } from '@/server/bank-import';
import { AccountError } from '@/server/accounts';
import { BillPaymentError } from '@/server/bill-payments';
import { LedgerError } from '@/server/ledger';
import { PaymentError } from '@/server/payments';
import { ensureAppUser } from '@/server/users';
import { amendImportLineInput, amendStatementSummaryInput, postImportLinesInput, saveReviewDraftsInput, stageImportInput, unpostImportLineInput } from '@/validation/bank-import';
import { isUuid } from '@/lib/uuid';
import { backFrom, withBack } from '@/app/reports/back';

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

/**
 * LL-106: the row's counterpart select carries either a match found on the other company's
 * statement (`line:<lineId>:<companyId>`) or a plain company pick (`company:<id>`); empty means
 * the line is still waiting for a match. The service re-proves whichever arrives.
 */
function parseCounterpart(v: FormDataEntryValue | null | undefined): { counterpartCompanyId?: string; counterpartStatementLineId?: string } {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.startsWith('line:')) {
    const [, lineId, companyId] = s.split(':');
    return { ...(lineId !== undefined && lineId !== '' ? { counterpartStatementLineId: lineId } : {}), ...(companyId !== undefined && companyId !== '' ? { counterpartCompanyId: companyId } : {}) };
  }
  if (s.startsWith('company:')) {
    const id = s.slice('company:'.length);
    return id === '' ? {} : { counterpartCompanyId: id };
  }
  return {};
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
    shareWithOrganization: formData.get('shareWithOrganization') === '1',
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
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  // A malformed id reads as not-found, never a database error (Gate 6 L1 / LL-093).
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');

  // Parallel per-line arrays (the journal-form pattern), zipped by index. The review page
  // emits every one of these for EVERY staged row (blank option when unused), so the
  // arrays stay aligned.
  const lineIds = formData.getAll('lineId');
  const actions = formData.getAll('action');
  const accountIds = formData.getAll('accountId');
  const documentIds = formData.getAll('documentId');
  const counterpartIds = formData.getAll('counterpartLineId');
  const counterpartEntryIds = formData.getAll('counterpartEntryId');
  const counterparts = formData.getAll('counterpart');
  const all = lineIds.map((lineId, i) => ({
    lineId: typeof lineId === 'string' ? lineId : '',
    action: typeof actions[i] === 'string' ? actions[i] : 'post',
    accountId: opt(accountIds[i] ?? null),
    documentId: opt(documentIds[i] ?? null),
    counterpartLineId: opt(counterpartIds[i] ?? null),
    counterpartEntryId: opt(counterpartEntryIds[i] ?? null),
    ...parseCounterpart(counterparts[i]),
  }));
  // LL-106: a transfer still waiting for the other company's statement is not submitted — it
  // stays a draft and the notice says so; the service would refuse it (COUNTERPART_REQUIRED).
  const waiting = all.filter((d) => d.action === 'intercompany_transfer' && d.counterpartCompanyId === undefined && d.counterpartStatementLineId === undefined).length;
  const decisions = all.filter((d) => !(d.action === 'intercompany_transfer' && d.counterpartCompanyId === undefined && d.counterpartStatementLineId === undefined));
  if (decisions.length === 0) redirect(withBack(`/bank-import/${batchId}?ok=posted&posted=0&ignored=0&waiting=${String(waiting)}`, back));

  const parsed = postImportLinesInput.safeParse({ decisions });
  if (!parsed.success) redirect(withBack(`/bank-import/${batchId}?error=invalid`, back));

  let result: { posted: number; ignored: number; applied: number; matched: number; personal: number; intercompany: number };
  try {
    result = await postImportLines(userId, companyId, batchId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (
      error instanceof BankImportError ||
      error instanceof LedgerError ||
      error instanceof PaymentError ||
      error instanceof BillPaymentError ||
      error instanceof AccountError
    ) {
      redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    }
    throw error;
  }
  redirect(
    withBack(`/bank-import/${batchId}?ok=posted&posted=${String(result.posted)}&ignored=${String(result.ignored)}&applied=${String(result.applied)}&matched=${String(result.matched)}&personal=${String(result.personal)}&intercompany=${String(result.intercompany)}&waiting=${String(waiting)}`, back),
  );
}

/**
 * Saves the review screen's current choices as drafts — LL-105. Called by the autosaver with
 * the form serialised exactly as a submit would be; never posts, never redirects (the page
 * stays put), and any failure is reported as `ok: false` for the status text — an autosave
 * must not throw the reviewer off the page.
 */
export async function saveReviewDraftsAction(formData: FormData): Promise<{ ok: true; saved: number } | { ok: false }> {
  const { userId, companyId } = await requireContext();
  const batchId = opt(formData.get('batchId')) ?? '';
  if (!isUuid(batchId)) return { ok: false };
  const lineIds = formData.getAll('lineId');
  const actions = formData.getAll('action');
  const accountIds = formData.getAll('accountId');
  const documentIds = formData.getAll('documentId');
  const counterparts = formData.getAll('counterpart');
  const parsed = saveReviewDraftsInput.safeParse({
    drafts: lineIds.map((lineId, i) => {
      const { counterpartCompanyId } = parseCounterpart(counterparts[i]);
      return {
        lineId: typeof lineId === 'string' ? lineId : '',
        action: typeof actions[i] === 'string' ? actions[i] : 'post',
        accountId: opt(accountIds[i] ?? null),
        documentId: opt(documentIds[i] ?? null),
        ...(counterpartCompanyId === undefined ? {} : { counterpartCompanyId }),
      };
    }),
  });
  if (!parsed.success) return { ok: false };
  try {
    const { saved } = await saveReviewDrafts(userId, companyId, batchId, parsed.data);
    return { ok: true, saved };
  } catch (error) {
    if (error instanceof AuthorizationDenied || error instanceof BankImportError) return { ok: false };
    throw error;
  }
}

/**
 * Undoes a posted import line — LL-110: its entry is reversed and it returns to review. The
 * refusal messages (undone elsewhere, reconciled) are fixed service text naming the right place
 * — never statement content — so they are carried to the notice as-is.
 */
export async function unpostImportLineAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  const lineId = opt(formData.get('lineId')) ?? '';
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  if (!isUuid(lineId)) redirect(withBack(`/bank-import/${batchId}?error=LINE_NOT_FOUND`, back));
  // LL-116: the reversal's date as chosen (omitted = today); the service checks range and period.
  const rawDate = opt(formData.get('reversalDate'))?.trim();
  const parsed = unpostImportLineInput.safeParse(rawDate === undefined || rawDate === '' ? {} : { reversalDate: rawDate });
  if (!parsed.success) redirect(withBack(`/bank-import/${batchId}?error=UNDO_DATE_INVALID`, back));
  let unposted = 0;
  try {
    ({ unposted } = await unpostImportLine(userId, companyId, batchId, lineId, parsed.data));
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (error instanceof BankImportError && (error.code === 'UNPOST_ELSEWHERE' || error.code === 'LINE_RECONCILED' || error.code === 'UNDO_DATE_INVALID')) {
      redirect(withBack(`/bank-import/${batchId}?error=${error.code}&detail=${encodeURIComponent(error.message)}`, back));
    }
    if (error instanceof BankImportError || error instanceof LedgerError) redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    throw error;
  }
  redirect(withBack(`/bank-import/${batchId}?ok=unposted&unposted=${String(unposted)}`, back));
}

/** Corrects the amount, date or description of a staged line the extractor misread — LL-107 / LL-112. */
export async function amendImportLineAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  const lineId = opt(formData.get('lineId')) ?? '';
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  if (!isUuid(lineId)) redirect(withBack(`/bank-import/${batchId}?error=LINE_NOT_FOUND`, back));
  // Thousands separators and stray spaces are forgiven; the sign is the statement's (− = money out).
  const amount = (opt(formData.get('amount')) ?? '').replace(/[,\s]/g, '');
  // A field the form did not send is left as it is; one it sent empty is invalid, not "unchanged".
  const rawDate = formData.get('txnDate');
  const rawDescription = formData.get('description');
  const parsed = amendImportLineInput.safeParse({
    amount,
    ...(typeof rawDate === 'string' ? { txnDate: rawDate.trim() } : {}),
    ...(typeof rawDescription === 'string' ? { description: rawDescription } : {}),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    redirect(withBack(`/bank-import/${batchId}?error=${field === 'txnDate' ? 'DATE_INVALID' : field === 'description' ? 'DESCRIPTION_INVALID' : 'AMOUNT_INVALID'}`, back));
  }
  try {
    await amendImportLine(userId, companyId, batchId, lineId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (error instanceof BankImportError) redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    throw error;
  }
  redirect(withBack(`/bank-import/${batchId}?ok=amended`, back));
}

/** Corrects a statement's four summary totals when they were misread — LL-123. */
export async function amendStatementSummaryAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  // As printed: thousands separators, spaces and a currency sign are forgiven.
  const field = (name: string) => (opt(formData.get(name)) ?? '').replace(/[,\s$]/g, '');
  const parsed = amendStatementSummaryInput.safeParse({
    beginningBalance: field('beginningBalance'),
    totalCredits: field('totalCredits'),
    totalDebits: field('totalDebits'),
    endingBalance: field('endingBalance'),
  });
  if (!parsed.success) redirect(withBack(`/bank-import/${batchId}?error=SUMMARY_INVALID`, back));
  try {
    await amendStatementSummary(userId, companyId, batchId, parsed.data);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (error instanceof BankImportError) redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    throw error;
  }
  redirect(withBack(`/bank-import/${batchId}?ok=summary_amended`, back));
}

/** Deletes an uploaded statement that has posted nothing — LL-087. */
export async function deleteImportBatchAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  try {
    await deleteImportBatch(userId, companyId, batchId);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (error instanceof BankImportError) redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    throw error;
  }
  redirect('/bank-import?ok=deleted');
}

/** Shares / un-shares a card statement with the organization — LL-097. */
export async function setBatchSharingAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  const shared = formData.get('shared') === '1';
  try {
    await setBatchSharing(userId, companyId, batchId, shared);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (error instanceof BankImportError) redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    throw error;
  }
  redirect(withBack(`/bank-import/${batchId}?ok=${shared ? 'shared' : 'unshared'}`, back));
}

/** Un-marks a bank line posted as an intercompany transfer (both sides if matched) — LL-100. */
export async function unmarkIntercompanyTransferAction(formData: FormData): Promise<void> {
  const { userId, companyId } = await requireContext();
  const back = backFrom(formData); // LL-120: stay on the way back
  const batchId = opt(formData.get('batchId')) ?? '';
  const lineId = opt(formData.get('lineId')) ?? '';
  if (!isUuid(batchId)) redirect('/bank-import?error=BATCH_NOT_FOUND');
  if (!isUuid(lineId)) redirect(withBack(`/bank-import/${batchId}?error=LINE_NOT_FOUND`, back));
  try {
    await unmarkIntercompanyTransfer(userId, companyId, batchId, lineId);
  } catch (error) {
    if (error instanceof AuthorizationDenied) redirect(withBack(`/bank-import/${batchId}?error=denied`, back));
    if (error instanceof BankImportError || error instanceof LedgerError) redirect(withBack(`/bank-import/${batchId}?error=${error.code}`, back));
    throw error;
  }
  redirect(withBack(`/bank-import/${batchId}?ok=unmarked`, back));
}
