'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { accountLabel } from './format';

/**
 * Invoice draft form — LL-044. Create or edit a DRAFT.
 *
 * THE ADVISORY TOTALS ARE COSMETIC. The server (`createInvoice`/`updateInvoice`)
 * re-authorizes, re-validates the customer and every line account in-company, and
 * RE-DERIVES subtotal/tax/total with decimal.js (ADR-013), regardless of what this
 * component computed. Totals here use decimal.js too — `parseFloat` is never used
 * for money, even for display (ADR-004).
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
  readonly taxRate: string;
}

export interface InvoiceFormInitial {
  readonly invoiceId: string;
  readonly customerText: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly memo: string;
  readonly lines: readonly Omit<Line, 'key'>[];
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
  return { key: nextKey, accountText: '', accountId: '', description: '', quantity: '1', unitPrice: '', taxRate: '0' };
}

export function InvoiceForm({
  customers,
  accounts,
  defaultDate,
  action,
  submitLabel,
  notice,
  initial,
}: {
  customers: Option[];
  accounts: AccountOption[];
  defaultDate: string;
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  notice: string | null;
  initial?: InvoiceFormInitial;
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

  const resolveCustomerId = (text: string): string => {
    const t = text.trim().toLowerCase();
    const matches = customers.filter((c) => c.label.toLowerCase() === t);
    return matches.length === 1 ? matches[0]!.id : '';
  };

  const [customerText, setCustomerText] = useState(initial?.customerText ?? '');
  const [lines, setLines] = useState<Line[]>(() =>
    initial === undefined
      ? [blankLine()]
      : initial.lines.map((l) => {
          nextKey += 1;
          return { key: nextKey, ...l };
        }),
  );

  const update = (key: number, patch: Partial<Line>): void => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const totals = useMemo(() => {
    let subtotal = new Decimal(0);
    let tax = new Decimal(0);
    for (const l of lines) {
      const amount = money(l.quantity).times(money(l.unitPrice)).toDecimalPlaces(4);
      subtotal = subtotal.plus(amount);
      tax = tax.plus(amount.times(money(l.taxRate)).dividedBy(100).toDecimalPlaces(4));
    }
    return { subtotal, tax, total: subtotal.plus(tax) };
  }, [lines]);

  const customerId = resolveCustomerId(customerText);
  const hasLine = lines.some((l) => l.accountId !== '' && money(l.unitPrice).gt(0));
  const looksPostable = customerId !== '' && hasLine;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{initial === undefined ? 'New Invoice' : 'Edit Invoice'}</h1>
        <Link href="/invoices" className="text-sm text-neutral-500 underline">
          ← Invoices
        </Link>
      </header>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {notice}
        </p>
      )}

      <datalist id="customer-options">
        {customers.map((c) => (
          <option key={c.id} value={c.label} />
        ))}
      </datalist>
      <datalist id="revenue-account-options">
        {accounts.map((a) => (
          <option key={a.id} value={accountLabel(a)} />
        ))}
      </datalist>

      <form action={action} data-testid="invoice-form" className="flex flex-col gap-4">
        {initial !== undefined && <input type="hidden" name="invoiceId" value={initial.invoiceId} />}

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Customer
            <input
              list="customer-options"
              data-testid="invoice-customer"
              value={customerText}
              onChange={(e) => { setCustomerText(e.target.value); }}
              placeholder="Search customer…"
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <input type="hidden" name="customerId" value={customerId} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Invoice date
            <input type="date" name="invoiceDate" required defaultValue={initial?.invoiceDate ?? defaultDate}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Due date
            <input type="date" name="dueDate" defaultValue={initial?.dueDate ?? ''}
              className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Memo
          <input type="text" name="memo" defaultValue={initial?.memo ?? ''} placeholder="Optional note on the invoice"
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>

        <table className="w-full border-collapse text-sm" data-testid="invoice-lines">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Revenue account</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Qty</th>
              <th className="py-2 pr-2 text-right">Unit price</th>
              <th className="py-2 pr-2 text-right">Tax %</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.key} data-testid="invoice-line-row">
                <td className="py-1 pr-2">
                  <input
                    list="revenue-account-options"
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
                <td className="py-1 pr-2">
                  <input type="text" inputMode="decimal" name="taxRate" aria-label={`Tax rate line ${String(i + 1)}`}
                    value={line.taxRate}
                    onChange={(e) => { update(line.key, { taxRate: e.target.value }); }}
                    className="w-16 rounded border border-neutral-300 px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-900" />
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
            <tr className="border-t border-neutral-300 dark:border-neutral-700">
              <td className="py-2 pr-2 text-right text-neutral-500" colSpan={4}>Subtotal</td>
              <td className="py-2 pr-2 text-right" colSpan={2} data-testid="subtotal">{totals.subtotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td className="py-1 pr-2 text-right text-neutral-500" colSpan={4}>Tax</td>
              <td className="py-1 pr-2 text-right" colSpan={2} data-testid="tax-total">{totals.tax.toFixed(2)}</td>
            </tr>
            <tr className="font-medium">
              <td className="py-1 pr-2 text-right" colSpan={4}>Total (advisory)</td>
              <td className="py-1 pr-2 text-right" colSpan={2} data-testid="grand-total">{totals.total.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setLines((prev) => [...prev, blankLine()]); }}
            className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700">Add line</button>
          <span className="flex-1" />
          <button type="submit" data-testid="save-invoice" disabled={!looksPostable}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900">
            {submitLabel}
          </button>
        </div>
        <p className="text-xs text-neutral-400">A draft can be edited freely. Finalizing assigns a number and posts it to the ledger.</p>
      </form>
    </main>
  );
}
