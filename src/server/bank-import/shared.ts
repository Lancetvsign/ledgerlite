import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, exists, inArray, sql } from 'drizzle-orm';

import { getDb, getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { ensureIntercompanyPair } from '@/server/accounts/internal';
import { recordAuditEvent } from '@/server/audit';
import { AuthorizationDenied, requirePermission } from '@/server/authorization';
import {
  isIdempotencyViolation,
  LedgerError,
  lockEntryCounters,
  postEntryCore,
  reverseEntryCore,
  toLedgerDomainError,
} from '@/server/ledger';
import { getAccountingPeriod } from '@/server/periods';
import { CAPABILITY_GRANTS } from '@/server/rbac';

import { BankImportError, PeriodClosedInCompanyError } from './errors';
import { findTransferCandidates, lockStagedLine, pickableAccounts, suggestForCompany, type PickableAccount } from './index';

import type { PoolDatabase } from '@/db';
import type { BankImportLine } from '@/db/schema';
import type { AssignSharedLinesInput } from '@/validation/bank-import';
import type { PostJournalEntryInput } from '@/validation/journal';

/**
 * Shared card statements — LL-097 / ADR-043. The cardholder company A shares a card
 * statement with its organization; from another member company B the reviewer sees the
 * lines nobody has taken (STAGED) plus those already assigned to B, and takes the ones
 * that are B's. Taking a line posts BOTH sides in one transaction, source INTERCOMPANY,
 * one `intercompany_group_id`:
 *
 *   in A:  Dr Due from B / Cr Card        (a charge; flipped for a refund)
 *   in B:  Dr B's expense / Cr Due to A
 *
 * so A's card still reconciles to the statement and B's books carry B's expense.
 *
 * Visibility is one predicate for every reader and writer here: the actor holds
 * `journal.post` in B; A is an ACTIVE member of B's organization (A ≠ B); the actor holds
 * an ACTIVE membership in A whose role carries `journal.post` (so a batch is visible iff
 * it is assignable — nothing "exists but forbidden"); and the batch is shared OR already
 * has a line assigned to B (un-sharing never strands B's undo). Anything else is the
 * uniform denial / null.
 *
 * Lock order of every two-company transaction (assign and unassign alike): A's line FOR
 * UPDATE → both company rows FOR KEY SHARE in id order → both entry counters FOR UPDATE in
 * id order → the two postings/reversals. Deadlock-free against archive/designate (company
 * FOR UPDATE → counter), leave (organization → companies in id order) and each other.
 */

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

const TAKER_ROLES = CAPABILITY_GRANTS['journal.post'];

export interface SharedImportSummary {
  readonly batchId: string;
  readonly ownerCompanyId: string;
  readonly ownerLegalName: string;
  readonly accountName: string;
  readonly filename: string | null;
  readonly createdAt: Date;
  readonly sharedWithOrganization: boolean;
  /** Lines nobody has taken yet. */
  readonly stagedCount: number;
  /** Lines already assigned to the viewing company. */
  readonly assignedToMeCount: number;
}

export interface SharedLineView {
  readonly id: string;
  readonly lineNumber: number;
  readonly txnDate: string;
  readonly description: string | null;
  readonly amount: string;
  readonly aiCategory: string | null;
  readonly status: 'STAGED' | 'ASSIGNED';
  /** A suggestion from the VIEWING company's chart and precedent. */
  readonly suggestedAccountId: string | null;
  /** When assigned to the viewer: the viewer's expense account and entry. */
  readonly assignedAccountId: string | null;
  readonly assignedJournalEntryId: string | null;
}

export interface SharedImportBatchView {
  readonly batch: SharedImportSummary;
  readonly viewerCompanyId: string;
  readonly lines: readonly SharedLineView[];
  /** The viewer's accounts a line may be taken to. */
  readonly pickable: readonly PickableAccount[];
}

interface VisibleBatch {
  readonly id: string;
  readonly ownerCompanyId: string;
  readonly ownerLegalName: string;
  readonly ownerTimezone: string;
  readonly bankAccountId: string;
  readonly accountName: string;
  readonly filename: string | null;
  readonly createdAt: Date;
  readonly sharedWithOrganization: boolean;
}

/** The batches of other members that the actor may take lines from, into `viewerCompanyId`. */
async function visibleBatches(actorUserId: string, viewerCompanyId: string, batchId?: string): Promise<VisibleBatch[]> {
  const db = getDb();
  const viewer = (
    await db
      .select({ organizationId: schema.companies.organizationId })
      .from(schema.companies)
      .where(and(eq(schema.companies.id, viewerCompanyId), eq(schema.companies.status, 'ACTIVE')))
      .limit(1)
  )[0];
  const organizationId = viewer?.organizationId ?? null;
  if (organizationId === null) return [];

  const b = schema.bankImportBatches;
  const l = schema.bankImportLines;
  const rows = await db
    .select({
      id: b.id,
      ownerCompanyId: b.companyId,
      ownerLegalName: schema.companies.legalName,
      ownerTimezone: schema.companies.timezone,
      bankAccountId: b.bankAccountId,
      accountName: schema.accounts.name,
      filename: b.filename,
      createdAt: b.createdAt,
      sharedWithOrganization: b.sharedWithOrganization,
    })
    .from(b)
    .innerJoin(
      schema.companies,
      and(
        eq(schema.companies.id, b.companyId),
        eq(schema.companies.status, 'ACTIVE'),
        eq(schema.companies.organizationId, organizationId),
        sql`${schema.companies.id} <> ${viewerCompanyId}`,
      ),
    )
    .innerJoin(schema.accounts, and(eq(schema.accounts.companyId, b.companyId), eq(schema.accounts.id, b.bankAccountId)))
    .innerJoin(
      schema.companyMemberships,
      and(
        eq(schema.companyMemberships.companyId, b.companyId),
        eq(schema.companyMemberships.userId, actorUserId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
        inArray(schema.companyMemberships.role, [...TAKER_ROLES]),
      ),
    )
    .where(
      and(
        batchId === undefined ? undefined : eq(b.id, batchId),
        // Only a card statement is ever shared (the service refuses otherwise); the
        // ACTIVE-account join above is enough here.
        sql`(${b.sharedWithOrganization} or ${exists(
          db
            .select({ one: sql`1` })
            .from(l)
            .where(and(eq(l.companyId, b.companyId), eq(l.batchId, b.id), eq(l.assignedCompanyId, viewerCompanyId))),
        )})`,
      ),
    )
    .orderBy(sql`${b.createdAt} desc`);
  return rows;
}

async function lineCounts(batches: readonly VisibleBatch[], viewerCompanyId: string): Promise<Map<string, { staged: number; mine: number }>> {
  const out = new Map<string, { staged: number; mine: number }>();
  if (batches.length === 0) return out;
  const rows = await getDb().execute<{ batch_id: string; staged: string; mine: string }>(sql`
    select batch_id::text as batch_id,
           count(*) filter (where status = 'STAGED')::text as staged,
           count(*) filter (where status = 'ASSIGNED' and assigned_company_id = ${viewerCompanyId})::text as mine
    from bank_import_lines
    where batch_id in (${sql.join(batches.map((x) => sql`${x.id}`), sql`, `)})
    group by batch_id`);
  for (const r of rows.rows) out.set(r.batch_id, { staged: Number(r.staged), mine: Number(r.mine) });
  return out;
}

function toSummary(v: VisibleBatch, counts: { staged: number; mine: number } | undefined): SharedImportSummary {
  return {
    batchId: v.id,
    ownerCompanyId: v.ownerCompanyId,
    ownerLegalName: v.ownerLegalName,
    accountName: v.accountName,
    filename: v.filename,
    createdAt: v.createdAt,
    sharedWithOrganization: v.sharedWithOrganization,
    stagedCount: v.sharedWithOrganization ? (counts?.staged ?? 0) : 0,
    assignedToMeCount: counts?.mine ?? 0,
  };
}

/** "Shared with you": the other members' card statements the actor may take lines from. */
export async function listSharedImports(actorUserId: string, viewerCompanyId: string): Promise<SharedImportSummary[]> {
  await requirePermission(actorUserId, viewerCompanyId, 'journal.post');
  const batches = await visibleBatches(actorUserId, viewerCompanyId);
  const counts = await lineCounts(batches, viewerCompanyId);
  return batches.map((v) => toSummary(v, counts.get(v.id)));
}

/** One shared statement as seen from the viewer: untaken lines and the viewer's own; null when invisible. */
export async function getSharedImportBatch(
  actorUserId: string,
  viewerCompanyId: string,
  batchId: string,
): Promise<SharedImportBatchView | null> {
  await requirePermission(actorUserId, viewerCompanyId, 'journal.post');
  const visible = (await visibleBatches(actorUserId, viewerCompanyId, batchId))[0];
  if (visible === undefined) return null;
  const db = getDb();

  const allLines = await db
    .select()
    .from(schema.bankImportLines)
    .where(
      and(
        eq(schema.bankImportLines.companyId, visible.ownerCompanyId),
        eq(schema.bankImportLines.batchId, batchId),
        // Un-shared (LL-097): only what this company already took is shown — no new takes.
        visible.sharedWithOrganization
          ? sql`(${schema.bankImportLines.status} = 'STAGED' or (${schema.bankImportLines.status} = 'ASSIGNED' and ${schema.bankImportLines.assignedCompanyId} = ${viewerCompanyId}))`
          : sql`(${schema.bankImportLines.status} = 'ASSIGNED' and ${schema.bankImportLines.assignedCompanyId} = ${viewerCompanyId})`,
      ),
    )
    .orderBy(schema.bankImportLines.lineNumber);
  // LL-102 (Gate 7 M3): a positive card line mirrored by the cardholder's OWN bank (a card
  // payment) is never on offer — it belongs to the cardholder, who matches it (LL-094).
  const payments = await cardPaymentLines(visible.ownerCompanyId, visible.bankAccountId, allLines);
  const lines = allLines.filter((x) => !payments.has(x.id));

  const { pickable, suggestions } = await suggestForCompany(
    viewerCompanyId,
    visible.bankAccountId,
    lines.filter((x) => x.status === 'STAGED').map((x) => ({ description: x.description ?? '', aiCategory: x.aiCategory })),
  );
  // The viewer's expense account of an assigned line is the non-intercompany line of ITS entry.
  const mineEntryIds = lines.map((x) => x.assignedJournalEntryId).filter((id): id is string => id !== null);
  const accountByEntry = new Map<string, string>();
  if (mineEntryIds.length > 0) {
    const rows = await db
      .select({ entryId: schema.journalLines.journalEntryId, accountId: schema.journalLines.accountId })
      .from(schema.journalLines)
      .innerJoin(schema.accounts, and(eq(schema.accounts.companyId, schema.journalLines.companyId), eq(schema.accounts.id, schema.journalLines.accountId)))
      .where(and(eq(schema.journalLines.companyId, viewerCompanyId), inArray(schema.journalLines.journalEntryId, mineEntryIds), sql`${schema.accounts.intercompanyCompanyId} is null`));
    for (const r of rows) accountByEntry.set(r.entryId, r.accountId);
  }
  const counts = await lineCounts([visible], viewerCompanyId);

  return {
    batch: toSummary(visible, counts.get(visible.id)),
    viewerCompanyId,
    pickable,
    lines: lines.map((x) => ({
      id: x.id,
      lineNumber: x.lineNumber,
      txnDate: x.txnDate,
      description: x.description,
      amount: x.amount,
      aiCategory: x.aiCategory,
      status: x.status === 'ASSIGNED' ? 'ASSIGNED' : 'STAGED',
      suggestedAccountId: x.status === 'STAGED' ? (suggestions.get(x.description ?? '') ?? null) : null,
      assignedAccountId: x.assignedJournalEntryId === null ? null : (accountByEntry.get(x.assignedJournalEntryId) ?? null),
      assignedJournalEntryId: x.assignedJournalEntryId,
    })),
  };
}

/** Both companies' periods for `date` must be OPEN; the message names the company (LL-097). */
async function assertPeriodsOpen(
  companies: readonly { id: string; legalName: string }[],
  date: string,
  cache: Map<string, boolean>,
): Promise<void> {
  for (const c of companies) {
    const key = `${c.id}|${date}`;
    let open = cache.get(key);
    if (open === undefined) {
      open = (await getAccountingPeriod(c.id, date)).status === 'OPEN';
      cache.set(key, open);
    }
    if (!open) throw new PeriodClosedInCompanyError(c.id, `The accounting period for ${date} is closed in ${c.legalName}.`);
  }
}

async function viewerLegalName(viewerCompanyId: string): Promise<string> {
  const rows = await getDb().select({ legalName: schema.companies.legalName }).from(schema.companies).where(eq(schema.companies.id, viewerCompanyId)).limit(1);
  return rows[0]?.legalName ?? 'this company';
}

/** Entry lines for one side: `from` is credited and `to` debited for a charge (negative amount); flipped for a refund. */
function sideLines(amount: string, debitAccount: string, creditAccount: string): PostJournalEntryInput['lines'] {
  const abs = toMoney(amount).abs().toFixed(4);
  return [
    { accountId: debitAccount, debit: abs, credit: '0' },
    { accountId: creditAccount, debit: '0', credit: abs },
  ];
}

/**
 * Takes STAGED lines of a shared card statement into the viewing company — AUTHORIZED
 * (journal.post in the viewer AND in the cardholder). Every decision is validated before
 * any line is written; then each line posts both sides in its own transaction — a line is
 * fully taken or untouched (invariant 7), and a retry or a concurrent take is a no-op
 * (invariant 6: the line lock and the source-once index).
 */
export async function assignSharedLines(
  actorUserId: string,
  viewerCompanyId: string,
  batchId: string,
  input: AssignSharedLinesInput,
): Promise<{ assigned: number }> {
  await requirePermission(actorUserId, viewerCompanyId, 'journal.post');
  const visible = (await visibleBatches(actorUserId, viewerCompanyId, batchId))[0];
  if (visible === undefined) throw new AuthorizationDenied();
  const ownerCompanyId = visible.ownerCompanyId;
  await requirePermission(actorUserId, ownerCompanyId, 'journal.post');
  const viewerName = await viewerLegalName(viewerCompanyId);
  const both = [
    { id: ownerCompanyId, legalName: visible.ownerLegalName },
    { id: viewerCompanyId, legalName: viewerName },
  ];

  const lineRows = await getDb()
    .select()
    .from(schema.bankImportLines)
    .where(and(eq(schema.bankImportLines.companyId, ownerCompanyId), eq(schema.bankImportLines.batchId, batchId)));
  const byId = new Map(lineRows.map((x) => [x.id, x]));
  const pickable = await pickableAccounts(viewerCompanyId, visible.bankAccountId);
  const allowedIds = new Set(pickable.map((a) => a.id));

  const plans: { line: BankImportLine; accountId: string }[] = [];
  const periodCache = new Map<string, boolean>();
  for (const d of input.decisions) {
    const line = byId.get(d.lineId);
    // An un-shared batch is visible only through the lines this company already took; its
    // untaken lines are not on offer (LL-097).
    if (line === undefined || !visible.sharedWithOrganization) throw new BankImportError('LINE_NOT_FOUND', 'Import line not found.');
    if (line.status !== 'STAGED') continue; // taken, posted or ignored meanwhile — idempotent no-op
    const n = String(line.lineNumber);
    if (!allowedIds.has(d.accountId)) {
      throw new BankImportError('CONTROL_ACCOUNT_NOT_ALLOWED', `Line ${n}: choose one of ${viewerName}'s active expense or asset accounts (never a control or intercompany account).`);
    }
    await assertPeriodsOpen(both, line.txnDate, periodCache);
    plans.push({ line, accountId: d.accountId });
  }
  // LL-102: a card payment mirrored by the cardholder's own bank is never takeable.
  const payments = await cardPaymentLines(ownerCompanyId, visible.bankAccountId, plans.map((p) => p.line));
  const paid = plans.find((p) => payments.has(p.line.id));
  if (paid !== undefined) {
    throw new BankImportError('CARD_PAYMENT_NOT_TAKEABLE', `Line ${String(paid.line.lineNumber)}: that is a payment to the card from the cardholder's own bank, not a charge — it stays with the cardholder.`);
  }

  let assigned = 0;
  for (const { line, accountId } of plans) {
    try {
      const done = await getDbTx().transaction(async (tx): Promise<boolean> => {
        if (!(await lockStagedLine(tx, ownerCompanyId, line.id))) return false;
        const pair = await ensureIntercompanyPair(tx, actorUserId, ownerCompanyId, viewerCompanyId);
        await lockEntryCounters(tx, [ownerCompanyId, viewerCompanyId]);
        const groupId = randomUUID();
        const charge = toMoney(line.amount).isNegative();
        const description = line.description ?? `Card statement line ${String(line.lineNumber)}`;

        const a = await postEntryCore(
          tx,
          {
            companyId: ownerCompanyId,
            actorUserId,
            transactionDate: line.txnDate,
            postingDate: line.txnDate,
            description: `${description} — taken by ${viewerName}`,
            sourceType: 'INTERCOMPANY',
            sourceId: line.id,
            intercompanyGroupId: groupId,
            lines: charge
              ? sideLines(line.amount, pair.dueFrom.id, visible.bankAccountId)
              : sideLines(line.amount, visible.bankAccountId, pair.dueFrom.id),
          },
          line.txnDate,
          undefined,
        );
        const b = await postEntryCore(
          tx,
          {
            companyId: viewerCompanyId,
            actorUserId,
            transactionDate: line.txnDate,
            postingDate: line.txnDate,
            description: `${visible.ownerLegalName} card — ${description}`,
            sourceType: 'INTERCOMPANY',
            sourceId: line.id,
            intercompanyGroupId: groupId,
            lines: charge ? sideLines(line.amount, accountId, pair.dueTo.id) : sideLines(line.amount, pair.dueTo.id, accountId),
          },
          line.txnDate,
          undefined,
        );

        await tx
          .update(schema.bankImportLines)
          .set({
            status: 'ASSIGNED',
            journalEntryId: a.entry.id,
            assignedCompanyId: viewerCompanyId,
            assignedJournalEntryId: b.entry.id,
            updatedAt: sql`now()`,
          })
          .where(and(eq(schema.bankImportLines.companyId, ownerCompanyId), eq(schema.bankImportLines.id, line.id), eq(schema.bankImportLines.status, 'STAGED')));

        await recordAuditEvent({
          tx,
          companyId: ownerCompanyId,
          actorUserId,
          action: 'BANK_IMPORT_ASSIGNED',
          entityType: 'bank_import_line',
          entityId: line.id,
          after: { batchId, assignedCompanyId: viewerCompanyId, amount: line.amount, journalEntryId: a.entry.id, assignedJournalEntryId: b.entry.id, intercompanyGroupId: groupId },
        });
        await recordAuditEvent({
          tx,
          companyId: viewerCompanyId,
          actorUserId,
          action: 'BANK_IMPORT_ASSIGNED',
          entityType: 'journal_entry',
          entityId: b.entry.id,
          after: { ownerCompanyId, batchId, lineId: line.id, accountId, amount: line.amount, intercompanyGroupId: groupId },
        });
        return true;
      });
      if (done) assigned += 1;
    } catch (error) {
      if (isIdempotencyViolation(error)) continue; // a concurrent take won — done
      throw toLedgerDomainError(error);
    }
  }
  return { assigned };
}

/**
 * Gives a line back: reverses both sides and returns the line to STAGED so anyone may take
 * it again — AUTHORIZED (journal.post in both). Only the company that took it may undo.
 */
export async function unassignSharedLine(
  actorUserId: string,
  viewerCompanyId: string,
  batchId: string,
  lineId: string,
): Promise<{ reversed: boolean }> {
  await requirePermission(actorUserId, viewerCompanyId, 'journal.post');
  const visible = (await visibleBatches(actorUserId, viewerCompanyId, batchId))[0];
  if (visible === undefined) throw new AuthorizationDenied();
  const ownerCompanyId = visible.ownerCompanyId;
  await requirePermission(actorUserId, ownerCompanyId, 'journal.post');

  const line = (
    await getDb()
      .select()
      .from(schema.bankImportLines)
      .where(and(eq(schema.bankImportLines.companyId, ownerCompanyId), eq(schema.bankImportLines.batchId, batchId), eq(schema.bankImportLines.id, lineId)))
      .limit(1)
  )[0];
  if (line === undefined || line.status !== 'ASSIGNED' || line.assignedCompanyId !== viewerCompanyId || line.journalEntryId === null || line.assignedJournalEntryId === null) {
    throw new BankImportError('LINE_NOT_FOUND', 'That line is not assigned to this company.');
  }
  const viewerRow = (await getDb().select({ legalName: schema.companies.legalName }).from(schema.companies).where(eq(schema.companies.id, viewerCompanyId)).limit(1))[0];
  // ONE reversal date for both sides — the cardholder's today — open in both companies (Gate 7 L6:
  // two dates around midnight across timezones made the pair differ for a day).
  const reversalDate = todayInTimeZone(visible.ownerTimezone);
  const periodCache = new Map<string, boolean>();
  await assertPeriodsOpen(
    [{ id: ownerCompanyId, legalName: visible.ownerLegalName }, { id: viewerCompanyId, legalName: viewerRow?.legalName ?? 'this company' }],
    reversalDate,
    periodCache,
  );

  const ownerEntryId = line.journalEntryId;
  const viewerEntryId = line.assignedJournalEntryId;
  try {
    const reversed = await getDbTx().transaction(async (tx): Promise<boolean> => {
      const locked = (
        await tx
          .select({ status: schema.bankImportLines.status, assignedCompanyId: schema.bankImportLines.assignedCompanyId })
          .from(schema.bankImportLines)
          .where(and(eq(schema.bankImportLines.companyId, ownerCompanyId), eq(schema.bankImportLines.id, lineId)))
          .for('update')
      )[0];
      if (locked?.status !== 'ASSIGNED' || locked.assignedCompanyId !== viewerCompanyId) return false;
      // KEY SHARE on both companies AND the pair reactivated if a past leave deactivated it
      // (Gate 7 5c M1): a reversal onto an INACTIVE pair account would otherwise escape the
      // leave rule. ensureIntercompanyPair is idempotent and takes the sorted KEY SHARE itself.
      await ensureIntercompanyPair(tx, actorUserId, ownerCompanyId, viewerCompanyId);
      await lockEntryCounters(tx, [ownerCompanyId, viewerCompanyId]);
      await reverseEntryCore(tx, { companyId: ownerCompanyId, actorUserId, entryId: ownerEntryId, description: 'Card line given back by the taking company' }, reversalDate);
      await reverseEntryCore(tx, { companyId: viewerCompanyId, actorUserId, entryId: viewerEntryId, description: 'Card line given back to the cardholder' }, reversalDate);
      await tx
        .update(schema.bankImportLines)
        .set({ status: 'STAGED', journalEntryId: null, assignedCompanyId: null, assignedJournalEntryId: null, updatedAt: sql`now()` })
        .where(and(eq(schema.bankImportLines.companyId, ownerCompanyId), eq(schema.bankImportLines.id, lineId)));
      await recordAuditEvent({
        tx,
        companyId: ownerCompanyId,
        actorUserId,
        action: 'BANK_IMPORT_UNASSIGNED',
        entityType: 'bank_import_line',
        entityId: lineId,
        before: { assignedCompanyId: viewerCompanyId, journalEntryId: ownerEntryId, assignedJournalEntryId: viewerEntryId },
        after: { status: 'STAGED' },
      });
      await recordAuditEvent({
        tx,
        companyId: viewerCompanyId,
        actorUserId,
        action: 'BANK_IMPORT_UNASSIGNED',
        entityType: 'journal_entry',
        entityId: viewerEntryId,
        before: { ownerCompanyId, batchId, lineId },
        after: { reversed: true },
      });
      return true;
    });
    return { reversed };
  } catch (error) {
    throw toLedgerDomainError(error);
  }
}

export async function lockCompanyKeyShare(tx: Tx, companyId: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), eq(schema.companies.status, 'ACTIVE')))
    .limit(1)
    .for('key share');
  if (rows[0] === undefined) throw new LedgerError('COMPANY_NOT_FOUND', 'Company not found or inactive.');
}

/** The positive (money-in) lines of a card batch that a same-company statement mirrors: card payments, not refunds. */
async function cardPaymentLines(ownerCompanyId: string, bankAccountId: string, lines: readonly BankImportLine[]): Promise<Set<string>> {
  const positive = lines.filter((x) => x.status === 'STAGED' && toMoney(x.amount).isPositive()).map((x) => x.id);
  if (positive.length === 0) return new Set();
  const candidates = await findTransferCandidates(ownerCompanyId, bankAccountId, positive);
  return new Set(positive.filter((id) => candidates.has(id)));
}
