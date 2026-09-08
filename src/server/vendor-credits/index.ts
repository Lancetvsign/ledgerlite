import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { resolveSystemAccount } from '@/server/accounts';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import {
  findIdempotentDocument,
  fingerprintRequest,
  isIdempotencyViolation,
  LedgerError,
  postEntryCore,
  reverseEntryCore,
} from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';
import { billReductionsTotal } from '@/server/reports/bill-open-balance';

import { VendorCreditError } from './errors';

import type { PoolDatabase } from '@/db';
import type { VendorCredit } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { IssueVendorCreditInput, VoidVendorCreditInput } from '@/validation/vendor-credit';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Vendor-credit service — LL-063 (Accounts Payable). The structural mirror of the
 * customer credit-memo service (LL-051). Reduce what we owe a vendor on ONE OPEN bill
 * (a return or allowance), posting Dr Accounts Payable (vendor-tagged) / Cr an expense
 * account through LedgerService, source-typed VENDOR_CREDIT and source-once. Void
 * reverses it.
 *
 * A vendor credit reduces the bill's open balance in the A/P subsidiary exactly like a
 * bill payment (the open balance derives from bills minus non-void bill payments AND
 * vendor credits — `billReductionsTotal`), so the A/P aging⇔control reconciliation
 * (LL-064 / GL-T023) keeps holding. Nothing is stored (invariant 2). A vendor credit
 * that clears the bill marks it PAID (settled); voiding reopens it. Authorization is
 * `vendor_credit.create` (ALL_WRITERS); the posting goes through `postEntryCore`, which
 * does not re-gate on `journal.post`. Vendor refunds and unapplied vendor credit are
 * out of scope (the A/P analogue of ADR-019).
 */

export async function issueVendorCredit(
  actorUserId: string,
  companyId: string,
  input: IssueVendorCreditInput,
): Promise<VendorCredit> {
  await requirePermission(actorUserId, companyId, 'vendor_credit.create');

  // Resolve-and-create the posting period BEFORE the tx (never lazily inside — a
  // concurrent create races the exclusion constraint, LL-032).
  const period = await getAccountingPeriod(companyId, input.creditDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${input.creditDate} is closed.`);
  }

  // Submit-once idempotency (LL-067). Fingerprint the REQUEST (the bill it credits and
  // the amount); a retry that collides on the key resolves to the ORIGINAL credit
  // instead of crediting the vendor twice.
  const idempotencyKey = input.idempotencyKey;
  const fingerprint =
    idempotencyKey === undefined
      ? undefined
      : fingerprintRequest({
          kind: 'vendor_credit',
          companyId,
          billId: input.billId,
          expenseAccountId: input.expenseAccountId,
          creditDate: input.creditDate,
          amount: input.amount,
          reason: input.reason ?? '',
        });
  const loadDoc = (id: string): Promise<VendorCredit> => loadVendorCredit(getDbTx(), companyId, id);

  // A retry whose key already posted returns the ORIGINAL here — BEFORE the
  // state-dependent validation below (the bill must still be OPEN, the credit ≤ its open
  // balance), which the winner's own credit would now make fail. A no-op, not an error.
  if (idempotencyKey !== undefined) {
    const prior = await findIdempotentDocument(companyId, idempotencyKey, fingerprint!, loadDoc);
    if (prior !== null) return prior;
  }

  const runCredit = (): Promise<VendorCredit> =>
    getDbTx().transaction(async (tx) => {
    const apAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_PAYABLE');
    if (apAccountId === null) {
      throw new VendorCreditError('AP_ACCOUNT_NOT_CONFIGURED', 'No Accounts Payable account is configured.');
    }

    // Lock the bill and validate it authoritatively.
    const billRows = await tx
      .select()
      .from(schema.bills)
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, input.billId)))
      .for('update')
      .limit(1);
    const bill = billRows[0];
    if (bill === undefined) {
      throw new VendorCreditError('BILL_NOT_FOUND', 'The bill does not exist in this company.');
    }
    if (bill.status !== 'OPEN') {
      throw new VendorCreditError('BILL_NOT_OPEN', 'Only an open bill can be credited.');
    }

    // The credited account must be in-company, ACTIVE, and an EXPENSE account (the
    // credit reduces an expense — a return or allowance). The mirror of the credit
    // memo's REVENUE requirement.
    const expRows = await tx
      .select({ status: schema.accounts.status, accountType: schema.accounts.accountType })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.expenseAccountId)))
      .limit(1);
    const expense = expRows[0];
    if (expense === undefined) {
      throw new VendorCreditError('CREDIT_ACCOUNT_INVALID', 'The expense account does not exist in this company.');
    }
    if (expense.status !== 'ACTIVE') {
      throw new VendorCreditError('CREDIT_ACCOUNT_INVALID', 'The expense account is inactive.');
    }
    if (expense.accountType !== 'EXPENSE') {
      throw new VendorCreditError('CREDIT_ACCOUNT_INVALID', 'A vendor credit must credit an expense account.');
    }

    // Open balance = total − non-void reductions (bill payments + vendor credits).
    const open = toMoney(bill.total).minus(await billReductionsTotal(tx, companyId, input.billId));
    const amount = toMoney(input.amount);
    if (amount.greaterThan(open)) {
      throw new VendorCreditError(
        'CREDIT_EXCEEDS_BALANCE',
        `Crediting ${input.amount} exceeds bill ${bill.id}'s open balance ${open.toFixed(4)}.`,
      );
    }
    const clearsBill = amount.equals(open);

    const creditRows = await tx
      .insert(schema.vendorCredits)
      .values({
        companyId,
        billId: input.billId,
        vendorId: bill.vendorId,
        expenseAccountId: input.expenseAccountId,
        creditDate: input.creditDate,
        amount: input.amount,
        reason: input.reason,
        status: 'POSTED',
        createdBy: actorUserId,
      })
      .returning();
    const credit = creditRows[0];
    if (credit === undefined) throw new Error('vendor-credit insert returned no row');

    // Post: Dr A/P = amount (A/P line tagged with the bill's vendor, so the subsidiary
    // sees the reduction), Cr expense account = amount.
    const ledgerLines: PostJournalEntryInput['lines'] = [
      { accountId: apAccountId, debit: input.amount, credit: '0', vendorId: bill.vendorId },
      { accountId: input.expenseAccountId, debit: '0', credit: input.amount },
    ];
    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(`vendor credit ${credit.id} posting is unbalanced`);
    }
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: input.creditDate,
      postingDate: input.creditDate,
      description: `Vendor credit for bill ${bill.billNumber ?? bill.id}`,
      sourceType: 'VENDOR_CREDIT',
      sourceId: credit.id,
      idempotencyKey,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, input.creditDate, fingerprint);

    // A vendor credit that clears the remaining balance settles the bill.
    if (clearsBill) {
      await tx
        .update(schema.bills)
        .set({ status: 'PAID', updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.bills.companyId, companyId),
            eq(schema.bills.id, input.billId),
            eq(schema.bills.status, 'OPEN'),
          ),
        );
    }

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'VENDOR_CREDIT_ISSUED',
      entityType: 'vendor_credit',
      entityId: credit.id,
      after: { billId: input.billId, amount: input.amount, clearedBill: clearsBill },
    });

    return await loadVendorCredit(tx, companyId, credit.id);
  });

  // No key → post directly. With a key, a retry that collides on the idempotency index
  // resolves to the ORIGINAL credit (fingerprint-verified) — a double-submit is a no-op.
  if (idempotencyKey === undefined) return await runCredit();
  try {
    return await runCredit();
  } catch (error) {
    // A truly-concurrent first submit lost the (company, key) unique index at post time.
    if (isIdempotencyViolation(error)) {
      const resolved = await findIdempotentDocument(companyId, idempotencyKey, fingerprint!, loadDoc);
      if (resolved !== null) return resolved;
    }
    throw error;
  }
}

export async function voidVendorCredit(
  actorUserId: string,
  companyId: string,
  vendorCreditId: string,
  input: VoidVendorCreditInput,
): Promise<VendorCredit> {
  await requirePermission(actorUserId, companyId, 'vendor_credit.void');

  const pre = await getDbTx()
    .select({ status: schema.vendorCredits.status })
    .from(schema.vendorCredits)
    .where(and(eq(schema.vendorCredits.companyId, companyId), eq(schema.vendorCredits.id, vendorCreditId)))
    .limit(1);
  const preC = pre[0];
  if (preC === undefined) throw new VendorCreditError('VENDOR_CREDIT_NOT_FOUND', 'Vendor credit not found.');
  if (preC.status !== 'POSTED') {
    throw new VendorCreditError('VENDOR_CREDIT_NOT_POSTED', 'Only a posted vendor credit can be voided.');
  }

  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new VendorCreditError('VENDOR_CREDIT_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.vendorCredits)
      .where(and(eq(schema.vendorCredits.companyId, companyId), eq(schema.vendorCredits.id, vendorCreditId)))
      .for('update')
      .limit(1);
    const credit = rows[0];
    if (credit === undefined) throw new VendorCreditError('VENDOR_CREDIT_NOT_FOUND', 'Vendor credit not found.');
    if (credit.status !== 'POSTED') {
      throw new VendorCreditError('VENDOR_CREDIT_NOT_POSTED', 'Only a posted vendor credit can be voided.');
    }

    // Its posted entry — unique via the source-once index.
    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'VENDOR_CREDIT'),
          eq(schema.journalEntries.sourceId, vendorCreditId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      throw new Error(`posted vendor credit ${vendorCreditId} has no journal entry to reverse`);
    }

    // Lock the bill so the PAID -> OPEN revert serialises against a concurrent
    // pay / credit / void on it (mirror of voidCreditMemo's invoice lock).
    await tx
      .select({ id: schema.bills.id })
      .from(schema.bills)
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, credit.billId)))
      .for('update');

    // Mark VOID first so this vendor credit drops out of the bill's reductions, then
    // reverse the entry in THIS transaction (both commit together).
    await tx
      .update(schema.vendorCredits)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.vendorCredits.companyId, companyId), eq(schema.vendorCredits.id, vendorCreditId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of vendor credit ${vendorCreditId}`,
      },
      reversalDate,
    );

    // If this vendor credit had cleared its bill, it is no longer cleared → back to OPEN.
    await tx
      .update(schema.bills)
      .set({ status: 'OPEN', updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.bills.companyId, companyId),
          eq(schema.bills.id, credit.billId),
          eq(schema.bills.status, 'PAID'),
        ),
      );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'VENDOR_CREDIT_VOIDED',
      entityType: 'vendor_credit',
      entityId: vendorCreditId,
      before: { status: 'POSTED', amount: credit.amount },
      after: { status: 'VOID', reversalDate, reason: input.reason ?? null },
    });

    return await loadVendorCredit(tx, companyId, vendorCreditId);
  });
}

export async function getVendorCredit(
  actorUserId: string,
  companyId: string,
  vendorCreditId: string,
): Promise<VendorCredit | null> {
  await requirePermission(actorUserId, companyId, 'vendor_credit.view');
  const rows = await getDbTx()
    .select()
    .from(schema.vendorCredits)
    .where(and(eq(schema.vendorCredits.companyId, companyId), eq(schema.vendorCredits.id, vendorCreditId)))
    .limit(1);
  return rows[0] ?? null; // cross-company id reads as a genuine miss
}

/** Company-scoped listing. `vendor_credit.view`. */
export async function listVendorCredits(actorUserId: string, companyId: string): Promise<VendorCredit[]> {
  await requirePermission(actorUserId, companyId, 'vendor_credit.view');
  return await getDbTx()
    .select()
    .from(schema.vendorCredits)
    .where(eq(schema.vendorCredits.companyId, companyId))
    .orderBy(schema.vendorCredits.creditDate, schema.vendorCredits.createdAt);
}

async function loadVendorCredit(
  tx: Tx | PoolDatabase,
  companyId: string,
  vendorCreditId: string,
): Promise<VendorCredit> {
  const rows = await tx
    .select()
    .from(schema.vendorCredits)
    .where(and(eq(schema.vendorCredits.companyId, companyId), eq(schema.vendorCredits.id, vendorCreditId)))
    .limit(1);
  const credit = rows[0];
  if (credit === undefined) throw new Error('vendor credit vanished');
  return credit;
}

export { VendorCreditError } from './errors';
export type { VendorCreditErrorCode } from './errors';
