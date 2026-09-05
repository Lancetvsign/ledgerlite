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

import { CreditMemoError } from './errors';

import type { PoolDatabase } from '@/db';
import type { CreditMemo } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { IssueCreditMemoInput, VoidCreditMemoInput } from '@/validation/credit-memo';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Customer credit-memo service — LL-051 (Accounts Receivable). Reduce what a customer
 * owes on ONE OPEN invoice (a return or allowance), posting Dr Sales Returns &
 * Allowances (a revenue/contra account) / Cr Accounts Receivable (customer-tagged)
 * through LedgerService, source-typed CREDIT_MEMO and source-once. Void reverses it.
 * ADR-019.
 *
 * A credit memo reduces the invoice's open balance in the A/R subsidiary exactly like
 * a payment or write-off (the open balance derives from invoices minus non-void
 * payments, write-offs, AND credit memos — `invoiceReductionsTotal`), so the
 * aging⇔control reconciliation (GL-T018) keeps holding. Nothing is stored (invariant
 * 2). A credit memo that clears the invoice marks it PAID (settled); voiding reopens
 * it. Authorization is `credit_memo.create` (ALL_WRITERS); the posting goes through
 * `postEntryCore`, which does not re-gate on `journal.post`. Cash refunds and unapplied
 * customer credit are out of scope (ADR-019).
 */

export async function issueCreditMemo(
  actorUserId: string,
  companyId: string,
  input: IssueCreditMemoInput,
): Promise<CreditMemo> {
  await requirePermission(actorUserId, companyId, 'credit_memo.create');

  // Resolve-and-create the posting period BEFORE the tx (never lazily inside — a
  // concurrent create races the exclusion constraint, LL-032).
  const period = await getAccountingPeriod(companyId, input.creditDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${input.creditDate} is closed.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const arAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_RECEIVABLE');
    if (arAccountId === null) {
      throw new CreditMemoError('AR_ACCOUNT_NOT_CONFIGURED', 'No Accounts Receivable account is configured.');
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
      throw new CreditMemoError('INVOICE_NOT_FOUND', 'The invoice does not exist in this company.');
    }
    if (invoice.status !== 'OPEN') {
      throw new CreditMemoError('INVOICE_NOT_OPEN', 'Only an open invoice can be credited.');
    }

    // The returns account must be in-company, ACTIVE, and a REVENUE account (the debit
    // reduces net revenue — a return or allowance).
    const revRows = await tx
      .select({ status: schema.accounts.status, accountType: schema.accounts.accountType })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.revenueAccountId)))
      .limit(1);
    const revenue = revRows[0];
    if (revenue === undefined) {
      throw new CreditMemoError('CREDIT_ACCOUNT_INVALID', 'The revenue account does not exist in this company.');
    }
    if (revenue.status !== 'ACTIVE') {
      throw new CreditMemoError('CREDIT_ACCOUNT_INVALID', 'The revenue account is inactive.');
    }
    if (revenue.accountType !== 'REVENUE') {
      throw new CreditMemoError('CREDIT_ACCOUNT_INVALID', 'A credit memo must debit a revenue account.');
    }

    // Open balance = total − non-void reductions (payments + write-offs + credit memos).
    const open = toMoney(invoice.total).minus(await invoiceReductionsTotal(tx, companyId, input.invoiceId));
    const amount = toMoney(input.amount);
    if (amount.greaterThan(open)) {
      throw new CreditMemoError(
        'CREDIT_EXCEEDS_BALANCE',
        `Crediting ${input.amount} exceeds invoice ${invoice.id}'s open balance ${open.toFixed(4)}.`,
      );
    }
    const clearsInvoice = amount.equals(open);

    const memoRows = await tx
      .insert(schema.creditMemos)
      .values({
        companyId,
        invoiceId: input.invoiceId,
        customerId: invoice.customerId,
        revenueAccountId: input.revenueAccountId,
        creditDate: input.creditDate,
        amount: input.amount,
        reason: input.reason,
        status: 'POSTED',
        createdBy: actorUserId,
      })
      .returning();
    const memo = memoRows[0];
    if (memo === undefined) throw new Error('credit-memo insert returned no row');

    // Post: Dr Sales Returns = amount, Cr A/R = amount (A/R line tagged with the
    // invoice's customer, so the subsidiary sees the reduction).
    const ledgerLines: PostJournalEntryInput['lines'] = [
      { accountId: input.revenueAccountId, debit: input.amount, credit: '0' },
      { accountId: arAccountId, debit: '0', credit: input.amount, customerId: invoice.customerId },
    ];
    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(`credit memo ${memo.id} posting is unbalanced`);
    }
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: input.creditDate,
      postingDate: input.creditDate,
      description: `Credit memo for invoice ${invoice.invoiceNumber ?? invoice.id}`,
      sourceType: 'CREDIT_MEMO',
      sourceId: memo.id,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, input.creditDate, undefined);

    // A credit memo that clears the remaining balance settles the invoice.
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
      action: 'CREDIT_MEMO_ISSUED',
      entityType: 'credit_memo',
      entityId: memo.id,
      after: { invoiceId: input.invoiceId, amount: input.amount, clearedInvoice: clearsInvoice },
    });

    return await loadCreditMemo(tx, companyId, memo.id);
  });
}

export async function voidCreditMemo(
  actorUserId: string,
  companyId: string,
  creditMemoId: string,
  input: VoidCreditMemoInput,
): Promise<CreditMemo> {
  await requirePermission(actorUserId, companyId, 'credit_memo.create');

  const pre = await getDbTx()
    .select({ status: schema.creditMemos.status })
    .from(schema.creditMemos)
    .where(and(eq(schema.creditMemos.companyId, companyId), eq(schema.creditMemos.id, creditMemoId)))
    .limit(1);
  const preM = pre[0];
  if (preM === undefined) throw new CreditMemoError('CREDIT_MEMO_NOT_FOUND', 'Credit memo not found.');
  if (preM.status !== 'POSTED') {
    throw new CreditMemoError('CREDIT_MEMO_NOT_POSTED', 'Only a posted credit memo can be voided.');
  }

  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new CreditMemoError('CREDIT_MEMO_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.creditMemos)
      .where(and(eq(schema.creditMemos.companyId, companyId), eq(schema.creditMemos.id, creditMemoId)))
      .for('update')
      .limit(1);
    const memo = rows[0];
    if (memo === undefined) throw new CreditMemoError('CREDIT_MEMO_NOT_FOUND', 'Credit memo not found.');
    if (memo.status !== 'POSTED') {
      throw new CreditMemoError('CREDIT_MEMO_NOT_POSTED', 'Only a posted credit memo can be voided.');
    }

    // Its posted entry — unique via the source-once index.
    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'CREDIT_MEMO'),
          eq(schema.journalEntries.sourceId, creditMemoId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      throw new Error(`posted credit memo ${creditMemoId} has no journal entry to reverse`);
    }

    // Mark VOID first so this credit memo drops out of the invoice's reductions, then
    // reverse the entry in THIS transaction (both commit together).
    await tx
      .update(schema.creditMemos)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.creditMemos.companyId, companyId), eq(schema.creditMemos.id, creditMemoId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of credit memo ${creditMemoId}`,
      },
      reversalDate,
    );

    // If this credit memo had cleared its invoice, it is no longer cleared → back to OPEN.
    await tx
      .update(schema.invoices)
      .set({ status: 'OPEN', updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.invoices.companyId, companyId),
          eq(schema.invoices.id, memo.invoiceId),
          eq(schema.invoices.status, 'PAID'),
        ),
      );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'CREDIT_MEMO_VOIDED',
      entityType: 'credit_memo',
      entityId: creditMemoId,
      before: { status: 'POSTED', amount: memo.amount },
      after: { status: 'VOID', reversalDate, reason: input.reason ?? null },
    });

    return await loadCreditMemo(tx, companyId, creditMemoId);
  });
}

export async function getCreditMemo(
  actorUserId: string,
  companyId: string,
  creditMemoId: string,
): Promise<CreditMemo | null> {
  await requirePermission(actorUserId, companyId, 'credit_memo.view');
  const rows = await getDbTx()
    .select()
    .from(schema.creditMemos)
    .where(and(eq(schema.creditMemos.companyId, companyId), eq(schema.creditMemos.id, creditMemoId)))
    .limit(1);
  return rows[0] ?? null; // cross-company id reads as a genuine miss
}

/** Company-scoped listing. `credit_memo.view`. */
export async function listCreditMemos(actorUserId: string, companyId: string): Promise<CreditMemo[]> {
  await requirePermission(actorUserId, companyId, 'credit_memo.view');
  return await getDbTx()
    .select()
    .from(schema.creditMemos)
    .where(eq(schema.creditMemos.companyId, companyId))
    .orderBy(schema.creditMemos.creditDate, schema.creditMemos.createdAt);
}

async function loadCreditMemo(tx: Tx | PoolDatabase, companyId: string, creditMemoId: string): Promise<CreditMemo> {
  const rows = await tx
    .select()
    .from(schema.creditMemos)
    .where(and(eq(schema.creditMemos.companyId, companyId), eq(schema.creditMemos.id, creditMemoId)))
    .limit(1);
  const memo = rows[0];
  if (memo === undefined) throw new Error('credit memo vanished');
  return memo;
}

export { CreditMemoError } from './errors';
export type { CreditMemoErrorCode } from './errors';
