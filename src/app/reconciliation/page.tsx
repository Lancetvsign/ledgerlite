import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money-format';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { companyToday } from '@/server/companies';
import { roleHasCapability } from '@/server/rbac';
import { isReconcilableAccount, listReconciliations } from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';

import { startReconciliationAction } from './actions';

/**
 * Bank reconciliation — list + start (LL-078). Anyone in the company can see the history
 * (`reconciliation.view`); starting one needs `reconciliation.complete` — the UI hides the
 * form otherwise and the SERVER re-checks regardless. Money is rendered straight from the
 * service's strings (ADR-004).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ReconciliationListPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'reconciliation.view')) redirect('/account?error=denied');
  const canWrite = roleHasCapability(membership.role, 'reconciliation.complete');

  const sp = await searchParams;
  const notice = noticeFrom(sp.error);
  const [accounts, reconciliations, today] = await Promise.all([
    listAccounts(user.id, membership.companyId),
    listReconciliations(user.id, membership.companyId),
    companyToday(user.id, membership.companyId),
  ]);
  const label = (a: { accountNumber: string | null; name: string }) =>
    a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
  const nameById = new Map(accounts.map((a) => [a.id, label(a)]));
  const bankAccounts = accounts.filter(isReconcilableAccount); // cash/bank assets and credit-card liabilities (LL-081)
  const inputClass = 'rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Bank reconciliation</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">← Company</Link>
      </header>

      <p className="text-sm text-neutral-500">
        Enter the statement date and the statement&apos;s ending figure (for a credit card, the balance
        owed), tick the ledger lines the statement shows, and complete when they agree to the cent.
        Nothing posts; this is a control, not an entry.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      {canWrite && (
        <form action={startReconciliationAction} data-testid="start-form" className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <label className="flex flex-col gap-1">
            <span>Account (bank or credit card)</span>
            <select name="bankAccountId" required defaultValue="" data-testid="recon-account" className={inputClass}>
              <option value="" disabled>Choose…</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>{label(a)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>Statement date</span>
            <input type="date" name="statementDate" required defaultValue={today} data-testid="recon-date" className={inputClass} />
          </label>
          <label className="flex flex-col gap-1">
            <span>Statement ending balance (for a card: balance owed)</span>
            <input type="text" inputMode="decimal" name="statementEndingAmount" required placeholder="0.00" data-testid="recon-amount" className={inputClass} />
          </label>
          <button type="submit" data-testid="recon-start" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
            Start
          </button>
        </form>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Reconciliations</h2>
        {reconciliations.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="no-reconciliations">None yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="recon-table">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Account</th>
                <th className="py-2 pr-2">Statement date</th>
                <th className="py-2 pr-2 text-right">Statement ending</th>
                <th className="py-2 pr-2">Status</th>
                <th className="py-2 pr-2" />
              </tr>
            </thead>
            <tbody>
              {reconciliations.map((r) => (
                <tr key={r.id} data-testid="recon-row" data-status={r.status} className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 pr-2">{nameById.get(r.bankAccountId) ?? r.bankAccountId}</td>
                  <td className="py-2 pr-2 tabular-nums">{r.statementDate}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(r.statementEndingAmount)}</td>
                  <td className="py-2 pr-2">{r.status}</td>
                  <td className="py-2 pr-2"><Link href={`/reconciliation/${r.id}`} data-testid="recon-link" className="underline">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function noticeFrom(error: string | undefined): string | null {
  if (error === undefined) return null;
  if (error === 'invalid') return 'Choose a bank account, a statement date, and the ending balance as a plain amount (e.g. 1379.50).';
  if (error === 'NOT_A_BANK_ACCOUNT') return 'Choose an active cash/bank asset account or a credit-card account.';
  if (error === 'ALREADY_IN_PROGRESS') return 'That account already has a reconciliation in progress — open it from the list.';
  if (error === 'DUPLICATE_STATEMENT_DATE') return 'A reconciliation for that account and statement date already exists.';
  if (error === 'STATEMENT_DATE_NOT_AFTER_LAST') return 'The statement date must be after the last completed statement for that account.';
  if (error === 'NOT_FOUND') return 'That reconciliation could not be found.';
  if (error === 'denied') return 'You do not have permission to reconcile.';
  return 'The reconciliation could not be started.';
}
