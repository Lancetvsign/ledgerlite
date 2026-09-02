import 'server-only';

import { and, eq } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { requireCompanyMembership, requirePermission } from '@/server/authorization';

import { installDefaultChart } from '@/server/accounts/installer';

import { insertMembership, selectActiveMembers } from './internal';

import type { AppUser, Company, CompanyMembership } from '@/db/schema';
import type { CoaChoice } from '@/server/accounts/default-coa';
import type { CreateCompanyInput } from '@/validation/company';

/**
 * What services RETURN for a company. `ein` is deliberately not here: the
 * protected column never travels in a default shape, so forgetting to strip it
 * at a call site is not possible — there is nothing to strip.
 */
export type CompanyView = Omit<Company, 'ein'>;

function toView(company: Company): CompanyView {
  const { ein: _ein, ...view } = company;
  return view;
}

/**
 * Creates a company and its creator's OWNER membership — one transaction on
 * the Pool client. Either both exist or neither does; no window may exist in
 * which a company has no owner (AGENTS.md §6: an ownerless company is a
 * tenant nobody can administer).
 *
 * Caller passes a VALIDATED input (the parsed Zod type) and an existing app
 * user id. Authentication is the only prerequisite — any signed-in user may
 * create a company and becomes its OWNER. What OWNER may *do* is LL-012's
 * capability model; company-scoped authorization for everything else is LL-013.
 */
export async function createCompanyWithOwner(
  ownerUserId: string,
  input: CreateCompanyInput,
  chart?: CoaChoice,
): Promise<{ company: CompanyView; membership: CompanyMembership }> {
  return await getDbTx().transaction(async (tx) => {
    const companies = await tx
      .insert(schema.companies)
      .values({
        legalName: input.legalName,
        dbaName: input.dbaName,
        email: input.email,
        phone: input.phone,
        address: input.address,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        currencyCode: input.currencyCode,
        timezone: input.timezone,
      })
      .returning();

    const company = companies[0];
    if (company === undefined) throw new Error('company insert returned no row');

    const memberships = await tx
      .insert(schema.companyMemberships)
      .values({ companyId: company.id, userId: ownerUserId, role: 'OWNER' })
      .returning();

    const membership = memberships[0];
    if (membership === undefined) throw new Error('membership insert returned no row');

    // Install a chart in the SAME transaction when one is chosen (LL-023).
    // Omitted (undefined) installs nothing — the company is still valid, and a
    // setup screen can install later via installDefaultChartFor. When a chart
    // IS chosen, the required system accounts arrive atomically with the company.
    if (chart !== undefined) {
      await installDefaultChart(company.id, chart, tx);
    }

    return { company: toView(company), membership };
  });
}

/** Companies where the user holds an ACTIVE membership and the company is ACTIVE. */
export async function listCompaniesForUser(
  userId: string,
): Promise<{ company: CompanyView; role: CompanyMembership['role'] }[]> {
  const rows = await getDbTx()
    .select({ company: schema.companies, role: schema.companyMemberships.role })
    .from(schema.companyMemberships)
    .innerJoin(schema.companies, eq(schema.companyMemberships.companyId, schema.companies.id))
    .where(
      and(
        eq(schema.companyMemberships.userId, userId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
        eq(schema.companies.status, 'ACTIVE'),
      ),
    );
  return rows.map((r) => ({ company: toView(r.company), role: r.role }));
}

/**
 * Active members of one company — AUTHORIZED. Any active member may see the
 * roster of their own company; nobody sees anyone else's. Hardened after the
 * LL-014 adversarial pass flagged the unauthorized repo read as the leak
 * waiting for its first careless route.
 */
export async function listMembersForCompany(
  actorUserId: string,
  companyId: string,
): Promise<{ user: AppUser; role: CompanyMembership['role'] }[]> {
  await requireCompanyMembership(actorUserId, companyId);
  return await selectActiveMembers(companyId);
}

/**
 * Grants a membership — AUTHORIZED (user.manage). The raw insert lives in
 * ./internal.ts, reachable only from server code; this is the front door the
 * future invite flow uses.
 */
export async function addMembershipAs(
  actorUserId: string,
  companyId: string,
  targetUserId: string,
  role: CompanyMembership['role'],
): Promise<CompanyMembership> {
  await requirePermission(actorUserId, companyId, 'user.manage');
  return await insertMembership(companyId, targetUserId, role);
}

/** The question LL-013's authorization layer will ask on every request. */
export async function hasActiveMembership(userId: string, companyId: string): Promise<boolean> {
  const rows = await getDbTx()
    .select({ id: schema.companyMemberships.id })
    .from(schema.companyMemberships)
    .where(
      and(
        eq(schema.companyMemberships.userId, userId),
        eq(schema.companyMemberships.companyId, companyId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

