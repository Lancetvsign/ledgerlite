import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';
import { isCategoryPostable } from '@/server/accounts/system-roles';
import { formatMoney } from '@/lib/money-format';
import { toMoney } from '@/lib/decimal';
import { isUuid } from '@/lib/uuid';
import { listAccounts } from '@/server/accounts';
import { getActiveCompanyMembership } from '@/server/authorization/company-context';
import { getImportBatch, transferCounterparts, type ImportLineView } from '@/server/bank-import';
import { listOrganizationCompanies } from '@/server/organizations';
import { listOpenBills } from '@/server/bill-payments';
import { listCustomers } from '@/server/customers';
import { listOpenInvoices } from '@/server/payments';
import { roleHasCapability } from '@/server/rbac';
import { ensureAppUser } from '@/server/users';
import { listVendors } from '@/server/vendors';

import { deleteImportBatchAction, postImportLinesAction, setBatchSharingAction } from '../actions';
import { BulkControls } from './bulk-controls';
import { LineAccountSelect } from './line-account';
import { LineCounterpartSelect } from './line-counterpart';
import { LineActionControls } from './line-action';
import { ReviewStateProvider, type LineAction } from './review-state';

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
  searchParams: Promise<{ error?: string; ok?: string; posted?: string; ignored?: string; applied?: string; matched?: string; personal?: string; intercompany?: string }>;
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
  const [accounts, openInvoices, openBills, customers, vendors, orgMembers, counterparts] = await Promise.all([
    listAccounts(user.id, companyId),
    listOpenInvoices(user.id, companyId),
    listOpenBills(user.id, companyId),
    listCustomers(user.id, companyId),
    listVendors(user.id, companyId),
    listOrganizationCompanies(user.id, companyId),
    transferCounterparts(user.id, companyId),
  ]);
  const inOrganization = orgMembers.length > 0;
  const label = (a: { accountNumber: string | null; name: string }) =>
    a.accountNumber !== null && a.accountNumber !== '' ? `${a.accountNumber} · ${a.name}` : a.name;
  const nameById = new Map(accounts.map((a) => [a.id, label(a)]));
  // A credit-card statement (LL-088): lines post to accounts only — no apply-to-document.
  const isCard = accounts.find((a) => a.id === view.batch.bankAccountId)?.accountType === 'LIABILITY';
  const pickable = accounts
    .filter((a) => a.status === 'ACTIVE' && a.id !== view.batch.bankAccountId)
    .filter((a) => isCategoryPostable(a.systemAccountType));
  const pickableOptions = pickable.map((a) => ({ id: a.id, label: label(a) }));
  // LL-097: the owner's personal account — Owner Distributions by subtype and name, else any
  // owner-equity account, else the first equity account. None → no "Mark personal" offered.
  const equity = pickable.filter((a) => a.accountType === 'EQUITY');
  const personalDefault =
    equity.find((a) => a.accountSubtype === 'owner_equity' && /distribution/i.test(a.name)) ??
    equity.find((a) => a.accountSubtype === 'owner_equity') ??
    equity[0] ??
    null;

  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
  const invoiceOptions: DocumentOption[] = openInvoices.map((i) => ({
    id: i.id,
    label: `${i.invoiceNumber ?? i.id.slice(0, 8)} · ${customerName.get(i.customerId) ?? 'customer'} · open ${formatMoney(i.openBalance)}`,
    openBalance: i.openBalance,
  }));
  const billOptions: DocumentOption[] = openBills.map((b) => ({
    id: b.id,
    label: `${b.billNumber ?? b.id.slice(0, 8)} · ${vendorName.get(b.vendorId) ?? 'vendor'} · open ${formatMoney(b.openBalance)}`,
    openBalance: b.openBalance,
  }));

  /** Money in → invoices; money out → bills. Preselect when exactly one open balance equals |amount|. */
  const suggestionFor = (l: ImportLineView): { moneyIn: boolean; options: DocumentOption[]; documentId: string; action: LineAction } => {
    const amt = toMoney(l.amount);
    const moneyIn = amt.isPositive();
    // A POSTED mirror on another statement account (LL-094): default to matching it, so the
    // transfer posts once and both statements reconcile.
    if (l.transferCandidate?.status === 'POSTED') return { moneyIn, options: [], documentId: '', action: 'match_transfer' };
    // The other company already posted its side of this movement (LL-099): default to matching it.
    if (l.intercompanyCandidate !== null) return { moneyIn, options: [], documentId: '', action: 'match_intercompany' };
    if (isCard) return { moneyIn, options: [], documentId: '', action: 'post' };
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

  // The client-side review state starts from the server's suggestion per STAGED line (LL-089).
  const defaultActions: Record<string, LineAction> = Object.fromEntries(
    view.lines.flatMap((l, i) => (l.status === 'STAGED' ? [[String(i), suggestionFor(l).action]] : [])),
  );
  const staged = view.lines.filter((l) => l.status === 'STAGED').length;
  const posted = view.lines.filter((l) => l.status === 'POSTED').length;
  const personal = view.lines.filter((l) => l.status === 'PERSONAL').length;
  const assigned = view.lines.filter((l) => l.status === 'ASSIGNED').length;
  const ignored = view.lines.filter((l) => l.status === 'IGNORED').length;
  const decided = posted + personal + assigned;

  const selectClass = 'max-w-56 rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900';

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Review import</h1>
        <Link href="/bank-import" className="text-sm text-neutral-500 underline">← Imports</Link>
      </header>

      <p className="text-sm text-neutral-500" data-testid="batch-summary">
        {view.batch.filename ?? 'statement'} into <strong>{nameById.get(view.batch.bankAccountId)}</strong>
        {isCard && <span data-testid="card-statement"> (credit card: charges increase what you owe, payments reduce it)</span>} ·{' '}
        {String(staged)} to review, {String(posted)} posted, {String(personal)} personal, {String(assigned)} taken by another company, {String(ignored)} ignored.
      </p>

      {isCard && inOrganization && (
        // LL-097: share this card statement so the other companies of the organization can take
        // the lines that are theirs (from their own "Shared with you" page).
        <form action={setBatchSharingAction} className="flex items-center gap-2 text-sm">
          <input type="hidden" name="batchId" value={view.batch.id} />
          <input type="hidden" name="shared" value={view.batch.sharedWithOrganization ? '0' : '1'} />
          <span data-testid="sharing-status" className="text-neutral-600 dark:text-neutral-400">
            {view.batch.sharedWithOrganization ? 'Shared with your organization: other companies can take the lines that are theirs.' : 'Not shared with your organization.'}
          </span>
          <button type="submit" data-testid={view.batch.sharedWithOrganization ? 'unshare-batch' : 'share-batch'} className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700">
            {view.batch.sharedWithOrganization ? 'Stop sharing' : 'Share with organization'}
          </button>
        </form>
      )}

      {notice !== null && (
        <p role="status" data-testid="notice" className="rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">
          {notice}
        </p>
      )}

      <form action={postImportLinesAction} data-testid="review-form" className="flex flex-col gap-4">
        <input type="hidden" name="batchId" value={view.batch.id} />
        <ReviewStateProvider defaults={defaultActions}>
        {staged > 0 && <BulkControls />}
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
                    {l.duplicateOf !== null && (
                      <span data-testid="duplicate-flag" className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                        {l.duplicateOf === 'posted' ? 'possible duplicate' : 'also staged in another import'}
                      </span>
                    )}
                    {l.intercompanyCandidate !== null && (
                      <span data-testid="intercompany-flag" className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-900 dark:bg-violet-900 dark:text-violet-100">
                        {`transfer posted by ${l.intercompanyCandidate.counterpartLegalName} on ${l.intercompanyCandidate.txnDate}`}
                      </span>
                    )}
                    {l.transferCandidate !== null && (
                      <span data-testid="transfer-flag" className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-900 dark:bg-sky-900 dark:text-sky-100">
                        {l.transferCandidate.status === 'POSTED'
                          ? `transfer already posted from ${nameById.get(l.transferCandidate.accountId) ?? 'another account'} on ${l.transferCandidate.txnDate}`
                          : `possible transfer — also staged on ${nameById.get(l.transferCandidate.accountId) ?? 'another account'}; post one side, then match the other`}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums" data-testid={`import-amount-${String(i)}`}>{formatMoney(l.amount)}</td>
                  {s !== null ? (
                    // Every staged row emits lineId, accountId, documentId, action — in this
                    // order, unconditionally — so the action can zip them by index.
                    <>
                      <td className="py-2 pr-2">
                        <input type="hidden" name="lineId" value={l.id} />
                        <input type="hidden" name="counterpartLineId" value={l.transferCandidate?.status === 'POSTED' ? l.transferCandidate.lineId : ''} />
                        <input type="hidden" name="counterpartEntryId" value={l.intercompanyCandidate?.entryId ?? ''} />
                        {counterparts.length > 0 && <LineCounterpartSelect index={i} options={counterparts} />}
                        <LineAccountSelect
                          index={i}
                          options={pickableOptions}
                          suggestedId={l.transferCandidate?.status === 'POSTED' ? l.transferCandidate.accountId : (l.suggestedAccountId ?? '')}
                          personalDefaultId={personalDefault?.id ?? null}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        {!isCard && (
                          <select name="documentId" defaultValue={s.documentId} data-testid={`import-document-${String(i)}`} className={selectClass}>
                            <option value="">{s.moneyIn ? 'Open invoice…' : 'Open bill…'}</option>
                            {s.options.map((o) => (
                              <option key={o.id} value={o.id}>{o.label}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <LineActionControls
                          index={i}
                          moneyIn={s.moneyIn}
                          allowApply={!isCard}
                          allowPersonal={personalDefault !== null}
                          allowIntercompany={counterparts.length > 0}
                          {...(l.intercompanyCandidate !== null ? { intercompanyMatchLabel: `Match transfer posted by ${l.intercompanyCandidate.counterpartLegalName}` } : {})}
                          {...(l.transferCandidate?.status === 'POSTED'
                            ? { matchLabel: `Match transfer (posted from ${nameById.get(l.transferCandidate.accountId) ?? 'another account'})` }
                            : {})}
                        />
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
                      <td className="py-2 pr-2 text-neutral-500" data-testid={`import-status-${String(i)}`}>
                        {l.status === 'ASSIGNED' ? `taken by ${l.assignedCompanyName ?? 'another company'}` : l.status}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </ReviewStateProvider>

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

      {decided === 0 && (
        // Nothing from this upload has posted, so it is still a staging artifact and can be
        // removed outright (LL-087 / ADR-042). Once any line posts, the service refuses.
        <details className="self-start">
          <summary className="cursor-pointer list-none rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
            Delete this import…
          </summary>
          <form action={deleteImportBatchAction} className="mt-2 flex flex-col gap-2 rounded border border-neutral-300 p-3 text-sm dark:border-neutral-700">
            <input type="hidden" name="batchId" value={view.batch.id} />
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              Removes the uploaded statement and its {String(view.lines.length)} extracted line(s). Nothing was posted, so
              the ledger is untouched. You can upload the statement again later.
            </p>
            <button type="submit" data-testid="delete-import-batch" className="self-start rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800">
              Delete import
            </button>
          </form>
        </details>
      )}
    </main>
  );
}

function noticeFrom(sp: { error?: string; ok?: string; posted?: string; ignored?: string; applied?: string; matched?: string; personal?: string; intercompany?: string }): string | null {
  if (sp.ok === 'posted') {
    const base = `Posted ${sp.posted ?? '0'} line(s), ignored ${sp.ignored ?? '0'}.`;
    const applied = sp.applied ?? '0';
    const matched = sp.matched ?? '0';
    const personal = sp.personal ?? '0';
    const intercompany = sp.intercompany ?? '0';
    return (
      base +
      (applied === '0' ? '' : ` ${applied} applied to open invoices/bills.`) +
      (matched === '0' ? '' : ` ${matched} matched to a transfer already posted from the other account.`) +
      (personal === '0' ? '' : ` ${personal} marked personal.`) +
      (intercompany === '0' ? '' : ` ${intercompany} posted as intercompany transfers.`)
    );
  }
  if (sp.ok === 'shared') return 'Shared with your organization. The other companies can now take the lines that are theirs.';
  if (sp.ok === 'unshared') return 'No longer shared. A company that already took lines keeps them (and can give them back).';
  const error = sp.error;
  if (error === undefined) return null;
  if (error === 'invalid') return 'Please check the lines and try again.';
  if (error === 'BATCH_HAS_POSTINGS') return 'Lines from this import have already posted (or been taken by another company), so it cannot be deleted.';
  if (error === 'ACCOUNT_REQUIRED') return 'Choose an account for every line you are posting.';
  if (error === 'CONTROL_ACCOUNT_NOT_ALLOWED') return 'Accounts Receivable, Accounts Payable, Opening Balance Equity, and the bank account itself cannot be used — pick another account.';
  if (error === 'DOCUMENT_REQUIRED') return 'Choose an open invoice or bill for every line you are applying.';
  if (error === 'WRONG_DIRECTION') return 'Money in can only be applied to an invoice; money out only to a bill.';
  if (error === 'TRANSFER_ALREADY_POSTED') return 'The other side of that transfer already posted from the other account — choose “Match transfer” (or Ignore) instead of posting it again.';
  if (error === 'TRANSFER_MISMATCH') return 'That line is not the posted mirror of the transfer — reload and review again.';
  if (error === 'ACCOUNT_INVALID') return 'A personal charge posts to an owner equity or asset account (Owner Distributions), not to an expense or revenue account.';
  if (error === 'COUNTERPART_INVALID') return 'Choose a company of your organization you can post in for the intercompany transfer.';
  if (error === 'TRANSFER_ALREADY_MATCHED') return 'This company already posted its side of that intercompany transfer — reload and review again.';
  if (error === 'INTERCOMPANY_NOT_ALLOWED') return 'The two companies must be active members of one organization with the same currency.';
  if (error === 'ONLY_CARDS_SHAREABLE') return 'Only a credit-card statement can be shared with the organization.';
  if (error === 'NOT_IN_ORGANIZATION') return 'Put this company in an organization (Account page) before sharing a statement.';
  if (error === 'CARD_CANNOT_APPLY') return 'Credit-card statement lines can only be posted to an account — pay bills from a bank account.';
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
