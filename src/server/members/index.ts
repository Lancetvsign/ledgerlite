import 'server-only';

import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';

import { getDbTx, schema } from '@/db';
import { log } from '@/lib/logging';
import { recordAuditEvent } from '@/server/audit';
import { AuthorizationDenied, requireCompanyMembership, requirePermission } from '@/server/authorization';
import { errorChainText } from '@/server/companies';
import { lockActiveCompany } from '@/server/companies/internal';
import { roleCovers, type Role } from '@/server/rbac';

import { MemberError } from './errors';
import { hashToken, INVITATION_TTL_MS, looksLikeToken, newToken } from './token';

import type { PoolDatabase } from '@/db';
import type { CompanyMembership } from '@/db/schema';
import type { InviteMemberInput } from '@/validation/member';

export { MemberError, type MemberErrorCode } from './errors';

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
  /** False only for rows created before LL-090 — they can never be claimed; revoke and re-invite. */
  readonly hasLink: boolean;
  readonly expiresAt: Date | null;
}

export type InviteResult =
  | { readonly mode: 'added'; readonly membershipId: string }
  /** `token` is the one-time secret for the join link; it exists only in memory here. */
  | { readonly mode: 'invited'; readonly invitationId: string; readonly token: string };

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
  const rows = await getDbTx()
    .select({
      id: schema.companyInvitations.id,
      email: schema.companyInvitations.email,
      role: schema.companyInvitations.role,
      createdAt: schema.companyInvitations.createdAt,
      tokenHash: schema.companyInvitations.tokenHash,
      expiresAt: schema.companyInvitations.expiresAt,
    })
    .from(schema.companyInvitations)
    .where(and(eq(schema.companyInvitations.companyId, companyId), eq(schema.companyInvitations.status, 'PENDING')))
    .orderBy(asc(schema.companyInvitations.createdAt));
  return rows.map(({ tokenHash, ...r }) => ({ ...r, hasLink: tokenHash !== null }));
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
        // A pending invitation for this email is superseded by the direct add: resolve
        // it now so it can never later rewrite the role we grant here (Gate 6 M3).
        await tx
          .update(schema.companyInvitations)
          .set({ status: 'REVOKED', resolvedAt: sql`now()` })
          .where(
            and(
              eq(schema.companyInvitations.companyId, companyId),
              eq(schema.companyInvitations.email, input.email),
              eq(schema.companyInvitations.status, 'PENDING'),
            ),
          );

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

      const token = newToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      const rows = await tx
        .insert(schema.companyInvitations)
        .values({ companyId, email: input.email, role: input.role, invitedBy: actorUserId, tokenHash: hashToken(token), expiresAt })
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
        after: { email: input.email, role: input.role, expiresAt: expiresAt.toISOString() },
      });
      return { mode: 'invited', invitationId: invitation.id, token };
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

/**
 * Issues a fresh join link for a PENDING invitation — AUTHORIZED (user.manage).
 * Each issue replaces the secret, so an older link stops working (said on screen).
 * Returns the secret once; only its hash is stored.
 */
export async function issueInvitationLink(
  actorUserId: string,
  companyId: string,
  invitationId: string,
): Promise<{ token: string; expiresAt: Date }> {
  await requirePermission(actorUserId, companyId, 'user.manage');
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  await getDbTx().transaction(async (tx) => {
    await lockActiveCompany(tx, companyId);
    const rows = await tx
      .update(schema.companyInvitations)
      .set({ tokenHash: hashToken(token), expiresAt })
      .where(
        and(
          eq(schema.companyInvitations.id, invitationId),
          eq(schema.companyInvitations.companyId, companyId),
          eq(schema.companyInvitations.status, 'PENDING'),
        ),
      )
      .returning({ id: schema.companyInvitations.id });
    if (rows[0] === undefined) throw new AuthorizationDenied();
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId,
      action: 'INVITATION_LINK_ISSUED',
      entityType: 'company_invitation',
      entityId: invitationId,
      after: { expiresAt: expiresAt.toISOString() },
    });
  });
  return { token, expiresAt };
}

export interface InvitationDescription {
  readonly companyName: string;
  readonly role: Role;
  readonly email: string;
}

/**
 * What a join link points at — for the /join page, UNAUTHENTICATED by design: the
 * secret itself is the credential. Reveals the company's legal name and the invited
 * role only to a holder of a live link; anything else is null.
 */
export async function describeInvitation(token: string): Promise<InvitationDescription | null> {
  if (!looksLikeToken(token)) return null;
  const rows = await getDbTx()
    .select({
      companyName: schema.companies.legalName,
      role: schema.companyInvitations.role,
      email: schema.companyInvitations.email,
    })
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
  return rows[0] ?? null;
}

export interface ClaimResult {
  readonly companyId: string;
  readonly membershipId: string;
  readonly role: Role;
  /** True when the claimant already held an ACTIVE membership: nothing changed, the link is spent. */
  readonly alreadyMember: boolean;
}

/**
 * Turns a live join link into a membership for the signed-in user — LL-090.
 *
 * The secret is the authorization (created under user.manage by the inviter); the
 * invitation's email is a label and is NOT compared. An ACTIVE membership is never
 * rewritten (Gate 6 M3): the link is spent and the member keeps their role. A removed
 * (INACTIVE) member is reactivated with the invited role. Lock order: company row,
 * then the invitation row — the same order issueInvitationLink uses.
 */
export async function claimInvitation(appUserId: string, token: string): Promise<ClaimResult> {
  const invalid = () => new MemberError('INVITATION_INVALID', 'This invitation link is not valid or has expired.');
  if (!looksLikeToken(token)) throw invalid();
  const tokenHash = hashToken(token);

  const peek = await getDbTx()
    .select({ companyId: schema.companyInvitations.companyId })
    .from(schema.companyInvitations)
    .where(eq(schema.companyInvitations.tokenHash, tokenHash))
    .limit(1);
  const companyId = peek[0]?.companyId;
  if (companyId === undefined) throw invalid();

  return await getDbTx().transaction(async (tx) => {
    try {
      await lockActiveCompany(tx, companyId);
    } catch (error) {
      if (error instanceof AuthorizationDenied) throw invalid(); // archived meanwhile
      throw error;
    }
    const invRows = await tx
      .select()
      .from(schema.companyInvitations)
      .where(and(eq(schema.companyInvitations.tokenHash, tokenHash), eq(schema.companyInvitations.companyId, companyId)))
      .for('update');
    const invitation = invRows[0];
    if (
      invitation === undefined ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt === null ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw invalid();
    }

    const existing = await tx
      .select()
      .from(schema.companyMemberships)
      .where(and(eq(schema.companyMemberships.companyId, companyId), eq(schema.companyMemberships.userId, appUserId)))
      .for('update');
    const current = existing[0];

    const spend = () =>
      tx
        .update(schema.companyInvitations)
        .set({ status: 'ACCEPTED', acceptedUserId: appUserId, resolvedAt: sql`now()` })
        .where(eq(schema.companyInvitations.id, invitation.id));

    if (current?.status === 'ACTIVE') {
      await spend();
      await recordAuditEvent({
        tx,
        companyId,
        actorUserId: appUserId,
        action: 'INVITATION_CLAIMED',
        entityType: 'company_invitation',
        entityId: invitation.id,
        after: { membershipId: current.id, role: current.role, alreadyMember: true },
      });
      return { companyId, membershipId: current.id, role: current.role, alreadyMember: true };
    }

    let membership: CompanyMembership | undefined;
    if (current !== undefined) {
      const rows = await tx
        .update(schema.companyMemberships)
        .set({ status: 'ACTIVE', role: invitation.role, updatedAt: sql`now()` })
        .where(eq(schema.companyMemberships.id, current.id))
        .returning();
      membership = rows[0];
    } else {
      const rows = await tx
        .insert(schema.companyMemberships)
        .values({ companyId, userId: appUserId, role: invitation.role })
        .returning();
      membership = rows[0];
    }
    if (membership === undefined) throw new Error('membership write returned no row');
    await spend();

    await recordAuditEvent({
      tx,
      companyId,
      actorUserId: appUserId,
      action: 'INVITATION_CLAIMED',
      entityType: 'company_invitation',
      entityId: invitation.id,
      after: { membershipId: membership.id, role: invitation.role },
    });
    await recordAuditEvent({
      tx,
      companyId,
      actorUserId: invitation.invitedBy,
      action: 'MEMBER_ADDED',
      entityType: 'company_membership',
      entityId: membership.id,
      before: current === undefined ? undefined : { status: current.status, role: current.role },
      after: { userId: appUserId, role: invitation.role, status: 'ACTIVE', via: 'invitation', invitationId: invitation.id },
    });
    return { companyId, membershipId: membership.id, role: invitation.role, alreadyMember: false };
  });
}
