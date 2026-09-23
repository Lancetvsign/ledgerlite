import Link from 'next/link';

import { isCalendarDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money-format';
import { isUuid } from '@/lib/uuid';
import { listAccounts } from '@/server/accounts';
import { getAccountRegister, type AccountRegisterLine } from '@/server/reports';

import { requireReportContext } from '../report-context';

/**
 * Account Register screen — LL-085. Pure presentation over `getAccountRegister`:
 * one account's opening balance, every posted line in the period with a running
 * balance, totals, and the closing balance. Money is rendered straight from the
 * service's `string` values (ADR-004); nothing is recomputed here.
 *
 * Every row links to its source: the document when one has a screen (invoice, bill,
 * payment, bill payment, bank-import batch), otherwise the journal entry itself.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = {
  INVOICE: 'Invoice',
  CUSTOMER_PAYMENT: 'Customer payment',
  CUSTOMER_REFUND: 'Customer refund',
  CREDIT_MEMO: 'Credit memo',
  EXPENSE: 'Bill',
  DEPOSIT: 'Deposit',
  TRANSFER: 'Transfer',
  JOURNAL_ENTRY: 'Journal entry',
  OPENING_BALANCE: 'Opening balance',
  REVERSAL: 'Reversal',
  BAD_DEBT_WRITEOFF: 'Write-off',
  BILL_PAYMENT: 'Bill payment',
  VENDOR_CREDIT: 'Vendor credit',
  CLOSING: 'Year-end close',
  BANK_IMPORT: 'Bank import',
};

/** Where "the source" of a line lives; falls back to the journal entry's own page. */
function sourceHref(l: AccountRegisterLine): string {
  const id = l.sourceId !== null && isUuid(l.sourceId) ? l.sourceId : null;
  switch (l.sourceType) {
    case 'INVOICE':
      return id !== null ? `/invoices/${id}` : `/journal/${l.entryId}`;
    case 'EXPENSE':
      return id !== null ? `/bills/${id}` : `/journal/${l.entryId}`;
    case 'CUSTOMER_PAYMENT':
      return id !== null ? `/payments/${id}` : `/journal/${l.entryId}`;
    case 'BILL_PAYMENT':
      return id !== null ? `/bill-payments/${id}` : `/journal/${l.entryId}`;
    case 'BANK_IMPORT':
    case 'INTERCOMPANY':
      return l.bankImportBatchId !== null ? `/bank-import/${l.bankImportBatchId}` : `/journal/${l.entryId}`;
    case 'REVERSAL':
      return l.reversalOfId !== null ? `/journal/${l.reversalOfId}` : `/journal/${l.entryId}`;
    default:
      return `/journal/${l.entryId}`;
  }
}

export default async function AccountRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string; from?: string; to?: string }>;
}) {
  const ctx = await requireReportContext();
  const params = await searchParams;
  // Inactive accounts stay pickable: their history is exactly what a register is for.
  const accounts = await listAccounts(ctx.userId, ctx.companyId);

  // Default to a year-to-date period ending on the company's today.
  const to = params.to !== undefined && isCalendarDate(params.to) ? params.to : ctx.today;
  const from =
    params.from !== undefined && isCalendarDate(params.from) ? params.from : `${ctx.today.slice(0, 4)}-01-01`;

  const accountId = params.accountId ?? '';
  const datesInvalid =
    (params.from !== undefined && params.from !== '' && !isCalendarDate(params.from)) ||
    (params.to !== undefined && params.to !== '' && !isCalendarDate(params.to)) ||
    from > to;

  // Only run once an account is chosen and the dates are sane. A cross-company or
  // unknown id returns null (no existence leak, §6); a malformed one reads as a miss.
  const register =
    accountId !== '' && isUuid(accountId) && !datesInvalid
      ? await getAccountRegister(ctx.userId, ctx.companyId, accountId, from, to)
      : null;

  const label = (a: { accountNumber: string | null; name: string; status: string }) =>
    `${a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ` : ''}${a.name}${a.status === 'INACTIVE' ? ' (inactive)' : ''}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Account Register</h1>
        <Link href="/reports" className="text-sm text-neutral-500 underline">
          ← Reports
        </Link>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" data-testid="register-form">
        <label className="flex flex-col gap-1">
          <span>Account</span>
          <select
            name="accountId"
            defaultValue={accountId}
            data-testid="register-account"
            className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">Select an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {label(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} data-testid="register-from" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <label className="flex flex-col gap-1">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} data-testid="register-to" className="rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
        </label>
        <button type="submit" data-testid="register-submit" className="rounded border border-neutral-300 px-3 py-1 dark:border-neutral-700">
          View
        </button>
      </form>

      {datesInvalid && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Enter a valid date range (From on or before To).
        </p>
      )}
      {accountId !== '' && !datesInvalid && register === null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          That account was not found.
        </p>
      )}

      {register !== null && (
        <section className="flex flex-col gap-3" data-testid="register">
          <p className="text-sm text-neutral-500">
            <span className="font-medium text-neutral-900 dark:text-neutral-100" data-testid="register-account-name">
              {register.accountNumber !== null && register.accountNumber !== '' ? `${register.accountNumber} · ` : ''}
              {register.accountName}
            </span>{' '}
            · {register.accountType} · {register.fromDate} to {register.toDate} · balance shown on the{' '}
            {register.debitNormal ? 'debit' : 'credit'} side
          </p>

          <div className="flex justify-between rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
            <span>Opening balance</span>
            <span className="tabular-nums" data-testid="register-opening">{formatMoney(register.openingBalance)}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" data-testid="register-table">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2">Entry</th>
                  <th className="py-2 pr-2">Source</th>
                  <th className="py-2 pr-2">Description</th>
                  <th className="py-2 pr-2 text-right">Debit</th>
                  <th className="py-2 pr-2 text-right">Credit</th>
                  <th className="py-2 pr-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {register.lines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-neutral-500">
                      No posted activity in this period.
                    </td>
                  </tr>
                ) : (
                  register.lines.map((l, i) => (
                    <tr key={`${l.entryId}-${String(i)}`} data-testid="register-row" className="border-b border-neutral-100 dark:border-neutral-800">
                      <td className="py-2 pr-2 text-neutral-500">{l.date}</td>
                      <td className="py-2 pr-2 tabular-nums">
                        <Link href={`/journal/${l.entryId}`} data-testid="register-entry-link" className="underline">
                          #{l.entryNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-2">
                        <Link href={sourceHref(l)} data-testid="register-source-link" className="underline">
                          {SOURCE_LABEL[l.sourceType] ?? l.sourceType}
                        </Link>
                      </td>
                      <td className="py-2 pr-2">{l.description ?? '—'}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.debit)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.credit)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.balance)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-300 font-medium dark:border-neutral-700">
                  <td className="py-2 pr-2" colSpan={4}>
                    Totals
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums" data-testid="register-total-debits">{formatMoney(register.totalDebits)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums" data-testid="register-total-credits">{formatMoney(register.totalCredits)}</td>
                  <td className="py-2 pr-2" />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex justify-between rounded bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
            <span>Closing balance</span>
            <span className="tabular-nums" data-testid="register-closing">{formatMoney(register.closingBalance)}</span>
          </div>
        </section>
      )}
    </main>
  );
}
