import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { isExtractionConfigured, listImportBatches } from '@/server/bank-import';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { uploadStatementAction } from './actions';

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
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) redirect('/account?error=denied');

  const params = await searchParams;
  const notice = noticeFrom(params.error);
  const configured = isExtractionConfigured();

  const accounts = await listAccounts(user.id, membership.companyId);
  const bankAccounts = accounts.filter(
    (a) => a.status === 'ACTIVE' && a.accountType === 'ASSET' && a.cashFlowCategory === 'CASH',
  );
  const batches = await listImportBatches(user.id, membership.companyId);
  const nameById = new Map(accounts.map((a) => [a.id, a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name]));

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bank statement import</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">← Company</Link>
      </header>

      <p className="text-sm text-neutral-500">
        Upload a bank statement PDF. Each transaction is extracted and staged with a suggested
        account; you review and confirm or change every line before anything posts to the ledger.
        The file itself is never stored.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
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
          <button type="submit" data-testid="upload-submit" className="self-start rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
            Upload &amp; extract
          </button>
        </form>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Recent imports</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="no-batches">No imports yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="batch-list">
            {batches.map((b) => (
              <li key={b.id}>
                <Link href={`/bank-import/${b.id}`} data-testid="batch-link" className="underline">
                  {b.filename ?? 'statement'} — {nameById.get(b.bankAccountId) ?? b.bankAccountId}
                </Link>
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
  if (error === 'INVALID_BANK_ACCOUNT') return 'Choose an active cash/bank asset account.';
  if (error === 'denied') return 'You do not have permission to import statements.';
  return 'The statement could not be imported.';
}
