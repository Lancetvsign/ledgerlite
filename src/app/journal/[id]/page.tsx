import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getJournalEntry } from '@/server/ledger';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { sourceHref } from '../../reports/source-href';

/**
 * Journal entry detail — LL-035. READ ONLY, by construction.
 *
 * A posted entry is immutable (invariant 3): there is no edit affordance anywhere
 * on this page — no edit link, no editable field, no delete — because there is no
 * such operation to offer. Corrections are made by reversal, which is a separate
 * authorized action, not an edit of this record. An entry belonging to another
 * company resolves to 404 exactly as a non-existent id does (no existence leak).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Show a money string only when it carries a value, so each line reads on one side. */
function shown(value: string): string {
  return /^-?0*(\.0*)?$/.test(value.trim()) ? '' : value;
}

export default async function JournalEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');

  const { id } = await params;
  const view = await getJournalEntry(user.id, membership.companyId, id);
  if (view === null) notFound();

  const { entry, lines } = view;
  const sp = await searchParams;
  const notice = noticeFrom(sp);
  // LL-110: where this entry's correction lives. A manual entry (or a reversal rooted in one) is
  // reversed here; a document's entry by the document's void; an import posting from its statement.
  const manual = view.rootSourceType === 'JOURNAL_ENTRY';
  const canReverse = manual && entry.status === 'POSTED' && roleHasCapability(membership.role, 'journal.post');
  const correctionHref = sourceHref({ entryId: entry.id, sourceType: entry.sourceType, sourceId: entry.sourceId, reversalOfId: entry.reversalOfId, bankImportBatchId: view.bankImportBatchId });

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          Journal Entry {entry.entryNumber !== null ? `#${String(entry.entryNumber)}` : ''}
        </h1>
        <Link href="/journal/new" className="text-sm text-neutral-500 underline">
          New entry
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">{notice}</p>
      )}

      <p role="status" data-testid="posted-confirmation" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
        This entry is posted and immutable. Corrections are made by reversal.
        {view.reversedByNumber !== null && entry.reversedById !== null && (
          <> Reversed by <Link href={`/journal/${entry.reversedById}`} data-testid="reversed-by-link" className="underline">#{String(view.reversedByNumber)}</Link>.</>
        )}
        {view.reversalOfNumber !== null && entry.reversalOfId !== null && (
          <> Reverses <Link href={`/journal/${entry.reversalOfId}`} data-testid="reversal-of-link" className="underline">#{String(view.reversalOfNumber)}</Link>.</>
        )}
      </p>

      {canReverse && (
        // LL-110: the correction of a posted manual entry — never an edit, a reversing entry. The
        // form lives on its own page: this page stays free of any input (nothing here is editable).
        <Link href={`/journal/${entry.id}/reverse`} data-testid="reverse-entry-open" className="self-start rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
          Reverse this entry…
        </Link>
      )}
      {!manual && entry.status === 'POSTED' && entry.sourceType !== 'REVERSAL' && correctionHref !== `/journal/${entry.id}` && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400" data-testid="correction-elsewhere">
          This entry was posted by {entry.sourceType === 'BANK_IMPORT' || entry.sourceType === 'INTERCOMPANY' ? 'a statement import' : 'a document'} — correct it{' '}
          <Link href={correctionHref} data-testid="correction-link" className="underline">
            {entry.sourceType === 'BANK_IMPORT' ? 'with “Undo posting” on its statement' : entry.sourceType === 'INTERCOMPANY' ? 'with “Undo transfer” on its statement' : 'by voiding the document'}
          </Link>
          .
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-neutral-500">Status</dt>
          <dd data-testid="entry-status" className="font-medium">{entry.status}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Transaction date</dt>
          <dd>{entry.transactionDate}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Posting date</dt>
          <dd>{entry.postingDate}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Source</dt>
          <dd>{entry.sourceType}</dd>
        </div>
        {entry.description !== null && entry.description !== '' && (
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-neutral-500">Description</dt>
            <dd data-testid="entry-description">{entry.description}</dd>
          </div>
        )}
      </dl>

      <table className="w-full border-collapse text-sm" data-testid="entry-lines">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Account</th>
            <th className="py-2 pr-2">Description</th>
            <th className="py-2 pr-2 text-right">Debit</th>
            <th className="py-2 pr-2 text-right">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} data-testid="entry-line" className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">
                {line.accountNumber !== null && line.accountNumber !== '' ? `${line.accountNumber} · ` : ''}
                {line.accountName}
              </td>
              <td className="py-2 pr-2 text-neutral-500">{line.description ?? ''}</td>
              <td className="py-2 pr-2 text-right font-mono">{shown(line.debit)}</td>
              <td className="py-2 pr-2 text-right font-mono">{shown(line.credit)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-neutral-400">
        Balances are derived from journal lines. This entry cannot be edited.
      </p>
    </main>
  );
}

function noticeFrom(sp: { ok?: string; error?: string }): string | null {
  if (sp.ok === 'reversed') return 'Reversal posted. The original entry is kept, marked reversed; post the corrected entry next.';
  const e = sp.error;
  if (e === undefined) return null;
  if (e === 'PERIOD_CLOSED') return 'That reversal date falls in a closed period — choose a date in an open period.';
  if (e === 'ENTRY_ALREADY_REVERSED') return 'That entry has already been reversed.';
  if (e === 'DOCUMENT_REVERSAL_REQUIRES_VOID') return 'This entry belongs to a document — void the document instead.';
  if (e === 'denied') return 'You do not have permission to reverse entries.';
  return 'The entry could not be reversed.';
}

