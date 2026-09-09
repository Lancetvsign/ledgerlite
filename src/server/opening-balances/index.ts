import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { moneyEquals, sumMoney } from '@/lib/decimal';
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

import { OpeningBalanceError } from './errors';

import type { PoolDatabase } from '@/db';
import type { JournalEntry, JournalLine } from '@/db/schema';
import type { PostJournalEntryInput } from '@/validation/journal';
import type { SetOpeningBalancesInput, VoidOpeningBalancesInput } from '@/validation/opening-balance';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Opening-balances service — LL-071. The one-time conversion entry a company posts when
 * it adopts LedgerLite mid-life: each non-control balance-sheet account's starting
 * balance, with **Opening Balance Equity** (account 3000) as the balancing plug. Posted
 * through LedgerService source-typed `OPENING_BALANCE`.
 *
 * It must call `postEntryCore` directly, NOT `postJournalEntry` — the manual API is pinned
 * to `JOURNAL_ENTRY` (LL-066). Two design constraints (ADR-029):
 *   - A/R and A/P are EXCLUDED. A lump opening balance on a control account would give it
 *     a balance with no matching open invoices/bills, breaking the aging⇔control
 *     reconciliation (ADR-016/024). The control-account trigger only blocks JOURNAL_ENTRY,
 *     so this exclusion is enforced HERE. Opening receivables/payables are entered as open
 *     invoices/bills through their own flows.
 *   - Set-once: at most one POSTED opening-balance entry per company (partial unique index
 *     `journal_entries_one_opening_balance`). Correct a mistake by voiding and re-setting.
 */

const CONTROL_SYSTEM_TYPES = new Set(['ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE']);

/** The company's single POSTED opening-balance entry with its lines, or null. */
async function loadOpeningBalanceEntry(
  executor: Tx | PoolDatabase,
  companyId: string,
): Promise<PostedEntry | null> {
  const entryRows = await executor
    .select()
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.companyId, companyId),
        eq(schema.journalEntries.sourceType, 'OPENING_BALANCE'),
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

export async function setOpeningBalances(
  actorUserId: string,
  companyId: string,
  input: SetOpeningBalancesInput,
): Promise<PostedEntry> {
  await requirePermission(actorUserId, companyId, 'journal.post');

  // The balancing plug goes to Opening Balance Equity (the FIRST consumer of it).
  const obeAccountId = await resolveSystemAccount(getDbTx(), companyId, 'OPENING_BALANCE_EQUITY');
  if (obeAccountId === null) {
    throw new OpeningBalanceError(
      'OBE_ACCOUNT_NOT_CONFIGURED',
      'No Opening Balance Equity account is configured for this company.',
    );
  }

  // Resolve-and-create the posting period BEFORE the tx (never lazily inside — a
  // concurrent create races the exclusion constraint, LL-032).
  const period = await getAccountingPeriod(companyId, input.conversionDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${input.conversionDate} is closed.`);
  }

  // The OBE plug balances the entry: plug = sum(debits) − sum(credits). A positive plug
  // is a net debit among the real lines, so OBE is CREDITED to balance (and vice versa).
  const plug = sumMoney(input.lines.map((l) => l.debit)).minus(sumMoney(input.lines.map((l) => l.credit)));
  const userLines: PostJournalEntryInput['lines'] = input.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit,
    credit: l.credit,
  }));
  const obeLine: PostJournalEntryInput['lines'][number] | null = plug.isZero()
    ? null
    : plug.isPositive()
      ? { accountId: obeAccountId, debit: '0', credit: plug.toFixed(4) }
      : { accountId: obeAccountId, debit: plug.abs().toFixed(4), credit: '0' };
  const ledgerLines: PostJournalEntryInput['lines'] = obeLine === null ? userLines : [...userLines, obeLine];

  // Sanity: the posted entry must balance exactly (the DB deferred trigger enforces it too).
  if (!moneyEquals(sumMoney(ledgerLines.map((l) => l.debit)), sumMoney(ledgerLines.map((l) => l.credit)))) {
    throw new Error('opening-balance posting is unbalanced after appending the OBE plug');
  }

  // A stable fingerprint over the request's material content, so a double-submit with the
  // SAME key resolves to the original and a key reused for DIFFERENT content is a conflict.
  const fingerprint =
    input.idempotencyKey !== undefined
      ? fingerprintRequest({
          kind: 'opening_balance',
          companyId,
          conversionDate: input.conversionDate,
          lines: [...userLines]
            .map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit }))
            .sort((a, b) =>
              a.accountId < b.accountId ? -1
              : a.accountId > b.accountId ? 1
              : a.debit < b.debit ? -1
              : a.debit > b.debit ? 1
              : 0,
            ),
        })
      : undefined;

  const runSet = (): Promise<PostedEntry> =>
    getDbTx().transaction(async (tx) => {
      // Reject A/R/A/P control lines and the OBE account itself. postEntryCore re-checks
      // existence/active/company; here we enforce the opening-balance-specific exclusions.
      const referencedIds = [...new Set(input.lines.map((l) => l.accountId))];
      const referenced = await tx
        .select({ id: schema.accounts.id, systemAccountType: schema.accounts.systemAccountType })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.companyId, companyId), inArray(schema.accounts.id, referencedIds)));
      for (const a of referenced) {
        if (a.systemAccountType !== null && CONTROL_SYSTEM_TYPES.has(a.systemAccountType)) {
          throw new OpeningBalanceError(
            'CONTROL_ACCOUNT_NOT_ALLOWED',
            'Opening balances cannot post to the Accounts Receivable or Accounts Payable control account. Enter the outstanding invoices and bills instead.',
          );
        }
        if (a.systemAccountType === 'OPENING_BALANCE_EQUITY') {
          throw new OpeningBalanceError(
            'OBE_NOT_ALLOWED',
            'Opening Balance Equity is the balancing plug and is computed automatically; do not enter it as a line.',
          );
        }
      }

      // Set-once: a POSTED opening-balance entry already present is either our own
      // already-committed submit (same key → return it) or a genuine duplicate.
      const existing = await loadOpeningBalanceEntry(tx, companyId);
      if (existing !== null) {
        if (input.idempotencyKey !== undefined && existing.entry.idempotencyKey === input.idempotencyKey) {
          if (existing.entry.idempotencyFingerprint !== fingerprint) {
            throw new LedgerError('IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key was already used for a different opening balance.');
          }
          return existing;
        }
        throw new OpeningBalanceError(
          'OPENING_BALANCE_ALREADY_SET',
          'Opening balances are already set for this company. Void them before setting again.',
        );
      }

      const ledgerInput: PostJournalEntryInput = {
        companyId,
        actorUserId,
        transactionDate: input.conversionDate,
        postingDate: input.conversionDate,
        description: `Opening balances as of ${input.conversionDate}`,
        sourceType: 'OPENING_BALANCE',
        idempotencyKey: input.idempotencyKey,
        lines: ledgerLines,
      };
      const posted = await postEntryCore(tx, ledgerInput, input.conversionDate, fingerprint);

      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'OPENING_BALANCES_SET',
        entityType: 'opening_balance',
        entityId: posted.entry.id,
        after: { conversionDate: input.conversionDate, lineCount: input.lines.length, obePlug: plug.toFixed(4) },
      });

      return posted;
    });

  // Always via the resolver — a concurrent first submit that lost a unique index (the
  // idempotency index OR the set-once index) must surface as a typed domain outcome, not
  // a raw duplicate-key error. This covers the keyless race too (a keyless winner has a
  // null key that never equals our undefined one, so the loser gets ALREADY_SET).
  try {
    return await runSet();
  } catch (error) {
    if (isIdempotencyViolation(error)) {
      const prior = await loadOpeningBalanceEntry(getDbTx(), companyId);
      if (prior !== null) {
        if (input.idempotencyKey !== undefined && prior.entry.idempotencyKey === input.idempotencyKey) {
          if (prior.entry.idempotencyFingerprint !== fingerprint) {
            throw new LedgerError('IDEMPOTENCY_KEY_CONFLICT', 'This idempotency key was already used for a different opening balance.');
          }
          return prior; // our own submit won the race
        }
        throw new OpeningBalanceError(
          'OPENING_BALANCE_ALREADY_SET',
          'Opening balances are already set for this company. Void them before setting again.',
        );
      }
    }
    throw error;
  }
}

export async function voidOpeningBalances(
  actorUserId: string,
  companyId: string,
  input: VoidOpeningBalancesInput,
): Promise<PostedEntry> {
  await requirePermission(actorUserId, companyId, 'journal.post');

  const existing = await loadOpeningBalanceEntry(getDbTx(), companyId);
  if (existing === null) {
    throw new OpeningBalanceError('OPENING_BALANCE_NOT_SET', 'No opening balances are set for this company.');
  }

  const companyRows = await getDbTx()
    .select({ timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .limit(1);
  const timezone = companyRows[0]?.timezone;
  if (timezone === undefined) throw new OpeningBalanceError('OPENING_BALANCE_NOT_SET', 'Company not found.');
  const reversalDate = input.reversalDate ?? todayInTimeZone(timezone);
  const period = await getAccountingPeriod(companyId, reversalDate);
  if (period.status !== 'OPEN') {
    throw new LedgerError('PERIOD_CLOSED', `The reversal date ${reversalDate} falls in a closed period.`);
  }

  return await getDbTx().transaction(async (tx) => {
    // reverseEntryCore locks the original FOR UPDATE and rejects an already-reversed entry,
    // so a concurrent void serialises safely. manualOnly defaults to false — an
    // OPENING_BALANCE root is not a JOURNAL_ENTRY, so the manual-only walk would reject it.
    const reversal = await reverseEntryCore(
      tx,
      {
        companyId,
        actorUserId,
        entryId: existing.entry.id,
        reversalDate,
        description: input.reason ?? 'Void of opening balances',
      },
      reversalDate,
    );

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'OPENING_BALANCES_VOIDED',
      entityType: 'opening_balance',
      entityId: existing.entry.id,
      before: { status: 'POSTED' },
      after: { status: 'REVERSED', reversalDate, reason: input.reason ?? null },
    });

    return reversal;
  });
}

/** The company's POSTED opening-balance entry with its lines, or null. `journal.post`. */
export async function getOpeningBalances(
  actorUserId: string,
  companyId: string,
): Promise<PostedEntry | null> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  return await loadOpeningBalanceEntry(getDbTx(), companyId);
}

export { OpeningBalanceError } from './errors';
export type { OpeningBalanceErrorCode } from './errors';
