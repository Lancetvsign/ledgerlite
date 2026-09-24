import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { errorChainText } from '@/lib/error-chain';
import { recordAuditEvent } from '@/server/audit';

import { AccountError } from './errors';
import { chartFor, REQUIRED_SYSTEM_ACCOUNTS, type CoaChoice } from './default-coa';

import type { PoolDatabase } from '@/db';
import type { Account } from '@/db/schema';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * UNAUTHORIZED-BY-DEFAULT default-chart install. In this fence-covered module
 * (src/app/** cannot import *_/internal) after the Gate 2A review flagged that
 * it lived in installer.ts, one import away from a route with no lint to stop
 * an attacker-supplied companyId. Callers: company creation (into the just-made
 * company, in-tx, before any capability exists) and the authorized
 * installDefaultChartFor. Idempotent via ON CONFLICT on (company_id,
 * account_number).
 */
export async function installDefaultChart(
  companyId: string,
  choice: CoaChoice,
  tx?: Tx,
): Promise<number> {
  const executor = tx ?? getDbTx();
  const chart = chartFor(choice);

  const result = await executor
    .insert(schema.accounts)
    .values(
      chart.map((a) => ({
        companyId,
        accountNumber: a.accountNumber,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        systemAccountType: a.systemAccountType ?? null,
        cashFlowCategory: a.cashFlowCategory ?? null,
      })),
    )
    // The idempotency mechanism: a re-run (or a concurrent install) collides and
    // inserts nothing, rather than duplicating. Untargeted so it covers EVERY
    // unique constraint on accounts — both (company_id, account_number) AND the
    // (company_id, system_account_type) index (LL-042): a second install of the
    // A/R account conflicts on the system-type index too, and targeting only
    // account_number would let that surface as a duplicate-key error.
    .onConflictDoNothing()
    .returning({ id: schema.accounts.id });

  return result.length; // rows actually inserted this run (0 on a repeat)
}

/**
 * Copies the master template company's ACTIVE chart into a brand-new company
 * (LL-083 / ADR-039), then installs the required system accounts as a safety net.
 *
 * Structurally scoped: the SELECT joins on companies.is_template = true, so even
 * an internal caller cannot copy an arbitrary company's chart. Ids are
 * pre-generated so parent links remap in a single insert (a parent that is
 * INACTIVE is not copied; its children become top-level). No balances, no
 * documents — account structure only, exactly like installDefaultChart.
 *
 * The safety net (`installDefaultChart(companyId, 'system-only', tx)`) relies on
 * that installer's untargeted ON CONFLICT DO NOTHING: a template that renumbered
 * A/R still yields exactly one ACCOUNTS_RECEIVABLE (conflict on the system-type
 * index), and a template missing a required account still yields it. Every
 * company therefore always has A/R, A/P, Retained Earnings and Opening Balance
 * Equity, whatever the template looks like.
 */
export async function installChartFromTemplate(
  companyId: string,
  templateCompanyId: string,
  tx: Tx,
): Promise<number> {
  const source = await tx
    .select({ account: schema.accounts })
    .from(schema.accounts)
    .innerJoin(schema.companies, eq(schema.accounts.companyId, schema.companies.id))
    .where(
      and(
        eq(schema.companies.id, templateCompanyId),
        eq(schema.companies.isTemplate, true),
        eq(schema.companies.status, 'ACTIVE'),
        eq(schema.accounts.status, 'ACTIVE'),
        // Never copy an intercompany pair (LL-096): it names a counterpart of the
        // TEMPLATE, and the template cannot be an organization member anyway (CHECK).
        isNull(schema.accounts.intercompanyCompanyId),
      ),
    );

  const idMap = new Map(source.map((r) => [r.account.id, randomUUID()] as const));
  // Parents first. Postgres checks the FK at statement end, so row order is not
  // required for correctness; it keeps the copied chart readable when inspected.
  const ordered = [...source].sort((a, b) => {
    const pa = a.account.parentAccountId === null ? 0 : 1;
    const pb = b.account.parentAccountId === null ? 0 : 1;
    return pa - pb || (a.account.accountNumber ?? '').localeCompare(b.account.accountNumber ?? '');
  });

  if (ordered.length > 0) {
    await tx.insert(schema.accounts).values(
      ordered.map(({ account: a }) => ({
        id: idMap.get(a.id),
        companyId,
        accountNumber: a.accountNumber,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        parentAccountId:
          a.parentAccountId === null ? null : (idMap.get(a.parentAccountId) ?? null),
        systemAccountType: a.systemAccountType,
        cashFlowCategory: a.cashFlowCategory,
        description: a.description,
      })),
    );
  }

  await installDefaultChart(companyId, 'system-only', tx);

  // A required role can still be missing after that: e.g. a chart-less template
  // that owns a non-A/R account numbered 1100 blocks the numbered A/R insert on
  // the number unique. Insert any missing role UNNUMBERED — the number is a
  // convenience, the role is the guarantee.
  const present = new Set(
    (
      await tx
        .select({ role: schema.accounts.systemAccountType })
        .from(schema.accounts)
        .where(eq(schema.accounts.companyId, companyId))
    ).map((r) => r.role),
  );
  const missing = REQUIRED_SYSTEM_ACCOUNTS.filter((a) => !present.has(a.systemAccountType ?? null));
  if (missing.length > 0) {
    await tx.insert(schema.accounts).values(
      missing.map((a) => ({
        companyId,
        accountNumber: null,
        name: a.name,
        accountType: a.accountType,
        accountSubtype: a.accountSubtype,
        systemAccountType: a.systemAccountType ?? null,
        cashFlowCategory: a.cashFlowCategory ?? null,
      })),
    );
  }
  return ordered.length;
}

/** The two accounts of an intercompany pair: "Due from B" in A, "Due to A" in B (LL-096). */
export interface IntercompanyPair {
  readonly dueFrom: Account;
  readonly dueTo: Account;
}

const RECEIVABLE_RANGE = [1300, 1399] as const;
const PAYABLE_RANGE = [2300, 2399] as const;

/**
 * Returns the intercompany pair between companies `a` (which will carry "Due from B")
 * and `b` ("Due to A"), creating either side on first use — UNAUTHORIZED-BY-DEFAULT
 * like everything in this module; the caller has authorized the posting that needs it.
 *
 * Contract: call INSIDE the transaction that posts. The two company rows are taken
 * FOR KEY SHARE (the same lock a posting holds — `postEntryCore`), so the pair cannot
 * be split by a concurrent leave (which takes the rows FOR UPDATE) between this check
 * and the caller's commit. Race-safe and idempotent: the insert targets the pair's
 * partial unique index; a second concurrent creator inserts nothing and selects the
 * winner's rows. A pair deactivated by a past leave is reactivated — same ids, history
 * intact (ADR-006).
 *
 * Both companies must be ACTIVE, members of the same organization and of one currency
 * (a NUMERIC mirror across currencies is meaningless) — else INTERCOMPANY_NOT_ALLOWED.
 */
export async function ensureIntercompanyPair(
  tx: Tx,
  actorUserId: string,
  a: string,
  b: string,
): Promise<IntercompanyPair> {
  if (a === b) throw new AccountError('INTERCOMPANY_NOT_ALLOWED', 'A company cannot owe itself.');
  const locked = new Map<string, { legalName: string; organizationId: string | null; currencyCode: string }>();
  for (const id of [a, b].sort()) {
    const rows = await tx
      .select({
        id: schema.companies.id,
        legalName: schema.companies.legalName,
        organizationId: schema.companies.organizationId,
        currencyCode: schema.companies.currencyCode,
      })
      .from(schema.companies)
      .where(and(eq(schema.companies.id, id), eq(schema.companies.status, 'ACTIVE')))
      .limit(1)
      .for('key share');
    const row = rows[0];
    if (row === undefined) throw new AccountError('INTERCOMPANY_NOT_ALLOWED', 'Both companies must be active.');
    locked.set(id, row);
  }
  const ca = locked.get(a);
  const cb = locked.get(b);
  if (ca === undefined || cb === undefined) throw new Error('unreachable: locked rows missing');
  if (ca.organizationId === null || ca.organizationId !== cb.organizationId) {
    throw new AccountError('INTERCOMPANY_NOT_ALLOWED', 'Both companies must belong to the same organization.');
  }
  if (ca.currencyCode !== cb.currencyCode) {
    throw new AccountError('INTERCOMPANY_NOT_ALLOWED', 'Intercompany postings require one currency.');
  }

  const dueFrom = await ensureSide(tx, actorUserId, {
    companyId: a,
    counterpartId: b,
    name: `Due from ${cb.legalName}`,
    accountType: 'ASSET',
    accountSubtype: 'intercompany_receivable',
    systemAccountType: 'INTERCOMPANY_RECEIVABLE',
    range: RECEIVABLE_RANGE,
  });
  const dueTo = await ensureSide(tx, actorUserId, {
    companyId: b,
    counterpartId: a,
    name: `Due to ${ca.legalName}`,
    accountType: 'LIABILITY',
    accountSubtype: 'intercompany_payable',
    systemAccountType: 'INTERCOMPANY_PAYABLE',
    range: PAYABLE_RANGE,
  });
  return { dueFrom, dueTo };
}

interface SideSpec {
  readonly companyId: string;
  readonly counterpartId: string;
  readonly name: string;
  readonly accountType: 'ASSET' | 'LIABILITY';
  readonly accountSubtype: string;
  readonly systemAccountType: 'INTERCOMPANY_RECEIVABLE' | 'INTERCOMPANY_PAYABLE';
  readonly range: readonly [number, number];
}

async function ensureSide(tx: Tx, actorUserId: string, spec: SideSpec): Promise<Account> {
  const pairWhere = and(
    eq(schema.accounts.companyId, spec.companyId),
    eq(schema.accounts.systemAccountType, spec.systemAccountType),
    eq(schema.accounts.intercompanyCompanyId, spec.counterpartId),
  );
  const existing = (await tx.select().from(schema.accounts).where(pairWhere).limit(1))[0];
  if (existing !== undefined) return existing.status === 'ACTIVE' ? existing : await reactivate(tx, actorUserId, existing);

  const insert = async (executor: Tx, accountNumber: string | null): Promise<Account | undefined> =>
    (
      await executor
        .insert(schema.accounts)
        .values({
          companyId: spec.companyId,
          accountNumber,
          name: spec.name,
          accountType: spec.accountType,
          accountSubtype: spec.accountSubtype,
          systemAccountType: spec.systemAccountType,
          intercompanyCompanyId: spec.counterpartId,
          cashFlowCategory: 'OPERATING',
        })
        // The pair's partial unique index is the arbiter between concurrent creators.
        .onConflictDoNothing({
          target: [schema.accounts.companyId, schema.accounts.systemAccountType, schema.accounts.intercompanyCompanyId],
          where: sql`intercompany_company_id is not null`,
        })
        .returning()
    )[0];

  let created: Account | undefined;
  try {
    // A SAVEPOINT: a lost race on the NUMBER unique must not abort the caller's posting.
    created = await tx.transaction(async (sp) => await insert(sp, await lowestFreeNumber(sp, spec.companyId, spec.range)));
  } catch (error) {
    if (!/accounts_company_number_unique/.test(errorChainText(error))) throw error;
    created = await insert(tx, null); // the number is a convenience; the role is the guarantee
  }
  if (created !== undefined) {
    await recordAuditEvent({
      tx,
      companyId: spec.companyId,
      actorUserId,
      action: 'ACCOUNT_CREATED',
      entityType: 'account',
      entityId: created.id,
      after: created,
    });
    return created;
  }
  // Conflict: another transaction created it — read the winner (it committed, or it holds
  // the row and we waited on the unique index until it did).
  const winner = (await tx.select().from(schema.accounts).where(pairWhere).limit(1))[0];
  if (winner === undefined) throw new Error('intercompany pair insert conflicted but no row is visible');
  return winner.status === 'ACTIVE' ? winner : await reactivate(tx, actorUserId, winner);
}

async function reactivate(tx: Tx, actorUserId: string, account: Account): Promise<Account> {
  const rows = await tx
    .update(schema.accounts)
    .set({ status: 'ACTIVE', updatedAt: sql`now()` })
    .where(and(eq(schema.accounts.companyId, account.companyId), eq(schema.accounts.id, account.id)))
    .returning();
  const updated = rows[0];
  if (updated === undefined) throw new Error('account reactivation returned no row');
  await recordAuditEvent({
    tx,
    companyId: account.companyId,
    actorUserId,
    action: 'ACCOUNT_UPDATED',
    entityType: 'account',
    entityId: account.id,
    before: { status: account.status },
    after: { status: 'ACTIVE' },
  });
  return updated;
}

/** The lowest unused account number in [lo, hi] for the company, or null when the range is full. */
async function lowestFreeNumber(executor: Tx, companyId: string, [lo, hi]: readonly [number, number]): Promise<string | null> {
  const taken = new Set(
    (
      await executor
        .select({ n: schema.accounts.accountNumber })
        .from(schema.accounts)
        .where(eq(schema.accounts.companyId, companyId))
    ).map((r) => r.n),
  );
  for (let n = lo; n <= hi; n += 1) {
    const s = String(n);
    if (!taken.has(s)) return s;
  }
  return null;
}

/**
 * Deactivates every intercompany account on BOTH sides of every pair the company is in
 * (LL-096, called by "remove from organization" after the zero-balance check, under the
 * company row locks). The public `deactivateAccount` refuses system accounts by design;
 * this is the one fenced path that may. Returns the ids deactivated.
 */
export async function deactivateIntercompanyPairs(tx: Tx, actorUserId: string, companyId: string): Promise<string[]> {
  const rows = await tx
    .select()
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.status, 'ACTIVE'),
        sql`(${schema.accounts.companyId} = ${companyId} and ${schema.accounts.intercompanyCompanyId} is not null) or ${schema.accounts.intercompanyCompanyId} = ${companyId}`,
      ),
    );
  for (const account of rows) {
    await tx
      .update(schema.accounts)
      .set({ status: 'INACTIVE', updatedAt: sql`now()` })
      .where(and(eq(schema.accounts.companyId, account.companyId), eq(schema.accounts.id, account.id)));
    await recordAuditEvent({
      tx,
      companyId: account.companyId,
      actorUserId,
      action: 'ACCOUNT_DEACTIVATED',
      entityType: 'account',
      entityId: account.id,
      before: { status: 'ACTIVE' },
      after: { status: 'INACTIVE', reason: 'left organization', leftCompanyId: companyId },
    });
  }
  return rows.map((r) => r.id);
}
