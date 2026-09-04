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

export default async function AccountPage() {
  const session = await getAuth().api.getSession({ headers: await headers() });

  if (session === null) {
    redirect('/sign-in');
  }

  // Controlled provisioning (LL-011): the application user comes into being on
  // first authenticated entry. Idempotent; grants no company access.
  const appUser = await ensureAppUser(session.user);
  const [companies, active] = await Promise.all([
    listCompaniesForUser(appUser.id),
    getActiveCompanyMembership(appUser.id),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Account</h1>
      <dl className="text-sm">
        <dt className="text-neutral-500">Signed in as</dt>
        <dd data-testid="account-email" className="font-mono">
          {appUser.email}
        </dd>
      </dl>
      <CompanyPanel companies={companies} active={active} />
      {active !== null && (
        <nav className="flex flex-col gap-1">
          <a href="/accounts" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Chart of Accounts →
          </a>
          <Link href="/customers" data-testid="customers-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Customers →
          </Link>
          <Link href="/invoices" data-testid="invoices-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Invoices →
          </Link>
          <Link href="/payments" data-testid="payments-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
            Payments →
          </Link>
          {roleHasCapability(active.role, 'journal.create') && (
            <Link href="/journal/new" data-testid="new-journal-entry-link" className="text-sm text-neutral-600 underline dark:text-neutral-300">
              New Journal Entry →
            </Link>
          )}
        </nav>
      )}
      <SignOutButton />
    </main>
  );
}
