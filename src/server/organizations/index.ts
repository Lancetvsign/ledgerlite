import 'server-only';

import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { isUuid } from '@/lib/uuid';
import { deactivateIntercompanyPairs } from '@/server/accounts/internal';
import { recordAuditEvent } from '@/server/audit';
import { AuthorizationDenied, requireCompanyMembership, requirePermission } from '@/server/authorization';
import { lockActiveCompany } from '@/server/companies/internal';
import { CAPABILITY_GRANTS } from '@/server/rbac';

import { OrganizationError } from './errors';

import type { PoolDatabase } from '@/db';
import type { CreateOrganizationInput } from '@/validation/organization';

export { OrganizationError, type OrganizationErrorCode } from './errors';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Organizations — LL-096 / ADR-043. A grouping of companies under one owner so that a
 * shared card statement or a bank transfer between them can post INTERCOMPANY: the
 * company whose statement shows the movement posts it against its own statement account,
 * the other side lands in a per-pair "Due from <B>" / "Due to <A>" account, and every
 * company still reconciles to its own statements.
 *
 * The organization holds no money and no ledger. Company membership stays the unit of
 * authorization (AGENTS.md §6): every operation is authorized in a COMPANY, with the
 * `company.organization` capability (OWNER). There is no organization-level role.
 *
 * Lock order, everywhere: the ORGANIZATION row FOR UPDATE first, then company rows
 * (`lockActiveCompany`, FOR UPDATE) in id order. Join and leave both follow it, so they
 * cannot deadlock each other; `ensureIntercompanyPair` takes company rows FOR KEY SHARE
 * only, which leave's FOR UPDATE waits for.
 */

export interface OrganizationView {
  readonly id: string;
  readonly name: string;
}

export interface MemberCompany {
  readonly id: string;
  readonly legalName: string;
}

/** Roles that may create/join/leave — read from the grants so no role name is compared here. */
const ORGANIZATION_ROLES = CAPABILITY_GRANTS['company.organization'];

async function lockOrganization(tx: Tx, organizationId: string): Promise<OrganizationView> {
  const rows = await tx
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for('update');
  const org = rows[0];
  // An unknown id is the uniform denial: never an oracle for which ids exist.
  if (org === undefined) throw new AuthorizationDenied();
  return org;
}

async function activeMembers(executor: Tx | PoolDatabase, organizationId: string): Promise<{ id: string; legalName: string; currencyCode: string }[]> {
  return await executor
    .select({ id: schema.companies.id, legalName: schema.companies.legalName, currencyCode: schema.companies.currencyCode })
    .from(schema.companies)
    .where(and(eq(schema.companies.organizationId, organizationId), eq(schema.companies.status, 'ACTIVE')))
    .orderBy(schema.companies.legalName, schema.companies.id);
}

/**
 * Creates an organization and makes `companyId` its first member — one transaction.
 * Authorized in that company (`company.organization`).
 */
export async function createOrganization(
  actorUserId: string,
  companyId: string,
  input: CreateOrganizationInput,
): Promise<OrganizationView> {
  await requirePermission(actorUserId, companyId, 'company.organization');

  return await getDbTx().transaction(async (tx) => {
    // The new row is ours alone until commit — the org-first lock order holds trivially.
    const inserted = await tx
      .insert(schema.organizations)
      .values({ name: input.name, createdBy: actorUserId })
      .returning({ id: schema.organizations.id, name: schema.organizations.name });
    const org = inserted[0];
    if (org === undefined) throw new Error('organization insert returned no row');

    const company = await lockActiveCompany(tx, companyId);
    assertCanJoin(company);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'ORGANIZATION_CREATED',
      entityType: 'organization',
      entityId: org.id,
      after: { name: org.name },
    });
    await joinLocked(tx, actorUserId, companyId, org.id);
    return org;
  });
}

/**
 * Adds `companyId` to an existing organization. The actor must hold the capability in the
 * joining company AND in at least one ACTIVE member of the target organization — an
 * organization the actor cannot prove a stake in is, to them, one that does not exist
 * (uniform denial, same as a forged id).
 */
export async function addCompanyToOrganization(
  actorUserId: string,
  companyId: string,
  organizationId: string,
): Promise<OrganizationView> {
  await requirePermission(actorUserId, companyId, 'company.organization');
  if (!isUuid(organizationId)) throw new AuthorizationDenied();

  return await getDbTx().transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    const members = await activeMembers(tx, org.id);
    const stake = members.length === 0
      ? []
      : await tx
          .select({ id: schema.companyMemberships.id })
          .from(schema.companyMemberships)
          .where(
            and(
              eq(schema.companyMemberships.userId, actorUserId),
              eq(schema.companyMemberships.status, 'ACTIVE'),
              inArray(schema.companyMemberships.companyId, members.map((m) => m.id)),
              inArray(schema.companyMemberships.role, [...ORGANIZATION_ROLES]),
            ),
          )
          .limit(1);
    if (stake.length === 0) throw new AuthorizationDenied();

    const company = await lockActiveCompany(tx, companyId);
    assertCanJoin(company);
    const other = members.find((m) => m.currencyCode !== company.currencyCode);
    if (other !== undefined) {
      throw new OrganizationError('CURRENCY_MISMATCH', 'Every company in an organization must use the same currency.');
    }
    await joinLocked(tx, actorUserId, companyId, org.id);
    return org;
  });
}

function assertCanJoin(company: { isTemplate: boolean; organizationId: string | null }): void {
  if (company.isTemplate) {
    throw new OrganizationError('TEMPLATE_IN_ORGANIZATION', 'The master template company cannot join an organization.');
  }
  if (company.organizationId !== null) {
    throw new OrganizationError('ALREADY_IN_ORGANIZATION', 'This company already belongs to an organization.');
  }
}

async function joinLocked(tx: Tx, actorUserId: string, companyId: string, organizationId: string): Promise<void> {
  await recordAuditEvent({
    tx,
    companyId,
    actorUserId,
    action: 'COMPANY_JOINED_ORGANIZATION',
    entityType: 'company',
    entityId: companyId,
    before: { organizationId: null },
    after: { organizationId },
  });
  await tx
    .update(schema.companies)
    .set({ organizationId, updatedAt: sql`now()` })
    .where(eq(schema.companies.id, companyId));
}

/**
 * Removes `companyId` from its organization. Refused while any intercompany pair the
 * company is in — either direction — carries a non-zero balance; at zero the pair
 * accounts on both sides are deactivated (never deleted, ADR-006; a later rejoin
 * reactivates the same rows). The leaver and every counterpart are locked FOR UPDATE
 * (after the organization row, in id order) so no posting can slip a balance in between
 * the check and the update — a posting holds the company row FOR KEY SHARE until it commits.
 */
export async function removeCompanyFromOrganization(actorUserId: string, companyId: string): Promise<void> {
  await requirePermission(actorUserId, companyId, 'company.organization');

  await getDbTx().transaction(async (tx) => {
    const peek = await tx
      .select({ organizationId: schema.companies.organizationId })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    const organizationId = peek[0]?.organizationId ?? null;
    if (organizationId === null) throw new OrganizationError('NOT_IN_ORGANIZATION', 'This company is not in an organization.');
    await lockOrganization(tx, organizationId);

    const counterpartRows = await tx
      .select({ a: schema.accounts.companyId, b: schema.accounts.intercompanyCompanyId })
      .from(schema.accounts)
      // Every pair the company is in, ACTIVE or not (Gate 7 5c M1): a balance on a
      // deactivated pair account is still a balance, and its counterpart must be locked too.
      .where(
        and(
          isNotNull(schema.accounts.intercompanyCompanyId),
          sql`(${schema.accounts.companyId} = ${companyId} or ${schema.accounts.intercompanyCompanyId} = ${companyId})`,
        ),
      );
    const toLock = new Set<string>([companyId]);
    for (const r of counterpartRows) {
      toLock.add(r.a);
      if (r.b !== null) toLock.add(r.b);
    }
    let company: Awaited<ReturnType<typeof lockActiveCompany>> | undefined;
    const activeIds = new Set(
      (await tx.select({ id: schema.companies.id }).from(schema.companies).where(and(inArray(schema.companies.id, [...toLock]), eq(schema.companies.status, 'ACTIVE')))).map((r) => r.id),
    );
    for (const id of [...toLock].sort()) {
      if (id !== companyId && !activeIds.has(id)) continue; // an archived counterpart cannot post; its balance is still counted below
      const locked = await lockActiveCompany(tx, id);
      if (id === companyId) company = locked;
    }
    if (company === undefined || company.organizationId !== organizationId) {
      // Changed under us before the lock: re-decide from the locked truth.
      throw new OrganizationError('NOT_IN_ORGANIZATION', 'This company is not in an organization.');
    }

    // Money stays NUMERIC in SQL; only a count comes back (ADR-004).
    const open = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from (
        select l.account_id
          from journal_lines l
          join accounts a on a.company_id = l.company_id and a.id = l.account_id
          join journal_entries e on e.company_id = l.company_id and e.id = l.journal_entry_id
         where e.status in ('POSTED', 'REVERSED')
           and a.intercompany_company_id is not null
           and (a.company_id = ${companyId} or a.intercompany_company_id = ${companyId})
         group by l.account_id
        having sum(l.debit) <> sum(l.credit)) s`);
    if ((open.rows[0]?.n ?? '0') !== '0') {
      throw new OrganizationError(
        'ORG_HAS_INTERCOMPANY_BALANCE',
        'Settle every Due from / Due to balance with the other companies before leaving.',
      );
    }

    const deactivated = await deactivateIntercompanyPairs(tx, actorUserId, companyId);
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'COMPANY_LEFT_ORGANIZATION',
      entityType: 'company',
      entityId: companyId,
      before: { organizationId },
      after: { organizationId: null, deactivatedAccounts: deactivated.length },
    });
    await tx
      .update(schema.companies)
      .set({ organizationId: null, updatedAt: sql`now()` })
      .where(eq(schema.companies.id, companyId));
  });
}

/** The OTHER active members of `companyId`'s organization (empty when it has none). Membership in `companyId` required. */
export async function listOrganizationCompanies(actorUserId: string, companyId: string): Promise<MemberCompany[]> {
  await requireCompanyMembership(actorUserId, companyId);
  const db = getDbTx();
  const rows = await db
    .select({ organizationId: schema.companies.organizationId })
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), eq(schema.companies.status, 'ACTIVE')))
    .limit(1);
  const organizationId = rows[0]?.organizationId ?? null;
  if (organizationId === null) return [];
  return (await db
    .select({ id: schema.companies.id, legalName: schema.companies.legalName })
    .from(schema.companies)
    .where(
      and(
        eq(schema.companies.organizationId, organizationId),
        eq(schema.companies.status, 'ACTIVE'),
        ne(schema.companies.id, companyId),
      ),
    )
    .orderBy(schema.companies.legalName, schema.companies.id));
}

/**
 * Organizations the actor may add a company to: those with an ACTIVE member in which the
 * actor holds the capability. Self-scoped (derived from the actor's own memberships), so
 * there is nothing to authorize and nothing to leak.
 */
export async function organizationsActorCanAddTo(actorUserId: string): Promise<OrganizationView[]> {
  const rows = await getDbTx()
    .selectDistinct({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.companyMemberships)
    .innerJoin(schema.companies, eq(schema.companyMemberships.companyId, schema.companies.id))
    .innerJoin(schema.organizations, eq(schema.companies.organizationId, schema.organizations.id))
    .where(
      and(
        eq(schema.companyMemberships.userId, actorUserId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
        inArray(schema.companyMemberships.role, [...ORGANIZATION_ROLES]),
        eq(schema.companies.status, 'ACTIVE'),
      ),
    )
    .orderBy(schema.organizations.name, schema.organizations.id);
  return rows;
}
