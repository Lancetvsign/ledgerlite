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

import { BillError } from './errors';

import type { PoolDatabase } from '@/db';
import type { Bill, BillLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { BillLineInput, CreateBillInput, UpdateBillInput, VoidBillInput } from '@/validation/bill';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Bill service — LL-061 (Accounts Payable). The structural mirror of the invoice
 * service (LL-041/042): DRAFT lifecycle, finalize (post to the ledger), and void.
 *
 * Every operation is company-scoped and authorization-gated (AGENTS §6). The total
 * is ALWAYS recomputed from the lines with decimal.js and stored (ADR-013) — no
 * input carries a total. Money is a string at every boundary and a `Decimal` only
 * in computation (ADR-004). Tenancy is structural: the vendor and every line account
 * are re-validated to be in this company, and the composite FKs make a cross-tenant
 * reference impossible even if that check were wrong. No tax leg (LL-061 scope).
 */

export interface BillWithLines {
  readonly bill: Bill;
  readonly lines: BillLine[];
}

/**
 * The one place bill money is computed. Per line: amount = quantity × unit price,
 * rounded to NUMERIC(19,4) (ROUND_HALF_EVEN, ADR-004). The total is the sum. Pure —
 * no I/O, exercised directly in tests.
 */
export function computeBillTotal(
  lines: readonly { readonly quantity: string; readonly unitPrice: string }[],
): string {
  let total = new Decimal(0);
  for (const line of lines) {
    total = total.plus(toMoney(line.quantity).times(toMoney(line.unitPrice)).toDecimalPlaces(4));
  }
  return total.toFixed(4);
}

export interface BillPostingBreakdown {
  readonly total: string;
  /** Expense to debit — one entry per DISTINCT account, in first-appearance order. */
  readonly expenseByAccount: readonly { readonly accountId: string; readonly amount: string }[];
}

/**
 * The per-account breakdown a finalize posts: the SAME total as `computeBillTotal`
 * (reused) plus expense grouped by account. Each account's debit is the sum of its
 * lines' 4dp amounts, so the expense debits sum to `total` exactly and balance the
 * A/P credit at NUMERIC(19,4). Pure — no I/O, tested directly.
 */
export function computeBillPosting(
  lines: readonly { readonly accountId: string; readonly quantity: string; readonly unitPrice: string }[],
): BillPostingBreakdown {
  const total = computeBillTotal(lines);
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
  const expenseByAccount = order.map((accountId) => ({
    accountId,
    amount: (byAccount.get(accountId) ?? new Decimal(0)).toFixed(4),
  }));
  return { total, expenseByAccount };
}

/**
 * Every bill line must post to an ordinary, in-company account — never a system
 * CONTROL account. Debiting the Accounts Payable control account as an "expense"
 * line posts Dr A/P (an amount) / Cr A/P (the total): the entry balances, so every
 * trigger passes, but the bill's full total counts as open in the A/P aging while
 * the ledger A/P moved by less — silently breaking the aging⇔control reconciliation
 * (the A/P analogue of GL-T018 / ADR-016). Accounts Receivable, Sales Tax Payable,
 * etc. are system-managed too and are never a legitimate manual line choice. Because
 * the browser is untrusted (AGENTS §6) and the line `accountId` is client-supplied,
 * the rule is enforced HERE, at the service. Also confirms each account exists.
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
      throw new BillError('ACCOUNT_NOT_FOUND', 'A line references an account not in this company.');
    }
    if (systemTypeById.get(id) !== null) {
      throw new BillError(
        'LINE_ACCOUNT_INVALID',
        'A bill line cannot post to a system control account (e.g. Accounts Payable).',
      );
    }
  }
}

/** Confirms the vendor lives in THIS company and every line account is postable. */
async function validateReferences(
  tx: Tx,
  companyId: string,
  vendorId: string,
  lines: readonly BillLineInput[],
): Promise<void> {
  const vendor = await tx
    .select({ id: schema.vendors.id })
    .from(schema.vendors)
    .where(and(eq(schema.vendors.companyId, companyId), eq(schema.vendors.id, vendorId)))
    .limit(1);
  if (vendor[0] === undefined) {
    throw new BillError('VENDOR_NOT_FOUND', 'That vendor does not exist in this company.');
  }
  await assertLineAccountsPostable(tx, companyId, lines.map((l) => l.accountId));
}

async function insertLines(
  tx: Tx,
  companyId: string,
  billId: string,
  lines: readonly BillLineInput[],
): Promise<void> {
  await tx.insert(schema.billLines).values(
    lines.map((line, index) => ({
      billId,
      companyId,
      lineNumber: index + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
    })),
  );
}

export async function createBill(
  actorUserId: string,
  companyId: string,
  input: CreateBillInput,
): Promise<BillWithLines> {
  await requirePermission(actorUserId, companyId, 'expense.create');
  const total = computeBillTotal(input.lines);

  return await getDbTx().transaction(async (tx) => {
    await validateReferences(tx, companyId, input.vendorId, input.lines);

    const rows = await tx
      .insert(schema.bills)
      .values({
        companyId,
        vendorId: input.vendorId,
        status: 'DRAFT',
        billDate: input.billDate,
        dueDate: input.dueDate,
        memo: input.memo,
        total,
        createdBy: actorUserId,
      })
      .returning();
    const bill = rows[0];
    if (bill === undefined) throw new Error('bill insert returned no row');

    await insertLines(tx, companyId, bill.id, input.lines);
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BILL_CREATED',
      entityType: 'bill',
      entityId: bill.id,
      after: { status: 'DRAFT', total, lineCount: input.lines.length },
    });
    return await loadBill(tx, companyId, bill.id);
  });
}

export async function updateBill(
  actorUserId: string,
  companyId: string,
  billId: string,
  input: UpdateBillInput,
): Promise<BillWithLines> {
  await requirePermission(actorUserId, companyId, 'expense.create');
  const total = computeBillTotal(input.lines);

  return await getDbTx().transaction(async (tx) => {
    // FOR UPDATE: an edit and a concurrent finalize (which flips DRAFT→OPEN and
    // posts) must serialise, so this update cannot clobber an already-posted bill.
    const existing = await tx
      .select()
      .from(schema.bills)
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
      .for('update')
      .limit(1);
    const bill = existing[0];
    if (bill === undefined) throw new BillError('BILL_NOT_FOUND', 'Bill not found.');
    if (bill.status !== 'DRAFT') {
      throw new BillError('BILL_NOT_DRAFT', 'Only a draft bill can be edited.');
    }

    await validateReferences(tx, companyId, input.vendorId, input.lines);

    await tx
      .update(schema.bills)
      .set({
        vendorId: input.vendorId,
        billDate: input.billDate,
        dueDate: input.dueDate ?? null,
        memo: input.memo ?? null,
        total,
        updatedAt: sql`now()`,
      })
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)));
    await tx.delete(schema.billLines).where(eq(schema.billLines.billId, billId));
    await insertLines(tx, companyId, billId, input.lines);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BILL_UPDATED',
      entityType: 'bill',
      entityId: billId,
      before: { total: bill.total },
      after: { total, lineCount: input.lines.length },
    });
    return await loadBill(tx, companyId, billId);
  });
}

export async function getBill(
  actorUserId: string,
  companyId: string,
  billId: string,
): Promise<BillWithLines | null> {
  await requirePermission(actorUserId, companyId, 'expense.view');
  const rows = await getDbTx()
    .select()
    .from(schema.bills)
    .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
    .limit(1);
  if (rows[0] === undefined) return null; // cross-company id reads as a genuine miss
  return await loadBill(getDbTx(), companyId, billId);
}

/** Company-scoped listing (headers + stored total). `expense.view`. */
export async function listBills(actorUserId: string, companyId: string): Promise<Bill[]> {
  await requirePermission(actorUserId, companyId, 'expense.view');
  return await getDbTx()
    .select()
    .from(schema.bills)
    .where(eq(schema.bills.companyId, companyId))
    .orderBy(schema.bills.billDate, schema.bills.createdAt);
}

async function loadBill(
  tx: Tx | PoolDatabase,
  companyId: string,
  billId: string,
): Promise<BillWithLines> {
  const billRows = await tx
    .select()
    .from(schema.bills)
    .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
    .limit(1);
  const bill = billRows[0];
  if (bill === undefined) throw new Error('bill vanished');
  const lines = await tx
    .select()
    .from(schema.billLines)
    .where(eq(schema.billLines.billId, billId))
    .orderBy(schema.billLines.lineNumber);
  return { bill, lines };
}

/**
 * Finalize a DRAFT bill: assign its number, transition DRAFT→OPEN, and post the
 * balanced entry to the general ledger — ATOMICALLY, in one transaction (invariant 7).
 *
 * The entry: Dr each expense account = its lines' amount, Cr Accounts Payable = total
 * (tagged with the VENDOR). It is source-typed EXPENSE with the bill's id, so the
 * "one POSTED per source" index makes a second posting of the same bill impossible —
 * that, with the DRAFT-guarded (FOR UPDATE) transition, is the idempotency.
 *
 * Authorized at `expense.create` (ALL_WRITERS incl. BOOKKEEPER). The posting goes
 * through `postEntryCore`, which does NOT re-check `journal.post`.
 */
export async function finalizeBill(
  actorUserId: string,
  companyId: string,
  billId: string,
): Promise<BillWithLines> {
  await requirePermission(actorUserId, companyId, 'expense.create');

  // Resolve-and-create the posting period BEFORE the tx (LL-032). Fast pre-check too.
  const pre = await getDbTx()
    .select({ status: schema.bills.status, billDate: schema.bills.billDate })
    .from(schema.bills)
    .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
    .limit(1);
  const preBill = pre[0];
  if (preBill === undefined) throw new BillError('BILL_NOT_FOUND', 'Bill not found.');
  if (preBill.status !== 'DRAFT') {
    throw new BillError('BILL_NOT_DRAFT', 'Only a draft bill can be finalized.');
  }
  const period = await getAccountingPeriod(companyId, preBill.billDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${preBill.billDate} is closed.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.bills)
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
      .for('update')
      .limit(1);
    const bill = rows[0];
    if (bill === undefined) throw new BillError('BILL_NOT_FOUND', 'Bill not found.');
    if (bill.status !== 'DRAFT') {
      throw new BillError('BILL_NOT_DRAFT', 'Only a draft bill can be finalized.');
    }
    if (bill.billDate !== preBill.billDate) {
      throw new Error(`bill ${billId} date changed during finalize; retry`);
    }

    const lineRows = await tx
      .select()
      .from(schema.billLines)
      .where(eq(schema.billLines.billId, billId))
      .orderBy(schema.billLines.lineNumber);

    // Defense in depth: no stored line may post to a system control account.
    await assertLineAccountsPostable(tx, companyId, lineRows.map((l) => l.accountId));

    // Derive the posting from the LOCKED lines; assert it matches the stored total
    // (ADR-013 tripwire — the service is the only writer of both).
    const posting = computeBillPosting(lineRows);
    if (posting.total !== bill.total) {
      throw new Error(`bill ${billId} stored total disagrees with its lines`);
    }
    if (toMoney(posting.total).lessThanOrEqualTo(0)) {
      throw new BillError('BILL_ZERO_TOTAL', 'A zero-total bill cannot be finalized.');
    }

    // Resolve A/P — the credit side (the payable owed to the vendor).
    const apAccountId = await resolveSystemAccount(tx, companyId, 'ACCOUNTS_PAYABLE');
    if (apAccountId === null) {
      throw new BillError('AP_ACCOUNT_NOT_CONFIGURED', 'No Accounts Payable account is configured.');
    }

    // Build the balanced lines: Dr expense by account, Cr A/P (vendor-tagged). A zero
    // expense group is skipped; the rest still sum to total.
    const ledgerLines: PostJournalEntryInput['lines'] = [];
    for (const exp of posting.expenseByAccount) {
      if (toMoney(exp.amount).greaterThan(0)) {
        ledgerLines.push({ accountId: exp.accountId, debit: exp.amount, credit: '0' });
      }
    }
    ledgerLines.push({ accountId: apAccountId, debit: '0', credit: posting.total, vendorId: bill.vendorId });

    const debits = sumMoney(ledgerLines.map((l) => l.debit));
    const credits = sumMoney(ledgerLines.map((l) => l.credit));
    if (!moneyEquals(debits, credits)) {
      throw new Error(`bill ${billId} posting is unbalanced (${debits.toString()} vs ${credits.toString()})`);
    }

    // Allocate the bill number — plain atomic increment, GAPS ALLOWED.
    const numberRows = await tx.execute<{ next_bill_number: string }>(sql`
      update company_counters
      set next_bill_number = next_bill_number + 1
      where company_id = ${companyId}
      returning next_bill_number - 1 as next_bill_number`);
    const allocated = numberRows.rows[0]?.next_bill_number;
    if (allocated === undefined) {
      throw new Error(`company ${companyId} has no bill-number counter row`);
    }
    const billNumber = String(allocated);

    await tx
      .update(schema.bills)
      .set({ status: 'OPEN', billNumber, updatedAt: sql`now()` })
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)));

    const postingDate = bill.billDate;
    const ledgerInput: PostJournalEntryInput = {
      companyId,
      actorUserId,
      transactionDate: postingDate,
      postingDate,
      description: `Bill ${billNumber}`,
      sourceType: 'EXPENSE',
      sourceId: billId,
      lines: ledgerLines,
    };
    await postEntryCore(tx, ledgerInput, postingDate, undefined);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BILL_FINALIZED',
      entityType: 'bill',
      entityId: billId,
      before: { status: 'DRAFT' },
      after: { status: 'OPEN', billNumber, total: posting.total },
    });
    return await loadBill(tx, companyId, billId);
  });
}

/**
 * Void an OPEN bill: reverse its posted entry and mark the bill VOID — atomically.
 * The original entry is never edited (invariant 3); the reversal nets it to zero.
 * Authorized at `bill.void` (LEDGER_WRITERS) — a void is a ledger correction (LL-053).
 *
 * NOTE — reduction guard (Gate-4 lesson, memory `ledgerlite-ar-reduction-sources`):
 * bills have no reductions yet, so there is nothing to strand. When LL-062 (bill
 * payments) and LL-063 (vendor credits) land, this MUST gain a symmetric guard —
 * refuse the void when live bill-payments or vendor-credits reference the bill
 * (BILL_HAS_PAYMENTS / BILL_HAS_ADJUSTMENTS) — or voiding a partially-reduced bill
 * would drive the vendor's A/P negative and break the aging⇔control tie.
 */
export async function voidBill(
  actorUserId: string,
  companyId: string,
  billId: string,
  input: VoidBillInput,
): Promise<BillWithLines> {
  await requirePermission(actorUserId, companyId, 'bill.void');

  const pre = await getDbTx()
    .select({ status: schema.bills.status })
    .from(schema.bills)
    .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
    .limit(1);
  const preBill = pre[0];
  if (preBill === undefined) throw new BillError('BILL_NOT_FOUND', 'Bill not found.');
  if (preBill.status !== 'OPEN') {
    throw new BillError('BILL_NOT_OPEN', 'Only an open bill can be voided.');
  }
  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new BillError('BILL_NOT_FOUND', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.bills)
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)))
      .for('update')
      .limit(1);
    const bill = rows[0];
    if (bill === undefined) throw new BillError('BILL_NOT_FOUND', 'Bill not found.');
    if (bill.status !== 'OPEN') {
      throw new BillError('BILL_NOT_OPEN', 'Only an open bill can be voided.');
    }

    const entryRows = await tx
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(
        and(
          eq(schema.journalEntries.companyId, companyId),
          eq(schema.journalEntries.sourceType, 'EXPENSE'),
          eq(schema.journalEntries.sourceId, billId),
          eq(schema.journalEntries.status, 'POSTED'),
        ),
      )
      .limit(1);
    const posted = entryRows[0];
    if (posted === undefined) {
      throw new Error(`open bill ${billId} has no posted entry to reverse`);
    }

    await tx
      .update(schema.bills)
      .set({ status: 'VOID', updatedAt: sql`now()` })
      .where(and(eq(schema.bills.companyId, companyId), eq(schema.bills.id, billId)));

    await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: posted.id,
        reversalDate,
        description: input.reason ?? `Void of bill ${bill.billNumber ?? billId}`,
      },
      reversalDate,
    );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'BILL_VOIDED',
      entityType: 'bill',
      entityId: billId,
      before: { status: 'OPEN' },
      after: { status: 'VOID' },
    });
    return await loadBill(tx, companyId, billId);
  });
}

export { BillError } from './errors';
export type { BillErrorCode } from './errors';
