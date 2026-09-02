'use client';

import { useState } from 'react';

import { createAccountAction } from './actions';

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE'] as const;

export function CreateAccountForm() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="self-start rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        New account
      </button>
    );
  }
  return (
    <form action={createAccountAction} className="flex flex-col gap-2 rounded border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="flex gap-2">
        <input name="accountNumber" placeholder="Number (optional)" className="w-32 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
        <input name="name" placeholder="Account name" required className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
      </div>
      <div className="flex gap-2">
        <select name="accountType" required defaultValue="" className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900">
          <option value="" disabled>Type…</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input name="accountSubtype" placeholder="Subtype (optional)" className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
      </div>
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-neutral-900 px-3 py-1 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">Create</button>
        <button type="button" onClick={() => { setOpen(false); }} className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">Cancel</button>
      </div>
    </form>
  );
}
