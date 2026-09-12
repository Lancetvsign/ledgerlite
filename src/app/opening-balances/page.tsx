import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money-format';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { companyToday } from '@/server/companies';
import { getOpeningBalances } from '@/server/opening-balances';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { voidOpeningBalancesAction } from './actions';
import { OpeningBalanceForm } from './opening-balance-form';

/**
 * Opening balances — LL-071. LEDGER_WRITERS only (OWNER/ADMIN/ACCOUNTANT).
 *
 * The capability gate here hides the surface from anyone without `journal.post`; the
 * service re-checks it (AGENTS §6). If an opening-balance entry already exists, the page
 * shows it read-only with a Void action — the entry is immutable, corrected by void +
 * re-enter, never edited.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** System accounts that may not carry an opening balance directly (control + the plug). */
const EXCLUDED_SYSTEM_TYPES = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'OPENING_BALANCE_EQUITY']);

export default async function OpeningBalancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);

  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) {
    redirect('/account?error=denied');
  }

  const params = await searchParams;
  const notice = noticeFrom(params.error, params.ok);

  const accounts = await listAccounts(user.id, membership.companyId);
  const nameById = new Map(accounts.map((a) => [a.id, displayName(a)]));

  const existing = await getOpeningBalances(user.id, membership.companyId);
  if (existing !== null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Opening balances</h1>
          <a href="/account" className="text-sm text-neutral-500 underline">← Company</a>
        </header>

        {notice !== null && (
          <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
            {notice}
          </p>
        )}

        <p className="text-sm text-neutral-500">
          Opening balances were posted on <strong>{existing.entry.postingDate}</strong> (entry #{existing.entry.entryNumber}).
          They are set once; to correct them, void and re-enter.
        </p>

        <table className="w-full border-collapse text-sm" data-testid="ob-summary">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2 text-right">Debit</th>
              <th className="py-2 pr-2 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {existing.lines.map((l) => (
              <tr key={l.id} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-1 pr-2">{nameById.get(l.accountId) ?? l.accountId}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatMoney(l.debit)}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{formatMoney(l.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <form action={voidOpeningBalancesAction} data-testid="void-opening-balances" className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Reason (optional)
            <input
              type="text"
              name="reason"
              placeholder="e.g. Corrected conversion figures"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <button
            type="submit"
            data-testid="void-button"
            className="self-start rounded border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
          >
            Void opening balances
          </button>
        </form>
      </main>
    );
  }

  const pickable = accounts
    .filter((a) => a.status === 'ACTIVE')
    .filter((a) => a.systemAccountType === null || !EXCLUDED_SYSTEM_TYPES.has(a.systemAccountType))
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));

  const today = await companyToday(user.id, membership.companyId); // the COMPANY's today (ADR-007)

  return (
    <OpeningBalanceForm
      accounts={pickable}
      defaultDate={today}
      idempotencyKey={crypto.randomUUID()}
      notice={notice}
    />
  );
}

function displayName(a: { accountNumber: string | null; name: string }): string {
  return a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
}

function noticeFrom(error: string | undefined, ok: string | undefined): string | null {
  if (ok === 'set') return 'Opening balances posted.';
  if (ok === 'voided') return 'Opening balances voided — you can set them again.';
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please check the amounts and try again.';
  if (error === 'CONTROL_ACCOUNT_NOT_ALLOWED') return 'Accounts Receivable and Accounts Payable cannot be entered here — add the outstanding invoices and bills instead.';
  if (error === 'OBE_NOT_ALLOWED') return 'Opening Balance Equity is posted automatically; do not enter it as a line.';
  if (error === 'OBE_ACCOUNT_NOT_CONFIGURED') return 'This company has no Opening Balance Equity account configured.';
  if (error === 'OPENING_BALANCE_ALREADY_SET') return 'Opening balances are already set. Void them before setting again.';
  if (error === 'OPENING_BALANCE_NOT_SET') return 'No opening balances are set to void.';
  if (error === 'PERIOD_CLOSED') return 'That conversion date falls in a closed period.';
  if (error === 'INACTIVE_ACCOUNT') return 'One of the accounts is inactive.';
  if (error === 'ACCOUNT_NOT_FOUND') return 'One of the accounts does not exist.';
  if (error === 'IDEMPOTENCY_KEY_CONFLICT') return 'That submission was already used for different figures — reload and try again.';
  if (error === 'denied') return 'You do not have permission to set opening balances.';
  return 'Opening balances could not be set.';
}
