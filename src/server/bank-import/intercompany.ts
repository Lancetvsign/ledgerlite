import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb, getDbTx, schema } from '@/db';
import { todayInTimeZone } from '@/lib/dates';
import { AuthorizationDenied, requirePermission } from '@/server/authorization';
import { getAccountingPeriod } from '@/server/periods';
import { LedgerError, toLedgerDomainError } from '@/server/ledger';
import { toMoney } from '@/lib/decimal';
import { ensureIntercompanyPair } from '@/server/accounts/internal';
import { recordAuditEvent } from '@/server/audit';
import { lockEntryCounters, postEntryCore, reverseEntryCore } from '@/server/ledger';
import { CAPABILITY_GRANTS } from '@/server/rbac';

import { BankImportError } from './errors';

import type { PoolDatabase } from '@/db';
import type { BankImportLine } from '@/db/schema';

/**
 * Intercompany BANK transfers — LL-099 / ADR-043. Money moving between two companies of one
 * organization appears on BOTH bank statements. Whichever company reviews first MARKS its line
 * as a transfer with the other company; the other company's review then OFFERS that posted
 * entry as a candidate (same amount, opposite direction, within the window) and MATCHES it,
 * posting its own side. Each side posts against its own statement account, so each company
 * reconciles to its own bank; the two sides share one `intercompany_group_id`.
 *
 * Which pair account carries it: the two companies keep ONE relationship, so a transfer moves
 * whatever pair already exists between them (settling a card-charge balance from LL-097 is
 * exactly this: the taker pays the cardholder back, and both Due accounts return to zero). If
 * no pair exists yet, one is created with the PAYER holding the receivable. If both directions
 * exist, the pair whose receivable the payer holds is used. Balances are signed, so a payment
 * larger than what was owed simply flips the sign — the report (LL-098) shows it either way,
 * and the mirror always holds because each side is one INTERCOMPANY posting on the pair.
 *
 *   money OUT of X (X's line negative):  Dr X's pair account / Cr Bank X
 *   money INTO Y (Y's line positive):    Dr Bank Y / Cr Y's pair account
 *
 * Both companies marking the same movement independently is harmless: two groups, but the
 * balances still mirror. Nothing structural depends on the group beyond one side per company.
 */

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

const WINDOW_DAYS = 3;
const TAKER_ROLES = CAPABILITY_GRANTS['journal.post'];

export interface IntercompanyCandidate {
  /** The other company's POSTED INTERCOMPANY entry (its side of the movement). */
  readonly entryId: string;
  readonly counterpartCompanyId: string;
  readonly counterpartLegalName: string;
  readonly txnDate: string;
  readonly intercompanyGroupId: string;
}

export interface MemberCompany {
  readonly id: string;
  readonly legalName: string;
}

/**
 * The other ACTIVE members of `companyId`'s organization in which the ACTOR holds a
 * `journal.post` role — the companies a transfer may be marked with or matched from
 * (visible ⇔ actionable, as for shared statements). Empty outside an organization.
 */
export async function transferCounterparts(actorUserId: string, companyId: string): Promise<MemberCompany[]> {
  const db = getDb();
  const me = (await db.select({ organizationId: schema.companies.organizationId }).from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1))[0];
  const organizationId = me?.organizationId ?? null;
  if (organizationId === null) return [];
  return await db
    .select({ id: schema.companies.id, legalName: schema.companies.legalName })
    .from(schema.companies)
    .innerJoin(
      schema.companyMemberships,
      and(
        eq(schema.companyMemberships.companyId, schema.companies.id),
        eq(schema.companyMemberships.userId, actorUserId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
        inArray(schema.companyMemberships.role, [...TAKER_ROLES]),
      ),
    )
    .where(and(eq(schema.companies.organizationId, organizationId), eq(schema.companies.status, 'ACTIVE'), sql`${schema.companies.id} <> ${companyId}`))
    .orderBy(schema.companies.legalName, schema.companies.id);
}

/**
 * For each STAGED line, the other company's unmatched INTERCOMPANY entry that mirrors it:
 * its pair-account line carries |amount| on the opposite side (a payer's DEBIT for our money
 * in, a payee's CREDIT for our money out), within the window, its group has no entry of ours,
 * and it lives in a counterpart the actor may act in. The nearest date wins.
 */
export async function findIntercompanyCandidates(
  actorUserId: string,
  companyId: string,
  lines: readonly { id: string; amount: string; txnDate: string; status: string }[],
): Promise<Map<string, IntercompanyCandidate>> {
  const out = new Map<string, IntercompanyCandidate>();
  const staged = lines.filter((l) => l.status === 'STAGED');
  if (staged.length === 0) return out;
  const counterparts = await transferCounterparts(actorUserId, companyId);
  if (counterparts.length === 0) return out;
  const nameById = new Map(counterparts.map((c) => [c.id, c.legalName]));

  const rows = await getDb().execute<{ line_id: string; entry_id: string; company_id: string; txn_date: string; group_id: string }>(sql`
    select l.id::text as line_id, e.id::text as entry_id, e.company_id::text as company_id,
           e.transaction_date::text as txn_date, e.intercompany_group_id::text as group_id
    from bank_import_lines l
    join journal_entries e
      on e.source_type = 'INTERCOMPANY' and e.status = 'POSTED' and e.intercompany_group_id is not null
     and e.company_id in (${sql.join(counterparts.map((c) => sql`${c.id}`), sql`, `)})
     and abs(e.transaction_date - l.txn_date) <= ${WINDOW_DAYS}
     and not exists (select 1 from journal_entries mine where mine.intercompany_group_id = e.intercompany_group_id and mine.company_id = ${companyId})
    join journal_lines jl
      on jl.journal_entry_id = e.id
    join accounts pa
      on pa.company_id = jl.company_id and pa.id = jl.account_id and pa.intercompany_company_id = ${companyId}
     and ((l.amount > 0 and jl.debit = abs(l.amount)) or (l.amount < 0 and jl.credit = abs(l.amount)))
    where l.company_id = ${companyId} and l.id in (${sql.join(staged.map((s) => sql`${s.id}`), sql`, `)})
    order by l.id, abs(e.transaction_date - l.txn_date), e.transaction_date, e.id`);
  // One candidate per line AND one line per candidate (LL-101): two equal lines in one batch are
  // offered different entries, so a single submit never sends two lines at one group.
  const taken = new Set<string>();
  for (const r of rows.rows) {
    if (out.has(r.line_id) || taken.has(r.entry_id)) continue;
    taken.add(r.entry_id);
    out.set(r.line_id, { entryId: r.entry_id, counterpartCompanyId: r.company_id, counterpartLegalName: nameById.get(r.company_id) ?? 'another company', txnDate: r.txn_date, intercompanyGroupId: r.group_id });
  }
  return out;
}

/** The pair to move for a transfer between `me` and `other`; created payer-holds-receivable when absent. */
async function pairAccountsFor(tx: Tx, actorUserId: string, me: string, other: string, moneyOut: boolean): Promise<{ mine: string; theirs: string }> {
  const existing = await tx
    .select({ companyId: schema.accounts.companyId, counterpart: schema.accounts.intercompanyCompanyId, role: schema.accounts.systemAccountType })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.status, 'ACTIVE'), sql`((${schema.accounts.companyId} = ${me} and ${schema.accounts.intercompanyCompanyId} = ${other}) or (${schema.accounts.companyId} = ${other} and ${schema.accounts.intercompanyCompanyId} = ${me}))`));
  const iHoldReceivable = existing.some((a) => a.companyId === me && a.role === 'INTERCOMPANY_RECEIVABLE');
  const theyHoldReceivable = existing.some((a) => a.companyId === other && a.role === 'INTERCOMPANY_RECEIVABLE');
  // Prefer an existing pair; with both, the payer's receivable; with none, create payer-holds-receivable.
  const useMineAsReceivable = iHoldReceivable && theyHoldReceivable ? moneyOut : iHoldReceivable ? true : theyHoldReceivable ? false : moneyOut;
  if (useMineAsReceivable) {
    const p = await ensureIntercompanyPair(tx, actorUserId, me, other);
    return { mine: p.dueFrom.id, theirs: p.dueTo.id };
  }
  const p = await ensureIntercompanyPair(tx, actorUserId, other, me);
  return { mine: p.dueTo.id, theirs: p.dueFrom.id };
}

export interface MarkResult {
  readonly entryId: string;
  readonly accountId: string;
  readonly intercompanyGroupId: string;
}

/**
 * The counterpart's still-unmatched mark that mirrors this line (opposite side of |amount| on the
 * pair account facing us, in the window), read inside the transaction — a mark auto-joins it
 * instead of opening a second group (LL-101: both companies marking independently no longer
 * leaves permanent in-transit both ways).
 */
async function findMirrorMark(tx: Tx, companyId: string, counterpartCompanyId: string, line: BankImportLine): Promise<string | null> {
  const amt = toMoney(line.amount);
  const abs = amt.abs().toFixed(4);
  const rows = await tx.execute<{ id: string }>(sql`
    select e.id::text as id
    from journal_entries e
    join journal_lines jl on jl.journal_entry_id = e.id
    join accounts pa on pa.company_id = jl.company_id and pa.id = jl.account_id and pa.intercompany_company_id = ${companyId}
    where e.company_id = ${counterpartCompanyId} and e.source_type = 'INTERCOMPANY' and e.status = 'POSTED' and e.intercompany_group_id is not null
      and abs(e.transaction_date - ${line.txnDate}::date) <= ${WINDOW_DAYS}
      and ${amt.isPositive() ? sql`jl.debit = ${abs}::numeric` : sql`jl.credit = ${abs}::numeric`}
      and not exists (select 1 from journal_entries mine where mine.intercompany_group_id = e.intercompany_group_id and mine.company_id = ${companyId})
    order by abs(e.transaction_date - ${line.txnDate}::date), e.transaction_date, e.id
    limit 1`);
  return rows.rows[0]?.id ?? null;
}

/** Posts THIS company's side of a transfer with `counterpartCompanyId` (inside the caller's tx, line already locked). */
export async function markIntercompanyTransfer(
  tx: Tx,
  actorUserId: string,
  companyId: string,
  bankAccountId: string,
  line: BankImportLine,
  counterpartCompanyId: string,
): Promise<MarkResult> {
  const mirror = await findMirrorMark(tx, companyId, counterpartCompanyId, line);
  if (mirror !== null) return await matchIntercompanyTransfer(tx, actorUserId, companyId, bankAccountId, line, mirror);
  const amt = toMoney(line.amount);
  const moneyOut = amt.isNegative();
  const abs = amt.abs().toFixed(4);
  const pair = await pairAccountsFor(tx, actorUserId, companyId, counterpartCompanyId, moneyOut);
  await lockEntryCounters(tx, [companyId]);
  const groupId = randomUUID();
  const entry = await postEntryCore(
    tx,
    {
      companyId,
      actorUserId,
      transactionDate: line.txnDate,
      postingDate: line.txnDate,
      description: line.description ?? `Bank import line ${String(line.lineNumber)}`,
      sourceType: 'INTERCOMPANY',
      sourceId: line.id,
      intercompanyGroupId: groupId,
      lines: moneyOut
        ? [{ accountId: pair.mine, debit: abs, credit: '0' }, { accountId: bankAccountId, debit: '0', credit: abs }]
        : [{ accountId: bankAccountId, debit: abs, credit: '0' }, { accountId: pair.mine, debit: '0', credit: abs }],
    },
    line.txnDate,
    undefined,
  );
  return { entryId: entry.entry.id, accountId: pair.mine, intercompanyGroupId: groupId };
}

/**
 * Posts THIS company's side against the other company's already-posted side (inside the
 * caller's tx, line locked). The other side is re-read and re-proven here: POSTED,
 * INTERCOMPANY, grouped, mirroring this line on its pair account facing us, in the window.
 */
export async function matchIntercompanyTransfer(
  tx: Tx,
  actorUserId: string,
  companyId: string,
  bankAccountId: string,
  line: BankImportLine,
  counterpartEntryId: string,
): Promise<MarkResult> {
  const amt = toMoney(line.amount);
  const moneyIn = amt.isPositive();
  const abs = amt.abs().toFixed(4);
  const proof = await tx.execute<{ company_id: string; group_id: string; role: string }>(sql`
    select e.company_id::text as company_id, e.intercompany_group_id::text as group_id, pa.system_account_type as role
    from journal_entries e
    join journal_lines jl on jl.journal_entry_id = e.id
    join accounts pa on pa.company_id = jl.company_id and pa.id = jl.account_id and pa.intercompany_company_id = ${companyId}
    where e.id = ${counterpartEntryId} and e.source_type = 'INTERCOMPANY' and e.status = 'POSTED' and e.intercompany_group_id is not null
      and abs(e.transaction_date - ${line.txnDate}::date) <= ${WINDOW_DAYS}
      and ${moneyIn ? sql`jl.debit = ${abs}::numeric` : sql`jl.credit = ${abs}::numeric`}
    limit 1`);
  const other = proof.rows[0];
  if (other === undefined) {
    throw new BankImportError('TRANSFER_MISMATCH', `Line ${String(line.lineNumber)}: that is not the other company's side of this transfer.`);
  }
  // Their pair account faces us; ours is the twin: their receivable ⇔ our payable, and vice versa.
  const theirsIsReceivable = other.role === 'INTERCOMPANY_RECEIVABLE';
  const mine = theirsIsReceivable
    ? (await ensureIntercompanyPair(tx, actorUserId, other.company_id, companyId)).dueTo.id
    : (await ensureIntercompanyPair(tx, actorUserId, companyId, other.company_id)).dueFrom.id;
  await lockEntryCounters(tx, [companyId]);
  const entry = await postEntryCore(
    tx,
    {
      companyId,
      actorUserId,
      transactionDate: line.txnDate,
      postingDate: line.txnDate,
      description: line.description ?? `Bank import line ${String(line.lineNumber)}`,
      sourceType: 'INTERCOMPANY',
      sourceId: line.id,
      intercompanyGroupId: other.group_id,
      lines: moneyIn
        ? [{ accountId: bankAccountId, debit: abs, credit: '0' }, { accountId: mine, debit: '0', credit: abs }]
        : [{ accountId: mine, debit: abs, credit: '0' }, { accountId: bankAccountId, debit: '0', credit: abs }],
    },
    line.txnDate,
    undefined,
  );
  return { entryId: entry.entry.id, accountId: mine, intercompanyGroupId: other.group_id };
}

export async function auditIntercompanyLine(tx: Tx, companyId: string, actorUserId: string, batchId: string, line: BankImportLine, r: MarkResult, kind: 'marked' | 'matched', counterpartCompanyId: string): Promise<void> {
  await recordAuditEvent({
    tx,
    companyId,
    actorUserId,
    action: 'BANK_IMPORT_POSTED',
    entityType: 'bank_import_line',
    entityId: line.id,
    after: { batchId, accountId: r.accountId, amount: line.amount, journalEntryId: r.entryId, intercompany: kind, counterpartCompanyId, intercompanyGroupId: r.intercompanyGroupId },
  });
}

/**
 * Un-marks / un-matches a bank line posted as an intercompany transfer — AUTHORIZED
 * (`journal.post` here; and in the other company when its side exists) — Gate 7 H1. Reverses
 * this company's INTERCOMPANY entry and, if the other company already posted its side into the
 * same group, that entry too — in ONE transaction, both dated today (this company's today, open
 * in both). Both statement lines return to STAGED so either company can decide them again; the
 * group is left behind as two REVERSED entries. A line that was posted in the other company but
 * whose actor lacks rights there is refused with the uniform denial.
 */
export async function unmarkIntercompanyTransfer(
  actorUserId: string,
  companyId: string,
  batchId: string,
  lineId: string,
): Promise<{ reversed: number }> {
  await requirePermission(actorUserId, companyId, 'journal.post');
  const db = getDb();
  const line = (
    await db
      .select()
      .from(schema.bankImportLines)
      .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.batchId, batchId), eq(schema.bankImportLines.id, lineId)))
      .limit(1)
  )[0];
  if (line === undefined || line.status !== 'POSTED' || line.journalEntryId === null) {
    throw new BankImportError('LINE_NOT_FOUND', 'That line is not a posted intercompany transfer.');
  }
  const mine = (
    await db
      .select({ sourceType: schema.journalEntries.sourceType, status: schema.journalEntries.status, groupId: schema.journalEntries.intercompanyGroupId })
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.id, line.journalEntryId)))
      .limit(1)
  )[0];
  if (mine === undefined || mine.sourceType !== 'INTERCOMPANY' || mine.status !== 'POSTED' || mine.groupId === null) {
    throw new BankImportError('LINE_NOT_FOUND', 'That line is not a posted intercompany transfer.');
  }
  // The other side, if any: the one other POSTED entry of the group.
  const other = (
    await db
      .select({ id: schema.journalEntries.id, companyId: schema.journalEntries.companyId, status: schema.journalEntries.status })
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.intercompanyGroupId, mine.groupId), sql`${schema.journalEntries.id} <> ${line.journalEntryId}`))
      .limit(1)
  )[0];
  if (other !== undefined && other.status !== 'POSTED') {
    throw new BankImportError('TRANSFER_MISMATCH', "The other company's side of this transfer is already reversed; reload.");
  }
  if (other !== undefined) await requirePermission(actorUserId, other.companyId, 'journal.post');

  const companies = await db
    .select({ id: schema.companies.id, legalName: schema.companies.legalName, timezone: schema.companies.timezone })
    .from(schema.companies)
    .where(inArray(schema.companies.id, other === undefined ? [companyId] : [companyId, other.companyId]));
  const me = companies.find((c) => c.id === companyId);
  if (me === undefined) throw new AuthorizationDenied();
  const reversalDate = todayInTimeZone(me.timezone);
  for (const c of companies) {
    if ((await getAccountingPeriod(c.id, reversalDate)).status !== 'OPEN') {
      throw new LedgerError('PERIOD_CLOSED', `The accounting period for ${reversalDate} is closed in ${c.legalName}.`);
    }
  }

  const entryId = line.journalEntryId;
  try {
    return await getDbTx().transaction(async (tx) => {
      const locked = (
        await tx
          .select({ status: schema.bankImportLines.status, journalEntryId: schema.bankImportLines.journalEntryId })
          .from(schema.bankImportLines)
          .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, lineId)))
          .for('update')
      )[0];
      if (locked?.status !== 'POSTED' || locked.journalEntryId !== entryId) return { reversed: 0 };
      const ids = other === undefined ? [companyId] : [companyId, other.companyId];
      for (const id of [...ids].sort()) await lockCompanyKeyShare(tx, id);
      await lockEntryCounters(tx, ids);

      await reverseEntryCore(tx, { companyId, actorUserId, entryId, description: 'Intercompany transfer un-marked' }, reversalDate);
      let reversed = 1;
      if (other !== undefined) {
        // Their statement line (marked or matched) goes back to STAGED with ours; lock it too.
        const theirLine = (
          await tx
            .select({ id: schema.bankImportLines.id, status: schema.bankImportLines.status })
            .from(schema.bankImportLines)
            .where(and(eq(schema.bankImportLines.companyId, other.companyId), eq(schema.bankImportLines.journalEntryId, other.id)))
            .for('update')
        )[0];
        await reverseEntryCore(tx, { companyId: other.companyId, actorUserId, entryId: other.id, description: `Intercompany transfer un-marked by ${me.legalName}` }, reversalDate);
        reversed += 1;
        if (theirLine !== undefined && theirLine.status === 'POSTED') {
          await tx
            .update(schema.bankImportLines)
            .set({ status: 'STAGED', chosenAccountId: null, journalEntryId: null, updatedAt: sql`now()` })
            .where(and(eq(schema.bankImportLines.companyId, other.companyId), eq(schema.bankImportLines.id, theirLine.id)));
        }
        await recordAuditEvent({
          tx,
          companyId: other.companyId,
          actorUserId,
          action: 'BANK_IMPORT_UNASSIGNED',
          entityType: 'journal_entry',
          entityId: other.id,
          before: { intercompanyGroupId: mine.groupId, unmarkedBy: companyId },
          after: { reversed: true },
        });
      }
      await tx
        .update(schema.bankImportLines)
        .set({ status: 'STAGED', chosenAccountId: null, journalEntryId: null, updatedAt: sql`now()` })
        .where(and(eq(schema.bankImportLines.companyId, companyId), eq(schema.bankImportLines.id, lineId)));
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'BANK_IMPORT_UNASSIGNED',
        entityType: 'bank_import_line',
        entityId: lineId,
        before: { journalEntryId: entryId, intercompanyGroupId: mine.groupId, otherSide: other?.companyId ?? null },
        after: { status: 'STAGED', reversed },
      });
      return { reversed };
    });
  } catch (error) {
    throw toLedgerDomainError(error);
  }
}

async function lockCompanyKeyShare(tx: Tx, companyId: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), eq(schema.companies.status, 'ACTIVE')))
    .limit(1)
    .for('key share');
  if (rows[0] === undefined) throw new LedgerError('COMPANY_NOT_FOUND', 'Company not found or inactive.');
}
