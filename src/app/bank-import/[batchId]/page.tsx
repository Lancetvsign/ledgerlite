import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { toMoney } from '@/lib/decimal';
import { isUuid } from '@/lib/uuid';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getImportBatch, type ImportLineView } from '@/server/bank-import';
import { listOpenBills } from '@/server/bill-payments';
import { listCustomers } from '@/server/customers';
import { listOpenInvoices } from '@/server/payments';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { postImportLinesAction } from '../actions';

/**
 * Bank-statement import — review (LL-076, LL-077). The human gate: every staged line shows
 * its extracted date/description/amount and a suggested account; the reviewer confirms or
 * changes the account, ignores the line, or — LL-077 — applies it to an open invoice
 * (money in) / bill (money out), which creates a real customer payment / bill payment. When
 * exactly one open document's balance equals the line amount it is preselected; the
 * reviewer still confirms every line. Nothing posts without an explicit decision. Money is
 * rendered straight from the service's `string`s (ADR-004).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXCLUDED_SYSTEM_TYPES = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'OPENING_BALANCE_EQUITY']);

interface DocumentOption {
  readonly id: string;
  readonly label: string;
  readonly openBalance: string;
}

export default async function ReviewImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; ok?: string; posted?: string; ignored?: string; applied?: string }>;
}) {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (session === null) redirect('/sign-in');
  const user = await ensureAppUser(session.user);
  const membership = await getActiveCompanyMembership(user.id);
  if (membership === null) redirect('/account');
  if (!roleHasCapability(membership.role, 'journal.post')) redirect('/account?error=denied');

  const { batchId } = await params;
  const sp = await searchParams;
  const notice = noticeFrom(sp);

  // A malformed or cross-company id reads as not-found, never a 500 (Gate 5).
  const view = isUuid(batchId) ? await getImportBatch(user.id, membership.companyId, batchId) : null;
  if (view === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Import not found</h1>
          <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
        </header>
        <p role="status" data-testid="notice" className="text-sm text-neutral-500">That import batch does not exist.</p>
      </main>
    );
  }

  const companyId = membership.companyId;
  const [accounts, openInvoices, openBills, customers, vendors] = await Promise.all([
    listAccounts(user.id, companyId),
    listOpenInvoices(user.id, companyId),
    listOpenBills(user.id, companyId),
    listCustomers(user.id, companyId),
    listVendors(user.id, companyId),
  ]);
  const label = (a: { accountNumber: string | null; name: string }) =>
    a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
  const nameById = new Map(accounts.map((a) => [a.id, label(a)]));
  const pickable = accounts
    .filter((a) => a.status === 'ACTIVE' && a.id !== view.batch.bankAccountId)
    .filter((a) => a.systemAccountType === null || !EXCLUDED_SYSTEM_TYPES.has(a.systemAccountType));

  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
  const invoiceOptions: DocumentOption[] = openInvoices.map((i) => ({
    id: i.id,
    label: `${i.invoiceNumber ?? i.id.slice(0, 8)} · ${customerName.get(i.customerId) ?? 'customer'} · open ${i.openBalance}`,
    openBalance: i.openBalance,
  }));
  const billOptions: DocumentOption[] = openBills.map((b) => ({
    id: b.id,
    label: `${b.billNumber ?? b.id.slice(0, 8)} · ${vendorName.get(b.vendorId) ?? 'vendor'} · open ${b.openBalance}`,
    openBalance: b.openBalance,
  }));

  /** Money in → invoices; money out → bills. Preselect when exactly one open balance equals |amount|. */
  const suggestionFor = (l: ImportLineView): { moneyIn: boolean; options: DocumentOption[]; documentId: string; action: string } => {
    const amt = toMoney(l.amount);
    const moneyIn = amt.isPositive();
    const options = moneyIn ? invoiceOptions : billOptions;
    const abs = amt.abs();
    const matches = options.filter((o) => toMoney(o.openBalance).eq(abs));
    const match = matches.length === 1 ? matches[0] : undefined;
    return {
      moneyIn,
      options,
      documentId: match?.id ?? '',
      action: match !== undefined ? (moneyIn ? 'apply_invoice' : 'apply_bill') : 'post',
    };
  };

  const staged = view.lines.filter((l) => l.status === 'STAGED').length;
  const posted = view.lines.filter((l) => l.status === 'POSTED').length;
  const ignored = view.lines.filter((l) => l.status === 'IGNORED').length;

  const selectClass = 'max-w-56 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Review import</h1>
        <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
      </header>

      <p className="text-sm text-neutral-500" data-testid="batch-summary">
        {view.batch.filename ?? 'statement'} into <strong>{nameById.get(view.batch.bankAccountId)}</strong> ·{' '}
        {String(staged)} to review, {String(posted)} posted, {String(ignored)} ignored.
      </p>

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          {notice}
        </p>
      )}

      <form action={postImportLinesAction} data-testid="review-form" className="flex flex-col gap-4">
        <input type="hidden" name="batchId" value={view.batch.id} />
        <table className="w-full border-collapse text-sm" data-testid="import-lines">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2 text-right">Amount</th>
              <th className="py-2 pr-2">Account</th>
              <th className="py-2 pr-2">Apply to</th>
              <th className="py-2 pr-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l, i) => {
              // Only staged rows render inputs; decided rows need no suggestion.
              const s = l.status === 'STAGED' ? suggestionFor(l) : null;
              return (
                <tr key={l.id} data-testid="import-line-row" data-status={l.status} className="border-b border-neutral-100 dark:border-neutral-800">
                  <td className="py-2 pr-2 tabular-nums">{l.txnDate}</td>
                  <td className="py-2 pr-2">
                    {l.description}
                    {l.aiCategory !== null && <span className="ml-2 text-xs text-neutral-400">suggested: {l.aiCategory}</span>}
                    {l.isDuplicate && (
                      <span data-testid="duplicate-flag" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        possible duplicate
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums" data-testid={`import-amount-${String(i)}`}>{l.amount}</td>
                  {s !== null ? (
                    // Every staged row emits lineId, accountId, documentId, action — in this
                    // order, unconditionally — so the action can zip them by index.
                    <>
                      <td className="py-2 pr-2">
                        <input type="hidden" name="lineId" value={l.id} />
                        <select name="accountId" defaultValue={l.suggestedAccountId ?? ''} data-testid={`import-account-${String(i)}`} className={selectClass}>
                          <option value="">Choose account…</option>
                          {pickable.map((a) => (
                            <option key={a.id} value={a.id}>{label(a)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 pr-2">
                        <select name="documentId" defaultValue={s.documentId} data-testid={`import-document-${String(i)}`} className={selectClass}>
                          <option value="">{s.moneyIn ? 'Open invoice…' : 'Open bill…'}</option>
                          {s.options.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 pr-2">
                        <select name="action" defaultValue={s.action} data-testid={`import-action-${String(i)}`} className={selectClass}>
                          <option value="post">Post to account</option>
                          <option value="ignore">Ignore</option>
                          {s.moneyIn ? (
                            <option value="apply_invoice">Apply to invoice</option>
                          ) : (
                            <option value="apply_bill">Apply to bill</option>
                          )}
                        </select>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 pr-2 text-neutral-500">
                        {l.chosenAccountId !== null ? nameById.get(l.chosenAccountId) : '—'}
                      </td>
                      <td className="py-2 pr-2 text-neutral-500" data-testid={`import-applied-${String(i)}`}>
                        {l.paymentId !== null ? (
                          <Link href={`/payments/${l.paymentId}`} className="underline">applied to payment</Link>
                        ) : l.billPaymentId !== null ? (
                          <Link href={`/bill-payments/${l.billPaymentId}`} className="underline">applied to bill payment</Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-2 text-neutral-500" data-testid={`import-status-${String(i)}`}>{l.status}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {staged > 0 && (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-neutral-400">
              Posting is final. A posted line becomes a journal entry (corrections by reversal); an applied
              line becomes a customer payment or bill payment (corrections by voiding it).
            </span>
            <button type="submit" data-testid="post-import-lines" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Post confirmed lines
            </button>
          </div>
        )}
      </form>
    </main>
  );
}

function noticeFrom(sp: { error?: string; ok?: string; posted?: string; ignored?: string; applied?: string }): string | null {
  if (sp.ok === 'posted') {
    const base = `Posted ${sp.posted ?? '0'} line(s), ignored ${sp.ignored ?? '0'}.`;
    const applied = sp.applied ?? '0';
    return applied === '0' ? base : `${base} ${applied} applied to open invoices/bills.`;
  }
  const error = sp.error;
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please check the lines and try again.';
  if (error === 'ACCOUNT_REQUIRED') return 'Choose an account for every line you are posting.';
  if (error === 'CONTROL_ACCOUNT_NOT_ALLOWED') return 'Accounts Receivable, Accounts Payable, Opening Balance Equity, and the bank account itself cannot be used — pick another account.';
  if (error === 'DOCUMENT_REQUIRED') return 'Choose an open invoice or bill for every line you are applying.';
  if (error === 'WRONG_DIRECTION') return 'Money in can only be applied to an invoice; money out only to a bill.';
  if (error === 'DOCUMENT_NOT_OPEN' || error === 'INVOICE_NOT_OPEN' || error === 'BILL_NOT_OPEN' || error === 'INVOICE_NOT_FOUND' || error === 'BILL_NOT_FOUND') {
    return 'That invoice or bill is no longer open — reload and choose again.';
  }
  if (error === 'OVERAPPLIED') return 'A line is larger than the open balance of the document it is applied to.';
  if (error === 'DEPOSIT_ACCOUNT_INVALID' || error === 'CASH_ACCOUNT_INVALID') return 'The bank account of this import cannot receive payments.';
  if (error === 'AR_ACCOUNT_NOT_CONFIGURED' || error === 'AP_ACCOUNT_NOT_CONFIGURED') return 'Accounts Receivable / Payable is not configured for this company.';
  if (error === 'PERIOD_CLOSED') return 'A line falls in a closed accounting period.';
  if (error === 'LINE_NOT_FOUND' || error === 'BATCH_NOT_FOUND') return 'That import could not be found.';
  if (error === 'denied') return 'You do not have permission to post.';
  return 'The lines could not be posted.';
}
