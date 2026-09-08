'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { payBillAction } from './actions';

/**
 * Pay-bill form — LL-065, the A/P mirror of the receive-payment form.
 *
 * THE ADVISORY TOTAL IS COSMETIC. `payBill` re-authorizes, re-validates every
 * application (the bill is OPEN, belongs to this vendor, and the amount is ≤ its open
 * balance) and re-derives the payment amount as the sum of the applications,
 * regardless of what this computed. Totals use decimal.js — never parseFloat for money
 * (ADR-004).
 */

interface Option {
  readonly id: string;
  readonly label: string;
}
interface OpenBillOption {
  readonly id: string;
  readonly billNumber: string | null;
  readonly vendorId: string;
  readonly billDate: string;
  readonly openBalance: string;
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
function resolveId(options: readonly Option[], text: string): string {
  const t = text.trim().toLowerCase();
  const matches = options.filter((o) => o.label.toLowerCase() === t);
  return matches.length === 1 ? matches[0]!.id : '';
}

export function BillPaymentForm({
  vendors,
  openBills,
  cashAccounts,
  defaultDate,
  notice,
}: {
  vendors: Option[];
  openBills: OpenBillOption[];
  cashAccounts: Option[];
  defaultDate: string;
  notice: string | null;
}) {
  const [vendorText, setVendorText] = useState('');
  const [cashText, setCashText] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const vendorId = resolveId(vendors, vendorText);
  const cashAccountId = resolveId(cashAccounts, cashText);
  const bills = useMemo(
    () => (vendorId === '' ? [] : openBills.filter((b) => b.vendorId === vendorId)),
    [vendorId, openBills],
  );

  const total = useMemo(
    () => bills.reduce((sum, b) => sum.plus(money(amounts[b.id] ?? '')), new Decimal(0)),
    [bills, amounts],
  );
  const looksPostable = vendorId !== '' && cashAccountId !== '' && total.gt(0);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Pay Bills</h1>
        <Link href="/bill-payments" className="text-sm text-neutral-500 underline">
          ← Bill payments
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      <datalist id="bill-payment-vendor-options">
        {vendors.map((v) => (
          <option key={v.id} value={v.label} />
        ))}
      </datalist>
      <datalist id="cash-account-options">
        {cashAccounts.map((a) => (
          <option key={a.id} value={a.label} />
        ))}
      </datalist>

      <form action={payBillAction} data-testid="bill-payment-form" className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Vendor
            <input list="bill-payment-vendor-options" data-testid="bill-payment-vendor" value={vendorText}
              onChange={(e) => { setVendorText(e.target.value); }} placeholder="Search vendor…"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
            <input type="hidden" name="vendorId" value={vendorId} />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Pay from
            <input list="cash-account-options" data-testid="bill-payment-cash" value={cashText}
              onChange={(e) => { setCashText(e.target.value); }} placeholder="Cash / Checking…"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
            <input type="hidden" name="cashAccountId" value={cashAccountId} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Date
            <input type="date" name="paymentDate" required defaultValue={defaultDate}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-sm">
            Method
            <input type="text" name="method" placeholder="e.g. CHECK"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Reference
            <input type="text" name="reference" placeholder="e.g. check #2048"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Memo
            <input type="text" name="memo"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
        </div>

        <table className="w-full border-collapse text-sm" data-testid="apply-table">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Bill</th>
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2 text-right">Open balance</th>
              <th className="py-2 pr-2 text-right">Apply</th>
            </tr>
          </thead>
          <tbody>
            {vendorId === '' ? (
              <tr><td colSpan={4} className="py-6 text-center text-neutral-500">Pick a vendor to see their open bills.</td></tr>
            ) : bills.length === 0 ? (
              <tr><td colSpan={4} className="py-6 text-center text-neutral-500">This vendor has no open bills.</td></tr>
            ) : (
              bills.map((b, i) => (
                <tr key={b.id} data-testid="apply-row" className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-1 pr-2">{b.billNumber ?? '(draft)'}</td>
                  <td className="py-1 pr-2 text-neutral-500">{b.billDate}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{b.openBalance}</td>
                  <td className="py-1 pr-2 text-right">
                    <input type="hidden" name="applyBillId" value={b.id} />
                    <input type="text" inputMode="decimal" name="applyAmount"
                      aria-label={`Apply to ${b.billNumber ?? 'bill'} ${String(i + 1)}`}
                      data-testid={`apply-amount-${String(i)}`} value={amounts[b.id] ?? ''}
                      onChange={(e) => { setAmounts((prev) => ({ ...prev, [b.id]: e.target.value })); }}
                      className="w-28 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900" />
                    <button type="button" aria-label={`Pay full ${String(i + 1)}`}
                      onClick={() => { setAmounts((prev) => ({ ...prev, [b.id]: b.openBalance })); }}
                      className="ml-1 rounded border border-neutral-300 px-1 py-1 text-xs dark:border-neutral-700">Full</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-2 pr-2 text-right" colSpan={3}>Payment total</td>
              <td className="py-2 pr-2 text-right" data-testid="bill-payment-total">{total.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="flex items-center">
          <span className="flex-1" />
          <button type="submit" data-testid="save-bill-payment" disabled={!looksPostable}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900">
            Pay bills
          </button>
        </div>
        <p className="text-xs text-neutral-400">The payment amount is the sum of what you apply. Posting is Dr Accounts Payable / Cr the cash account.</p>
      </form>
    </main>
  );
}
