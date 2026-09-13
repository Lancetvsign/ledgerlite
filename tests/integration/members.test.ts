/**
 * Team membership — LL-086 (ADR-041). Against a real DB. Proves: add-by-email for an
 * existing user, PENDING invitations for unknown emails and their claim on first entry
 * (mixed-case email, repeat entry, concurrent entries, archived company), reactivation,
 * the role ceiling (ADMIN cannot touch OWNER; denial identical to no membership), the
 * last-owner rule, revocation, audit rows, and the CHECK/unique constraints.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { AuthorizationDenied, requireCompanyMembership } from '@/server/authorization';
import { createCompanyWithOwner, deleteCompany, listCompaniesForUser } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import {
  changeMemberRole,
  claimPendingInvitations,
  inviteMember,
  listInvitations,
  listMembers,
  MemberError,
  removeMember,
  revokeInvitation,
} from '@/server/members';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';
import { inviteMemberInput } from '@/validation/member';

import { getTestDb, truncateAll } from '../helpers/database';

import type { AppUser } from '@/db/schema';

let seq = 0;
async function signUp(email: string): Promise<{ id: string; email: string; name: string }> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: `U${String(++seq)}` },
    returnHeaders: true,
  });
  return { id: response.user.id, email: response.user.email, name: response.user.name };
}
async function makeUser(email = `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`): Promise<AppUser> {
  return await ensureAppUser(await signUp(email));
}
async function makeCompany(owner: AppUser, legalName = 'Team Co'): Promise<string> {
  const { company } = await createCompanyWithOwner(owner.id, createCompanyInput.parse({ legalName, timezone: 'America/Chicago' }));
  return company.id;
}
const invite = (actor: AppUser, companyId: string, email: string, role = 'BOOKKEEPER') =>
  inviteMember(actor.id, companyId, inviteMemberInput.parse({ email, role }));

async function denialOf(promise: Promise<unknown>): Promise<AuthorizationDenied> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationDenied);
    return error as AuthorizationDenied;
  }
  expect.unreachable('expected denial, got access');
}
async function errOf(promise: Promise<unknown>): Promise<MemberError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemberError);
    return error as MemberError;
  }
  expect.unreachable('expected MemberError');
}
async function expectDbRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    expect.unreachable('statement should have been rejected by the database');
  } catch (error) {
    expect(String((error as Error).cause ?? error)).toMatch(pattern);
  }
}
async function audits(companyId: string): Promise<{ action: string; actor: string; entity: string }[]> {
  const db = await getTestDb();
  const r = await db.execute<{ action: string; actor: string; entity: string }>(
    sql`select action, actor_user_id::text as actor, entity_id as entity from audit_events where company_id = ${companyId} order by created_at, action`,
  );
  return r.rows;
}
async function invitationRow(id: string): Promise<{ status: string; accepted: string | null; resolved: string | null }> {
  const db = await getTestDb();
  const r = await db.execute<{ status: string; accepted: string | null; resolved: string | null }>(
    sql`select status, accepted_user_id::text as accepted, resolved_at::text as resolved from company_invitations where id = ${id}`,
  );
  return r.rows[0]!;
}

beforeEach(async () => {
  await truncateAll();
});

describe('inviteMember', () => {
  it('adds an existing user at once, audited with the manager as actor; ALREADY_MEMBER on repeat', async () => {
    const owner = await makeUser();
    const keeper = await makeUser('keeper@synthetic.test');
    const companyId = await makeCompany(owner);

    const r = await invite(owner, companyId, 'Keeper@Synthetic.test', 'BOOKKEEPER');
    expect(r.mode).toBe('added');
    const roster = (await listMembers(keeper.id, companyId)).map((m) => `${m.email}:${m.role}`).sort();
    expect(roster).toEqual([`${keeper.email}:BOOKKEEPER`, `${owner.email}:OWNER`].sort());
    expect((await audits(companyId)).filter((a) => a.action === 'MEMBER_ADDED')).toEqual([
      { action: 'MEMBER_ADDED', actor: owner.id, entity: r.mode === 'added' ? r.membershipId : '' },
    ]);
    expect((await errOf(invite(owner, companyId, keeper.email))).code).toBe('ALREADY_MEMBER');
  });

  it('stores a PENDING invitation for an unknown email; ALREADY_INVITED on repeat; revoke then re-invite', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);

    const r = await invite(owner, companyId, '  Ghost@Synthetic.TEST ', 'ACCOUNTANT');
    expect(r.mode).toBe('invited');
    const id = r.mode === 'invited' ? r.invitationId : '';
    expect((await listInvitations(owner.id, companyId)).map((i) => [i.email, i.role])).toEqual([['ghost@synthetic.test', 'ACCOUNTANT']]);
    expect((await errOf(invite(owner, companyId, 'ghost@synthetic.test'))).code).toBe('ALREADY_INVITED');

    await revokeInvitation(owner.id, companyId, id);
    const row = await invitationRow(id);
    expect(row.status).toBe('REVOKED');
    expect(row.resolved).not.toBeNull();
    expect(await listInvitations(owner.id, companyId)).toEqual([]);
    await denialOf(revokeInvitation(owner.id, companyId, id)); // already resolved → the uniform miss
    expect((await invite(owner, companyId, 'ghost@synthetic.test')).mode).toBe('invited');
    expect((await audits(companyId)).map((a) => a.action)).toEqual(['MEMBER_INVITED', 'INVITATION_REVOKED', 'MEMBER_INVITED']);
  });
});

describe('claim on first entry', () => {
  it('a mixed-case sign-up claims the invitation: ACTIVE membership, ACCEPTED row, inviter as audit actor; later entries claim nothing', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);
    const r = await invite(owner, companyId, 'newbie@synthetic.test', 'ACCOUNTANT');
    const invitationId = r.mode === 'invited' ? r.invitationId : '';

    const auth = await signUp('Newbie@Synthetic.Test');
    const newbie = await ensureAppUser(auth); // first entry
    expect((await requireCompanyMembership(newbie.id, companyId)).role).toBe('ACCOUNTANT');
    expect((await listCompaniesForUser(newbie.id)).map((c) => c.company.id)).toEqual([companyId]);
    const row = await invitationRow(invitationId);
    expect(row).toMatchObject({ status: 'ACCEPTED', accepted: newbie.id });
    expect(row.resolved).not.toBeNull();
    const added = (await audits(companyId)).filter((a) => a.action === 'MEMBER_ADDED');
    expect(added).toHaveLength(1);
    expect(added[0]!.actor).toBe(owner.id);

    expect(await claimPendingInvitations(newbie)).toBe(0);
    await ensureAppUser(auth);
    expect((await audits(companyId)).filter((a) => a.action === 'MEMBER_ADDED')).toHaveLength(1);
  });

  it('three concurrent first entries yield exactly one membership and one audit row', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);
    await invite(owner, companyId, 'racer@synthetic.test');
    const auth = await signUp('racer@synthetic.test');
    await Promise.all([ensureAppUser(auth), ensureAppUser(auth), ensureAppUser(auth)]);

    const db = await getTestDb();
    const m = await db.execute<{ n: string }>(sql`select count(*)::text as n from company_memberships where company_id = ${companyId}`);
    expect(Number(m.rows[0]!.n)).toBe(2); // owner + racer
    expect((await audits(companyId)).filter((a) => a.action === 'MEMBER_ADDED')).toHaveLength(1);
  });

  it('an invitation to an archived company stays PENDING and grants nothing', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner, 'Gone Co');
    const r = await invite(owner, companyId, 'late@synthetic.test');
    const invitationId = r.mode === 'invited' ? r.invitationId : '';
    await expect(deleteCompany(owner.id, companyId, { confirmLegalName: 'Gone Co' })).resolves.toEqual({ mode: 'archived' });

    const late = await ensureAppUser(await signUp('late@synthetic.test'));
    expect((await invitationRow(invitationId)).status).toBe('PENDING');
    expect(await listCompaniesForUser(late.id)).toEqual([]);
  });
});

describe('reactivation', () => {
  it('inviting a removed person reactivates the same membership with the new role', async () => {
    const owner = await makeUser();
    const keeper = await makeUser('back@synthetic.test');
    const companyId = await makeCompany(owner);
    const first = await invite(owner, companyId, keeper.email, 'BOOKKEEPER');
    const membershipId = first.mode === 'added' ? first.membershipId : '';
    await removeMember(owner.id, companyId, membershipId);
    await denialOf(requireCompanyMembership(keeper.id, companyId));

    const again = await invite(owner, companyId, keeper.email, 'ACCOUNTANT');
    expect(again).toEqual({ mode: 'added', membershipId });
    expect((await requireCompanyMembership(keeper.id, companyId)).role).toBe('ACCOUNTANT');
    expect((await audits(companyId)).map((a) => a.action)).toEqual(['MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_ADDED']);
  });
});

describe('the role ceiling', () => {
  it('an ADMIN cannot grant OWNER, promote to OWNER, change or remove an OWNER — each denial identical to no membership', async () => {
    const owner = await makeUser();
    const admin = await makeUser('admin@synthetic.test');
    const keeper = await makeUser('kp@synthetic.test');
    const stranger = await makeUser('stranger@synthetic.test');
    const companyId = await makeCompany(owner);
    await insertMembership(companyId, admin.id, 'ADMIN');
    const k = await invite(owner, companyId, keeper.email, 'BOOKKEEPER');
    const keeperMembership = k.mode === 'added' ? k.membershipId : '';
    const ownerMembership = (await listMembers(owner.id, companyId)).find((m) => m.userId === owner.id)!.membershipId;

    const baseline = await denialOf(listInvitations(stranger.id, companyId));
    for (const attempt of [
      () => invite(admin, companyId, 'x@synthetic.test', 'OWNER'),
      () => changeMemberRole(admin.id, companyId, keeperMembership, 'OWNER'),
      () => changeMemberRole(admin.id, companyId, ownerMembership, 'ADMIN'),
      () => removeMember(admin.id, companyId, ownerMembership),
    ]) {
      const d = await denialOf(attempt());
      expect({ name: d.name, code: d.code, message: d.message }).toEqual({ name: baseline.name, code: baseline.code, message: baseline.message });
    }
    // Within the ceiling the ADMIN is a full manager.
    await changeMemberRole(admin.id, companyId, keeperMembership, 'ACCOUNTANT');
    expect((await invite(admin, companyId, 'y@synthetic.test', 'ADMIN')).mode).toBe('invited');
    // The OWNER may do everything the ADMIN could not.
    await changeMemberRole(owner.id, companyId, keeperMembership, 'OWNER');
    expect((await requireCompanyMembership(keeper.id, companyId)).role).toBe('OWNER');
  });

  it('BOOKKEEPER sees the roster and nothing else', async () => {
    const owner = await makeUser();
    const keeper = await makeUser('bk@synthetic.test');
    const companyId = await makeCompany(owner);
    const k = await invite(owner, companyId, keeper.email, 'BOOKKEEPER');
    const membershipId = k.mode === 'added' ? k.membershipId : '';
    expect((await listMembers(keeper.id, companyId)).length).toBe(2);
    await denialOf(listInvitations(keeper.id, companyId));
    await denialOf(invite(keeper, companyId, 'z@synthetic.test', 'READ_ONLY'));
    await denialOf(changeMemberRole(keeper.id, companyId, membershipId, 'READ_ONLY'));
    await denialOf(removeMember(keeper.id, companyId, membershipId));
    await denialOf(revokeInvitation(keeper.id, companyId, membershipId));
  });
});

describe('the last-owner rule', () => {
  it('the sole OWNER cannot demote or remove themselves; after a second OWNER exists they can', async () => {
    const owner = await makeUser();
    const other = await makeUser('other@synthetic.test');
    const companyId = await makeCompany(owner);
    const ownerMembership = (await listMembers(owner.id, companyId))[0]!.membershipId;
    expect((await errOf(changeMemberRole(owner.id, companyId, ownerMembership, 'ADMIN'))).code).toBe('LAST_OWNER');
    expect((await errOf(removeMember(owner.id, companyId, ownerMembership))).code).toBe('LAST_OWNER');
    expect((await requireCompanyMembership(owner.id, companyId)).role).toBe('OWNER');

    await invite(owner, companyId, other.email, 'OWNER');
    await changeMemberRole(owner.id, companyId, ownerMembership, 'ADMIN'); // demotion now allowed
    await changeMemberRole(other.id, companyId, ownerMembership, 'OWNER'); // and back
    const left = await removeMember(owner.id, companyId, ownerMembership); // self-removal
    expect(left.userId).toBe(owner.id);
    await denialOf(requireCompanyMembership(owner.id, companyId));
  });

  it('never fires for non-owners, and a no-op role change writes no audit row', async () => {
    const owner = await makeUser();
    const keeper = await makeUser('nk@synthetic.test');
    const companyId = await makeCompany(owner);
    const k = await invite(owner, companyId, keeper.email, 'ADMIN');
    const membershipId = k.mode === 'added' ? k.membershipId : '';
    const before = (await audits(companyId)).length;
    await changeMemberRole(owner.id, companyId, membershipId, 'ADMIN');
    expect((await audits(companyId)).length).toBe(before);
    await changeMemberRole(owner.id, companyId, membershipId, 'READ_ONLY');
    await removeMember(owner.id, companyId, membershipId);
    expect((await audits(companyId)).map((a) => a.action)).toEqual(['MEMBER_ADDED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED']);
  });
});

describe('the database backstops', () => {
  it('rejects a non-normalised email, an unstamped acceptance, an unstamped resolution and a duplicate pending invitation', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);
    const db = await getTestDb();
    const ins = (email: string, extra = sql``) =>
      db.execute(sql`insert into company_invitations (company_id, email, role, invited_by ${extra}) values (${companyId}, ${email}, 'READ_ONLY', ${owner.id})`);
    await expectDbRejection(ins('Mixed@Case.test'), /company_invitations_email_lowercase/);
    await expectDbRejection(
      db.execute(sql`insert into company_invitations (company_id, email, role, invited_by, status) values (${companyId}, 'a@b.test', 'READ_ONLY', ${owner.id}, 'ACCEPTED')`),
      /company_invitations_(accepted|resolved)_stamp/,
    );
    await expectDbRejection(
      db.execute(sql`insert into company_invitations (company_id, email, role, invited_by, status, resolved_at) values (${companyId}, 'a@b.test', 'READ_ONLY', ${owner.id}, 'ACCEPTED', now())`),
      /company_invitations_accepted_stamp/,
    );
    await ins('dup@b.test');
    await expectDbRejection(ins('dup@b.test'), /company_invitations_pending_email_unique/);
  });
});
