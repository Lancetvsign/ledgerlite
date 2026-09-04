import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { moneyEquals, sumMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import { getAccountingPeriod } from '@/server/periods';

import { LedgerError } from './errors';
import { allocateEntryNumber, loadEntry, toLedgerDomainError, type PostedEntry, type Tx } from './internal';

import type { JournalLine } from '@/db/schema';
import type { ReverseJournalEntryInput } from '@/validation/journal';

/**
 * Reversal engine — LL-033.
 *
 * The only correct way to undo a posted entry (invariant 3). It NEVER edits the
 * original: it posts a NEW entry with every debit turned into a credit and every
 * credit into a debit, on the same accounts for the same amounts, so the two
 * together net to exactly zero on every account. The original keeps its date,
 * lines, and amounts precisely as posted; it gains only `reversed_by_id` and the
 * status `REVERSED`, through the single transition the LL-030 trigger permits.
 *
 * The reversal date follows ADR-007: the caller supplies it, it defaults to the
 * company's today, and it must fall in an OPEN period. The original's period is
 * never reopened, mutated, or even read for its status — a January error found
 * in March is reversed in March, and January's closed books stay closed.
 *
 * Reversing a reversal is ordinary and permitted (a reversal is just a posted
 * entry). Reversing one that is already `REVERSED` is rejected — that would
 * double-count the correction.
 */
export async function reverseJournalEntry(input: ReverseJournalEntryInput): Promise<PostedEntry> {
  // ---- 1. Authorization — a reversal is a posting; same capability. ---------
  await requirePermission(input.actorUserId, input.companyId, 'journal.post');

  // ---- 2. Company must exist and be active. Loading it here also gives us the
  // timezone needed to resolve "the company's today" (ADR-007). ---------------
  const companyRows = await getDbTx()
    .select({ status: schema.companies.status, timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, input.companyId))
    .limit(1);
  const company = companyRows[0];
  if (company === undefined || company.status !== 'ACTIVE') {
    throw new LedgerError('COMPANY_NOT_FOUND', 'Company not found or inactive.');
  }

  // ---- 3. Resolve the reversal date and its period BEFORE the transaction. --
  // Same discipline as posting (LL-032): creating the period lazily inside the
  // posting tx would let concurrent operations race on the period's exclusion
  // constraint. Resolve-and-create it first, in its own commit.
  const reversalDate = input.reversalDate ?? todayInTimeZone(company.timezone);
  const period = await getAccountingPeriod(input.companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError(
      'PERIOD_CLOSED',
      `The reversal date ${reversalDate} falls in a closed period.`,
    );
  }

  try {
    return await reverseInNewTransaction(input, reversalDate);
  } catch (error) {
    // A concurrent reversal that slipped past the status guard is stopped by the
    // LL-030 trigger (OLD.reversed_by_id must be NULL). Surface it as the typed
    // immutability error rather than a raw constraint violation.
    throw toLedgerDomainError(error);
  }
}

async function reverseInNewTransaction(
  input: ReverseJournalEntryInput,
  reversalDate: string,
): Promise<PostedEntry> {
  return await getDbTx().transaction((tx) => reverseEntryCore(tx, input, reversalDate));
}

/**
 * The in-transaction reversal mechanics, shared by the manual reversal path
 * above and by document services (voiding an invoice in LL-042; a payment
 * later) that must reverse WITHIN their own transaction, so the document's
 * status change and its reversing entry commit atomically.
 *
 * MECHANICAL BY DESIGN — like `postEntryCore`, it does NOT authorize and does
 * NOT create the period. The CALLER authorizes at its own capability (a manual
 * reversal → `journal.post`; an invoice void → `invoice.post`) and resolves the
 * reversal-date period BEFORE opening the transaction handed in here.
 */
export async function reverseEntryCore(
  tx: Tx,
  input: ReverseJournalEntryInput,
  reversalDate: string,
): Promise<PostedEntry> {
  // ---- Load and LOCK the original, scoped to this company. ------------------
  // FOR UPDATE serialises concurrent reversals of the same entry: the second
  // waits, then re-reads the now-REVERSED row and is rejected below — exactly
  // one reversal is ever produced. Scoping to (company_id, id) means a
  // cross-company id resolves to nothing and returns the same ENTRY_NOT_FOUND
  // as a genuine miss, never revealing that it exists in another company.
  const originalRows = await tx
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.companyId, input.companyId),
        eq(schema.journalEntries.id, input.entryId),
      ),
    )
    .for('update')
    .limit(1);
  const original = originalRows[0];
  if (original === undefined) {
    throw new LedgerError('ENTRY_NOT_FOUND', 'Entry not found.');
  }

  // ---- Only a POSTED, not-yet-reversed entry can be reversed. ---------------
  if (original.status === 'DRAFT') {
    throw new LedgerError('ENTRY_NOT_POSTED', 'Only a posted entry can be reversed.');
  }
  if (original.status === 'REVERSED' || original.reversedById !== null) {
    throw new LedgerError('ENTRY_ALREADY_REVERSED', 'This entry has already been reversed.');
  }

  // ---- Company still active (parity with posting; atomic in-tx). ------------
  const companyNow = await tx
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(
      and(eq(schema.companies.id, input.companyId), eq(schema.companies.status, 'ACTIVE')),
    )
    .limit(1);
  if (companyNow[0] === undefined) {
    throw new LedgerError('COMPANY_NOT_FOUND', 'Company not found or inactive.');
  }

  // ---- Re-read the reversal period inside the tx (a close could have landed
  // in the gap since we resolved it). Never CREATE here — that would race. ----
  const periodNow = await tx
    .select({ status: schema.accountingPeriods.status })
    .from(schema.accountingPeriods)
    .where(
      and(
        eq(schema.accountingPeriods.companyId, input.companyId),
        sql`${reversalDate} between start_date and end_date`,
      ),
    )
    .limit(1);
  if (periodNow[0]?.status === 'CLOSED') {
    throw new LedgerError(
      'PERIOD_CLOSED',
      `The reversal date ${reversalDate} falls in a closed period.`,
    );
  }

  // ---- Derive the reversing lines: swap debit and credit. -------------------
  // Amounts and accounts are copied verbatim from the original's committed
  // lines. The original's accounts may since have been DEACTIVATED — a
  // reversal must still be possible against them, so unlike posting this path
  // deliberately does NOT re-check account status. Trapping an erroneous entry
  // because its account was later deactivated is not an option.
  const originalLines = await tx
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.journalEntryId, original.id))
    .orderBy(schema.journalLines.lineNumber);
  if (originalLines.length < 2) {
    // A POSTED entry always has ≥2 lines (LL-030). This cannot happen; if it
    // does, the ledger is corrupt and we must not compound it.
    throw new Error(`posted entry ${original.id} has ${String(originalLines.length)} lines`);
  }

  const reversalLines = originalLines.map((line: JournalLine) => ({
    companyId: input.companyId,
    accountId: line.accountId,
    lineNumber: line.lineNumber,
    description: line.description,
    debit: line.credit, // swap
    credit: line.debit, // swap
    customerId: line.customerId,
    vendorId: line.vendorId,
  }));

  // Balance is structurally guaranteed by the swap, but we assert it here too
  // (ADR-004, exact NUMERIC(19,4) equality) — "same balance validation" as
  // posting, and a tripwire if the original were ever stored unbalanced.
  const debits = sumMoney(reversalLines.map((l) => l.debit));
  const credits = sumMoney(reversalLines.map((l) => l.credit));
  if (!moneyEquals(debits, credits)) {
    throw new LedgerError(
      'UNBALANCED_JOURNAL_ENTRY',
      `Reversal debits (${debits.toString()}) must equal credits (${credits.toString()}).`,
    );
  }

  // ---- Allocate the gapless number and insert the reversal entry. -----------
  const entryNumber = await allocateEntryNumber(tx, input.companyId);
  const description =
    input.description ?? `Reversal of entry #${String(original.entryNumber)}`;

  const insertedRows = await tx
    .insert(schema.journalEntries)
    .values({
      companyId: input.companyId,
      entryNumber,
      // The correction is an event ON the reversal date, in the open period
      // where it is actually being made (ADR-007) — not backdated to the
      // original, which would drag it into the original's (closed) period.
      transactionDate: reversalDate,
      postingDate: reversalDate,
      description,
      status: 'POSTED',
      // A distinct source keeps the reversal from colliding with the original
      // on the "one POSTED per source" index (invariant 6): the original may
      // carry an invoice/payment source, and copying it verbatim would be a
      // second posting of that source. The authoritative link is reversalOfId;
      // sourceId mirrors it so the source view points back too.
      sourceType: 'REVERSAL',
      sourceId: original.id,
      reversalOfId: original.id,
      createdBy: input.actorUserId,
      postedAt: sql`now()`,
    })
    .returning();
  const reversal = insertedRows[0];
  if (reversal === undefined) throw new Error('reversal entry insert returned no row');

  await tx.insert(schema.journalLines).values(
    reversalLines.map((line) => ({ ...line, journalEntryId: reversal.id })),
  );

  // ---- Drive the original through the ONE permitted transition. -------------
  // Setting ONLY status and reversed_by_id is exactly what the LL-030 trigger
  // allows (POSTED→REVERSED, reversed_by_id NULL→set, all else unchanged). Any
  // other column touched here, or a second reversal racing in, is rejected by
  // the trigger as POSTED_ENTRY_IMMUTABLE.
  const updated = await tx
    .update(schema.journalEntries)
    .set({ status: 'REVERSED', reversedById: reversal.id })
    .where(
      and(
        eq(schema.journalEntries.companyId, input.companyId),
        eq(schema.journalEntries.id, original.id),
      ),
    )
    .returning();
  if (updated[0] === undefined) throw new Error('original entry vanished during reversal');

  // ---- Audit, INSIDE the transaction (both facts, atomically). --------------
  // The reversal is a posting like any other; the original records that it was
  // reversed and by which entry. A rolled-back reversal leaves neither.
  await recordAuditEvent({
    tx,
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    action: 'JOURNAL_ENTRY_POSTED',
    entityType: 'journal_entry',
    entityId: reversal.id,
    after: {
      entryNumber,
      sourceType: 'REVERSAL',
      reversalOfId: original.id,
      lineCount: reversalLines.length,
    },
  });
  await recordAuditEvent({
    tx,
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    action: 'JOURNAL_ENTRY_REVERSED',
    entityType: 'journal_entry',
    entityId: original.id,
    before: { status: original.status, reversedById: original.reversedById },
    after: { status: 'REVERSED', reversedById: reversal.id, reversalEntryNumber: entryNumber },
  });

  // The deferred balance trigger validates the reversal AT COMMIT (LL-030).
  return await loadEntry(tx, reversal.id);
}
