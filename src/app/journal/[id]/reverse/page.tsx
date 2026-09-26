import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { todayInTimeZone } from '@/lib/dates';
import { formatMoney } from '@/lib/money-format';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCompaniesForUser } from '@/server/companies';
import { getJournalEntry } from '@/server/ledger';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { reverseJournalEntryAction } from '../../actions';

/**
 * Reverse a posted manual journal entry — LL-110. The correction of a posted entry is never an
 * edit (invariant 3): it is a NEW entry with every debit and credit swapped, dated here, while
 * the original stays as it is, marked reversed. The service re-proves everything (journal.post,
 * manual entries only — a document's entry is voided on its document —, an open period).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ReverseEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) redirect('/account?error=denied');

  const { id } = await params;
  const view = await getJournalEntry(user.id, membership.companyId, id);
  if (view === null) notFound();
  const { entry, lines } = view;
  // Only a posted manual entry has this correction; anything else goes back to its own page.
  if (entry.status !== 'POSTED' || view.rootSourceType !== 'JOURNAL_ENTRY') redirect(`/journal/${entry.id}`);

  const companies = await listCompaniesForUser(user.id);
  const today = todayInTimeZone(companies.find((c) => c.company.id === membership.companyId)?.company.timezone ?? 'UTC');
  const label = (l: { accountNumber: string | null; accountName: string }) =>
    l.accountNumber !== null && l.accountNumber !== '' ? `${l.accountNumber} · ${l.accountName}` : l.accountName;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Reverse entry {entry.entryNumber !== null ? `#${String(entry.entryNumber)}` : ''}</h1>
        <Link href={`/journal/${entry.id}`} className="text-sm text-neutral-500 underline">← Entry</Link>
      </header>

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        A reversal posts a new entry with every debit and credit of this one swapped. This entry stays as it is, marked
        reversed, so the history shows both. Post the corrected entry afterwards.
      </p>

      <table className="w-full border-collapse text-sm" data-testid="reverse-preview">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Account</th>
            <th className="py-2 pr-2 text-right">Reversal debit</th>
            <th className="py-2 pr-2 text-right">Reversal credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-2 pr-2">{label(l)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{/^0*(\.0*)?$/.test(l.credit) ? '' : formatMoney(l.credit)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{/^0*(\.0*)?$/.test(l.debit) ? '' : formatMoney(l.debit)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <form action={reverseJournalEntryAction} className="flex flex-col gap-3 text-sm" data-testid="reverse-entry">
        <input type="hidden" name="entryId" value={entry.id} />
        <label className="flex items-center gap-2">
          <span className="w-28 text-neutral-500">Reversal date</span>
          <input type="date" name="reversalDate" defaultValue={today} required data-testid="reverse-entry-date" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-28 text-neutral-500">Reason</span>
          <input name="reason" maxLength={1000} placeholder="Optional" data-testid="reverse-entry-reason" className="flex-1 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="reverse-entry-confirm" className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Reverse entry
        </button>
      </form>
    </main>
  );
}
