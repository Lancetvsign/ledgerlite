import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';

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
}: {
  params: Promise<{ id: string }>;
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

      <p role="status" data-testid="posted-confirmation" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
        This entry is posted and immutable. Corrections are made by reversal.
      </p>

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
