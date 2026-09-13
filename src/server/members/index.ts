import 'server-only';

import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { log } from '@/lib/logging';
import { recordAuditEvent } from '@/server/audit';
import { AuthorizationDenied, requireCompanyMembership, requirePermission } from '@/server/authorization';
import { errorChainText } from '@/server/companies';
import { lockActiveCompany } from '@/server/companies/internal';
import { roleCovers, type Role } from '@/server/rbac';

import { MemberError } from './errors';

import type { PoolDatabase } from '@/db';
import type { CompanyMembership } from '@/db/schema';
import type { InviteMemberInput } from '@/validation/member';

export { MemberError, type MemberErrorCode } from './errors';
export { claimPendingInvitations } from './claim';

type Tx = Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * Team membership — LL-086 / ADR-041.
 *
 * Every operation authorizes itself (`user.manage`, or plain membership for the
 * roster) and then applies the ROLE CEILING: an actor may grant, change or remove
 * only roles whose capability set is a subset of their own (`roleCovers`). No role
 * name appears here — the ceiling is derived from the grant matrix, so an ADMIN
 * cannot touch an OWNER because OWNER holds capabilities ADMIN lacks. A ceiling
 * failure is the uniform AuthorizationDenied, logged with its reason.
 *
 * The LAST-OWNER rule is the same idea from the other side: a change or removal is
 * refused when no OTHER active member would still cover the affected member's
 * current role (`LAST_OWNER`). For an OWNER that means another OWNER must remain;
 * for anyone else the company's OWNER always covers them, so it never fires.
 *
 * Memberships are never deleted (ADR-006): removal is status INACTIVE, and inviting
 * a removed person reactivates the same row with the new role.
 */

export interface MemberView {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: Date;
}

export type InviteResult =
  | { readonly mode: 'added'; readonly membershipId: string }
  | { readonly mode: 'invited'; readonly invitationId: string };

function requireCeiling(actor: CompanyMembership, target: Role): void {
  if (!roleCovers(actor.role, target)) {
    log.info('authorization denied', {
      reason: 'role ceiling',
      companyId: actor.companyId,
      userId: actor.userId,
      role: actor.role,
      target,
    });
    throw new AuthorizationDenied();
  }
}

/** The ACTIVE membership, locked; a foreign or unknown id is the same miss as any other. */
async function loadTargetLocked(tx: Tx, companyId: string, membershipId: string): Promise<CompanyMembership> {
  const rows = await tx
    .select()
    .from(schema.companyMemberships)
    .where(
      and(
        eq(schema.companyMemberships.id, membershipId),
        eq(schema.companyMemberships.companyId, companyId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
      ),
    )
    .for('update');
  const target = rows[0];
  if (target === undefined) throw new AuthorizationDenied();
  return target;
}

/** LAST_OWNER unless some other ACTIVE member still covers the target's current role. */
async function assertSomeoneElseCovers(tx: Tx, target: CompanyMembership): Promise<void> {
  const others = await tx
    .select({ role: schema.companyMemberships.role })
    .from(schema.companyMemberships)
    .where(
      and(
        eq(schema.companyMemberships.companyId, target.companyId),
        eq(schema.companyMemberships.status, 'ACTIVE'),
        ne(schema.companyMemberships.id, target.id),
      ),
    );
  if (!others.some((m) => roleCovers(m.role, target.role))) {
    throw new MemberError('LAST_OWNER', 'Nobody else would be able to administer the company.');
  }
}

/** The roster — any active member may see their own company's team. */
export async function listMembers(actorUserId: string, companyId: string): Promise<MemberView[]> {
  await requireCompanyMembership(actorUserId, companyId);
  const rows = await getDbTx()
    .select({
      membershipId: schema.companyMemberships.id,
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
      role: schema.companyMemberships.role,
    })
    .from(schema.companyMemberships)
    .innerJoin(schema.users, eq(schema.companyMemberships.userId, schema.users.id))
    .where(and(eq(schema.companyMemberships.companyId, companyId), eq(schema.companyMemberships.status, 'ACTIVE')))
    .orderBy(asc(schema.users.displayName), asc(schema.users.email));
  return rows;
}

/** Pending invitations — managers only. */
export async function listInvitations(actorUserId: string, companyId: string): Promise<InvitationView[]> {
  await requirePermission(actorUserId, companyId, 'user.manage');
  return await getDbTx()
    .select({
      id: schema.companyInvitations.id,
      email: schema.companyInvitations.email,
      role: schema.companyInvitations.role,
      createdAt: schema.companyInvitations.createdAt,
    })
    .from(schema.companyInvitations)
    .where(and(eq(schema.companyInvitations.companyId, companyId), eq(schema.companyInvitations.status, 'PENDING')))
    .orderBy(asc(schema.companyInvitations.createdAt));
}

/**
 * Adds a person by email. If the email already has a LedgerLite user, the
 * membership is created (or a removed one reactivated with the new role) at once;
 * otherwise a PENDING invitation is stored and claimed on that email's first entry.
 * Managers learn whether an email already has an account (the roster shows it a
 * moment later anyway) — accepted in ADR-041.
 */
export async function inviteMember(
  actorUserId: string,
  companyId: string,
  input: InviteMemberInput,
): Promise<InviteResult> {
  const actor = await requirePermission(actorUserId, companyId, 'user.manage');
  requireCeiling(actor, input.role);

  try {
    return await getDbTx().transaction(async (tx) => {
      await lockActiveCompany(tx, companyId);

      // Better Auth stores emails lower-cased and ensureAppUser copies them; lower()
      // here is belt and braces on the rare path (no index needed).
      const users = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${input.email}`)
        .limit(1);
      const user = users[0];

      if (user !== undefined) {
        const existing = await tx
          .select()
          .from(schema.companyMemberships)
          .where(and(eq(schema.companyMemberships.companyId, companyId), eq(schema.companyMemberships.userId, user.id)))
          .for('update');
        const current = existing[0];
        if (current?.status === 'ACTIVE') {
          throw new MemberError('ALREADY_MEMBER', 'That person is already a member of this company.');
        }

        let membership: CompanyMembership | undefined;
        if (current !== undefined) {
          const rows = await tx
            .update(schema.companyMemberships)
            .set({ status: 'ACTIVE', role: input.role, updatedAt: sql`now()` })
            .where(eq(schema.companyMemberships.id, current.id))
            .returning();
          membership = rows[0];
        } else {
          const rows = await tx
            .insert(schema.companyMemberships)
            .values({ companyId, userId: user.id, role: input.role })
            .returning();
          membership = rows[0];
        }
        if (membership === undefined) throw new Error('membership write returned no row');

        await recordAuditEvent({
          tx,
          companyId,
          actorUserId,
          action: 'MEMBER_ADDED',
          entityType: 'company_membership',
          entityId: membership.id,
          before: current === undefined ? undefined : { status: current.status, role: current.role },
          after: { userId: user.id, role: input.role, status: 'ACTIVE' },
        });
        return { mode: 'added', membershipId: membership.id };
      }

      const rows = await tx
        .insert(schema.companyInvitations)
        .values({ companyId, email: input.email, role: input.role, invitedBy: actorUserId })
        .returning();
      const invitation = rows[0];
      if (invitation === undefined) throw new Error('invitation insert returned no row');
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId,
        action: 'MEMBER_INVITED',
        entityType: 'company_invitation',
        entityId: invitation.id,
        after: { email: input.email, role: input.role },
      });
      return { mode: 'invited', invitationId: invitation.id };
    });
  } catch (error) {
    if (/company_invitations_pending_email_unique/.test(errorChainText(error))) {
      throw new MemberError('ALREADY_INVITED', 'That email already has a pending invitation.');
    }
    throw error;
  }
}

/** Changes a member's role — ceiling on both the current and the new role; last-owner rule on demotion. */
export async function changeMemberRole(
  actorUserId: string,
  companyId: string,
  membershipId: string,
  role: Role,
): Promise<CompanyMembership> {
  const actor = await requirePermission(actorUserId, companyId, 'user.manage');

  return await getDbTx().transaction(async (tx) => {
    await lockActiveCompany(tx, companyId);
    const target = await loadTargetLocked(tx, companyId, membershipId);
    requireCeiling(actor, target.role);
    requireCeiling(actor, role);
    if (target.role === role) return target;

    // A demotion is "the new role no longer covers the old one"; someone else must.
    if (!roleCovers(role, target.role)) await assertSomeoneElseCovers(tx, target);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'MEMBER_ROLE_CHANGED',
      entityType: 'company_membership',
      entityId: target.id,
      before: { role: target.role },
      after: { role },
    });
    const rows = await tx
      .update(schema.companyMemberships)
      .set({ role, updatedAt: sql`now()` })
      .where(eq(schema.companyMemberships.id, target.id))
      .returning();
    const updated = rows[0];
    if (updated === undefined) throw new Error('membership update returned no row');
    return updated;
  });
}

/** Removes (deactivates) a member — ceiling on their role; last-owner rule. Self-removal allowed. */
export async function removeMember(
  actorUserId: string,
  companyId: string,
  membershipId: string,
): Promise<{ membershipId: string; userId: string }> {
  const actor = await requirePermission(actorUserId, companyId, 'user.manage');

  return await getDbTx().transaction(async (tx) => {
    await lockActiveCompany(tx, companyId);
    const target = await loadTargetLocked(tx, companyId, membershipId);
    requireCeiling(actor, target.role);
    await assertSomeoneElseCovers(tx, target);

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'MEMBER_REMOVED',
      entityType: 'company_membership',
      entityId: target.id,
      before: { status: 'ACTIVE', role: target.role },
      after: { status: 'INACTIVE' },
    });
    await tx
      .update(schema.companyMemberships)
      .set({ status: 'INACTIVE', updatedAt: sql`now()` })
      .where(eq(schema.companyMemberships.id, target.id));
    return { membershipId: target.id, userId: target.userId };
  });
}

/** Revokes a PENDING invitation; a resolved, foreign or unknown id is the uniform miss. */
export async function revokeInvitation(actorUserId: string, companyId: string, invitationId: string): Promise<void> {
  await requirePermission(actorUserId, companyId, 'user.manage');

  await getDbTx().transaction(async (tx) => {
    await lockActiveCompany(tx, companyId);
    const rows = await tx
      .update(schema.companyInvitations)
      .set({ status: 'REVOKED', resolvedAt: sql`now()` })
      .where(
        and(
          eq(schema.companyInvitations.id, invitationId),
          eq(schema.companyInvitations.companyId, companyId),
          eq(schema.companyInvitations.status, 'PENDING'),
        ),
      )
      .returning();
    const revoked = rows[0];
    if (revoked === undefined) throw new AuthorizationDenied();
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVITATION_REVOKED',
      entityType: 'company_invitation',
      entityId: revoked.id,
      before: { status: 'PENDING' },
      after: { status: 'REVOKED' },
    });
  });
}
