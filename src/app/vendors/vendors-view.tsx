import Link from 'next/link';

import { createVendorAction } from './actions';

import type { Vendor } from '@/db/schema';

/**
 * Vendors screen body — LL-065. A server component: the create form posts a server
 * action, so no client JS is needed. The form shows only when the viewer can manage
 * vendors; the action re-authorizes regardless (AGENTS §6). The A/P mirror of the
 * customers screen — surfaced here because a bill cannot be raised without a vendor.
 */
export function VendorsView({
  vendors,
  canManage,
  notice,
}: {
  vendors: Vendor[];
  canManage: boolean;
  notice: string | null;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Vendors</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Company
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          {notice}
        </p>
      )}

      {canManage && (
        <form action={createVendorAction} data-testid="create-vendor-form" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Name
            <input
              type="text"
              name="name"
              required
              data-testid="vendor-name"
              placeholder="Globex Supply Co."
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              name="email"
              placeholder="ap@globex.com"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Phone
            <input
              type="text"
              name="phone"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <button
            type="submit"
            data-testid="add-vendor"
            className="rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add vendor
          </button>
        </form>
      )}

      <table className="w-full border-collapse text-sm" data-testid="vendors-table">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-2">Name</th>
            <th className="py-2 pr-2">Email</th>
            <th className="py-2 pr-2">Phone</th>
            <th className="py-2 pr-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {vendors.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-6 text-center text-neutral-500">
                No vendors yet.
              </td>
            </tr>
          ) : (
            vendors.map((vendor) => (
              <tr key={vendor.id} data-testid="vendor-row" className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-2 pr-2">{vendor.name}</td>
                <td className="py-2 pr-2 text-neutral-500">{vendor.email ?? '—'}</td>
                <td className="py-2 pr-2 text-neutral-500">{vendor.phone ?? '—'}</td>
                <td className="py-2 pr-2">{vendor.status}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  );
}
