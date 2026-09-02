import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { endOfMonth, isCalendarDate, startOfMonth } from '@/lib/dates';
import { recordAuditEvent } from '@/server/audit';
import { requirePermission } from '@/server/authorization';

import { PeriodError } from './errors';

import type { PoolDatabase } from '@/db';
import type { AccountingPeriod } from '@/db/schema';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Accounting-period service — LL-022.
 *
 * Periods resolve by the date they are asked about, which for a posting is its
 * POSTING date (ADR-002) — this service is date-agnostic; the caller passes the
 * posting date. Periods are monthly and generated LAZILY: looking one up creates
 * the containing month if absent, and the exclusion constraint makes concurrent
 * creation safe.
 */

async function findPeriod(
  executor: Tx | PoolDatabase,
  companyId: string,
  date: string,
): Promise<AccountingPeriod | undefined> {
  const rows = await executor
    .select()
    .from(schema.accountingPeriods)
    .where(
      and(
        eq(schema.accountingPeriods.companyId, companyId),
        sql`${schema.accountingPeriods.startDate} <= ${date}`,
        sql`${schema.accountingPeriods.endDate} >= ${date}`,
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The accounting period containing `date` for a company, creating the monthly
 * period on first lookup. `date` is a 'YYYY-MM-DD' string (ADR-005).
 *
 * Not authorization-gated: resolving which period a date falls in is a read the
 * posting path needs, and it exposes nothing cross-company (it is always called
 * with a company the caller was already authorized for). Creating the period is
 * a side effect of that resolution, made concurrency-safe by the exclusion
 * constraint rather than by a lock.
 */
export async function getAccountingPeriod(
  companyId: string,
  date: string,
): Promise<AccountingPeriod> {
  if (!isCalendarDate(date)) {
    throw new PeriodError('INVALID_DATE', `Not a calendar date: ${date}`);
  }

  const existing = await findPeriod(getDbTx(), companyId, date);
  if (existing !== undefined) return existing;

  // Create the containing month. Two concurrent creators race here; the
  // exclusion constraint lets exactly one win, and the loser re-reads.
  const start = startOfMonth(date);
  const end = endOfMonth(date);
  try {
    const rows = await getDbTx()
      .insert(schema.accountingPeriods)
      .values({ companyId, startDate: start, endDate: end })
      .returning();
    const created = rows[0];
    if (created === undefined) throw new Error('period insert returned no row');
    return created;
  } catch (error) {
    // Lost the race (overlap rejected) — the winner's period now exists.
    const now = await findPeriod(getDbTx(), companyId, date);
    if (now !== undefined) return now;
    throw error;
  }
}

/**
 * The single home of the closed-period rule (LL-031 depends on it). Resolves the
 * period for `date` and throws typed PERIOD_CLOSED if it is closed. Never
 * duplicated in a UI check.
 */
export async function assertPeriodOpen(companyId: string, date: string): Promise<void> {
  const period = await getAccountingPeriod(companyId, date);
  if (period.status === 'CLOSED') {
    throw new PeriodError('PERIOD_CLOSED', `The accounting period for ${date} is closed.`);
  }
}

/**
 * Placeholder for the "period dates are frozen once financial activity exists"
 * rule. No financial activity exists until Sprint 3, so this always passes today.
 *
 * HOOK FOR LL-030: once journal_lines exist, this must reject an edit to a period
 * that has posted entries. Wire the journal-line existence check in HERE — one
 * place — rather than scattering it across the mutators.
 */
export function assertPeriodEditable(_period: AccountingPeriod): void {
  // Intentionally empty until LL-030. See docstring.
}

export async function closePeriod(
  actorUserId: string,
  companyId: string,
  periodId: string,
): Promise<AccountingPeriod> {
  await requirePermission(actorUserId, companyId, 'period.close');

  return await getDbTx().transaction(async (tx) => {
    const before = await tx
      .select()
      .from(schema.accountingPeriods)
      .where(
        and(
          eq(schema.accountingPeriods.companyId, companyId),
          eq(schema.accountingPeriods.id, periodId),
        ),
      )
      .limit(1);
    const period = before[0];
    if (period === undefined) throw new PeriodError('PERIOD_NOT_FOUND', 'Period not found.');
    if (period.status === 'CLOSED') {
      throw new PeriodError('PERIOD_ALREADY_CLOSED', 'Period is already closed.');
    }

    const rows = await tx
      .update(schema.accountingPeriods)
      .set({ status: 'CLOSED', closedAt: sql`now()`, closedBy: actorUserId })
      .where(eq(schema.accountingPeriods.id, periodId))
      .returning();
    const updated = rows[0];
    if (updated === undefined) throw new PeriodError('PERIOD_NOT_FOUND', 'Period not found.');

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'ACCOUNTING_PERIOD_CLOSED',
      entityType: 'accounting_period',
      entityId: periodId,
      before: period,
      after: updated,
    });
    return updated;
  });
}

export async function reopenPeriod(
  actorUserId: string,
  companyId: string,
  periodId: string,
): Promise<AccountingPeriod> {
  await requirePermission(actorUserId, companyId, 'period.close');

  return await getDbTx().transaction(async (tx) => {
    const before = await tx
      .select()
      .from(schema.accountingPeriods)
      .where(
        and(
          eq(schema.accountingPeriods.companyId, companyId),
          eq(schema.accountingPeriods.id, periodId),
        ),
      )
      .limit(1);
    const period = before[0];
    if (period === undefined) throw new PeriodError('PERIOD_NOT_FOUND', 'Period not found.');
    if (period.status === 'OPEN') {
      throw new PeriodError('PERIOD_ALREADY_OPEN', 'Period is already open.');
    }

    const rows = await tx
      .update(schema.accountingPeriods)
      .set({ status: 'OPEN', reopenedAt: sql`now()`, reopenedBy: actorUserId })
      .where(eq(schema.accountingPeriods.id, periodId))
      .returning();
    const updated = rows[0];
    if (updated === undefined) throw new PeriodError('PERIOD_NOT_FOUND', 'Period not found.');

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'ACCOUNTING_PERIOD_REOPENED',
      entityType: 'accounting_period',
      entityId: periodId,
      before: period,
      after: updated,
    });
    return updated;
  });
}

/** Company-scoped listing of periods, `period.view`. */
export async function listPeriods(
  actorUserId: string,
  companyId: string,
): Promise<AccountingPeriod[]> {
  await requirePermission(actorUserId, companyId, 'period.view');
  return await getDbTx()
    .select()
    .from(schema.accountingPeriods)
    .where(eq(schema.accountingPeriods.companyId, companyId))
    .orderBy(schema.accountingPeriods.startDate);
}

export { PeriodError } from './errors';
export type { PeriodErrorCode } from './errors';
