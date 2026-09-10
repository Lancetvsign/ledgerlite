import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { isUuid } from '@/lib/uuid';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getImportBatch } from '@/server/bank-import';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { postImportLinesAction } from '../actions';

/**
 * Bank-statement import — review (LL-076). The human gate: every staged line shows its
 * extracted date/description/amount and a suggested account; the reviewer confirms or
 * changes the account (or ignores the line) and posts. Nothing posts without an explicit
 * decision. Money is rendered straight from the service's `string`s (ADR-004).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXCLUDED_SYSTEM_TYPES = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'OPENING_BALANCE_EQUITY']);

export default async function ReviewImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; ok?: string; posted?: string; ignored?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) redirect('/account?error=denied');

  const { batchId } = await params;
  const sp = await searchParams;
  const notice = noticeFrom(sp.error, sp.ok, sp.posted, sp.ignored);

  // A malformed or cross-company id reads as not-found, never a 500 (Gate 5).
  const view = isUuid(batchId) ? await getImportBatch(user.id, membership.companyId, batchId) : null;
  if (view === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Import not found</h1>
          <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
        </header>
        <p role="status" data-testid="notice" className="text-sm text-neutral-500">That import batch does not exist.</p>
      </main>
    );
  }

  const accounts = await listAccounts(user.id, membership.companyId);
  const label = (a: { accountNumber: string | null; name: string }) =>
    a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
  const nameById = new Map(accounts.map((a) => [a.id, label(a)]));
  const pickable = accounts
    .filter((a) => a.status === 'ACTIVE' && a.id !== view.batch.bankAccountId)
    .filter((a) => a.systemAccountType === null || !EXCLUDED_SYSTEM_TYPES.has(a.systemAccountType));

  const staged = view.lines.filter((l) => l.status === 'STAGED').length;
  const posted = view.lines.filter((l) => l.status === 'POSTED').length;
  const ignored = view.lines.filter((l) => l.status === 'IGNORED').length;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Review import</h1>
        <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
      </header>

      <p className="text-sm text-neutral-500" data-testid="batch-summary">
        {view.batch.filename ?? 'statement'} into <strong>{nameById.get(view.batch.bankAccountId)}</strong> ·{' '}
        {String(staged)} to review, {String(posted)} posted, {String(ignored)} ignored.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          {notice}
        </p>
      )}

      <form action={postImportLinesAction} data-testid="review-form" className="flex flex-col gap-4">
        <input type="hidden" name="batchId" value={view.batch.id} />
        <table className="w-full border-collapse text-sm" data-testid="import-lines">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Amount</th>
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l, i) => (
              <tr key={l.id} data-testid="import-line-row" data-status={l.status} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2 pr-2 tabular-nums">{l.txnDate}</td>
                <td className="py-2 pr-2">
                  {l.description}
                  {l.aiCategory !== null && <span className="ml-2 text-xs text-neutral-400">suggested: {l.aiCategory}</span>}
                  {l.isDuplicate && (
                    <span data-testid="duplicate-flag" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                      possible duplicate
                    </span>
                  )}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid={`import-amount-${String(i)}`}>{l.amount}</td>
                {l.status === 'STAGED' ? (
                  <>
                    <td className="py-2 pr-2">
                      <input type="hidden" name="lineId" value={l.id} />
                      <select name="accountId" defaultValue={l.suggestedAccountId ?? ''} data-testid={`import-account-${String(i)}`} className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                        <option value="">Choose account…</option>
                        {pickable.map((a) => (
                          <option key={a.id} value={a.id}>{label(a)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-2">
                      <select name="action" defaultValue="post" data-testid={`import-action-${String(i)}`} className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                        <option value="post">Post</option>
                        <option value="ignore">Ignore</option>
                      </select>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-2 text-neutral-500">{l.chosenAccountId !== null ? nameById.get(l.chosenAccountId) : '—'}</td>
                    <td className="py-2 pr-2 text-neutral-500" data-testid={`import-status-${String(i)}`}>{l.status}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        {staged > 0 && (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-neutral-400">
              Posting is final. Each posted line becomes a journal entry; corrections are made by reversal.
            </span>
            <button type="submit" data-testid="post-import-lines" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Post confirmed lines
            </button>
          </div>
        )}
      </form>
    </main>
  );
}

function noticeFrom(error: string | undefined, ok: string | undefined, posted: string | undefined, ignored: string | undefined): string | null {
  if (ok === 'posted') return `Posted ${posted ?? '0'} line(s), ignored ${ignored ?? '0'}.`;
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please check the lines and try again.';
  if (error === 'ACCOUNT_REQUIRED') return 'Choose an account for every line you are posting.';
  if (error === 'CONTROL_ACCOUNT_NOT_ALLOWED') return 'Accounts Receivable, Accounts Payable, Opening Balance Equity, and the bank account itself cannot be used — pick another account.';
  if (error === 'PERIOD_CLOSED') return 'A line falls in a closed accounting period.';
  if (error === 'LINE_NOT_FOUND' || error === 'BATCH_NOT_FOUND') return 'That import could not be found.';
  if (error === 'denied') return 'You do not have permission to post.';
  return 'The lines could not be posted.';
}
