/**
 * The company authorization layer — LL-013. Every case the ticket names, plus
 * the property that makes the denials safe: they are indistinguishable.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import {
  AuthorizationDenied,
  requireCompanyMembership,
  requirePermission,
} from '@/server/authorization';
import { createCompanyWithOwner, listCompaniesForUser } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { insertMembership } from '@/server/companies/internal';

import { truncateAll } from '../helpers/database';

import type { AppUser } from '@/db/schema';

const COMPANY_A = createCompanyInput.parse({ legalName: 'Alpha LLC', timezone: 'America/Chicago' });
const COMPANY_B = createCompanyInput.parse({ legalName: 'Beta Inc', timezone: 'America/New_York' });
const GHOST_COMPANY = '00000000-0000-4000-8000-00000000dead';

async function makeUser(email: string): Promise<AppUser> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  return await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
}

/** Capture a denial for shape comparison; fail the test if access was granted. */
async function denialOf(promise: Promise<unknown>): Promise<AuthorizationDenied> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthorizationDenied);
    return error as AuthorizationDenied;
  }
  expect.unreachable('expected denial, got access');
}

beforeEach(async () => {
  await truncateAll();
});

describe('requireCompanyMembership', () => {
  it('admits a valid owner', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY_A);
    const membership = await requireCompanyMembership(owner.id, company.id);
    expect(membership.role).toBe('OWNER');
  });

  it('admits a valid bookkeeper', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const keeper = await makeUser('keeper@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY_A);
    await insertMembership(company.id, keeper.id, 'BOOKKEEPER');
    const membership = await requireCompanyMembership(keeper.id, company.id);
    expect(membership.role).toBe('BOOKKEEPER');
  });

  it('denies a user with no membership', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const outsider = await makeUser('outsider@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY_A);
    await denialOf(requireCompanyMembership(outsider.id, company.id));
  });

  it('denies an INACTIVE membership', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const keeper = await makeUser('keeper@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY_A);
    await insertMembership(company.id, keeper.id, 'BOOKKEEPER');
    const { getTestDb } = await import('../helpers/database');
    const { sql } = await import('drizzle-orm');
    const db = await getTestDb();
    await db.execute(
      sql`update company_memberships set status='INACTIVE' where user_id=${keeper.id}`,
    );
    await denialOf(requireCompanyMembership(keeper.id, company.id));
  });

  it('denies the user of Company A a Company B id, identically to a nonexistent id', async () => {
    const userA = await makeUser('a@synthetic.test');
    const userB = await makeUser('b@synthetic.test');
    await createCompanyWithOwner(userA.id, COMPANY_A);
    const { company: companyB } = await createCompanyWithOwner(userB.id, COMPANY_B);

    const crossTenant = await denialOf(requireCompanyMembership(userA.id, companyB.id));
    const nonexistent = await denialOf(requireCompanyMembership(userA.id, GHOST_COMPANY));

    // THE existence-leak property: real-but-forbidden and not-real produce
    // byte-identical public shapes. Only the server log knows which was which.
    expect({ code: crossTenant.code, message: crossTenant.message, name: crossTenant.name })
      .toEqual({ code: nonexistent.code, message: nonexistent.message, name: nonexistent.name });
  });

  it('fails closed on malformed identifiers without touching the database', async () => {
    const owner = await makeUser('owner@synthetic.test');
    await denialOf(requireCompanyMembership(owner.id, "'; drop table companies; --"));
    await denialOf(requireCompanyMembership('not-a-uuid', GHOST_COMPANY));
  });

  it('handles zero companies and many companies', async () => {
    const nobody = await makeUser('nobody@synthetic.test');
    expect(await listCompaniesForUser(nobody.id)).toHaveLength(0);
    await denialOf(requireCompanyMembership(nobody.id, GHOST_COMPANY));

    const mogul = await makeUser('mogul@synthetic.test');
    const { company: first } = await createCompanyWithOwner(mogul.id, COMPANY_A);
    const { company: second } = await createCompanyWithOwner(mogul.id, COMPANY_B);
    expect((await requireCompanyMembership(mogul.id, first.id)).companyId).toBe(first.id);
    expect((await requireCompanyMembership(mogul.id, second.id)).companyId).toBe(second.id);
  });
});

describe('requirePermission', () => {
  it('admits capability the role holds and denies one it lacks — same denial shape', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const keeper = await makeUser('keeper@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY_A);
    await insertMembership(company.id, keeper.id, 'BOOKKEEPER');

    await expect(requirePermission(keeper.id, company.id, 'invoice.create')).resolves.toBeDefined();
    await expect(requirePermission(owner.id, company.id, 'journal.post')).resolves.toBeDefined();

    const wrongCapability = await denialOf(requirePermission(keeper.id, company.id, 'journal.post'));
    const noMembership = await denialOf(requirePermission(keeper.id, GHOST_COMPANY, 'journal.post'));
    expect(wrongCapability.message).toBe(noMembership.message);
    expect(wrongCapability.code).toBe(noMembership.code);
  });

  it('OWNER of Company A is nobody in Company B — the role does not travel', async () => {
    const userA = await makeUser('a@synthetic.test');
    const userB = await makeUser('b@synthetic.test');
    await createCompanyWithOwner(userA.id, COMPANY_A);
    const { company: companyB } = await createCompanyWithOwner(userB.id, COMPANY_B);
    await denialOf(requirePermission(userA.id, companyB.id, 'report.view'));
  });
});

describe('forged company context', () => {
  it('a forged companyId in any transport is just an id that fails membership', async () => {
    // Body, cookie, URL, header — by the time authorization sees it, a claimed
    // company is a string. Every string that is not a proven ACTIVE membership
    // denies; there is nothing transport-specific to bypass.
    const userA = await makeUser('a@synthetic.test');
    const userB = await makeUser('b@synthetic.test');
    await createCompanyWithOwner(userA.id, COMPANY_A);
    const { company: companyB } = await createCompanyWithOwner(userB.id, COMPANY_B);

    for (const forged of [companyB.id, GHOST_COMPANY, '', '../../etc', companyB.id.toUpperCase()]) {
      await denialOf(requireCompanyMembership(userA.id, forged));
    }
  });
});
