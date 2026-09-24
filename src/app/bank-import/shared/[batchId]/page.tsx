import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money-format';
import { isUuid } from '@/lib/uuid';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getSharedImportBatch } from '@/server/bank-import';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { assignSharedLinesAction, unassignSharedLineAction } from '../actions';
import { TakeCheckbox } from './take-checkbox';

/**
 * A card statement another company of the organization shared — seen from THIS company
 * (LL-097 / ADR-043). Only the lines nobody has taken, plus the ones this company took.
 * Ticking a line and choosing this company's account posts both sides in one go: this
 * company's expense against "Due to <cardholder>", and the cardholder's "Due from <us>"
 * against its card — so its card still reconciles and our books carry our expense.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function SharedImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; ok?: string; assigned?: string; detail?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) redirect('/account?error=denied');

  const { batchId } = await params;
  const sp = await searchParams;
  const notice = noticeFrom(sp);
  const view = isUuid(batchId) ? await getSharedImportBatch(user.id, membership.companyId, batchId) : null;
  if (view === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Shared statement not found</h1>
          <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
        </header>
        <p role="status" data-testid="notice" className="text-sm text-neutral-500">That shared statement does not exist.</p>
      </main>
    );
  }

  const label = (a: { accountNumber: string | null; name: string }) =>
    a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
  const nameById = new Map(view.pickable.map((a) => [a.id, label(a)]));
  const untaken = view.lines.filter((l) => l.status === 'STAGED');
  const selectClass = 'max-w-56 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Shared card statement</h1>
        <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
      </header>

      <p className="text-sm text-neutral-500" data-testid="shared-summary">
        <strong>{view.batch.ownerLegalName}</strong> · {view.batch.accountName} · {view.batch.filename ?? 'statement'} ·{' '}
        {String(view.batch.stagedCount)} untaken, {String(view.batch.assignedToMeCount)} taken by this company.
        {!view.batch.sharedWithOrganization && <span data-testid="no-longer-shared"> No longer shared — only the lines this company took are shown.</span>}
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          {notice}
        </p>
      )}

      <form action={assignSharedLinesAction} data-testid="shared-form" className="flex flex-col gap-4">
        <input type="hidden" name="batchId" value={view.batch.batchId} />
        <table className="w-full border-collapse text-sm" data-testid="shared-lines">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Take</th>
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Amount</th>
              <th className="py-2 pr-2">Our account</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l, i) => (
              <tr key={l.id} data-testid="shared-line-row" data-status={l.status} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2 pr-2">
                  {l.status === 'STAGED' ? (
                    <>
                      <input type="hidden" name="lineId" value={l.id} />
                      <TakeCheckbox index={i} />
                    </>
                  ) : (
                    <span className="text-xs text-neutral-500" data-testid={`shared-taken-${String(i)}`}>taken</span>
                  )}
                </td>
                <td className="py-2 pr-2 tabular-nums">{l.txnDate}</td>
                <td className="py-2 pr-2">
                  {l.description}
                  {l.aiCategory !== null && <span className="ml-2 text-xs text-neutral-400">suggested: {l.aiCategory}</span>}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid={`shared-amount-${String(i)}`}>{formatMoney(l.amount)}</td>
                <td className="py-2 pr-2">
                  {l.status === 'STAGED' ? (
                    <select name="accountId" defaultValue={l.suggestedAccountId ?? ''} data-testid={`shared-account-${String(i)}`} className={selectClass}>
                      <option value="">Choose our account…</option>
                      {view.pickable.map((a) => (
                        <option key={a.id} value={a.id}>{label(a)}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-neutral-500">{l.assignedAccountId !== null ? (nameById.get(l.assignedAccountId) ?? 'our account') : '—'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {untaken.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-neutral-400">
              Taking a line posts it as this company&apos;s expense owed to {view.batch.ownerLegalName} (“Due to”), and as
              “Due from” this company on their card. Give a line back with Undo.
            </span>
            <button type="submit" data-testid="assign-shared-lines" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Take selected lines
            </button>
          </div>
        ) : (
          <p className="text-sm text-neutral-500" data-testid="nothing-untaken">Nothing left to take.</p>
        )}
      </form>

      {view.lines.some((l) => l.status === 'ASSIGNED') && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Taken by this company</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {view.lines.map((l, i) =>
              l.status === 'ASSIGNED' ? (
                <li key={l.id} className="flex items-center gap-2">
                  <span className="tabular-nums">{l.txnDate}</span>
                  <span className="flex-1">{l.description}</span>
                  <span className="tabular-nums">{formatMoney(l.amount)}</span>
                  {l.assignedJournalEntryId !== null && (
                    <Link href={`/journal/${l.assignedJournalEntryId}`} className="text-xs underline">entry</Link>
                  )}
                  <form action={unassignSharedLineAction}>
                    <input type="hidden" name="batchId" value={view.batch.batchId} />
                    <input type="hidden" name="lineId" value={l.id} />
                    <button type="submit" data-testid={`shared-undo-${String(i)}`} className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
                      Undo
                    </button>
                  </form>
                </li>
              ) : null,
            )}
          </ul>
        </section>
      )}
    </main>
  );
}

function noticeFrom(sp: { error?: string; ok?: string; assigned?: string; detail?: string }): string | null {
  if (sp.ok === 'assigned') return `Took ${sp.assigned ?? '0'} line(s): posted here as expenses, and on the cardholder's card as due from this company.`;
  if (sp.ok === 'unassigned') return 'Line given back: both entries reversed; the cardholder can review it again.';
  const error = sp.error;
  if (error === undefined) return null;
  if (error === 'nothing') return 'Tick the lines to take.';
  if (error === 'ACCOUNT_REQUIRED') return 'Choose one of our accounts for every ticked line.';
  if (error === 'CARD_PAYMENT_NOT_TAKEABLE') return 'That line is a payment to the card from the cardholder’s own bank — it stays with the cardholder.';
  if (error === 'CONTROL_ACCOUNT_NOT_ALLOWED') return 'Choose one of our active expense or asset accounts — never a control or intercompany account.';
  if (error === 'PERIOD_CLOSED') return sp.detail ?? 'A line falls in a closed accounting period.';
  if (error === 'INTERCOMPANY_NOT_ALLOWED') return 'The two companies must be active members of one organization with the same currency.';
  if (error === 'LINE_NOT_FOUND' || error === 'BATCH_NOT_FOUND') return 'That line is no longer available — reload.';
  if (error === 'denied') return 'You need posting rights in both companies to take a line.';
  return 'The lines could not be taken.';
}
