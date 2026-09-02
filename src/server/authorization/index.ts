import 'server-only';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDbTx, schema } from '@/db';
import { log } from '@/lib/logging';
import { roleHasCapability, type Capability } from '@/server/rbac';

import type { CompanyMembership } from '@/db/schema';

/**
 * The company authorization layer — LL-013.
 *
 * EVERY company-scoped operation in this application, now and forever, calls
 * one of these two functions itself. Not via middleware: middleware is bypassed
 * by the next background job, internal route, or direct service call, and the
 * bypass will not look like a security decision when it is written.
 *
 * FAIL CLOSED means: any error, any ambiguity, any missing record, any
 * malformed input, any database failure → denial. There is no code path from
 * an exception or a null to access.
 */

/**
 * The one public denial. Deliberately a single shape with a single message:
 * "no membership", "inactive membership", "wrong capability" and "no such
 * company" must be indistinguishable to a caller, or the error becomes an
 * oracle for which companies exist and who belongs to them. The real reason is
 * logged server-side and goes nowhere else.
 */
export class AuthorizationDenied extends Error {
  public override readonly name = 'AuthorizationDenied';
  /** Uniform, machine-readable, and identical for every denial path. */
  public readonly code = 'NOT_FOUND' as const;

  constructor() {
    super('Not found.');
  }
}

const uuid = z.uuid();

/** Denials carry no detail; the log carries all of it. */
function deny(reason: string, context: Record<string, unknown>): never {
  log.info('authorization denied', { reason, ...context });
  throw new AuthorizationDenied();
}

/**
 * Proves `userId` holds an ACTIVE membership in an ACTIVE `companyId`.
 * Returns the membership; throws AuthorizationDenied otherwise.
 *
 * Inputs are untrusted by definition — a companyId from a cookie, URL, header
 * or body is attacker-writable. Shape is checked before the database is ever
 * consulted, and a database failure is a denial, not an exception a caller
 * might mistake for "try again and it may work".
 */
export async function requireCompanyMembership(
  userId: string,
  companyId: string,
): Promise<CompanyMembership> {
  if (!uuid.safeParse(userId).success || !uuid.safeParse(companyId).success) {
    deny('malformed identifier', { companyId: String(companyId).slice(0, 40) });
  }

  let rows: { membership: CompanyMembership }[];
  try {
    rows = await getDbTx()
      .select({ membership: schema.companyMemberships })
      .from(schema.companyMemberships)
      .innerJoin(
        schema.companies,
        eq(schema.companyMemberships.companyId, schema.companies.id),
      )
      .where(
        and(
          eq(schema.companyMemberships.userId, userId),
          eq(schema.companyMemberships.companyId, companyId),
          eq(schema.companyMemberships.status, 'ACTIVE'),
          eq(schema.companies.status, 'ACTIVE'),
        ),
      )
      .limit(1);
  } catch (error) {
    // Fail CLOSED: an unanswerable question is a "no", never a 500 that a
    // retry loop might eventually squeeze a "yes" out of.
    log.error('authorization query failed', { err: error });
    deny('authorization query failed', { companyId });
  }

  const membership = rows[0]?.membership;
  if (membership === undefined) {
    deny('no active membership', { companyId, userId });
  }
  return membership;
}

/**
 * requireCompanyMembership, then the capability check on the membership's
 * role. Same single denial shape for both failures — which one tripped is
 * visible only in the server log.
 */
export async function requirePermission(
  userId: string,
  companyId: string,
  capability: Capability,
): Promise<CompanyMembership> {
  const membership = await requireCompanyMembership(userId, companyId);

  if (!roleHasCapability(membership.role, capability)) {
    deny('missing capability', { companyId, userId, capability, role: membership.role });
  }
  return membership;
}
