import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';

import { ReconciliationError } from './errors';

import type { PoolDatabase } from '@/db';
import type { BankReconciliation } from '@/db/schema';
import type { SetClearedInput, StartReconciliationInput, UpdateReconciliationInput } from '@/validation/reconciliation';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Bank reconciliation service — LL-078 (ADR-036).
 *
 *   start    → a header for (account, statement date, statement ending figure); one IN_PROGRESS
 *              per account; statement dates move forward per account.
 *   get      → the header plus DERIVED figures (opening cleared, cleared here, difference, ledger
 *              as-of) and the tick list: uncleared lines up to the statement date ∪ lines cleared
 *              by this reconciliation. Nothing derived is ever stored (invariant 2).
 *   setCleared → replaces the cleared set after validating every line (this account, posted,
 *              on or before the statement date, not cleared elsewhere).
 *   complete → allowed only when Σ(all cleared lines of the account) = statement ending figure,
 *              exactly, at NUMERIC(19,4). Completed is final.
 *
 * "Cleared" is reconciliation state in its own table — posted journal lines are immutable.
 * Reads gate on `reconciliation.view` (everyone); writes on `reconciliation.complete`
 * (ALL_WRITERS: a bookkeeper reconciles). No posting happens here, so a closed period is not
 * a bar to reconciling it.
 */

const SIGNED_SUM = sql`coalesce(sum(l.debit - l.credit), 0)::numeric(19,4)::text`;

/** A 23505 on the named constraint — checked structurally and, as the ledger does, by message. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const walk = (e: unknown, depth: number): boolean => {
    if (depth > 5 || typeof e !== 'object' || e === null) return false;
    const r = e as { code?: unknown; constraint?: unknown; cause?: unknown; message?: unknown };
    if (r.code === '23505' && r.constraint === constraint) return true;
    if (typeof r.message === 'string' && r.message.includes(constraint) && /duplicate key/i.test(r.message)) return true;
    return walk(r.cause, depth + 1);
  };
  return walk(error, 0);
}

async function loadHeader(executor: Tx | PoolDatabase, companyId: string, id: string, lock: boolean): Promise<BankReconciliation | undefined> {
  const q = executor
    .select()
    .from(schema.bankReconciliations)
    .where(and(eq(schema.bankReconciliations.companyId, companyId), eq(schema.bankReconciliations.id, id)))
    .limit(1);
  const rows = lock ? await q.for('update') : await q;
  return rows[0];
}

async function lastCompletedStatementDate(executor: Tx | PoolDatabase, companyId: string, bankAccountId: string, excludeId?: string): Promise<string | null> {
  const rows = await executor.execute<{ d: string | null }>(sql`
    select max(statement_date)::text as d from bank_reconciliations
    where company_id = ${companyId} and bank_account_id = ${bankAccountId} and status = 'COMPLETED'
      ${excludeId === undefined ? sql`` : sql`and id <> ${excludeId}`}`);
  return rows.rows[0]?.d ?? null;
}

export async function startReconciliation(
  actorUserId: string,
  companyId: string,
  input: StartReconciliationInput,
): Promise<BankReconciliation> {
  await requirePermission(actorUserId, companyId, 'reconciliation.complete');

  const bankRows = await getDbTx()
    .select({ status: schema.accounts.status, accountType: schema.accounts.accountType, cashFlowCategory: schema.accounts.cashFlowCategory })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, input.bankAccountId)))
    .limit(1);
  const bank = bankRows[0];
  if (bank === undefined || bank.status !== 'ACTIVE' || bank.accountType !== 'ASSET' || bank.cashFlowCategory !== 'CASH') {
    throw new ReconciliationError('NOT_A_BANK_ACCOUNT', 'Choose an active cash/bank asset account to reconcile.');
  }

  const last = await lastCompletedStatementDate(getDbTx(), companyId, input.bankAccountId);
  if (last !== null && input.statementDate <= last) {
    throw new ReconciliationError('STATEMENT_DATE_NOT_AFTER_LAST', `The statement date must be after the last completed statement (${last}).`);
  }

  try {
    return await getDbTx().transaction(async (tx) => {
      const rows = await tx
        .insert(schema.bankReconciliations)
        .values({
          companyId,
          bankAccountId: input.bankAccountId,
          statementDate: input.statementDate,
          statementEndingAmount: input.statementEndingAmount,
          startedBy: actorUserId,
        })
        .returning();
      const rec = rows[0];
      if (rec === undefined) throw new Error('reconciliation insert returned no row');
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'RECONCILIATION_STARTED',
        entityType: 'bank_reconciliation',
        entityId: rec.id,
        after: { bankAccountId: rec.bankAccountId, statementDate: rec.statementDate, statementEndingAmount: rec.statementEndingAmount },
      });
      return rec;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'bank_reconciliations_one_in_progress')) {
      throw new ReconciliationError('ALREADY_IN_PROGRESS', 'This account already has a reconciliation in progress.');
    }
    if (isUniqueViolation(error, 'bank_reconciliations_account_statement_unique')) {
      throw new ReconciliationError('DUPLICATE_STATEMENT_DATE', 'A reconciliation for this account and statement date already exists.');
    }
    throw error;
  }
}

export async function updateReconciliation(
  actorUserId: string,
  companyId: string,
  id: string,
  input: UpdateReconciliationInput,
): Promise<BankReconciliation> {
  await requirePermission(actorUserId, companyId, 'reconciliation.complete');
  try {
    return await getDbTx().transaction(async (tx) => {
      const rec = await loadHeader(tx, companyId, id, true);
      if (rec === undefined) throw new ReconciliationError('NOT_FOUND', 'Reconciliation not found.');
      if (rec.status !== 'IN_PROGRESS') throw new ReconciliationError('NOT_IN_PROGRESS', 'A completed reconciliation is final.');

      const statementDate = input.statementDate ?? rec.statementDate;
      if (input.statementDate !== undefined) {
        const last = await lastCompletedStatementDate(tx, companyId, rec.bankAccountId, rec.id);
        if (last !== null && statementDate <= last) {
          throw new ReconciliationError('STATEMENT_DATE_NOT_AFTER_LAST', `The statement date must be after the last completed statement (${last}).`);
        }
        // Every already-cleared line must still fall on or before the new date.
        const late = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from bank_reconciliation_lines rl
          join journal_lines l on l.company_id = rl.company_id and l.id = rl.journal_line_id
          join journal_entries e on e.id = l.journal_entry_id
          where rl.company_id = ${companyId} and rl.reconciliation_id = ${rec.id} and e.posting_date > ${statementDate}`);
        if (late.rows[0]?.n !== '0') {
          throw new ReconciliationError('LINE_INVALID', 'Some cleared lines are dated after the new statement date. Untick them first.');
        }
      }

      const rows = await tx
        .update(schema.bankReconciliations)
        .set({
          statementDate,
          statementEndingAmount: input.statementEndingAmount ?? rec.statementEndingAmount,
        })
        .where(and(eq(schema.bankReconciliations.companyId, companyId), eq(schema.bankReconciliations.id, id)))
        .returning();
      const updated = rows[0];
      if (updated === undefined) throw new Error('reconciliation update returned no row');
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'bank_reconciliations_account_statement_unique')) {
      throw new ReconciliationError('DUPLICATE_STATEMENT_DATE', 'A reconciliation for this account and statement date already exists.');
    }
    throw error;
  }
}

export interface ReconciliationLineView {
  readonly journalLineId: string;
  readonly entryId: string;
  readonly entryNumber: string | null;
  readonly postingDate: string;
  readonly description: string | null;
  /** Signed, from the bank account's side: debit − credit (money in positive). */
  readonly amount: string;
  readonly cleared: boolean;
  /** The line came from a bank-statement import — the bank has, by definition, seen it. */
  readonly fromImport: boolean;
}

export interface ReconciliationView {
  readonly reconciliation: BankReconciliation;
  /** Σ of this account's lines cleared by OTHER (completed) reconciliations. */
  readonly openingCleared: string;
  /** Σ of the lines cleared by THIS reconciliation. */
  readonly clearedHere: string;
  /** statement ending − (opening + here). Completion requires exactly 0.0000. */
  readonly difference: string;
  /** The ledger's own figure for the account on the statement date (information only). */
  readonly ledgerAsOf: string;
  readonly lines: readonly ReconciliationLineView[];
}

/** Header + derived figures + tick list, or null for an unknown/other-company id (no existence leak). */
export async function getReconciliation(actorUserId: string, companyId: string, id: string): Promise<ReconciliationView | null> {
  await requirePermission(actorUserId, companyId, 'reconciliation.view');
  const db = getDbTx();
  const rec = await loadHeader(db, companyId, id, false);
  if (rec === undefined) return null;

  const figures = await db.execute<{ opening: string; here: string; ledger: string }>(sql`
    select
      (select ${SIGNED_SUM} from bank_reconciliation_lines rl
         join journal_lines l on l.company_id = rl.company_id and l.id = rl.journal_line_id
        where rl.company_id = ${companyId} and rl.bank_account_id = ${rec.bankAccountId} and rl.reconciliation_id <> ${rec.id}) as opening,
      (select ${SIGNED_SUM} from bank_reconciliation_lines rl
         join journal_lines l on l.company_id = rl.company_id and l.id = rl.journal_line_id
        where rl.company_id = ${companyId} and rl.reconciliation_id = ${rec.id}) as here,
      (select ${SIGNED_SUM} from journal_lines l
         join journal_entries e on e.id = l.journal_entry_id
        where l.company_id = ${companyId} and l.account_id = ${rec.bankAccountId}
          and e.status in ('POSTED', 'REVERSED') and e.posting_date <= ${rec.statementDate}) as ledger`);
  const f = figures.rows[0];
  if (f === undefined) throw new Error('reconciliation figures returned no row');
  const difference = toMoney(rec.statementEndingAmount).minus(toMoney(f.opening)).minus(toMoney(f.here)).toFixed(4);

  // The tick list. IN_PROGRESS: every uncleared line on or before the statement date, plus the
  // lines cleared here. COMPLETED: the cleared lines only.
  const lines = await db.execute<{
    journal_line_id: string; entry_id: string; entry_number: string | null; posting_date: string;
    description: string | null; amount: string; cleared: boolean; from_import: boolean;
  }>(sql`
    select l.id as journal_line_id, e.id as entry_id, e.entry_number::text as entry_number,
           e.posting_date::text as posting_date, coalesce(l.description, e.description) as description,
           (l.debit - l.credit)::numeric(19,4)::text as amount,
           (rl.id is not null) as cleared,
           exists (select 1 from bank_import_lines b where b.company_id = l.company_id and b.journal_entry_id = e.id) as from_import
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    left join bank_reconciliation_lines rl on rl.company_id = l.company_id and rl.journal_line_id = l.id
    where l.company_id = ${companyId} and l.account_id = ${rec.bankAccountId}
      and e.status in ('POSTED', 'REVERSED')
      and (
        rl.reconciliation_id = ${rec.id}
        ${rec.status === 'IN_PROGRESS' ? sql`or (rl.id is null and e.posting_date <= ${rec.statementDate})` : sql``}
      )
    order by e.posting_date, e.entry_number, l.line_number`);

  return {
    reconciliation: rec,
    openingCleared: f.opening,
    clearedHere: f.here,
    difference,
    ledgerAsOf: f.ledger,
    lines: lines.rows.map((r) => ({
      journalLineId: r.journal_line_id,
      entryId: r.entry_id,
      entryNumber: r.entry_number,
      postingDate: r.posting_date,
      description: r.description,
      amount: r.amount,
      cleared: r.cleared,
      fromImport: r.from_import,
    })),
  };
}

export async function listReconciliations(actorUserId: string, companyId: string): Promise<BankReconciliation[]> {
  await requirePermission(actorUserId, companyId, 'reconciliation.view');
  return await getDbTx()
    .select()
    .from(schema.bankReconciliations)
    .where(eq(schema.bankReconciliations.companyId, companyId))
    .orderBy(desc(schema.bankReconciliations.statementDate), desc(schema.bankReconciliations.startedAt))
    .limit(50);
}

/** Replace the cleared set of an IN_PROGRESS reconciliation with exactly `journalLineIds`. */
export async function setCleared(actorUserId: string, companyId: string, id: string, input: SetClearedInput): Promise<{ cleared: number }> {
  await requirePermission(actorUserId, companyId, 'reconciliation.complete');
  try {
    return await getDbTx().transaction(async (tx) => {
      // Lock first, then re-check: a save racing a completion must see COMPLETED.
      const rec = await loadHeader(tx, companyId, id, true);
      if (rec === undefined) throw new ReconciliationError('NOT_FOUND', 'Reconciliation not found.');
      if (rec.status !== 'IN_PROGRESS') throw new ReconciliationError('NOT_IN_PROGRESS', 'A completed reconciliation is final.');

      if (input.journalLineIds.length > 0) {
        // Every id must be one of THIS account's ledger lines, posted, on or before the statement
        // date, and not cleared by another reconciliation. Counting valid ids against the request
        // rejects foreign / cross-account / phantom ids without saying which (no existence leak).
        const valid = await tx.execute<{ n: string }>(sql`
          select count(*)::text as n from journal_lines l
          join journal_entries e on e.id = l.journal_entry_id
          left join bank_reconciliation_lines rl on rl.company_id = l.company_id and rl.journal_line_id = l.id and rl.reconciliation_id <> ${rec.id}
          where l.company_id = ${companyId} and l.account_id = ${rec.bankAccountId}
            and e.status in ('POSTED', 'REVERSED') and e.posting_date <= ${rec.statementDate}
            and rl.id is null
            and l.id in (${sql.join(input.journalLineIds.map((v) => sql`${v}::uuid`), sql`, `)})`);
        if (valid.rows[0]?.n !== String(input.journalLineIds.length)) {
          throw new ReconciliationError('LINE_INVALID', 'A ticked line is not a reconcilable line of this account (wrong account, unposted, dated after the statement, or already cleared).');
        }
      }

      await tx
        .delete(schema.bankReconciliationLines)
        .where(and(eq(schema.bankReconciliationLines.companyId, companyId), eq(schema.bankReconciliationLines.reconciliationId, rec.id)));
      if (input.journalLineIds.length > 0) {
        await tx.insert(schema.bankReconciliationLines).values(
          input.journalLineIds.map((journalLineId) => ({ companyId, reconciliationId: rec.id, journalLineId, bankAccountId: rec.bankAccountId })),
        );
      }
      return { cleared: input.journalLineIds.length };
    });
  } catch (error) {
    // The once-only unique is the structural backstop for the validation above.
    if (isUniqueViolation(error, 'bank_reconciliation_lines_line_once_unique')) {
      throw new ReconciliationError('LINE_INVALID', 'A ticked line is already cleared by another reconciliation.');
    }
    throw error;
  }
}

/** Complete: allowed only when every cleared line of the account sums exactly to the statement figure. */
export async function completeReconciliation(actorUserId: string, companyId: string, id: string): Promise<BankReconciliation> {
  await requirePermission(actorUserId, companyId, 'reconciliation.complete');
  return await getDbTx().transaction(async (tx) => {
    const rec = await loadHeader(tx, companyId, id, true);
    if (rec === undefined) throw new ReconciliationError('NOT_FOUND', 'Reconciliation not found.');
    if (rec.status !== 'IN_PROGRESS') throw new ReconciliationError('NOT_IN_PROGRESS', 'A completed reconciliation is final.');

    // Opening and here collapse: the bank's figure must equal everything ever cleared on this account.
    const sum = await tx.execute<{ cleared: string; lines: string }>(sql`
      select ${SIGNED_SUM} as cleared, count(*) filter (where rl.reconciliation_id = ${rec.id})::text as lines
      from bank_reconciliation_lines rl
      join journal_lines l on l.company_id = rl.company_id and l.id = rl.journal_line_id
      where rl.company_id = ${companyId} and rl.bank_account_id = ${rec.bankAccountId}`);
    const row = sum.rows[0];
    if (row === undefined) throw new Error('reconciliation sum returned no row');
    const difference = toMoney(rec.statementEndingAmount).minus(toMoney(row.cleared));
    if (!difference.isZero()) {
      throw new ReconciliationError('DIFFERENCE_NOT_ZERO', `Cleared lines differ from the statement by ${difference.toFixed(4)}.`);
    }

    const rows = await tx
      .update(schema.bankReconciliations)
      .set({ status: 'COMPLETED', completedBy: actorUserId, completedAt: sql`now()` })
      .where(and(eq(schema.bankReconciliations.companyId, companyId), eq(schema.bankReconciliations.id, id), eq(schema.bankReconciliations.status, 'IN_PROGRESS')))
      .returning();
    const done = rows[0];
    if (done === undefined) throw new Error('reconciliation complete returned no row');

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'RECONCILIATION_COMPLETED',
      entityType: 'bank_reconciliation',
      entityId: rec.id,
      before: { status: 'IN_PROGRESS' },
      after: { status: 'COMPLETED', statementDate: rec.statementDate, statementEndingAmount: rec.statementEndingAmount, clearedLines: row.lines },
    });
    return done;
  });
}

export { ReconciliationError } from './errors';
export type { ReconciliationErrorCode } from './errors';
