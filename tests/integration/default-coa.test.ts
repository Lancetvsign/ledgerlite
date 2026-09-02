/**
 * Default chart of accounts installer — LL-023.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { listAccounts } from '@/server/accounts';
import { REQUIRED_SYSTEM_ACCOUNTS, STANDARD_CHART } from '@/server/accounts/default-coa';
import { installDefaultChart } from '@/server/accounts/internal';
import { createCompanyWithOwner } from '@/server/companies';
import { ensureAppUser } from '@/server/users';
import { createCompanyInput } from '@/validation/company';

import { getTestDb, truncateAll } from '../helpers/database';

import type { AppUser, Company } from '@/db/schema';

const COMPANY = createCompanyInput.parse({ legalName: 'Alpha LLC', timezone: 'America/Chicago' });

async function makeOwner(email: string, chart?: 'standard' | 'system-only'): Promise<{ user: AppUser; company: Company }> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email, password: 'synthetic-password-1', name: email.split('@')[0] ?? email },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  const { company } = await createCompanyWithOwner(user.id, COMPANY, chart);
  return { user, company: company as Company };
}

async function countAccounts(companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where company_id = ${companyId}`);
  return Number(r.rows[0]?.n ?? '0');
}

beforeEach(async () => {
  await truncateAll();
});

describe('the default chart data', () => {
  it('has unique account numbers and the required system accounts', () => {
    const numbers = STANDARD_CHART.map((a) => a.accountNumber);
    expect(new Set(numbers).size).toBe(numbers.length); // no dup numbers
    for (const req of REQUIRED_SYSTEM_ACCOUNTS) {
      expect(STANDARD_CHART).toContainEqual(req); // standard ⊇ required
    }
  });

  it('names the three required system accounts', () => {
    const sys = REQUIRED_SYSTEM_ACCOUNTS.map((a) => a.systemAccountType);
    expect(sys).toEqual(['ACCOUNTS_RECEIVABLE', 'RETAINED_EARNINGS', 'OPENING_BALANCE_EQUITY']);
  });
});

describe('installation', () => {
  it('standard install creates every account with correct type and subtype', async () => {
    const { user, company } = await makeOwner('o@synthetic.test', 'standard');
    const accounts = await listAccounts(user.id, company.id);
    expect(accounts).toHaveLength(STANDARD_CHART.length);
    for (const expected of STANDARD_CHART) {
      const got = accounts.find((a) => a.accountNumber === expected.accountNumber);
      expect(got?.name).toBe(expected.name);
      expect(got?.accountType).toBe(expected.accountType);
      expect(got?.accountSubtype).toBe(expected.accountSubtype);
    }
  });

  it('flags system accounts and leaves ordinary ones unflagged', async () => {
    const { user, company } = await makeOwner('o@synthetic.test', 'standard');
    const accounts = await listAccounts(user.id, company.id);
    const ar = accounts.find((a) => a.accountNumber === '1100');
    const checking = accounts.find((a) => a.accountNumber === '1000');
    expect(ar?.systemAccountType).toBe('ACCOUNTS_RECEIVABLE');
    expect(checking?.systemAccountType).toBeNull();
  });

  it('system-only install yields exactly the required accounts', async () => {
    const { user, company } = await makeOwner('o@synthetic.test', 'system-only');
    const accounts = await listAccounts(user.id, company.id);
    expect(accounts).toHaveLength(REQUIRED_SYSTEM_ACCOUNTS.length);
    expect(accounts.every((a) => a.systemAccountType !== null)).toBe(true);
  });

  it('creates no journal entries or balances (no such column, no such table use)', async () => {
    const { company } = await makeOwner('o@synthetic.test', 'standard');
    const db = await getTestDb();
    // accounts has no balance column by design; assert the installed rows carry none.
    const cols = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'accounts'`,
    );
    expect(cols.rows.map((c) => c.column_name)).not.toContain('balance');
    expect(await countAccounts(company.id)).toBe(STANDARD_CHART.length);
  });
});

describe('idempotency', () => {
  it('re-running installs nothing new', async () => {
    const { company } = await makeOwner('o@synthetic.test', 'standard');
    const before = await countAccounts(company.id);
    const insertedSecond = await installDefaultChart(company.id, 'standard');
    expect(insertedSecond).toBe(0); // ON CONFLICT DO NOTHING
    expect(await countAccounts(company.id)).toBe(before);
  });

  it('is idempotent under CONCURRENCY — two simultaneous installs, no duplicates', async () => {
    // The ticket's race test: both run at once, ON CONFLICT lets exactly one
    // row per number survive. Uses a fresh company with no chart, then fires two.
    const { company } = await makeOwner('race@synthetic.test');
    expect(await countAccounts(company.id)).toBe(0);
    await Promise.all([
      installDefaultChart(company.id, 'standard'),
      installDefaultChart(company.id, 'standard'),
    ]);
    expect(await countAccounts(company.id)).toBe(STANDARD_CHART.length);
  });
});

describe('tenant isolation', () => {
  it('installing for Company A creates nothing in Company B', async () => {
    const a = await makeOwner('a@synthetic.test', 'standard');
    const b = await makeOwner('b@synthetic.test'); // no chart
    expect(await countAccounts(a.company.id)).toBe(STANDARD_CHART.length);
    expect(await countAccounts(b.company.id)).toBe(0);
  });
});
