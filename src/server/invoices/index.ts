import 'server-only';

import Decimal from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { resolveSystemAccount } from '@/server/accounts';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { LedgerError, postEntryCore, reverseEntryCore } from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';

import { InvoiceError } from './errors';

import type { PoolDatabase } from '@/db';
import type { Invoice, InvoiceLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type {
  CreateInvoiceInput,
  InvoiceLineInput,
  UpdateInvoiceInput,
  VoidInvoiceInput,
} from '@/validation/invoice';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Invoice service — LL-041 (Accounts Receivable). Draft lifecycle only; finalize,
 * posting to the ledger, and void arrive in LL-042.
 *
 * Every operation is company-scoped and authorization-gated (AGENTS §6). Totals
 * (subtotal / tax / total) are ALWAYS recomputed from the lines with decimal.js
 * and stored (ADR-013) — no input carries a total. Money is a string at every
 * boundary and a `Decimal` only in computation (ADR-004). Tenancy is structural:
 * the customer and every line account are re-validated to be in this company, and
 * the composite FKs make a cross-tenant reference impossible even if that check
 * were wrong.
 */

export interface InvoiceWithLines {
  readonly invoice: Invoice;
  readonly lines: InvoiceLine[];
}

interface Totals {
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
}

/**
 * The one place invoice money is computed. Per line: amount = quantity × unit
 * price, tax = amount × rate ÷ 100, each rounded to NUMERIC(19,4) (ROUND_HALF_EVEN,
 * ADR-004). Totals are the sums. Pure — no I/O, exercised directly in tests.
 */
export function computeInvoiceTotals(
  lines: readonly { readonly quantity: string; readonly unitPrice: string; readonly taxRate: string }[],
): Totals {
  let subtotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  for (const line of lines) {
    const amount = toMoney(line.quantity).times(toMoney(line.unitPrice)).toDecimalPlaces(4);
    const tax = amount.times(toMoney(line.taxRate)).dividedBy(100).toDecimalPlaces(4);
    subtotal = subtotal.plus(amount);
    taxTotal = taxTotal.plus(tax);
  }
  return {
    subtotal: subtotal.toFixed(4),
    taxTotal: taxTotal.toFixed(4),
    total: subtotal.plus(taxTotal).toFixed(4),
  };
}

export interface InvoicePostingBreakdown extends Totals {
  /** Revenue to credit — one entry per DISTINCT account, in first-appearance order. */
  readonly revenueByAccount: readonly { readonly accountId: string; readonly amount: string }[];
}

/**
 * The per-account breakdown a finalize posts (LL-042): the SAME totals as
 * `computeInvoiceTotals` (reused, so they can never disagree) plus revenue
 * grouped by account. Each account's credit is the sum of its lines' 4dp amounts,
 * so the revenue credits sum to `subtotal` exactly and, with the tax credit,
 * balance the A/R debit (= `total`) at NUMERIC(19,4). Pure — no I/O, tested directly.
 */
export function computeInvoicePosting(
  lines: readonly {
    readonly accountId: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly taxRate: string;
  }[],
): InvoicePostingBreakdown {
  const totals = computeInvoiceTotals(lines);
  const order: string[] = [];
  const byAccount = new Map<string, Decimal>();
  for (const line of lines) {
    const amount = toMoney(line.quantity).times(toMoney(line.unitPrice)).toDecimalPlaces(4);
    const running = byAccount.get(line.accountId);
    if (running === undefined) {
      order.push(line.accountId);
      byAccount.set(line.accountId, amount);
    } else {
      byAccount.set(line.accountId, running.plus(amount));
    }
  }
  const revenueByAccount = order.map((accountId) => ({
    accountId,
    amount: (byAccount.get(accountId) ?? new Decimal(0)).toFixed(4),
  }));
  return { ...totals, revenueByAccount };
}

/**
 * Every invoice line must post to an ordinary, in-company account — never a system
 * CONTROL account. Crediting the Accounts Receivable control account as a "revenue"
 * line posts Dr A/R (the total) / Cr A/R (the subtotal): the entry balances, so every
 * trigger passes, but the invoice's full total counts as open in the aging while the
 * ledger A/R moved only by the tax — silently breaking the aging⇔control
 * reconciliation (GL-T018 / ADR-016). Sales Tax Payable, Retained Earnings, etc. are
 * system-managed too and are never a legitimate manual line choice. The invoice UI only
 * offers REVENUE accounts; because the browser is untrusted (AGENTS §6) and the line
 * `accountId` is a client-supplied field, the rule is enforced HERE, at the service.
 * Also confirms each account exists in this company.
 */
async function assertLineAccountsPostable(
  tx: Tx,
  companyId: string,
  accountIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(accountIds)];
  const found = await tx
    .select({ id: schema.accounts.id, systemAccountType: schema.accounts.systemAccountType })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), inArray(schema.accounts.id, ids)));
  const systemTypeById = new Map(found.map((a) => [a.id, a.systemAccountType]));
  for (const id of ids) {
    if (!systemTypeById.has(id)) {
      throw new InvoiceError('ACCOUNT_NOT_FOUND', 'A line references an account not in this company.');
    }
    if (systemTypeById.get(id) !== null) {
      throw new InvoiceError(
        'LINE_ACCOUNT_INVALID',
        'An invoice line cannot post to a system control account (e.g. Accounts Receivable).',
      );
    }
  }
}

/** Confirms the customer lives in THIS company and every line account is postable. */
async function validateReferences(
  tx: Tx,
  companyId: string,
  customerId: string,
  lines: readonly InvoiceLineInput[],
): Promise<void> {
  const customer = await tx
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, customerId)))
    .limit(1);
  if (customer[0] === undefined) {
    throw new InvoiceError('CUSTOMER_NOT_FOUND', 'That customer does not exist in this company.');
  }

  await assertLineAccountsPostable(tx, companyId, lines.map((l) => l.accountId));
}

async function insertLines(
  tx: Tx,
  companyId: string,
  invoiceId: string,
  lines: readonly InvoiceLineInput[],
): Promise<void> {
  await tx.insert(schema.invoiceLines).values(
    lines.map((line, index) => ({
      invoiceId,
      companyId,
      lineNumber: index + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxRate: line.taxRate,
    })),
  );
}

export async function createInvoice(
  actorUserId: string,
  companyId: string,
  input: CreateInvoiceInput,
): Promise<InvoiceWithLines> {
  await requirePermission(actorUserId, companyId, 'invoice.create');
  const totals = computeInvoiceTotals(input.lines);

  return await getDbTx().transaction(async (tx) => {
    await validateReferences(tx, companyId, input.customerId, input.lines);

    const rows = await tx
      .insert(schema.invoices)
      .values({
        companyId,
        customerId: input.customerId,
        status: 'DRAFT',
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate,
        memo: input.memo,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdBy: actorUserId,
      })
      .returning();
    const invoice = rows[0];
    if (invoice === undefined) throw new Error('invoice insert returned no row');

    await insertLines(tx, companyId, invoice.id, input.lines);
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVOICE_CREATED',
      entityType: 'invoice',
      entityId: invoice.id,
      after: { status: 'DRAFT', total: totals.total, lineCount: input.lines.length },
    });
    return await loadInvoice(tx, companyId, invoice.id);
  });
}

export async function updateInvoice(
  actorUserId: string,
  companyId: string,
  invoiceId: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceWithLines> {
  await requirePermission(actorUserId, companyId, 'invoice.create');
  const totals = computeInvoiceTotals(input.lines);

  return await getDbTx().transaction(async (tx) => {
    // FOR UPDATE: an edit and a concurrent finalize (which flips DRAFT→OPEN and
    // posts) must serialise. Without the lock the DRAFT check here could pass on a
    // stale read and this update would clobber an already-posted invoice. LL-042.
    const existing = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
      .for('update')
      .limit(1);
    const invoice = existing[0];
    if (invoice === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Invoice not found.');
    if (invoice.status !== 'DRAFT') {
      throw new InvoiceError('INVOICE_NOT_DRAFT', 'Only a draft invoice can be edited.');
    }

    await validateReferences(tx, companyId, input.customerId, input.lines);

    // Wholesale replace: header fields, then delete-and-reinsert the lines.
    await tx
      .update(schema.invoices)
      .set({
        customerId: input.customerId,
        invoiceDate: input.invoiceDate,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)));
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
    await insertLines(tx, companyId, invoiceId, input.lines);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVOICE_UPDATED',
      entityType: 'invoice',
      entityId: invoiceId,
      before: { total: invoice.total },
      after: { total: totals.total, lineCount: input.lines.length },
    });
    return await loadInvoice(tx, companyId, invoiceId);
  });
}

export async function getInvoice(
  actorUserId: string,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceWithLines | null> {
  await requirePermission(actorUserId, companyId, 'invoice.view');
  const rows = await getDbTx()
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
    .limit(1);
  if (rows[0] === undefined) return null; // cross-company id reads as a genuine miss
  return await loadInvoice(getDbTx(), companyId, invoiceId);
}

/** Company-scoped listing (headers + stored totals). `invoice.view`. */
export async function listInvoices(actorUserId: string, companyId: string): Promise<Invoice[]> {
  await requirePermission(actorUserId, companyId, 'invoice.view');
  return await getDbTx()
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.companyId, companyId))
    .orderBy(schema.invoices.invoiceDate, schema.invoices.createdAt);
}

async function loadInvoice(
  tx: Tx | PoolDatabase,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceWithLines> {
  const invoiceRows = await tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
    .limit(1);
  const invoice = invoiceRows[0];
  if (invoice === undefined) throw new Error('invoice vanished');
  const lines = await tx
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(schema.invoiceLines.lineNumber);
  return { invoice, lines };
}

/**
 * Finalize a DRAFT invoice: assign its number, transition DRAFT→OPEN, and post
 * the balanced entry to the general ledger — ATOMICALLY, in one transaction, so
 * the invoice is never OPEN without its entry, nor an entry present for a still-
 * DRAFT invoice (invariant 7).
 *
 * The entry (ADR-014): Dr Accounts Receivable = total (tagged with the customer),
 * Cr each revenue account = its lines' amount, Cr Sales Tax Payable = tax. It is
 * source-typed INVOICE with the invoice's id, so the "one POSTED per source"
 * index makes a second posting of the same invoice impossible — that, with the
 * DRAFT-guarded (FOR UPDATE) status transition, is the idempotency. No idempotency
 * key is needed: source-once is the stronger guarantee.
 *
 * Authorized at `invoice.post` (ALL_WRITERS incl. BOOKKEEPER — the documented
 * intent). The posting goes through `postEntryCore`, which does NOT re-check
 * `journal.post`, so a bookkeeper who may post invoices but not raw journals is
 * not wrongly blocked.
 */
export async function finalizeInvoice(
  actorUserId: string,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceWithLines> {
  await requirePermission(actorUserId, companyId, 'invoice.post');

  // Pre-read the invoice date to resolve-and-create the posting period BEFORE the
  // tx — creating a period lazily inside the posting tx would race on its
  // exclusion constraint (LL-032). Also a fast existence/status pre-check.
  const pre = await getDbTx()
    .select({ status: schema.invoices.status, invoiceDate: schema.invoices.invoiceDate })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
    .limit(1);
  const preInvoice = pre[0];
  if (preInvoice === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Invoice not found.');
  if (preInvoice.status !== 'DRAFT') {
    throw new InvoiceError('INVOICE_NOT_DRAFT', 'Only a draft invoice can be finalized.');
  }
  const period = await getAccountingPeriod(companyId, preInvoice.invoiceDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${preInvoice.invoiceDate} is closed.`);
  }

  return await getDbTx().transaction(async (tx) => {
    // Lock the invoice and re-validate authoritatively; a concurrent finalize
    // blocks here, then sees OPEN and is rejected below.
    const rows = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
      .for('update')
      .limit(1);
    const invoice = rows[0];
    if (invoice === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Invoice not found.');
    if (invoice.status !== 'DRAFT') {
      throw new InvoiceError('INVOICE_NOT_DRAFT', 'Only a draft invoice can be finalized.');
    }
    // The period was resolved from the pre-read date. If a concurrent edit changed
    // the invoice date in the window between that read and this lock, the resolved
    // period no longer matches the date we would post with — abort rather than post
    // into a date whose period was never resolved. The retry resolves the right one.
    // (Rare: requires an updateInvoice racing this finalize on the same invoice.)
    if (invoice.invoiceDate !== preInvoice.invoiceDate) {
      throw new Error(`invoice ${invoiceId} date changed during finalize; retry`);
    }

    const lineRows = await tx
      .select()
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, invoiceId))
      .orderBy(schema.invoiceLines.lineNumber);

    // Defense in depth: no stored line may post to a system control account (see
    // assertLineAccountsPostable). create/update already enforce this, so this only
    // catches a draft created before the guard existed or through some other path —
    // it must never post a reconciliation-breaking entry (GL-T018 / ADR-016).
    await assertLineAccountsPostable(tx, companyId, lineRows.map((l) => l.accountId));

    // Derive the posting from the LOCKED lines; assert it matches the stored
    // totals (ADR-013 tripwire — the service is the only writer of both).
    const posting = computeInvoicePosting(lineRows);
    if (
      posting.subtotal !== invoice.subtotal ||
      posting.taxTotal !== invoice.taxTotal ||
      posting.total !== invoice.total
    ) {
      throw new Error(`invoice ${invoiceId} stored totals disagree with its lines`);
    }
    if (toMoney(posting.total).lessThanOrEqualTo(0)) {
      throw new InvoiceError('INVOICE_ZERO_TOTAL', 'A zero-total invoice cannot be finalized.');
    }

    // Resolve the posting accounts: A/R always; Sales Tax Payable only when taxed.
    const arAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_RECEIVABLE');
    if (arAccountId === null) {
      throw new InvoiceError('AR_ACCOUNT_NOT_CONFIGURED', 'No Accounts Receivable account is configured.');
    }
    const hasTax = toMoney(posting.taxTotal).greaterThan(0);
    let taxAccountId: string | null = null;
    if (hasTax) {
      taxAccountId = await resolveSystemAccount(tx, companyId, 'SALES_TAX_PAYABLE');
      if (taxAccountId === null) {
        throw new InvoiceError(
          'TAX_ACCOUNT_NOT_CONFIGURED',
          'This invoice has tax but no Sales Tax Payable account is configured.',
        );
      }
    }

    // Build the balanced lines: Dr A/R, Cr revenue by account, Cr tax. A zero
    // revenue group is skipped (not a valid line); the rest still sum to subtotal.
    const ledgerLines: PostJournalEntryInput['lines'] = [
      { accountId: arAccountId, debit: posting.total, credit: '0', customerId: invoice.customerId },
    ];
    for (const rev of posting.revenueByAccount) {
      if (toMoney(rev.amount).greaterThan(0)) {
        ledgerLines.push({ accountId: rev.accountId, debit: '0', credit: rev.amount });
      }
    }
    if (hasTax && taxAccountId !== null) {
      ledgerLines.push({ accountId: taxAccountId, debit: '0', credit: posting.taxTotal });
    }

    // Balance tripwire (guaranteed by construction; the deferred trigger is the
    // final backstop at commit).
    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(
        `invoice ${invoiceId} posting is unbalanced (${debits.toString()} vs ${credits.toString()})`,
      );
    }

    // Allocate the invoice number — plain atomic increment, GAPS ALLOWED: a
    // rolled-back finalize simply skips the number (contrast entry numbers).
    const numberRows = await tx.execute<{ next_invoice_number: string }>(sql`
      update company_counters
      set next_invoice_number = next_invoice_number + 1
      where company_id = ${companyId}
      returning next_invoice_number - 1 as next_invoice_number`);
    const allocated = numberRows.rows[0]?.next_invoice_number;
    if (allocated === undefined) {
      // The counter row is seeded atomically with the company; its absence is
      // corruption, not a missing invoice — fail loud rather than mislabel it.
      throw new Error(`company ${companyId} has no invoice-number counter row`);
    }
    const invoiceNumber = String(allocated);

    // Transition the (locked) invoice to OPEN with its number.
    await tx
      .update(schema.invoices)
      .set({ status: 'OPEN', invoiceNumber, updatedAt: sql`now()` })
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)));

    const postingDate = invoice.invoiceDate;
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: postingDate,
      postingDate,
      description: `Invoice ${invoiceNumber}`,
      sourceType: 'INVOICE',
      sourceId: invoiceId,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, postingDate, undefined);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVOICE_FINALIZED',
      entityType: 'invoice',
      entityId: invoiceId,
      before: { status: 'DRAFT' },
      after: { status: 'OPEN', invoiceNumber, total: posting.total },
    });

    return await loadInvoice(tx, companyId, invoiceId);
  });
}

/**
 * Void an OPEN invoice: reverse its posted entry and mark the invoice VOID —
 * atomically, in one transaction. The original entry is never edited (invariant
 * 3); the reversal is a new entry that nets it to exactly zero on every account
 * (ADR-010). Authorized at `invoice.post`, same as finalize.
 */
export async function voidInvoice(
  actorUserId: string,
  companyId: string,
  invoiceId: string,
  input: VoidInvoiceInput,
): Promise<InvoiceWithLines> {
  await requirePermission(actorUserId, companyId, 'invoice.post');

  // Fast pre-check + resolve the reversal date's period BEFORE the tx (ADR-007;
  // never create a period inside the posting tx).
  const pre = await getDbTx()
    .select({ status: schema.invoices.status })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
    .limit(1);
  const preInvoice = pre[0];
  if (preInvoice === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Invoice not found.');
  if (preInvoice.status !== 'OPEN') {
    throw new InvoiceError('INVOICE_NOT_OPEN', 'Only an open invoice can be voided.');
  }
  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    // Lock + authoritative status check.
    const rows = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)))
      .for('update')
      .limit(1);
    const invoice = rows[0];
    if (invoice === undefined) throw new InvoiceError('INVOICE_NOT_FOUND', 'Invoice not found.');
    if (invoice.status !== 'OPEN') {
      throw new InvoiceError('INVOICE_NOT_OPEN', 'Only an open invoice can be voided.');
    }

    // An invoice with LIVE (non-void) payments applied cannot be voided — void the
    // payment first (LL-043). Otherwise the payment's Cr A/R would strand against a
    // voided invoice, leaving an untracked customer credit.
    const livePayments = await tx.execute<{ n: string }>(sql`
      select count(*)::text n
      from payment_applications pa
      join payments p on p.company_id = pa.company_id and p.id = pa.payment_id
      where pa.company_id = ${companyId} and pa.invoice_id = ${invoiceId} and p.status <> 'VOID'`);
    if (Number(livePayments.rows[0]?.n ?? '0') > 0) {
      throw new InvoiceError(
        'INVOICE_HAS_PAYMENTS',
        'Void the payments applied to this invoice before voiding it.',
      );
    }

    // Its posted entry — unique via the source-once index.
    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'INVOICE'),
          eq(schema.journalEntries.sourceId, invoiceId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      // An OPEN invoice always has a POSTED entry; its absence means corruption.
      throw new Error(`open invoice ${invoiceId} has no posted entry to reverse`);
    }

    // Mark VOID (row already locked + verified OPEN), then reverse the entry in
    // THIS transaction so both commit together.
    await tx
      .update(schema.invoices)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, invoiceId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of invoice ${invoice.invoiceNumber ?? invoiceId}`,
      },
      reversalDate,
    );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVOICE_VOIDED',
      entityType: 'invoice',
      entityId: invoiceId,
      before: { status: 'OPEN', invoiceNumber: invoice.invoiceNumber },
      after: { status: 'VOID', reversalDate, reason: input.reason ?? null },
    });

    return await loadInvoice(tx, companyId, invoiceId);
  });
}

export { InvoiceError } from './errors';
export type { InvoiceErrorCode } from './errors';
