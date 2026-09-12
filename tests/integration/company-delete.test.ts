/**
 * Delete a company — LL-082 (ADR-038). Against a real DB. Proves: the archive rule
 * (any posted entry OR any audit event → status INACTIVE, everything retained, hidden
 * from every listing, every membership check fails closed), the purge rule (nothing
 * ever recorded → rows physically gone, children first, other tenants untouched),
 * OWNER-only authorization checked BEFORE the typed-name comparison, and that the
 * purge list structurally covers every tenant table except the append-only audit log.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { AuthorizationDenied, requireCompanyMembership } from '@/server/authorization';
import {
  CompanyError,
  createCompanyWithOwner,
  deleteCompany,
  listCompaniesForUser,
  PURGE_ORDER,
} from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { postJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { postJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

const NAME = 'Doomed Co';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `del-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'D',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function makeCompany(ownerId: string, legalName = NAME): Promise<string> {
  const { company } = await createCompanyWithOwner(
    ownerId,
    createCompanyInput.parse({ legalName, timezone: 'America/Chicago' }),
    'standard',
  );
  return company.id;
}

async function postOne(userId: string, companyId: string): Promise<string> {
  const bank = await createAccount(userId, companyId, createAccountInput.parse({ name: 'Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const sales = await createAccount(userId, companyId, createAccountInput.parse({ name: 'Sales', accountType: 'REVENUE' }));
  const { entry } = await postJournalEntry(postJournalEntryInput.parse({
    companyId, actorUserId: userId, transactionDate: '2026-06-01', sourceType: 'JOURNAL_ENTRY',
    lines: [{ accountId: bank.id, debit: '100.00' }, { accountId: sales.id, credit: '100.00' }],
  }));
  return entry.id;
}

async function countRows(table: string, companyId: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from ${sql.identifier(table)} where company_id = ${companyId}`,
  );
  return Number(r.rows[0]!.n);
}

async function companyStatus(companyId: string): Promise<string | undefined> {
  const db = await getTestDb();
  const r = await db.execute<{ status: string }>(sql`select status from companies where id = ${companyId}`);
  return r.rows[0]?.status;
}

beforeEach(async () => {
  await truncateAll();
});

describe('deleteCompany — archive path', () => {
  it('a company with posted history is archived: hidden, fail-closed, rows retained, audited', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);
    const entryId = await postOne(owner, companyId);

    await expect(deleteCompany(owner, companyId, { confirmLegalName: NAME })).resolves.toEqual({ mode: 'archived' });

    expect(await companyStatus(companyId)).toBe('INACTIVE');
    expect((await listCompaniesForUser(owner)).map((c) => c.company.id)).not.toContain(companyId);
    await expect(requireCompanyMembership(owner, companyId)).rejects.toBeInstanceOf(AuthorizationDenied);

    const db = await getTestDb();
    const lines = await db.execute<{ n: string }>(sql`select count(*)::text as n from journal_lines where journal_entry_id = ${entryId}`);
    expect(Number(lines.rows[0]!.n)).toBe(2);
    expect(await countRows('accounts', companyId)).toBeGreaterThan(0);
    expect(await countRows('company_memberships', companyId)).toBe(1);

    const audit = await db.execute<{ action: string; after_json: { status: string; postedEntries: number } }>(
      sql`select action, after_json from audit_events where company_id = ${companyId} and action = 'COMPANY_ARCHIVED'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.after_json.status).toBe('INACTIVE');
    expect(audit.rows[0]!.after_json.postedEntries).toBe(1);
  });

  it('a company with an audit trail but no postings is archived, never purged (the log is append-only)', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);
    await createCustomer(owner, companyId, createCustomerInput.parse({ name: 'Someone' }));

    await expect(deleteCompany(owner, companyId, { confirmLegalName: NAME })).resolves.toEqual({ mode: 'archived' });
    expect(await companyStatus(companyId)).toBe('INACTIVE');
    expect(await countRows('customers', companyId)).toBe(1);
  });

  it('an archived company cannot be deleted again — the membership check fails closed', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);
    await postOne(owner, companyId);
    await deleteCompany(owner, companyId, { confirmLegalName: NAME });

    await expect(deleteCompany(owner, companyId, { confirmLegalName: NAME })).rejects.toBeInstanceOf(AuthorizationDenied);
  });
});

describe('deleteCompany — purge path', () => {
  it('a company nothing was ever recorded about is physically removed; another tenant is untouched', async () => {
    const owner = await makeUser();
    const keeper = await makeUser();
    const companyId = await makeCompany(owner);
    await insertMembership(companyId, keeper, 'BOOKKEEPER');
    const otherId = await makeCompany(keeper, 'Survivor Inc');

    expect(await countRows('accounts', companyId)).toBeGreaterThan(0);
    expect(await countRows('audit_events', companyId)).toBe(0);

    await expect(deleteCompany(owner, companyId, { confirmLegalName: NAME })).resolves.toEqual({ mode: 'purged' });

    expect(await companyStatus(companyId)).toBeUndefined();
    for (const table of PURGE_ORDER) {
      expect(await countRows(table, companyId), table).toBe(0);
    }
    expect((await listCompaniesForUser(owner)).map((c) => c.company.id)).toEqual([]);
    expect((await listCompaniesForUser(keeper)).map((c) => c.company.id)).toEqual([otherId]);
    expect(await companyStatus(otherId)).toBe('ACTIVE');
    expect(await countRows('accounts', otherId)).toBeGreaterThan(0);
    expect(await countRows('company_counters', otherId)).toBe(1);
  });

  it('PURGE_ORDER names every tenant table except the append-only audit log', async () => {
    const db = await getTestDb();
    const rows = await db.execute<{ table_name: string }>(
      sql`select distinct table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'company_id'`,
    );
    const tenantTables = rows.rows.map((r) => r.table_name).filter((t) => t !== 'audit_events').sort();
    expect([...PURGE_ORDER].sort()).toEqual(tenantTables);
    expect(PURGE_ORDER).not.toContain('audit_events');
  });
});

describe('deleteCompany — authorization and confirmation', () => {
  it('requires the exact legal name; a mismatch changes nothing', async () => {
    const owner = await makeUser();
    const companyId = await makeCompany(owner);

    for (const typed of ['doomed co', 'Doomed Co.', '']) {
      await expect(deleteCompany(owner, companyId, { confirmLegalName: typed })).rejects.toMatchObject({
        name: 'CompanyError',
        code: 'NAME_MISMATCH',
      });
    }
    expect(await companyStatus(companyId)).toBe('ACTIVE');
    // Surrounding whitespace is forgiven — it is what a paste produces.
    await expect(deleteCompany(owner, companyId, { confirmLegalName: `  ${NAME}  ` })).resolves.toEqual({ mode: 'purged' });
  });

  it('only the OWNER may delete: ADMIN, a non-member and a malformed id are all the same denial', async () => {
    const owner = await makeUser();
    const admin = await makeUser();
    const stranger = await makeUser();
    const companyId = await makeCompany(owner);
    await insertMembership(companyId, admin, 'ADMIN');

    await expect(deleteCompany(admin, companyId, { confirmLegalName: NAME })).rejects.toBeInstanceOf(AuthorizationDenied);
    await expect(deleteCompany(stranger, companyId, { confirmLegalName: NAME })).rejects.toBeInstanceOf(AuthorizationDenied);
    await expect(deleteCompany(owner, 'not-a-uuid', { confirmLegalName: NAME })).rejects.toBeInstanceOf(AuthorizationDenied);
    expect(await companyStatus(companyId)).toBe('ACTIVE');
  });

  it('authorization is decided before the name is compared — a wrong name is not an oracle', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const companyId = await makeCompany(owner);

    // A stranger with the WRONG name must see the denial, never NAME_MISMATCH
    // (which would confirm the company exists and that its name differs).
    let caught: unknown;
    try {
      await deleteCompany(stranger, companyId, { confirmLegalName: 'Guess' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthorizationDenied);
    expect(caught).not.toBeInstanceOf(CompanyError);
  });
});
