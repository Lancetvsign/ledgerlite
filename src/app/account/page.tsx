import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { listCompaniesForUser } from '@/server/companies';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';

import { CompanyPanel } from './company-panel';
import { SignOutButton } from './sign-out-button';

/**
 * The PROTECTED demonstration route (the landing page is the unprotected one).
 *
 * The check happens here in the page itself, not in middleware — middleware is
 * a convenience layer and never the sole enforcement point (AGENTS.md §6).
 *
 * Note what this page does NOT do: grant anything beyond identity. Company
 * data access requires membership checks that arrive in LL-013.
 */
export const runtime = 'nodejs';
// Never prerendered: the session check must run per request, and running it at
// build time would also demand BETTER_AUTH_SECRET in every build environment.
export const dynamic = 'force-dynamic';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });

  if (session === null) {
    redirect('/sign-in');
  }

  // Controlled provisioning (LL-011): the application user comes into being on
  // first authenticated entry. Idempotent; grants no company access.
  const appUser = await ensureAppUser(session.user);
  const [companies, active, sp] = await Promise.all([
    listCompaniesForUser(appUser.id),
    getActiveCompanyMembership(appUser.id),
    searchParams,
  ]);
  const notice = noticeFrom(sp);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Account</h1>
      {notice !== null && (
        <p
          role="status"
          data-testid="notice"
          className={
            notice.tone === 'ok'
              ? 'rounded bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300'
              : 'rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300'
          }
        >
          {notice.text}
        </p>
      )}
      <dl className="text-sm">
        <dt className="text-neutral-500">Signed in as</dt>
        <dd data-testid="account-email" className="font-mono">
          {appUser.email}
        </dd>
      </dl>
      <CompanyPanel companies={companies} active={active} />
      {active !== null && (
        <nav className="flex flex-col gap-1">
          <Link href="/dashboard" data-testid="dashboard-link" className="text-sm font-medium text-neutral-800 underline dark:text-neutral-100">
            Dashboard →
          </Link>
          <a href="/accounts" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Chart of Accounts →
          </a>
          <Link href="/customers" data-testid="customers-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Customers →
          </Link>
          <Link href="/vendors" data-testid="vendors-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Vendors →
          </Link>
          <Link href="/invoices" data-testid="invoices-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Invoices →
          </Link>
          <Link href="/payments" data-testid="payments-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Payments →
          </Link>
          <Link href="/bills" data-testid="bills-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Bills →
          </Link>
          <Link href="/bill-payments" data-testid="bill-payments-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Bill Payments →
          </Link>
          <Link href="/reports" data-testid="reports-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Reports →
          </Link>
          {roleHasCapability(active.role, 'journal.create') && (
            <Link href="/journal/new" data-testid="new-journal-entry-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
              New Journal Entry →
            </Link>
          )}
          {roleHasCapability(active.role, 'journal.post') && (
            <Link href="/opening-balances" data-testid="opening-balances-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
              Opening Balances →
            </Link>
          )}
          {roleHasCapability(active.role, 'period.close') && (
            <Link href="/year-end" data-testid="year-end-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
              Year-end Close →
            </Link>
          )}
          {roleHasCapability(active.role, 'journal.post') && (
            <Link href="/bank-import" data-testid="bank-import-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
              Bank Import →
            </Link>
          )}
          {roleHasCapability(active.role, 'reconciliation.view') && (
            <Link href="/reconciliation" data-testid="reconciliation-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
              Bank Reconciliation →
            </Link>
          )}
        </nav>
      )}
      <SignOutButton />
    </main>
  );
}

function noticeFrom(sp: { ok?: string; error?: string }): { tone: 'ok' | 'error'; text: string } | null {
  if (sp.ok === 'company-archived') {
    return { tone: 'ok', text: 'Company archived: it had posted history, so its records are kept but it is hidden from every list.' };
  }
  if (sp.ok === 'company-purged') return { tone: 'ok', text: 'Company deleted.' };
  if (sp.error === undefined) return null;
  if (sp.error === 'NAME_MISMATCH') return { tone: 'error', text: 'The name you typed does not match the company name. Nothing was deleted.' };
  if (sp.error === 'invalid-company') return { tone: 'error', text: 'Enter a legal name for the new company.' };
  if (sp.error === 'denied') return { tone: 'error', text: 'You do not have permission for that.' };
  return { tone: 'error', text: 'That action could not be completed.' };
}
