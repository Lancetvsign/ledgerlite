'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { receivePaymentAction } from './actions';

/**
 * Receive-payment form — LL-045.
 *
 * THE ADVISORY TOTAL IS COSMETIC. `receivePayment` re-authorizes, re-validates
 * every application (the invoice is OPEN, belongs to this customer, and the amount
 * is ≤ its open balance) and re-derives the payment amount as the sum of the
 * applications, regardless of what this computed. Totals use decimal.js — never
 * parseFloat for money (ADR-004).
 */

interface Option {
  readonly id: string;
  readonly label: string;
}
interface OpenInvoiceOption {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly customerId: string;
  readonly invoiceDate: string;
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

export function PaymentForm({
  customers,
  openInvoices,
  depositAccounts,
  defaultDate,
  notice,
}: {
  customers: Option[];
  openInvoices: OpenInvoiceOption[];
  depositAccounts: Option[];
  defaultDate: string;
  notice: string | null;
}) {
  const [customerText, setCustomerText] = useState('');
  const [depositText, setDepositText] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const customerId = resolveId(customers, customerText);
  const depositAccountId = resolveId(depositAccounts, depositText);
  const invoices = useMemo(
    () => (customerId === '' ? [] : openInvoices.filter((i) => i.customerId === customerId)),
    [customerId, openInvoices],
  );

  const total = useMemo(
    () => invoices.reduce((sum, i) => sum.plus(money(amounts[i.id] ?? '')), new Decimal(0)),
    [invoices, amounts],
  );
  const looksPostable = customerId !== '' && depositAccountId !== '' && total.gt(0);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Receive Payment</h1>
        <Link href="/payments" className="text-sm text-neutral-500 underline">
          ← Payments
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      <datalist id="payment-customer-options">
        {customers.map((c) => (
          <option key={c.id} value={c.label} />
        ))}
      </datalist>
      <datalist id="deposit-account-options">
        {depositAccounts.map((a) => (
          <option key={a.id} value={a.label} />
        ))}
      </datalist>

      <form action={receivePaymentAction} data-testid="payment-form" className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Customer
            <input list="payment-customer-options" data-testid="payment-customer" value={customerText}
              onChange={(e) => { setCustomerText(e.target.value); }} placeholder="Search customer…"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
            <input type="hidden" name="customerId" value={customerId} />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Deposit to
            <input list="deposit-account-options" data-testid="payment-deposit" value={depositText}
              onChange={(e) => { setDepositText(e.target.value); }} placeholder="Cash / Checking / Undeposited…"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
            <input type="hidden" name="depositAccountId" value={depositAccountId} />
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
            <input type="text" name="reference" placeholder="e.g. check #1024"
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
              <th className="py-2 pr-2">Invoice</th>
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2 text-right">Open balance</th>
              <th className="py-2 pr-2 text-right">Apply</th>
            </tr>
          </thead>
          <tbody>
            {customerId === '' ? (
              <tr><td colSpan={4} className="py-6 text-center text-neutral-500">Pick a customer to see their open invoices.</td></tr>
            ) : invoices.length === 0 ? (
              <tr><td colSpan={4} className="py-6 text-center text-neutral-500">This customer has no open invoices.</td></tr>
            ) : (
              invoices.map((inv, i) => (
                <tr key={inv.id} data-testid="apply-row" className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-1 pr-2">{inv.invoiceNumber ?? '(draft)'}</td>
                  <td className="py-1 pr-2 text-neutral-500">{inv.invoiceDate}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{inv.openBalance}</td>
                  <td className="py-1 pr-2 text-right">
                    <input type="hidden" name="applyInvoiceId" value={inv.id} />
                    <input type="text" inputMode="decimal" name="applyAmount"
                      aria-label={`Apply to ${inv.invoiceNumber ?? 'invoice'} ${String(i + 1)}`}
                      data-testid={`apply-amount-${String(i)}`} value={amounts[inv.id] ?? ''}
                      onChange={(e) => { setAmounts((prev) => ({ ...prev, [inv.id]: e.target.value })); }}
                      className="w-28 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900" />
                    <button type="button" aria-label={`Pay full ${String(i + 1)}`}
                      onClick={() => { setAmounts((prev) => ({ ...prev, [inv.id]: inv.openBalance })); }}
                      className="ml-1 rounded border border-neutral-300 px-1 py-1 text-xs dark:border-neutral-700">Full</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
              <td className="py-2 pr-2 text-right" colSpan={3}>Payment total</td>
              <td className="py-2 pr-2 text-right" data-testid="payment-total">{total.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="flex items-center">
          <span className="flex-1" />
          <button type="submit" data-testid="save-payment" disabled={!looksPostable}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900">
            Receive payment
          </button>
        </div>
        <p className="text-xs text-neutral-400">The payment amount is the sum of what you apply. Posting is Dr the deposit account / Cr Accounts Receivable.</p>
      </form>
    </main>
  );
}
