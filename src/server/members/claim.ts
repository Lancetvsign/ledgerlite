import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { recordAuditEvent } from '@/server/audit';

/**
 * Turns PENDING invitations for this email into memberships — LL-086 / ADR-041.
 *
 * Called by `ensureAppUser` on EVERY authenticated entry, not only the first: an
 * invitation created after the invitee's first sign-in but before their next request
 * must still land, and the alternative ("only when the user row was just inserted")
 * leaves a race in which neither side sees the other. The cost is one SELECT on the
 * partial index `(email) WHERE status = 'PENDING'`; a transaction runs only when
 * something is pending.
 *
 * No authorization call: this is not actor-driven. The invitation row IS the
 * authorization — it was created under `user.manage` by the inviter, who is therefore
 * the audit actor of record. Concurrency: the conditional UPDATE to ACCEPTED admits
 * one winner per invitation; the membership insert is idempotent on (company, user).
 * Invitations to an archived company stay PENDING and harmless.
 */
export async function claimPendingInvitations(appUser: {
  readonly id: string;
  readonly email: string;
}): Promise<number> {
  const email = appUser.email.trim().toLowerCase();
  const db = getDbTx();
  const pending = await db
    .select({ invitation: schema.companyInvitations })
    .from(schema.companyInvitations)
    .innerJoin(schema.companies, eq(schema.companyInvitations.companyId, schema.companies.id))
    .where(
      and(
        eq(schema.companyInvitations.email, email),
        eq(schema.companyInvitations.status, 'PENDING'),
        eq(schema.companies.status, 'ACTIVE'),
      ),
    );
  if (pending.length === 0) return 0;

  return await db.transaction(async (tx) => {
    let claimed = 0;
    for (const { invitation } of pending) {
      const won = await tx
        .update(schema.companyInvitations)
        .set({ status: 'ACCEPTED', acceptedUserId: appUser.id, resolvedAt: sql`now()` })
        .where(and(eq(schema.companyInvitations.id, invitation.id), eq(schema.companyInvitations.status, 'PENDING')))
        .returning({ id: schema.companyInvitations.id });
      if (won.length === 0) continue; // a concurrent entry claimed it first

      const rows = await tx
        .insert(schema.companyMemberships)
        .values({ companyId: invitation.companyId, userId: appUser.id, role: invitation.role })
        .onConflictDoUpdate({
          target: [schema.companyMemberships.companyId, schema.companyMemberships.userId],
          set: { status: 'ACTIVE', role: invitation.role, updatedAt: sql`now()` },
        })
        .returning();
      const membership = rows[0];
      if (membership === undefined) throw new Error('membership upsert returned no row');

      await recordAuditEvent({
        tx,
        companyId: invitation.companyId,
        actorUserId: invitation.invitedBy,
        action: 'MEMBER_ADDED',
        entityType: 'company_membership',
        entityId: membership.id,
        after: { userId: appUser.id, role: invitation.role, status: 'ACTIVE', via: 'invitation', invitationId: invitation.id },
      });
      claimed += 1;
    }
    return claimed;
  });
}
