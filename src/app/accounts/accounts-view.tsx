import Link from 'next/link';

import { CreateAccountForm } from './create-account-form';
import { AccountRow } from './account-row';

import type { Account } from '@/db/schema';

/**
 * The chart-of-accounts screen body. Server component; renders the search box,
 * the create form (only when the viewer can manage), and one row per account.
 */
export function AccountsView({
  accounts,
  total,
  canManage,
  query,
  notice,
}: {
  accounts: Account[];
  total: number;
  canManage: boolean;
  query: string;
  notice: string | null;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Chart of Accounts</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Company
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {notice}
        </p>
      )}

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search number, name, type…"
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button type="submit" className="rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
          Search
        </button>
      </form>

      {canManage && <CreateAccountForm />}

      <table className="w-full border-collapse text-sm" data-testid="accounts-table">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Number</th>
            <th className="py-2 pr-2">Name</th>
            <th className="py-2 pr-2">Type</th>
            <th className="py-2 pr-2">Subtype</th>
            <th className="py-2 pr-2">Status</th>
            {canManage && <th className="py-2">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 6 : 5} className="py-6 text-center text-neutral-500">
                {total === 0 ? 'No accounts yet.' : 'No accounts match your search.'}
              </td>
            </tr>
          ) : (
            accounts.map((account) => (
              <AccountRow key={account.id} account={account} canManage={canManage} />
            ))
          )}
        </tbody>
      </table>

      <p className="text-xs text-neutral-400">
        {/* The single most important thing this screen does NOT show. */}
        Balances are derived from journal activity and are not shown here.
      </p>
    </main>
  );
}
