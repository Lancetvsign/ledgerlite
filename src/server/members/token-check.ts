import 'server-only';

import { and, eq, gt, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';

import { hashToken, looksLikeToken } from './token';

/**
 * Is this secret a live invitation? Used by the sign-up gate (src/lib/auth) —
 * deliberately tiny, with no dependencies beyond the database, so the auth
 * layer stays free of application modules. Grants nothing: it only says whether
 * account creation may proceed; the membership is granted by `claimInvitation`.
 */
export async function isClaimableInvitationToken(token: string): Promise<boolean> {
  if (!looksLikeToken(token)) return false;
  const rows = await getDbTx()
    .select({ id: schema.companyInvitations.id })
    .from(schema.companyInvitations)
    .innerJoin(schema.companies, eq(schema.companyInvitations.companyId, schema.companies.id))
    .where(
      and(
        eq(schema.companyInvitations.tokenHash, hashToken(token)),
        eq(schema.companyInvitations.status, 'PENDING'),
        gt(schema.companyInvitations.expiresAt, sql`now()`),
        eq(schema.companies.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
