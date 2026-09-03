'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { postJournalEntryAction } from '../actions';

/**
 * Manual journal entry form — LL-035.
 *
 * THE RUNNING TOTALS AND THE DISABLED SUBMIT ARE ADVISORY ONLY. `LedgerService`
 * on the server is authoritative: it re-authorizes, re-validates balance,
 * accounts, and period, and re-derives everything from the submitted values,
 * regardless of what this component computed or whether Submit was disabled.
 * Disabling Submit when obviously unbalanced is a courtesy to the user, never a
 * control — a client that removes the attribute and posts garbage is refused by
 * the server exactly the same.
 *
 * Totals are computed with decimal.js from the raw string values. `parseFloat` is
 * never used for a monetary total, even for display — a UI total that disagrees
 * with the server's is a support ticket waiting to happen (ADR-004).
 */

interface AccountOption {
  readonly id: string;
  readonly accountNumber: string | null;
  readonly name: string;
}

interface Line {
  readonly key: number;
  readonly accountText: string;
  readonly accountId: string;
  readonly description: string;
  readonly debit: string;
  readonly credit: string;
}

const MONEY_RE = /^-?\d*(\.\d*)?$/;

/** Sum money strings with decimal.js; anything not yet a valid number counts as 0. */
function safeSum(values: readonly string[]): Decimal {
  return values.reduce((acc, raw) => {
    const v = raw.trim();
    if (v === '' || v === '-' || v === '.' || !MONEY_RE.test(v)) return acc;
    try {
      return acc.plus(new Decimal(v));
    } catch {
      return acc;
    }
  }, new Decimal(0));
}

function displayOf(a: AccountOption): string {
  return a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
}

let nextKey = 0;
function blankLine(): Line {
  nextKey += 1;
  return { key: nextKey, accountText: '', accountId: '', description: '', debit: '', credit: '' };
}

export function JournalEntryForm({
  accounts,
  defaultDate,
  notice,
}: {
  accounts: AccountOption[];
  defaultDate: string;
  notice: string | null;
}) {
  const [lines, setLines] = useState<Line[]>(() => [blankLine(), blankLine()]);

  // Resolve a typed value to an account id: match the display string, the bare
  // name, or the account number (case-insensitive). Ambiguous or unknown → ''.
  const resolveAccountId = (text: string): string => {
    const t = text.trim().toLowerCase();
    if (t === '') return '';
    const matches = accounts.filter(
      (a) =>
        displayOf(a).toLowerCase() === t ||
        a.name.toLowerCase() === t ||
        (a.accountNumber ?? '').toLowerCase() === t,
    );
    return matches.length === 1 ? matches[0]!.id : '';
  };

  const update = (key: number, patch: Partial<Line>): void => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const totalDebit = useMemo(() => safeSum(lines.map((l) => l.debit)), [lines]);
  const totalCredit = useMemo(() => safeSum(lines.map((l) => l.credit)), [lines]);
  const difference = totalDebit.minus(totalCredit);
  const filledLines = lines.filter((l) => l.accountId !== '' && safeSum([l.debit, l.credit]).gt(0)).length;
  const looksPostable = difference.isZero() && totalDebit.gt(0) && filledLines >= 2;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">New Journal Entry</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Company
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      <form action={postJournalEntryAction} data-testid="journal-entry-form" className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Transaction date
            <input
              type="date"
              name="transactionDate"
              required
              defaultValue={defaultDate}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Posting date
            <input
              type="date"
              name="postingDate"
              defaultValue={defaultDate}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Reference / description
            <input
              type="text"
              name="description"
              placeholder="e.g. Owner capital contribution"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        {/* Options are ONLY this company's active accounts (page-scoped) — the
            picker cannot surface another tenant's or a deactivated account. */}
        <datalist id="account-options">
          {accounts.map((a) => (
            <option key={a.id} value={displayOf(a)} />
          ))}
        </datalist>

        <table className="w-full border-collapse text-sm" data-testid="lines-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Debit</th>
              <th className="py-2 pr-2 text-right">Credit</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} data-testid="line-row">
                <td className="py-1 pr-2">
                  <input
                    list="account-options"
                    aria-label={`Account line ${String(i + 1)}`}
                    data-testid={`line-account-${String(i)}`}
                    value={line.accountText}
                    onChange={(e) => {
                      update(line.key, { accountText: e.target.value, accountId: resolveAccountId(e.target.value) });
                    }}
                    placeholder="Search account…"
                    className="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  {/* The resolved id is what actually posts. */}
                  <input type="hidden" name="accountId" value={line.accountId} />
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="text"
                    name="lineDescription"
                    value={line.description}
                    onChange={(e) => { update(line.key, { description: e.target.value }); }}
                    className="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    name="debit"
                    aria-label={`Debit line ${String(i + 1)}`}
                    data-testid={`line-debit-${String(i)}`}
                    value={line.debit}
                    onChange={(e) => { update(line.key, { debit: e.target.value }); }}
                    className="w-28 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    name="credit"
                    aria-label={`Credit line ${String(i + 1)}`}
                    data-testid={`line-credit-${String(i)}`}
                    value={line.credit}
                    onChange={(e) => { update(line.key, { credit: e.target.value }); }}
                    className="w-28 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </td>
                <td className="py-1 text-right">
                  {lines.length > 2 && (
                    <button
                      type="button"
                      aria-label={`Remove line ${String(i + 1)}`}
                      onClick={() => { setLines((prev) => prev.filter((l) => l.key !== line.key)); }}
                      className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-2 pr-2 text-right" colSpan={2}>
                Totals
              </td>
              <td className="py-2 pr-2 text-right" data-testid="total-debit">
                {totalDebit.toFixed(2)}
              </td>
              <td className="py-2 pr-2 text-right" data-testid="total-credit">
                {totalCredit.toFixed(2)}
              </td>
              <td />
            </tr>
            <tr>
              <td className="py-1 pr-2 text-right text-neutral-500" colSpan={2}>
                Difference (advisory)
              </td>
              <td className="py-1 pr-2 text-right" colSpan={2} data-testid="difference">
                {difference.toFixed(2)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setLines((prev) => [...prev, blankLine()]); }}
            className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
          >
            Add line
          </button>
          <span className="flex-1" />
          <button
            type="submit"
            data-testid="post-entry"
            disabled={!looksPostable}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Post entry
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          Posting is final. A posted entry cannot be edited — corrections are made by reversal.
        </p>
      </form>
    </main>
  );
}
