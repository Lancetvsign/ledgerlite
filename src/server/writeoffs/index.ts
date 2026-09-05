import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { resolveSystemAccount } from '@/server/accounts';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { LedgerError, postEntryCore, reverseEntryCore } from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';
import { invoiceReductionsTotal } from '@/server/reports/open-balance';

import { WriteoffError } from './errors';

import type { PoolDatabase } from '@/db';
import type { Writeoff } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { VoidWriteoffInput, WriteOffInvoiceInput } from '@/validation/writeoff';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Bad-debt write-off service — LL-050 (Accounts Receivable). The SANCTIONED way to
 * reduce a receivable a customer will not pay: write off one OPEN invoice (in whole
 * or in part), posting Dr Bad Debt Expense / Cr Accounts Receivable (customer-tagged)
 * through LedgerService, source-typed BAD_DEBT_WRITEOFF and source-once. Void
 * reverses it. ADR-016 / ADR-017.
 *
 * A write-off reduces the invoice's open balance in the A/R subsidiary exactly like a
 * payment application does (the open balance derives from invoices minus non-void
 * payments AND non-void write-offs — `invoiceReductionsTotal`), so the aging⇔control
 * reconciliation (GL-T018) keeps holding. Nothing is stored (invariant 2). A write-off
 * that clears the invoice marks it PAID (settled); voiding reopens it. Authorization is
 * `writeoff.create` (ALL_WRITERS); the posting goes through `postEntryCore`, which does
 * not re-gate on `journal.post`.
 */

export async function writeOffInvoice(
  actorUserId: string,
  companyId: string,
  input: WriteOffInvoiceInput,
): Promise<Writeoff> {
  await requirePermission(actorUserId, companyId, 'writeoff.create');

  // Resolve-and-create the posting period BEFORE the tx (never lazily inside — a
  // concurrent create races the exclusion constraint, LL-032).
  const period = await getAccountingPeriod(companyId, input.writeoffDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${input.writeoffDate} is closed.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const arAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_RECEIVABLE');
    if (arAccountId === null) {
      throw new WriteoffError('AR_ACCOUNT_NOT_CONFIGURED', 'No Accounts Receivable account is configured.');
    }

    // Lock the invoice and validate it authoritatively.
    const invoiceRows = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, companyId), eq(schema.invoices.id, input.invoiceId)))
      .for('update')
      .limit(1);
    const invoice = invoiceRows[0];
    if (invoice === undefined) {
      throw new WriteoffError('INVOICE_NOT_FOUND', 'The invoice does not exist in this company.');
    }
    if (invoice.status !== 'OPEN') {
      throw new WriteoffError('INVOICE_NOT_OPEN', 'Only an open invoice can be written off.');
    }

    // The expense account must be in-company, ACTIVE, and an EXPENSE account (the
    // debit is a cost of doing business — the bad debt).
    const expRows = await tx
      .select({ status: schema.accounts.status, accountType: schema.accounts.accountType })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.expenseAccountId)))
      .limit(1);
    const expense = expRows[0];
    if (expense === undefined) {
      throw new WriteoffError('WRITEOFF_ACCOUNT_INVALID', 'The expense account does not exist in this company.');
    }
    if (expense.status !== 'ACTIVE') {
      throw new WriteoffError('WRITEOFF_ACCOUNT_INVALID', 'The expense account is inactive.');
    }
    if (expense.accountType !== 'EXPENSE') {
      throw new WriteoffError('WRITEOFF_ACCOUNT_INVALID', 'A write-off must debit an expense account.');
    }

    // Open balance = total − non-void reductions (payments applied + prior write-offs).
    const open = toMoney(invoice.total).minus(await invoiceReductionsTotal(tx, companyId, input.invoiceId));
    const amount = toMoney(input.amount);
    if (amount.greaterThan(open)) {
      throw new WriteoffError(
        'WRITEOFF_EXCEEDS_BALANCE',
        `Writing off ${input.amount} exceeds invoice ${invoice.id}'s open balance ${open.toFixed(4)}.`,
      );
    }
    const clearsInvoice = amount.equals(open);

    const writeoffRows = await tx
      .insert(schema.writeoffs)
      .values({
        companyId,
        invoiceId: input.invoiceId,
        customerId: invoice.customerId,
        expenseAccountId: input.expenseAccountId,
        writeoffDate: input.writeoffDate,
        amount: input.amount,
        reason: input.reason,
        status: 'POSTED',
        createdBy: actorUserId,
      })
      .returning();
    const writeoff = writeoffRows[0];
    if (writeoff === undefined) throw new Error('write-off insert returned no row');

    // Post: Dr Bad Debt Expense = amount, Cr A/R = amount (A/R line tagged with the
    // invoice's customer, so the subsidiary sees the reduction).
    const ledgerLines: PostJournalEntryInput['lines'] = [
      { accountId: input.expenseAccountId, debit: input.amount, credit: '0' },
      { accountId: arAccountId, debit: '0', credit: input.amount, customerId: invoice.customerId },
    ];
    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(`write-off ${writeoff.id} posting is unbalanced`);
    }
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: input.writeoffDate,
      postingDate: input.writeoffDate,
      description: `Bad-debt write-off of invoice ${invoice.invoiceNumber ?? invoice.id}`,
      sourceType: 'BAD_DEBT_WRITEOFF',
      sourceId: writeoff.id,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, input.writeoffDate, undefined);

    // A write-off that clears the remaining balance settles the invoice.
    if (clearsInvoice) {
      await tx
        .update(schema.invoices)
        .set({ status: 'PAID', updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.invoices.companyId, companyId),
            eq(schema.invoices.id, input.invoiceId),
            eq(schema.invoices.status, 'OPEN'),
          ),
        );
    }

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'WRITEOFF_POSTED',
      entityType: 'writeoff',
      entityId: writeoff.id,
      after: { invoiceId: input.invoiceId, amount: input.amount, clearedInvoice: clearsInvoice },
    });

    return await loadWriteoff(tx, companyId, writeoff.id);
  });
}

export async function voidWriteoff(
  actorUserId: string,
  companyId: string,
  writeoffId: string,
  input: VoidWriteoffInput,
): Promise<Writeoff> {
  await requirePermission(actorUserId, companyId, 'writeoff.create');

  const pre = await getDbTx()
    .select({ status: schema.writeoffs.status })
    .from(schema.writeoffs)
    .where(and(eq(schema.writeoffs.companyId, companyId), eq(schema.writeoffs.id, writeoffId)))
    .limit(1);
  const preW = pre[0];
  if (preW === undefined) throw new WriteoffError('WRITEOFF_NOT_FOUND', 'Write-off not found.');
  if (preW.status !== 'POSTED') {
    throw new WriteoffError('WRITEOFF_NOT_POSTED', 'Only a posted write-off can be voided.');
  }

  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new WriteoffError('WRITEOFF_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.writeoffs)
      .where(and(eq(schema.writeoffs.companyId, companyId), eq(schema.writeoffs.id, writeoffId)))
      .for('update')
      .limit(1);
    const writeoff = rows[0];
    if (writeoff === undefined) throw new WriteoffError('WRITEOFF_NOT_FOUND', 'Write-off not found.');
    if (writeoff.status !== 'POSTED') {
      throw new WriteoffError('WRITEOFF_NOT_POSTED', 'Only a posted write-off can be voided.');
    }

    // Its posted entry — unique via the source-once index.
    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'BAD_DEBT_WRITEOFF'),
          eq(schema.journalEntries.sourceId, writeoffId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      throw new Error(`posted write-off ${writeoffId} has no journal entry to reverse`);
    }

    // Mark VOID first so this write-off drops out of the invoice's reductions, then
    // reverse the entry in THIS transaction (both commit together).
    await tx
      .update(schema.writeoffs)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.writeoffs.companyId, companyId), eq(schema.writeoffs.id, writeoffId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of write-off ${writeoffId}`,
      },
      reversalDate,
    );

    // If this write-off had cleared its invoice, it is no longer cleared → back to OPEN.
    await tx
      .update(schema.invoices)
      .set({ status: 'OPEN', updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.invoices.companyId, companyId),
          eq(schema.invoices.id, writeoff.invoiceId),
          eq(schema.invoices.status, 'PAID'),
        ),
      );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'WRITEOFF_VOIDED',
      entityType: 'writeoff',
      entityId: writeoffId,
      before: { status: 'POSTED', amount: writeoff.amount },
      after: { status: 'VOID', reversalDate, reason: input.reason ?? null },
    });

    return await loadWriteoff(tx, companyId, writeoffId);
  });
}

export async function getWriteoff(
  actorUserId: string,
  companyId: string,
  writeoffId: string,
): Promise<Writeoff | null> {
  await requirePermission(actorUserId, companyId, 'writeoff.view');
  const rows = await getDbTx()
    .select()
    .from(schema.writeoffs)
    .where(and(eq(schema.writeoffs.companyId, companyId), eq(schema.writeoffs.id, writeoffId)))
    .limit(1);
  return rows[0] ?? null; // cross-company id reads as a genuine miss
}

/** Company-scoped listing. `writeoff.view`. */
export async function listWriteoffs(actorUserId: string, companyId: string): Promise<Writeoff[]> {
  await requirePermission(actorUserId, companyId, 'writeoff.view');
  return await getDbTx()
    .select()
    .from(schema.writeoffs)
    .where(eq(schema.writeoffs.companyId, companyId))
    .orderBy(schema.writeoffs.writeoffDate, schema.writeoffs.createdAt);
}

async function loadWriteoff(tx: Tx | PoolDatabase, companyId: string, writeoffId: string): Promise<Writeoff> {
  const rows = await tx
    .select()
    .from(schema.writeoffs)
    .where(and(eq(schema.writeoffs.companyId, companyId), eq(schema.writeoffs.id, writeoffId)))
    .limit(1);
  const writeoff = rows[0];
  if (writeoff === undefined) throw new Error('write-off vanished');
  return writeoff;
}

export { WriteoffError } from './errors';
export type { WriteoffErrorCode } from './errors';
