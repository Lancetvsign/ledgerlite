import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb, schema } from '@/db';
import { toMoney } from '@/lib/decimal';
import { ensureIntercompanyPair } from '@/server/accounts/internal';
import { recordAuditEvent } from '@/server/audit';
import { lockEntryCounters, postEntryCore } from '@/server/ledger';
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
  for (const r of rows.rows) {
    if (!out.has(r.line_id)) {
      out.set(r.line_id, { entryId: r.entry_id, counterpartCompanyId: r.company_id, counterpartLegalName: nameById.get(r.company_id) ?? 'another company', txnDate: r.txn_date, intercompanyGroupId: r.group_id });
    }
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

/** Posts THIS company's side of a transfer with `counterpartCompanyId` (inside the caller's tx, line already locked). */
export async function markIntercompanyTransfer(
  tx: Tx,
  actorUserId: string,
  companyId: string,
  bankAccountId: string,
  line: BankImportLine,
  counterpartCompanyId: string,
): Promise<MarkResult> {
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
