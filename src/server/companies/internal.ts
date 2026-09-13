import 'server-only';

import { and, eq } from 'drizzle-orm';

import { AuthorizationDenied } from '@/server/authorization';

import { getDbTx, schema } from '@/db';

import type { AppUser, Company, CompanyMembership } from '@/db/schema';
import type { PoolDatabase } from '@/db';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * UNAUTHORIZED-BY-DEFAULT repository operations. Importable ONLY from
 * src/server/** and tests — an import from src/app/** is a lint error
 * (eslint.config.mjs), because the LL-014 adversarial pass proved the obvious:
 * `insertMembership(companyA, attacker, 'OWNER')` is a complete cross-tenant
 * takeover the moment any route reaches it without authorizing first.
 *
 * Application code uses the authorized wrappers in ./index.ts. This module
 * exists for those wrappers, for company creation (which grants the FIRST
 * membership before anyone could hold a capability), and for test fixtures.
 */

export async function insertMembership(
  companyId: string,
  userId: string,
  role: CompanyMembership['role'],
): Promise<CompanyMembership> {
  const rows = await getDbTx()
    .insert(schema.companyMemberships)
    .values({ companyId, userId, role })
    .returning();
  const membership = rows[0];
  if (membership === undefined) throw new Error('membership insert returned no row');
  return membership;
}

export async function selectActiveMembers(
  companyId: string,
): Promise<{ user: AppUser; role: CompanyMembership['role'] }[]> {
  return await getDbTx()
    .select({ user: schema.users, role: schema.companyMemberships.role })
    .from(schema.companyMemberships)
    .innerJoin(schema.users, eq(schema.companyMemberships.userId, schema.users.id))
    .where(
      and(
        eq(schema.companyMemberships.companyId, companyId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
      ),
    );
}

/**
 * The master template company, if one is designated (LL-083 / ADR-039).
 *
 * THE ONE UNAUTHORIZED COMPANY READ, BY DESIGN: company creation copies the
 * template before the creator holds any capability anywhere. Structurally
 * limited to the row flagged is_template (at most one, by partial unique
 * index) and ACTIVE. Never reachable from src/app/** (fence); the app layer
 * learns only a boolean through hasTemplateCompany().
 */
export async function selectTemplateCompany(executor?: Tx): Promise<Company | undefined> {
  const rows = await (executor ?? getDbTx())
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.isTemplate, true), eq(schema.companies.status, 'ACTIVE')))
    .limit(1);
  return rows[0];
}

/**
 * Locks the ACTIVE company row for the rest of the transaction; missing or archived →
 * the uniform denial (never a distinguishable "already deleted"). Shared by the
 * company and member services (LL-082 / LL-086).
 */
export async function lockActiveCompany(tx: Tx, companyId: string): Promise<Company> {
  const locked = await tx
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.id, companyId), eq(schema.companies.status, 'ACTIVE')))
    .for('update');
  const company = locked[0];
  if (company === undefined) throw new AuthorizationDenied();
  return company;
}
