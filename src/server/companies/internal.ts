import 'server-only';

import { and, eq } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';

import type { AppUser, CompanyMembership } from '@/db/schema';

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
