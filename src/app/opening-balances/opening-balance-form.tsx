'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { setOpeningBalancesAction } from './actions';

/**
 * Opening-balances form — LL-071.
 *
 * The running totals and the live Opening Balance Equity plug are ADVISORY. The service
 * on the server is authoritative: it re-authorizes, re-validates the period and accounts,
 * rejects A/R/A/P/OBE lines, appends the OBE plug, and enforces set-once — regardless of
 * what this component computed. Totals use decimal.js on the raw strings; `parseFloat` is
 * never used for a monetary total, even for display (ADR-004).
 *
 * Unlike a manual journal entry, this entry is ALWAYS balanced by construction — the
 * server appends an Opening Balance Equity line equal to the difference — so Submit is
 * enabled as soon as one real line is filled, not gated on debits equalling credits.
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
  readonly debit: string;
  readonly credit: string;
}

const MONEY_RE = /^-?\d*(\.\d*)?$/;

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
  return { key: nextKey, accountText: '', accountId: '', debit: '', credit: '' };
}

export function OpeningBalanceForm({
  accounts,
  defaultDate,
  idempotencyKey,
  notice,
}: {
  accounts: AccountOption[];
  defaultDate: string;
  idempotencyKey: string;
  notice: string | null;
}) {
  const [lines, setLines] = useState<Line[]>(() => [blankLine(), blankLine()]);

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
  // The Opening Balance Equity plug the server will append to balance the entry.
  const plug = totalDebit.minus(totalCredit);
  const filledLines = lines.filter((l) => l.accountId !== '' && safeSum([l.debit, l.credit]).gt(0)).length;
  const looksPostable = filledLines >= 1;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Opening balances</h1>
        <Link href="/account" className="text-sm text-neutral-500 underline">
          ← Company
        </Link>
      </header>

      <p className="text-sm text-neutral-500">
        Enter each account&apos;s starting balance as of your conversion date. The difference is posted
        automatically to <strong>Opening Balance Equity</strong>. Accounts Receivable and Accounts Payable
        are entered as outstanding invoices and bills, not here.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      <form action={setOpeningBalancesAction} data-testid="opening-balance-form" className="flex flex-col gap-4">
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Conversion date
            <input
              type="date"
              name="conversionDate"
              required
              defaultValue={defaultDate}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        {/* Options exclude A/R, A/P, and Opening Balance Equity (page-scoped). */}
        <datalist id="ob-account-options">
          {accounts.map((a) => (
            <option key={a.id} value={displayOf(a)} />
          ))}
        </datalist>

        <table className="w-full border-collapse text-sm" data-testid="ob-lines-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2 text-right">Debit</th>
              <th className="py-2 pr-2 text-right">Credit</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} data-testid="ob-line-row">
                <td className="py-1 pr-2">
                  <input
                    list="ob-account-options"
                    aria-label={`Account line ${String(i + 1)}`}
                    data-testid={`ob-line-account-${String(i)}`}
                    value={line.accountText}
                    onChange={(e) => {
                      update(line.key, { accountText: e.target.value, accountId: resolveAccountId(e.target.value) });
                    }}
                    placeholder="Search account…"
                    className="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <input type="hidden" name="accountId" value={line.accountId} />
                </td>
                <td className="py-1 pr-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    name="debit"
                    aria-label={`Debit line ${String(i + 1)}`}
                    data-testid={`ob-line-debit-${String(i)}`}
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
                    data-testid={`ob-line-credit-${String(i)}`}
                    value={line.credit}
                    onChange={(e) => { update(line.key, { credit: e.target.value }); }}
                    className="w-28 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </td>
                <td className="py-1 text-right">
                  {lines.length > 1 && (
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
              <td className="py-2 pr-2 text-right">Totals</td>
              <td className="py-2 pr-2 text-right" data-testid="ob-total-debit">{totalDebit.toFixed(2)}</td>
              <td className="py-2 pr-2 text-right" data-testid="ob-total-credit">{totalCredit.toFixed(2)}</td>
              <td />
            </tr>
            <tr>
              <td className="py-1 pr-2 text-right text-neutral-500">Opening Balance Equity (auto)</td>
              <td className="py-1 pr-2 text-right" colSpan={2} data-testid="ob-plug">
                {plug.isZero()
                  ? '0.00'
                  : plug.isPositive()
                    ? `credit ${plug.toFixed(2)}`
                    : `debit ${plug.abs().toFixed(2)}`}
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
            data-testid="set-opening-balances"
            disabled={!looksPostable}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Set opening balances
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          Opening balances are set once. To correct them, void and re-enter — while the setup period is still open.
        </p>
      </form>
    </main>
  );
}
