import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { isUuid } from '@/lib/uuid';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { roleHasCapability } from '@/server/rbac';
import { getReconciliation } from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';

import { completeReconciliationAction, setClearedAction, updateReconciliationAction } from '../actions';

/**
 * Bank reconciliation — work screen (LL-078). The summary strip shows the bank's figure, what
 * earlier reconciliations already cleared, what this one clears, and the difference; the table
 * is every ledger line that could still clear, with a checkbox. "Save cleared" replaces the
 * saved set with the ticked set; "Complete" is accepted by the server only when the difference
 * is exactly 0.0000. Lines that came in through a bank-statement import are pre-ticked on the
 * first visit (nothing saved yet) — the bank has seen them by definition — but only in the UI:
 * a save is always an explicit act. Money is rendered straight from the service's strings.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string; cleared?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'reconciliation.view')) redirect('/account?error=denied');
  const canWrite = roleHasCapability(membership.role, 'reconciliation.complete');

  const { id } = await params;
  const sp = await searchParams;
  const notice = noticeFrom(sp);

  const view = isUuid(id) ? await getReconciliation(user.id, membership.companyId, id) : null;
  if (view === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Reconciliation not found</h1>
          <Link href="/reconciliation" className="text-sm text-neutral-500 underline">← Reconciliations</Link>
        </header>
        <p role="status" data-testid="notice" className="text-sm text-neutral-500">That reconciliation does not exist.</p>
      </main>
    );
  }

  const accounts = await listAccounts(user.id, membership.companyId);
  const account = accounts.find((a) => a.id === view.reconciliation.bankAccountId);
  const accountLabel = account === undefined ? view.reconciliation.bankAccountId : account.accountNumber !== null && account.accountNumber !== '' ? `${account.accountNumber} · ${account.name}` : account.name;
  const rec = view.reconciliation;
  const inProgress = rec.status === 'IN_PROGRESS';
  const editable = inProgress && canWrite;
  const nothingSavedYet = view.lines.every((l) => !l.cleared);
  const balanced = view.difference === '0.0000';
  const inputClass = 'rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Reconcile {accountLabel}</h1>
        <Link href="/reconciliation" className="text-sm text-neutral-500 underline">← Reconciliations</Link>
      </header>

      <p className="text-sm text-neutral-500" data-testid="recon-summary">
        Statement dated <strong>{rec.statementDate}</strong> · status <strong data-testid="recon-status">{rec.status}</strong>
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          {notice}
        </p>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="recon-figures">
        <Figure label="Statement ending" value={rec.statementEndingAmount} testid="recon-statement" />
        <Figure label="Cleared before" value={view.openingCleared} testid="recon-opening" />
        <Figure label="Cleared here" value={view.clearedHere} testid="recon-here" />
        <Figure label="Difference" value={view.difference} testid="recon-difference" emphasis={!balanced} />
        <Figure label={`Ledger as of ${rec.statementDate}`} value={view.ledgerAsOf} testid="recon-ledger" />
      </section>

      {editable && (
        <form action={updateReconciliationAction} data-testid="recon-update-form" className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="reconciliationId" value={rec.id} />
          <label className="flex flex-col gap-1">
            <span>Statement date</span>
            <input type="date" name="statementDate" defaultValue={rec.statementDate} data-testid="recon-edit-date" className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span>Statement ending balance</span>
            <input type="text" inputMode="decimal" name="statementEndingAmount" defaultValue={rec.statementEndingAmount} data-testid="recon-edit-amount" className={inputClass} />
          </label>
          <button type="submit" data-testid="recon-update" className="rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">Update statement</button>
        </form>
      )}

      <form action={setClearedAction} data-testid="recon-lines-form" className="flex flex-col gap-4">
        <input type="hidden" name="reconciliationId" value={rec.id} />
        <table className="w-full border-collapse text-sm" data-testid="recon-lines">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Cleared</th>
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Entry</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.length === 0 && (
              <tr><td colSpan={5} className="py-3 text-neutral-500" data-testid="recon-no-lines">No ledger lines on this account up to the statement date.</td></tr>
            )}
            {view.lines.map((l, i) => (
              <tr key={l.journalLineId} data-testid="recon-line-row" data-cleared={l.cleared} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    name="journalLineId"
                    value={l.journalLineId}
                    defaultChecked={l.cleared || (nothingSavedYet && l.fromImport)}
                    disabled={!editable}
                    data-testid={`recon-tick-${String(i)}`}
                    aria-label={`Cleared: ${l.description ?? l.entryNumber ?? l.journalLineId}`}
                  />
                </td>
                <td className="py-2 pr-2 tabular-nums">{l.postingDate}</td>
                <td className="py-2 pr-2 tabular-nums">
                  <Link href={`/journal/${l.entryId}`} className="underline">{l.entryNumber ?? '—'}</Link>
                  {l.fromImport && <span className="ml-2 text-xs text-neutral-400">from statement import</span>}
                </td>
                <td className="py-2 pr-2">{l.description ?? ''}</td>
                <td className="py-2 pr-2 text-right tabular-nums" data-testid={`recon-amount-${String(i)}`}>{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {editable && (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-neutral-400">
              Ticking saves nothing until you press Save. Complete is accepted only when the difference is 0.0000.
            </span>
            <button type="submit" data-testid="recon-save" className="rounded border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
              Save cleared
            </button>
          </div>
        )}
      </form>

      {editable && (
        <form action={completeReconciliationAction} data-testid="recon-complete-form" className="flex justify-end">
          <input type="hidden" name="reconciliationId" value={rec.id} />
          <button
            type="submit"
            disabled={!balanced}
            data-testid="recon-complete"
            title={balanced ? 'Mark this statement reconciled' : 'Save cleared lines until the difference is 0.0000'}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Complete reconciliation
          </button>
        </form>
      )}
    </main>
  );
}

function Figure({ label, value, testid, emphasis = false }: { label: string; value: string; testid: string; emphasis?: boolean }) {
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`tabular-nums ${emphasis ? 'font-semibold text-amber-700 dark:text-amber-300' : ''}`} data-testid={testid}>{value}</div>
    </div>
  );
}

function noticeFrom(sp: { error?: string; ok?: string; cleared?: string }): string | null {
  if (sp.ok === 'saved') return `Saved ${sp.cleared ?? '0'} cleared line(s).`;
  if (sp.ok === 'updated') return 'Statement details updated.';
  if (sp.ok === 'completed') return 'Reconciliation completed.';
  const error = sp.error;
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please check the values and try again.';
  if (error === 'NOT_IN_PROGRESS') return 'This reconciliation is completed and final.';
  if (error === 'LINE_INVALID') return 'A ticked line cannot be cleared here (wrong account, dated after the statement, or already cleared) — reload and try again.';
  if (error === 'DIFFERENCE_NOT_ZERO') return 'The cleared lines do not add up to the statement ending balance yet.';
  if (error === 'STATEMENT_DATE_NOT_AFTER_LAST') return 'The statement date must be after the last completed statement for this account.';
  if (error === 'DUPLICATE_STATEMENT_DATE') return 'A reconciliation for this account and statement date already exists.';
  if (error === 'NOT_FOUND') return 'That reconciliation could not be found.';
  if (error === 'denied') return 'You do not have permission to reconcile.';
  return 'The change could not be saved.';
}
