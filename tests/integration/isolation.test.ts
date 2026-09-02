/**
 * The permanent tenant-isolation suite — LL-014. Release-blocking, forever.
 *
 * User A belongs only to Company A; User B only to Company B. Everything B can
 * reach of A's must fail, correctly in kind. New tenant-owned tables MUST
 * register a descriptor — the completeness test at the bottom makes an
 * unregistered one a CI failure, not a review hope.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { requireCompanyMembership, requirePermission } from '@/server/authorization';
import { createCompanyWithOwner, listCompaniesForUser, listMembersForCompany } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { insertMembership } from '@/server/companies/internal';

import { getTestDb, truncateAll } from '../helpers/database';
import { attack, type IsolationContext, type IsolationDescriptor } from '../helpers/isolation';

import type { AppUser } from '@/db/schema';

/* ---------------------------------------------------------------------------
 * THE REGISTRY. A new company-scoped entity joins by adding a descriptor.
 * The completeness test below fails if a table with a company_id column has
 * no entry here.
 * ------------------------------------------------------------------------- */
const REGISTRY: IsolationDescriptor[] = [
  {
    table: 'companies',
    seed: (victim) => Promise.resolve({ recordId: victim.companyId }),
    attempts: [
      {
        operation: 'read by direct id',
        expect: 'denied',
        run: (attacker, victim) => requireCompanyMembership(attacker, victim.companyId),
      },
      {
        operation: 'manage (update path)',
        expect: 'denied',
        run: (attacker, victim) => requirePermission(attacker, victim.companyId, 'company.manage'),
      },
      {
        operation: 'deactivate (state transition path)',
        expect: 'denied',
        run: (attacker, victim) => requirePermission(attacker, victim.companyId, 'company.manage'),
      },
      {
        operation: 'list (self-scoped listing must not contain it)',
        expect: 'empty',
        run: async (attacker, victim) => {
          const mine = await listCompaniesForUser(attacker);
          return mine.filter((entry) => entry.company.id === victim.companyId);
        },
      },
    ],
  },
  {
    table: 'company_memberships',
    seed: async (victim) => {
      // A second, non-owner member makes the roster worth stealing.
      const keeper = await makeUser(`keeper-${victim.companyId.slice(0, 8)}@synthetic.test`);
      const membership = await insertMembership(victim.companyId, keeper.id, 'BOOKKEEPER');
      return { recordId: membership.id };
    },
    attempts: [
      {
        operation: 'list members (the authorized front door)',
        expect: 'denied',
        run: (attacker, victim) => listMembersForCompany(attacker, victim.companyId),
      },
      {
        operation: 'grant self a membership (write path)',
        expect: 'denied',
        run: async (attacker, victim) => {
          await requirePermission(attacker, victim.companyId, 'user.manage');
          return await insertMembership(victim.companyId, attacker, 'ADMIN');
        },
      },
      {
        operation: 'deactivate a membership (state transition)',
        expect: 'denied',
        run: (attacker, victim) => requirePermission(attacker, victim.companyId, 'user.manage'),
      },
    ],
  },
];

const COMPANY_A = createCompanyInput.parse({ legalName: 'Alpha LLC', timezone: 'America/Chicago' });
const COMPANY_B = createCompanyInput.parse({ legalName: 'Beta Inc', timezone: 'America/New_York' });

async function makeUser(email: string): Promise<AppUser> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  return await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
}

interface Fixture {
  readonly victim: IsolationContext;
  readonly attackerUserId: string;
}

async function buildFixture(): Promise<Fixture> {
  const userA = await makeUser('user-a@synthetic.test');
  const userB = await makeUser('user-b@synthetic.test');
  const { company: companyA } = await createCompanyWithOwner(userA.id, COMPANY_A);
  await createCompanyWithOwner(userB.id, COMPANY_B); // B has a legitimate home
  return { victim: { companyId: companyA.id, ownerUserId: userA.id }, attackerUserId: userB.id };
}

beforeEach(async () => {
  await truncateAll();
});

describe('tenant isolation — the registry, attacked', () => {
  it('every registered entity resists every registered attack, in the right way', async () => {
    const { victim, attackerUserId } = await buildFixture();

    const failures: string[] = [];
    for (const descriptor of REGISTRY) {
      const results = await attack(descriptor, attackerUserId, victim);
      for (const r of results) {
        if (!r.ok) failures.push(`${r.table} / ${r.operation}: ${r.detail}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('the OWNER of the victim company still passes — the harness attacks membership, not everyone', async () => {
    // Guards the harness itself: if requireCompanyMembership ever started
    // denying everyone, the suite above would go green for the wrong reason.
    const { victim } = await buildFixture();
    await expect(
      requireCompanyMembership(victim.ownerUserId, victim.companyId),
    ).resolves.toBeDefined();
  });
});

describe('tenant isolation — completeness is structural', () => {
  it('every table with a company_id column has a registered descriptor', async () => {
    const db = await getTestDb();
    const rows = await db.execute<{ table_name: string }>(
      sql`select distinct table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'company_id'`,
    );
    const tenantTables = rows.rows.map((r) => r.table_name).sort();
    const registered = REGISTRY.map((d) => d.table);
    // `companies` is the tenant ROOT (no company_id column) and registers anyway.
    const missing = tenantTables.filter((t) => !registered.includes(t));
    expect(
      missing,
      `Tenant-owned tables without an isolation descriptor: ${missing.join(', ')}. ` +
        'Register one in tests/integration/isolation.test.ts before merging.',
    ).toEqual([]);
  });

  it('the registry covers at least the tenant root plus every company_id table', () => {
    expect(REGISTRY.map((d) => d.table)).toContain('companies');
    expect(REGISTRY.length).toBeGreaterThanOrEqual(2);
  });
});

describe('scoped queries stay scoped even with no authorization in the way', () => {
  it('listCompaniesForUser is structurally self-scoped', async () => {
    const { victim, attackerUserId } = await buildFixture();
    const list = await listCompaniesForUser(attackerUserId);
    expect(list.some((entry) => entry.company.id === victim.companyId)).toBe(false);
    expect(list).toHaveLength(1); // their own Beta Inc, nothing else
  });
});
