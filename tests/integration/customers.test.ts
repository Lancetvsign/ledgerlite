/**
 * Customer service — LL-040. Against a real database.
 *
 * Covers the service surface (create/update/deactivate/list, authorization,
 * soft-delete, duplicate number) and the STRUCTURAL guarantee that a journal line
 * can never reference another company's customer — proven in raw SQL against the
 * composite FK, with the application bypassed.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import {
  CustomerError,
  createCustomer,
  deactivateCustomer,
  listCustomers,
  updateCustomer,
} from '@/server/customers';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput, updateCustomerInput } from '@/validation/customer';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `cust-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'C',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Cust Co', timezone: 'America/Chicago' }),
  );
  return { userId, companyId: company.id };
}

async function auditCount(companyId: string, action: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from audit_events where company_id = ${companyId} and action = ${action}`,
  );
  return Number(r.rows[0]?.n);
}

/** Asserts a query rejects with `re` found anywhere on the error's cause chain
 *  (the Neon driver wraps constraint failures under a generic "Failed query" message). */
async function expectRejectsOnChain(p: Promise<unknown>, re: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected the query to reject').toBeDefined();
  const seen = new Set<unknown>();
  let cur: unknown = thrown;
  let text = '';
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    text += ' ' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  expect(text).toMatch(re);
}

const errOf = async (p: Promise<unknown>): Promise<CustomerError> => {
  try {
    await p;
    throw new Error('expected CustomerError');
  } catch (e) {
    expect(e).toBeInstanceOf(CustomerError);
    return e as CustomerError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('customer CRUD (soft-delete, audited)', () => {
  it('creates a customer and records an audit event', async () => {
    const c = await setup();
    const customer = await createCustomer(c.userId, c.companyId, createCustomerInput.parse({
      name: 'Acme Corp', customerNumber: 'C-100', email: 'ap@acme.test',
    }));
    expect(customer.name).toBe('Acme Corp');
    expect(customer.status).toBe('ACTIVE');
    expect(await auditCount(c.companyId, 'CUSTOMER_CREATED')).toBe(1);
  });

  it('updates permitted fields and audits the change', async () => {
    const c = await setup();
    const customer = await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'Acme' }));
    const updated = await updateCustomer(c.userId, c.companyId, customer.id, updateCustomerInput.parse({
      name: 'Acme Corporation', email: 'billing@acme.test',
    }));
    expect(updated.name).toBe('Acme Corporation');
    expect(updated.email).toBe('billing@acme.test');
    expect(await auditCount(c.companyId, 'CUSTOMER_UPDATED')).toBe(1);
  });

  it('deactivates (never deletes) and the customer stays listable', async () => {
    const c = await setup();
    const customer = await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'Gone Inc' }));
    const deactivated = await deactivateCustomer(c.userId, c.companyId, customer.id);
    expect(deactivated.status).toBe('INACTIVE');
    const all = await listCustomers(c.userId, c.companyId);
    expect(all.map((x) => x.id)).toContain(customer.id); // history preserved
    expect(await auditCount(c.companyId, 'CUSTOMER_DEACTIVATED')).toBe(1);
  });

  it('rejects a duplicate customer number in the same company', async () => {
    const c = await setup();
    await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'One', customerNumber: 'DUP' }));
    expect((await errOf(
      createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'Two', customerNumber: 'DUP' })),
    )).code).toBe('DUPLICATE_CUSTOMER_NUMBER');
  });

  it('allows many customers with no number (NULLs are distinct)', async () => {
    const c = await setup();
    await createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'No Number A' }));
    await expect(
      createCustomer(c.userId, c.companyId, createCustomerInput.parse({ name: 'No Number B' })),
    ).resolves.toBeDefined();
  });

  it('lists only this company’s customers, ordered by name', async () => {
    const a = await setup();
    const b = await setup();
    await createCustomer(a.userId, a.companyId, createCustomerInput.parse({ name: 'Zed' }));
    await createCustomer(a.userId, a.companyId, createCustomerInput.parse({ name: 'Alpha' }));
    await createCustomer(b.userId, b.companyId, createCustomerInput.parse({ name: 'Beta' }));
    const listed = await listCustomers(a.userId, a.companyId);
    expect(listed.map((x) => x.name)).toEqual(['Alpha', 'Zed']);
  });

  it('updating a nonexistent / cross-company customer is CUSTOMER_NOT_FOUND', async () => {
    const a = await setup();
    const b = await setup();
    const bCustomer = await createCustomer(b.userId, b.companyId, createCustomerInput.parse({ name: 'B Cust' }));
    // a's user, scoped to a's company, cannot see b's customer.
    expect((await errOf(
      updateCustomer(a.userId, a.companyId, bCustomer.id, updateCustomerInput.parse({ name: 'x' })),
    )).code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('authorization', () => {
  it('a READ_ONLY member may view but not manage customers', async () => {
    const c = await setup();
    const reader = await makeUser();
    await insertMembership(c.companyId, reader, 'READ_ONLY');
    // view: allowed
    await expect(listCustomers(reader, c.companyId)).resolves.toBeDefined();
    // manage: denied
    await expect(
      createCustomer(reader, c.companyId, createCustomerInput.parse({ name: 'Nope' })),
    ).rejects.toThrow();
    expect(await auditCount(c.companyId, 'CUSTOMER_CREATED')).toBe(0);
  });

  it('a non-member is denied entirely', async () => {
    const c = await setup();
    const outsider = await setup();
    await expect(listCustomers(outsider.userId, c.companyId)).rejects.toThrow();
  });
});

describe('structural tenancy — the composite FK, application bypassed', () => {
  it('rejects a journal line referencing another company’s customer (raw SQL)', async () => {
    const a = await setup();
    const b = await setup();
    const aCash = await createAccount(a.userId, a.companyId, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
    const bCustomer = await createCustomer(b.userId, b.companyId, createCustomerInput.parse({ name: 'B Cust' }));
    const db = await getTestDb();
    // A DRAFT entry in company A (drafts skip the balance trigger), then a line in
    // A tagged with B's customer → the composite FK must reject it.
    const entry = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${a.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${a.userId}, 'DRAFT') returning id`);
    await expectRejectsOnChain(
      db.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit, customer_id)
        values (${entry.rows[0]!.id}, ${a.companyId}, ${aCash.id}, 1, '5.0000', '0.0000', ${bCustomer.id})`),
      /foreign key|customer_same_company/i,
    );
  });

  it('accepts a journal line tagged with a customer in its OWN company', async () => {
    const a = await setup();
    const aCash = await createAccount(a.userId, a.companyId, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
    const aCustomer = await createCustomer(a.userId, a.companyId, createCustomerInput.parse({ name: 'A Cust' }));
    const db = await getTestDb();
    const entry = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${a.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${a.userId}, 'DRAFT') returning id`);
    await expect(
      db.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit, customer_id)
        values (${entry.rows[0]!.id}, ${a.companyId}, ${aCash.id}, 1, '5.0000', '0.0000', ${aCustomer.id})`),
    ).resolves.toBeDefined();
  });
});
