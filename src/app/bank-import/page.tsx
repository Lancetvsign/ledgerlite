import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { isStatementAccount } from '@/server/accounts/statement-account';
import { isExtractionConfigured, listImportBatches, listSharedImports } from '@/server/bank-import';
import { listOrganizationCompanies } from '@/server/organizations';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { uploadStatementAction } from './actions';
import { REVIEW_STATUS_CLASS, REVIEW_STATUS_TEXT } from './review-status';
import { UploadSubmitButton } from './upload-submit-button';

/**
 * Bank-statement import — upload (LL-076). LEDGER_WRITERS (journal.post). Pick the bank
 * account the statement is for and upload the PDF; the extracted lines are staged for
 * per-line review before anything posts. The file is read in memory and never stored.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BankImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) redirect('/account?error=denied');

  const params = await searchParams;
  const notice = noticeFrom(params.error);
  const ok = params.ok === 'deleted' ? 'Import deleted. Nothing had posted from it.' : null;
  const configured = isExtractionConfigured();

  const accounts = await listAccounts(user.id, membership.companyId);
  // Bank accounts and credit cards (LL-088) — the same predicate Reconciliation uses.
  const bankAccounts = accounts.filter(isStatementAccount);
  const batches = await listImportBatches(user.id, membership.companyId);
  const [orgMembers, shared] = await Promise.all([
    listOrganizationCompanies(user.id, membership.companyId),
    listSharedImports(user.id, membership.companyId),
  ]);
  const inOrganization = orgMembers.length > 0;
  const nameById = new Map(accounts.map((a) => [a.id, a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name]));

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bank statement import</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">← Company</Link>
      </header>

      <p className="text-sm text-neutral-500">
        Upload a bank or credit-card statement PDF. Each transaction is extracted and staged with a suggested
        account; you review and confirm or change every line before anything posts to the ledger.
        The file itself is never stored.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}
      {ok !== null && (
        <p role="status" data-testid="notice" className="rounded bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {ok}
        </p>
      )}

      {!configured ? (
        <p data-testid="extraction-not-configured" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          Statement extraction is not configured yet — the AI extraction integration is a follow-up.
          Previously staged batches below can still be reviewed and posted.
        </p>
      ) : (
        <form action={uploadStatementAction} data-testid="upload-form" className="flex flex-col gap-3 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <label className="flex flex-col gap-1">
            <span>Bank account</span>
            <select name="bankAccountId" required defaultValue="" data-testid="upload-bank-account" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="" disabled>Choose the statement&apos;s bank account…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>{nameById.get(a.id)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>Statement PDF</span>
            <input type="file" name="file" accept="application/pdf,.pdf" required data-testid="upload-file" className="text-sm" />
          </label>
          {inOrganization && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="shareWithOrganization" value="1" data-testid="upload-share" />
              Share with my organization (credit-card statements only) — the other companies can take the charges that are theirs
            </label>
          )}
          <UploadSubmitButton />
        </form>
      )}

      {inOrganization && (
        <section className="flex flex-col gap-2" data-testid="shared-imports">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Shared with you</h2>
          {shared.length === 0 ? (
            <p className="text-sm text-neutral-500" data-testid="no-shared-imports">No card statements shared by the other companies of your organization.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" data-testid="shared-list">
              {shared.map((b) => (
                <li key={b.batchId}>
                  <Link href={`/bank-import/shared/${b.batchId}`} data-testid="shared-link" className="underline">
                    {b.ownerLegalName} — {b.accountName} — {b.filename ?? 'statement'}
                  </Link>{' '}
                  <span className="text-neutral-500">· {String(b.stagedCount)} untaken · {String(b.assignedToMeCount)} yours{b.draftCount > 0 ? ' · in progress' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Recent imports</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="no-batches">No imports yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="batch-list">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/bank-import/${b.id}`} data-testid="batch-link" className="underline">
                  {b.filename ?? 'statement'} — {nameById.get(b.bankAccountId) ?? b.bankAccountId}
                </Link>
                {/* LL-105: where the review stands — a saved draft counts as progress. */}
                <span data-testid="batch-status" data-status={b.reviewStatus} className={`rounded px-1.5 py-0.5 text-xs ${REVIEW_STATUS_CLASS[b.reviewStatus]}`}>
                  {REVIEW_STATUS_TEXT[b.reviewStatus]}
                </span>
                <span className="text-xs text-neutral-500">
                  {String(b.stagedCount)} to review · {String(b.decidedCount)} done
                </span>
                {b.verificationStatus === 'mismatch' && (
                  <span data-testid="batch-totals-mismatch" className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800 dark:bg-red-900 dark:text-red-200">
                    totals mismatch
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function noticeFrom(error: string | undefined): string | null {
  if (error === undefined) return null;
  if (error === 'invalid_file') return 'Please choose a PDF statement under 10 MB.';
  if (error === 'invalid') return 'Please choose a bank account and a PDF, then try again.';
  if (error === 'EXTRACTION_NOT_CONFIGURED') return 'Statement extraction is not configured yet.';
  if (error === 'EXTRACTION_FAILED') return 'No usable transactions could be extracted from that statement.';
  if (error === 'SCANNED_PDF') return 'That PDF appears to be a scanned image; a text-based statement is needed.';
  if (error === 'INVALID_BANK_ACCOUNT') return 'Choose an active bank account or credit card.';
  if (error === 'ONLY_CARDS_SHAREABLE') return 'Only a credit-card statement can be shared with the organization — upload it without sharing, or choose the card account.';
  if (error === 'NOT_IN_ORGANIZATION') return 'Put this company in an organization (Account page) before sharing a statement.';
  if (error === 'BATCH_NOT_FOUND') return 'That import batch does not exist.';
  if (error === 'denied') return 'You do not have permission to import statements.';
  return 'The statement could not be imported.';
}
