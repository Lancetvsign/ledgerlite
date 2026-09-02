/**
 * Identity and tenancy against the real database — LL-011.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import {
  createCompanyWithOwner,
  hasActiveMembership,
  listCompaniesForUser,
  listMembersForCompany,
} from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

import type { AppUser } from '@/db/schema';

const COMPANY = createCompanyInput.parse({
  legalName: 'Synthetic Coffee LLC',
  timezone: 'America/Chicago',
});

/** Real auth identity first — users.auth_user_id has a real FK to satisfy. */
async function makeUser(email: string): Promise<AppUser> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  return await ensureAppUser({
    id: response.user.id,
    email: response.user.email,
    name: response.user.name,
  });
}


/**
 * Assert a statement is rejected AND for the right reason. Drizzle wraps the
 * Postgres error ("Failed query: …") with the constraint detail in `cause`, so
 * matching on the outer message would accept any failure — connection refused
 * included — as a passing test.
 */
async function expectDbRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    expect.unreachable('statement should have been rejected by the database');
  } catch (error) {
    const cause = (error as Error).cause;
    expect(String(cause ?? error)).toMatch(pattern);
  }
}

beforeEach(async () => {
  await truncateAll();
});

describe('application user provisioning', () => {
  it('creates the app user on first entry and is idempotent on re-entry', async () => {
    const first = await makeUser('owner@synthetic.test');
    const again = await ensureAppUser({
      id: first.authUserId,
      email: 'owner@synthetic.test',
      name: 'Renamed Later',
    });
    expect(again.id).toBe(first.id); // same row, not a duplicate
  });

  it('is race-safe: concurrent first entries resolve to one row', async () => {
    const { response } = await getAuth().api.signUpEmail({
      body: { email: 'racer@synthetic.test', password: 'synthetic-password-1', name: 'Racer' },
      returnHeaders: true,
    });
    const identity = { id: response.user.id, email: response.user.email, name: 'Racer' };
    const results = await Promise.all([
      ensureAppUser(identity),
      ensureAppUser(identity),
      ensureAppUser(identity),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });
});

describe('company creation with owner', () => {
  it('creates company and OWNER membership together', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company, membership } = await createCompanyWithOwner(owner.id, COMPANY);

    expect(company.legalName).toBe('Synthetic Coffee LLC');
    expect(membership.role).toBe('OWNER');
    expect(await hasActiveMembership(owner.id, company.id)).toBe(true);
  });

  it('never returns the protected ein column', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY);
    expect('ein' in company).toBe(false);
    const listed = await listCompaniesForUser(owner.id);
    expect(listed.some((entry) => 'ein' in entry.company)).toBe(false);
  });

  it('ROLLS BACK COMPLETELY when the owner membership cannot be created', async () => {
    // The atomicity requirement. A user id that satisfies the uuid type but no
    // FK forces the second insert in the transaction to fail; the company
    // insert that SUCCEEDED moments earlier must be gone afterwards.
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await expect(createCompanyWithOwner(ghost, COMPANY)).rejects.toThrow();

    const db = await getTestDb();
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from companies`,
    );
    expect(rows.rows[0]?.count).toBe('0'); // no ownerless company survives
  });
});

describe('database-held validation (bypassing the application)', () => {
  it.each([
    ['fiscal month 0', `insert into companies (legal_name, timezone, fiscal_year_start_month) values ('X','UTC',0)`],
    ['fiscal month 13', `insert into companies (legal_name, timezone, fiscal_year_start_month) values ('X','UTC',13)`],
    ['lowercase currency', `insert into companies (legal_name, timezone, currency_code) values ('X','UTC','usd')`],
    ['blank legal name', `insert into companies (legal_name, timezone) values ('   ','UTC')`],
  ])('the DATABASE rejects %s', async (_label, statement) => {
    const db = await getTestDb();
    await expectDbRejection(db.execute(sql.raw(statement)), /check constraint/i);
  });
});

describe('memberships', () => {
  it('supports one user in many companies, each visible with its role', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company: first } = await createCompanyWithOwner(owner.id, COMPANY);
    const { company: second } = await createCompanyWithOwner(
      owner.id,
      createCompanyInput.parse({ legalName: 'Second Venture Inc', timezone: 'America/New_York' }),
    );

    const companies = await listCompaniesForUser(owner.id);
    expect(companies.map((c) => c.company.id).sort()).toEqual([first.id, second.id].sort());
    expect(companies.every((c) => c.role === 'OWNER')).toBe(true);
  });

  it('lists the active members of a company', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY);
    const members = await listMembersForCompany(company.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.user.id).toBe(owner.id);
    expect(members[0]?.role).toBe('OWNER');
  });

  it('duplicate membership is rejected by the DATABASE constraint', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY);

    const db = await getTestDb();
    await expectDbRejection(
      db.execute(
        sql`insert into company_memberships (company_id, user_id, role)
            values (${company.id}, ${owner.id}, 'READ_ONLY')`,
      ),
      /duplicate key|unique/i,
    );
  });

  it('an inactive membership disappears from active queries', async () => {
    const owner = await makeUser('owner@synthetic.test');
    const { company } = await createCompanyWithOwner(owner.id, COMPANY);

    const db = await getTestDb();
    await db.execute(
      sql`update company_memberships set status = 'INACTIVE'
          where company_id = ${company.id} and user_id = ${owner.id}`,
    );

    expect(await hasActiveMembership(owner.id, company.id)).toBe(false);
    expect(await listCompaniesForUser(owner.id)).toHaveLength(0);
    expect(await listMembersForCompany(company.id)).toHaveLength(0);
  });

  it('carries the standing tenancy constraint UNIQUE (company_id, id)', async () => {
    // The pattern later composite FKs depend on. Asserted structurally, not
    // by convention: the constraint must exist in the catalog.
    const db = await getTestDb();
    const rows = await db.execute<{ conname: string }>(
      sql`select conname from pg_constraint
          where conrelid = 'company_memberships'::regclass and contype = 'u'`,
    );
    expect(rows.rows.map((r) => r.conname)).toContain(
      'company_memberships_company_id_id_unique',
    );
  });
});
