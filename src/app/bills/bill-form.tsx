'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { createBillAction } from './actions';
import { accountLabel } from './format';

/**
 * Bill draft form — LL-065. Create a DRAFT bill. The A/P mirror of the invoice form
 * (no tax leg — a bill's total is the sum of its lines, LL-061).
 *
 * THE ADVISORY TOTAL IS COSMETIC. The server (`createBill`) re-authorizes,
 * re-validates the vendor and every line account in-company, and RE-DERIVES the total
 * with decimal.js (ADR-013), regardless of what this component computed. The total
 * here uses decimal.js too — `parseFloat` is never used for money (ADR-004).
 */

interface Option {
  readonly id: string;
  readonly label: string;
}
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
  readonly quantity: string;
  readonly unitPrice: string;
}

const NUM_RE = /^\d*(\.\d*)?$/;

function money(raw: string): Decimal {
  const v = raw.trim();
  if (v === '' || v === '.' || !NUM_RE.test(v)) return new Decimal(0);
  try {
    return new Decimal(v);
  } catch {
    return new Decimal(0);
  }
}
let nextKey = 0;
function blankLine(): Line {
  nextKey += 1;
  return { key: nextKey, accountText: '', accountId: '', description: '', quantity: '1', unitPrice: '' };
}

export function BillForm({
  vendors,
  accounts,
  defaultDate,
  notice,
}: {
  vendors: Option[];
  accounts: AccountOption[];
  defaultDate: string;
  notice: string | null;
}) {
  const accountByLabel = useMemo(() => {
    const m = new Map<string, AccountOption[]>();
    for (const a of accounts) {
      for (const key of [accountLabel(a).toLowerCase(), a.name.toLowerCase(), (a.accountNumber ?? '').toLowerCase()]) {
        if (key !== '') m.set(key, [...(m.get(key) ?? []), a]);
      }
    }
    return m;
  }, [accounts]);
  const resolveAccountId = (text: string): string => {
    const matches = accountByLabel.get(text.trim().toLowerCase());
    return matches !== undefined && matches.length === 1 ? matches[0]!.id : '';
  };

  const resolveVendorId = (text: string): string => {
    const t = text.trim().toLowerCase();
    const matches = vendors.filter((v) => v.label.toLowerCase() === t);
    return matches.length === 1 ? matches[0]!.id : '';
  };

  const [vendorText, setVendorText] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);

  const update = (key: number, patch: Partial<Line>): void => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const total = useMemo(() => {
    let sum = new Decimal(0);
    for (const l of lines) {
      sum = sum.plus(money(l.quantity).times(money(l.unitPrice)).toDecimalPlaces(4));
    }
    return sum;
  }, [lines]);

  const vendorId = resolveVendorId(vendorText);
  const hasLine = lines.some((l) => l.accountId !== '' && money(l.unitPrice).gt(0));
  const looksPostable = vendorId !== '' && hasLine;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">New Bill</h1>
        <Link href="/bills" className="text-sm text-neutral-500 underline">
          ← Bills
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      <datalist id="vendor-options">
        {vendors.map((v) => (
          <option key={v.id} value={v.label} />
        ))}
      </datalist>
      <datalist id="bill-account-options">
        {accounts.map((a) => (
          <option key={a.id} value={accountLabel(a)} />
        ))}
      </datalist>

      <form action={createBillAction} data-testid="bill-form" className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Vendor
            <input
              list="vendor-options"
              data-testid="bill-vendor"
              value={vendorText}
              onChange={(e) => { setVendorText(e.target.value); }}
              placeholder="Search vendor…"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <input type="hidden" name="vendorId" value={vendorId} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Bill date
            <input type="date" name="billDate" required defaultValue={defaultDate}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Due date
            <input type="date" name="dueDate" defaultValue=""
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Memo
          <input type="text" name="memo" defaultValue="" placeholder="Optional note on the bill"
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>

        <table className="w-full border-collapse text-sm" data-testid="bill-lines">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Expense account</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Qty</th>
              <th className="py-2 pr-2 text-right">Unit price</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} data-testid="bill-line-row">
                <td className="py-1 pr-2">
                  <input
                    list="bill-account-options"
                    aria-label={`Account line ${String(i + 1)}`}
                    data-testid={`line-account-${String(i)}`}
                    value={line.accountText}
                    onChange={(e) => { update(line.key, { accountText: e.target.value, accountId: resolveAccountId(e.target.value) }); }}
                    placeholder="Search account…"
                    className="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <input type="hidden" name="accountId" value={line.accountId} />
                </td>
                <td className="py-1 pr-2">
                  <input type="text" name="lineDescription" value={line.description}
                    onChange={(e) => { update(line.key, { description: e.target.value }); }}
                    className="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
                </td>
                <td className="py-1 pr-2">
                  <input type="text" inputMode="decimal" name="quantity" aria-label={`Quantity line ${String(i + 1)}`}
                    data-testid={`line-qty-${String(i)}`} value={line.quantity}
                    onChange={(e) => { update(line.key, { quantity: e.target.value }); }}
                    className="w-20 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900" />
                </td>
                <td className="py-1 pr-2">
                  <input type="text" inputMode="decimal" name="unitPrice" aria-label={`Unit price line ${String(i + 1)}`}
                    data-testid={`line-price-${String(i)}`} value={line.unitPrice}
                    onChange={(e) => { update(line.key, { unitPrice: e.target.value }); }}
                    className="w-28 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900" />
                </td>
                <td className="py-1 text-right">
                  {lines.length > 1 && (
                    <button type="button" aria-label={`Remove line ${String(i + 1)}`}
                      onClick={() => { setLines((prev) => prev.filter((l) => l.key !== line.key)); }}
                      className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">✕</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-2 pr-2 text-right" colSpan={3}>Total (advisory)</td>
              <td className="py-2 pr-2 text-right" colSpan={2} data-testid="grand-total">{total.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setLines((prev) => [...prev, blankLine()]); }}
            className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">Add line</button>
          <span className="flex-1" />
          <button type="submit" data-testid="save-bill" disabled={!looksPostable}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900">
            Create draft
          </button>
        </div>
        <p className="text-xs text-neutral-400">Finalizing assigns a number and posts Dr Expense / Cr Accounts Payable to the ledger.</p>
      </form>
    </main>
  );
}
