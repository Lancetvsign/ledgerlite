import 'server-only';

import { eq, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';

import type { AppUser } from '@/db/schema';

/**
 * Application-user provisioning — the controlled workflow that links a Better
 * Auth identity to a LedgerLite user the first time it enters the system.
 *
 * Idempotent and race-safe: two concurrent first requests resolve to one row
 * via ON CONFLICT on the unique auth_user_id, not check-then-insert (which has
 * a window between the check and the insert).
 *
 * Grants nothing. A LedgerLite user with no memberships can access no company.
 */
export async function ensureAppUser(authUser: {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}): Promise<AppUser> {
  const rows = await getDbTx()
    .insert(schema.users)
    .values({
      authUserId: authUser.id,
      email: authUser.email,
      displayName: authUser.name === '' ? authUser.email : authUser.name,
    })
    .onConflictDoUpdate({
      target: schema.users.authUserId,
      // The auth table owns identity truth; our display copy follows it.
      set: {
        email: authUser.email,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) throw new Error('ensureAppUser returned no row');
  return row;
}

export async function getAppUserByAuthId(authUserId: string): Promise<AppUser | undefined> {
  const rows = await getDbTx()
    .select()
    .from(schema.users)
    .where(eq(schema.users.authUserId, authUserId))
    .limit(1);
  return rows[0];
}
