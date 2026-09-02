'use client';

import { useState } from 'react';

import { deactivateAccountAction, updateAccountAction } from './actions';

import type { Account } from '@/db/schema';

/**
 * One account row. When editable, a system account still cannot have its
 * system_account_type changed (the service rejects it, and the form does not
 * offer it) and cannot be deactivated (the button is withheld AND the server
 * refuses). The UI withholding is cosmetic; the service is authoritative.
 */
export function AccountRow({ account, canManage }: { account: Account; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const isSystem = account.systemAccountType !== null;
  const inactive = account.status === 'INACTIVE';

  if (editing) {
    return (
      <tr className="border-b border-neutral-200 dark:border-neutral-800">
        <td className="py-2 pr-2 font-mono">{account.accountNumber}</td>
        <td colSpan={4} className="py-2 pr-2">
          <form action={updateAccountAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="accountId" value={account.id} />
            <input name="name" defaultValue={account.name} required className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
            <input name="accountSubtype" defaultValue={account.accountSubtype ?? ''} placeholder="subtype" className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
            <button type="submit" className="rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900">Save</button>
            <button type="button" onClick={() => { setEditing(false); }} className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">Cancel</button>
          </form>
        </td>
        {canManage && <td />}
      </tr>
    );
  }

  return (
    <tr className={`border-b border-neutral-200 dark:border-neutral-800 ${inactive ? 'text-neutral-400' : ''}`} data-testid="account-row">
      <td className="py-2 pr-2 font-mono">{account.accountNumber}</td>
      <td className="py-2 pr-2">
        {account.name}
        {isSystem && (
          <span data-testid="system-badge" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            system
          </span>
        )}
      </td>
      <td className="py-2 pr-2">{account.accountType}</td>
      <td className="py-2 pr-2">{account.accountSubtype}</td>
      <td className="py-2 pr-2">{account.status}</td>
      {canManage && (
        <td className="py-2">
          <div className="flex gap-2">
            <button type="button" onClick={() => { setEditing(true); }} className="text-xs underline">Edit</button>
            {/* System accounts and already-inactive ones offer no deactivate —
                and the server refuses it regardless. */}
            {!isSystem && !inactive && (
              <form action={deactivateAccountAction}>
                <input type="hidden" name="accountId" value={account.id} />
                <button type="submit" data-testid="deactivate" className="text-xs text-red-600 underline dark:text-red-400">Deactivate</button>
              </form>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}
