import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listClosings } from '@/server/year-end';

import { closeFiscalYearAction, reopenFiscalYearAction } from './actions';

/**
 * Year-end closing — LL-073. LEDGER_WRITERS (period.close). Posts the entry that moves a
 * fiscal year's revenue/expense into Retained Earnings; a closed year can be reopened
 * (which reverses the closing entry). Closing does NOT lock the year's periods — that is
 * the separate Periods screen.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function YearEndPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'period.close')) redirect('/account?error=denied');

  const params = await searchParams;
  const notice = noticeFrom(params.error, params.ok);
  const closings = await listClosings(user.id, membership.companyId);

  // A sensible default: the prior calendar year. The service normalises whatever date is
  // submitted to the company's canonical fiscal-year start.
  const defaultFy = `${String(new Date().getUTCFullYear() - 1)}-01-01`;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Year-end close</h1>
        <a href="/account" className="text-sm text-neutral-500 underline">← Company</a>
      </header>

      <p className="text-sm text-neutral-500">
        Closing a fiscal year posts one entry that moves that year&apos;s revenue and expenses into
        Retained Earnings. It does not lock the year&apos;s periods — do that on the Periods screen. A
        closed year can be reopened, which reverses the entry.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          {notice}
        </p>
      )}

      <form action={closeFiscalYearAction} data-testid="close-year-form" className="flex flex-wrap items-end gap-3 text-sm">
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <label className="flex flex-col gap-1">
          <span>Fiscal year to close (any date within it)</span>
          <input type="date" name="fiscalYearStart" required defaultValue={defaultFy} data-testid="close-year-date" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="close-year-submit" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
          Close fiscal year
        </button>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Closed years</h2>
        {closings.length === 0 ? (
          <p className="text-sm text-neutral-500" data-testid="no-closings">No fiscal years have been closed yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm" data-testid="closings-table">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-2">Fiscal year start</th>
                <th className="py-2 pr-2">Closed on</th>
                <th className="py-2 pr-2">Entry #</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {closings.map((c) => (
                <tr key={c.id} data-testid="closing-row" className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 pr-2 tabular-nums">{c.sourceId}</td>
                  <td className="py-2 pr-2 tabular-nums">{c.postingDate}</td>
                  <td className="py-2 pr-2 tabular-nums">{c.entryNumber}</td>
                  <td className="py-2 text-right">
                    <form action={reopenFiscalYearAction}>
                      <input type="hidden" name="fiscalYearStart" value={c.sourceId ?? ''} />
                      <button type="submit" data-testid="reopen-year-submit" className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300">
                        Reopen
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function noticeFrom(error: string | undefined, ok: string | undefined): string | null {
  if (ok === 'closed') return 'Fiscal year closed — net income moved to Retained Earnings.';
  if (ok === 'reopened') return 'Fiscal year reopened — the closing entry was reversed.';
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please choose a valid date and try again.';
  if (error === 'RE_ACCOUNT_NOT_CONFIGURED') return 'This company has no Retained Earnings account configured.';
  if (error === 'NOTHING_TO_CLOSE') return 'That fiscal year has no revenue or expense activity to close.';
  if (error === 'YEAR_ALREADY_CLOSED') return 'That fiscal year is already closed. Reopen it before closing again.';
  if (error === 'YEAR_NOT_CLOSED') return 'That fiscal year is not closed.';
  if (error === 'PERIOD_CLOSED') return 'The year-end period is closed — reopen it before closing the year.';
  if (error === 'IDEMPOTENCY_KEY_CONFLICT') return 'That submission was already used differently — reload and try again.';
  if (error === 'denied') return 'You do not have permission to close the books.';
  return 'The fiscal year could not be closed.';
}
