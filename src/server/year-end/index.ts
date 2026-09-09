import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { fiscalYearEnd, fiscalYearStart } from '@/lib/dates';
import { moneyEquals, sumMoney, toMoney } from '@/lib/decimal';
import { resolveSystemAccount } from '@/server/accounts';
import { requirePermission } from '@/server/authorization';
import { recordAuditEvent } from '@/server/audit';
import {
  fingerprintRequest,
  isIdempotencyViolation,
  LedgerError,
  postEntryCore,
  reverseEntryCore,
  type PostedEntry,
} from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';

import { YearEndError } from './errors';

import type { PoolDatabase } from '@/db';
import type { JournalEntry, JournalLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { CloseFiscalYearInput, ReopenFiscalYearInput } from '@/validation/year-end';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Year-end closing service — LL-073. Posts the entry that zeroes a fiscal year's
 * revenue/COGS/expense accounts into **Retained Earnings** (its first consumer), so the
 * books are actually closed rather than only derived (ADR-030/031). Posted through
 * LedgerService source-typed `CLOSING` — via `postEntryCore`, NOT `postJournalEntry`
 * (which pins JOURNAL_ENTRY, LL-066).
 *
 * Set-once per fiscal year: `sourceId` is the fiscal-year start date, so the existing
 * `journal_entries_source_posted_once` index allows one POSTED close per (company, year);
 * reopening reverses it (freeing the slot). Closing does NOT lock the year's periods —
 * that stays the separate `/periods` action (product decision) — but the year-end
 * period must be OPEN to post the entry.
 */

/** The company's POSTED closing entry for a fiscal year, with its lines, or null. */
async function loadClosingEntry(
  executor: Tx | PoolDatabase,
  companyId: string,
  fiscalYearStartDate: string,
): Promise<PostedEntry | null> {
  const entryRows = await executor
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.companyId, companyId),
        eq(schema.journalEntries.sourceType, 'CLOSING'),
        eq(schema.journalEntries.sourceId, fiscalYearStartDate),
        eq(schema.journalEntries.status, 'POSTED'),
      ),
    )
    .limit(1);
  const entry = entryRows[0] as JournalEntry | undefined;
  if (entry === undefined) return null;
  const lines = (await executor
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.journalEntryId, entry.id))
    .orderBy(schema.journalLines.lineNumber)) as JournalLine[];
  return { entry, lines };
}

/** The company's fiscal-year start month (1–12), defaulting to January. */
async function fiscalStartMonth(executor: Tx | PoolDatabase, companyId: string): Promise<number> {
  const rows = await executor.execute<{ fiscal_year_start_month: number }>(
    sql`select fiscal_year_start_month from companies where id = ${companyId} limit 1`,
  );
  return rows.rows[0]?.fiscal_year_start_month ?? 1;
}

export async function closeFiscalYear(
  actorUserId: string,
  companyId: string,
  input: CloseFiscalYearInput,
): Promise<PostedEntry> {
  await requirePermission(actorUserId, companyId, 'period.close');

  const startMonth = await fiscalStartMonth(getDbTx(), companyId);
  const fy = fiscalYearStart(input.fiscalYearStart, startMonth);
  const fyStart = `${String(fy.year)}-${String(fy.month).padStart(2, '0')}-01`;
  const fyEnd = fiscalYearEnd(input.fiscalYearStart, startMonth);

  // The net income lands in Retained Earnings — closing is its first consumer.
  const reAccountId = await resolveSystemAccount(getDbTx(), companyId, 'RETAINED_EARNINGS');
  if (reAccountId === null) {
    throw new YearEndError('RE_ACCOUNT_NOT_CONFIGURED', 'No Retained Earnings account is configured for this company.');
  }

  // The closing entry posts on the last day of the fiscal year; its period must be OPEN.
  const period = await getAccountingPeriod(companyId, fyEnd);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${fyEnd} is closed.`);
  }

  const fingerprint =
    input.idempotencyKey !== undefined
      ? fingerprintRequest({ kind: 'closing', companyId, fiscalYearStart: fyStart, fiscalYearEnd: fyEnd })
      : undefined;

  const runClose = (): Promise<PostedEntry> =>
    getDbTx().transaction(async (tx) => {
      // Set-once: an existing POSTED close for this year is either our own committed
      // submit (same key → return it) or a genuine duplicate.
      const existing = await loadClosingEntry(tx, companyId, fyStart);
      if (existing !== null) {
        if (input.idempotencyKey !== undefined && existing.entry.idempotencyKey === input.idempotencyKey) {
          if (existing.entry.idempotencyFingerprint !== fingerprint) {
            throw new LedgerError('IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key was already used for a different close.');
          }
          return existing;
        }
        throw new YearEndError('YEAR_ALREADY_CLOSED', `Fiscal year starting ${fyStart} is already closed. Reopen it before closing again.`);
      }

      // Each P&L account's raw net (debits − credits) over the fiscal year, counting
      // POSTED and REVERSED (a reversed prior close and its reversal cancel, so a
      // re-close recomputes from the real activity). Zero-net accounts are dropped.
      const nets = await tx.execute<{ account_id: string; raw_net: string }>(sql`
        select a.id::text as account_id,
               (sum(l.debit) - sum(l.credit))::numeric(19,4)::text as raw_net
        from accounts a
        join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
        join journal_entries e on e.id = l.journal_entry_id
        where a.company_id = ${companyId}
          and a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
          and e.status in ('POSTED', 'REVERSED')
          -- The REAL operating activity only: exclude prior closing entries and their
          -- reversals (the same rule the Income Statement uses), so the close amount is
          -- the year's true net income and a re-close after a reopen recomputes it
          -- correctly regardless of what closing history exists.
          and e.source_type <> 'CLOSING'
          and not exists (
            select 1 from journal_entries oe
            where oe.id = e.reversal_of_id and oe.source_type = 'CLOSING'
          )
          and e.posting_date between ${fyStart} and ${fyEnd}
        group by a.id
        having (sum(l.debit) - sum(l.credit)) <> 0
        order by a.id`);

      if (nets.rows.length === 0) {
        throw new YearEndError('NOTHING_TO_CLOSE', `Fiscal year starting ${fyStart} has no revenue or expense activity to close.`);
      }

      // Zero each account by posting the OPPOSITE of its raw net: a net debit is
      // credited, a net credit is debited. This is type-agnostic — it zeroes revenue,
      // COGS and expense uniformly.
      const zeroingLines: PostJournalEntryInput['lines'] = nets.rows.map((r) => {
        const raw = toMoney(r.raw_net);
        return raw.isPositive()
          ? { accountId: r.account_id, debit: '0', credit: raw.toFixed(4) }
          : { accountId: r.account_id, debit: raw.abs().toFixed(4), credit: '0' };
      });

      // The balancing plug is net income → Retained Earnings (Cr for a profit, Dr for a
      // loss). plug = Σ debits − Σ credits of the zeroing lines = net income.
      const plug = sumMoney(zeroingLines.map((l) => l.debit)).minus(sumMoney(zeroingLines.map((l) => l.credit)));
      const reLine: PostJournalEntryInput['lines'][number] | null = plug.isZero()
        ? null
        : plug.isPositive()
          ? { accountId: reAccountId, debit: '0', credit: plug.toFixed(4) }
          : { accountId: reAccountId, debit: plug.abs().toFixed(4), credit: '0' };
      const lines: PostJournalEntryInput['lines'] = reLine === null ? zeroingLines : [...zeroingLines, reLine];

      if (!moneyEquals(sumMoney(lines.map((l) => l.debit)), sumMoney(lines.map((l) => l.credit)))) {
        throw new Error('year-end closing posting is unbalanced');
      }

      const ledgerInput: PostJournalEntryInput = {
        companyId,
        actorUserId,
        transactionDate: fyEnd,
        postingDate: fyEnd,
        description: `Year-end close for fiscal year ${fyStart} – ${fyEnd}`,
        sourceType: 'CLOSING',
        sourceId: fyStart,
        idempotencyKey: input.idempotencyKey,
        lines,
      };
      const posted = await postEntryCore(tx, ledgerInput, fyEnd, fingerprint);

      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'YEAR_END_CLOSED',
        entityType: 'fiscal_year',
        entityId: fyStart,
        after: { fiscalYearStart: fyStart, fiscalYearEnd: fyEnd, netIncome: plug.toFixed(4), accountsClosed: zeroingLines.length },
      });

      return posted;
    });

  try {
    return await runClose();
  } catch (error) {
    // A concurrent first submit lost a unique index (idempotency or set-once).
    if (isIdempotencyViolation(error)) {
      const prior = await loadClosingEntry(getDbTx(), companyId, fyStart);
      if (prior !== null) {
        if (input.idempotencyKey !== undefined && prior.entry.idempotencyKey === input.idempotencyKey) {
          if (prior.entry.idempotencyFingerprint !== fingerprint) {
            throw new LedgerError('IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key was already used for a different close.');
          }
          return prior;
        }
        throw new YearEndError('YEAR_ALREADY_CLOSED', `Fiscal year starting ${fyStart} is already closed. Reopen it before closing again.`);
      }
    }
    throw error;
  }
}

export async function reopenFiscalYear(
  actorUserId: string,
  companyId: string,
  input: ReopenFiscalYearInput,
): Promise<PostedEntry> {
  await requirePermission(actorUserId, companyId, 'period.close');

  const startMonth = await fiscalStartMonth(getDbTx(), companyId);
  const fy = fiscalYearStart(input.fiscalYearStart, startMonth);
  const fyStart = `${String(fy.year)}-${String(fy.month).padStart(2, '0')}-01`;

  const existing = await loadClosingEntry(getDbTx(), companyId, fyStart);
  if (existing === null) {
    throw new YearEndError('YEAR_NOT_CLOSED', `Fiscal year starting ${fyStart} is not closed.`);
  }

  // Reverse the closing entry AT the fiscal-year end — the SAME period it was posted in —
  // not "today". A closing dated fyEnd whose reversal landed in a later period would not
  // cancel it at the fyEnd snapshot, leaving the year half-closed and a re-close to
  // double-count. Its period must be OPEN (closing does not lock periods).
  const reversalDate = fiscalYearEnd(input.fiscalYearStart, startMonth);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The fiscal-year-end period ${reversalDate} is closed; reopen it first.`);
  }

  return await getDbTx().transaction(async (tx) => {
    const reversal = await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: existing.entry.id,
        reversalDate,
        description: input.reason ?? `Reopen of fiscal year ${fyStart}`,
      },
      reversalDate,
    );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'YEAR_END_REOPENED',
      entityType: 'fiscal_year',
      entityId: fyStart,
      before: { fiscalYearStart: fyStart, status: 'CLOSED' },
      after: { status: 'REOPENED', reversalDate, reason: input.reason ?? null },
    });

    return reversal;
  });
}

/** The company's POSTED closing entries (most recent first). `period.view`. */
export async function listClosings(actorUserId: string, companyId: string): Promise<JournalEntry[]> {
  await requirePermission(actorUserId, companyId, 'period.view');
  return await getDbTx()
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.companyId, companyId),
        eq(schema.journalEntries.sourceType, 'CLOSING'),
        eq(schema.journalEntries.status, 'POSTED'),
      ),
    )
    .orderBy(schema.journalEntries.postingDate);
}

export { YearEndError } from './errors';
export type { YearEndErrorCode } from './errors';
