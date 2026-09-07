/**
 * Vendor service — LL-060 (Accounts Payable). Against a real database.
 *
 * The mirror of the customer suite: the service surface (create/update/deactivate/
 * list, authorization, soft-delete, duplicate number) plus the STRUCTURAL guarantee
 * that a journal line can never reference another company's vendor — proven in raw
 * SQL against the new composite FK `journal_lines_vendor_same_company_fk`, with the
 * application bypassed.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import {
  VendorError,
  createVendor,
  deactivateVendor,
  listVendors,
  updateVendor,
} from '@/server/vendors';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createVendorInput, updateVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `vend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'V',
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
    createCompanyInput.parse({ legalName: 'Vend Co', timezone: 'America/Chicago' }),
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

/** Asserts a query rejects with `re` found anywhere on the error's cause chain. */
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

const errOf = async (p: Promise<unknown>): Promise<VendorError> => {
  try {
    await p;
    throw new Error('expected VendorError');
  } catch (e) {
    expect(e).toBeInstanceOf(VendorError);
    return e as VendorError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('vendor CRUD (soft-delete, audited)', () => {
  it('creates a vendor and records an audit event', async () => {
    const c = await setup();
    const vendor = await createVendor(c.userId, c.companyId, createVendorInput.parse({
      name: 'Globex Supply', vendorNumber: 'V-100', email: 'ar@globex.test',
    }));
    expect(vendor.name).toBe('Globex Supply');
    expect(vendor.status).toBe('ACTIVE');
    expect(await auditCount(c.companyId, 'VENDOR_CREATED')).toBe(1);
  });

  it('updates permitted fields and audits the change', async () => {
    const c = await setup();
    const vendor = await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'Globex' }));
    const updated = await updateVendor(c.userId, c.companyId, vendor.id, updateVendorInput.parse({
      name: 'Globex Supply Co', email: 'billing@globex.test',
    }));
    expect(updated.name).toBe('Globex Supply Co');
    expect(updated.email).toBe('billing@globex.test');
    expect(await auditCount(c.companyId, 'VENDOR_UPDATED')).toBe(1);
  });

  it('deactivates (never deletes) and the vendor stays listable', async () => {
    const c = await setup();
    const vendor = await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'Gone Supply' }));
    const deactivated = await deactivateVendor(c.userId, c.companyId, vendor.id);
    expect(deactivated.status).toBe('INACTIVE');
    const all = await listVendors(c.userId, c.companyId);
    expect(all.map((x) => x.id)).toContain(vendor.id); // history preserved
    expect(await auditCount(c.companyId, 'VENDOR_DEACTIVATED')).toBe(1);
  });

  it('rejects a duplicate vendor number in the same company', async () => {
    const c = await setup();
    await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'One', vendorNumber: 'DUP' }));
    expect((await errOf(
      createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'Two', vendorNumber: 'DUP' })),
    )).code).toBe('DUPLICATE_VENDOR_NUMBER');
  });

  it('allows many vendors with no number (NULLs are distinct)', async () => {
    const c = await setup();
    await createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'No Number A' }));
    await expect(
      createVendor(c.userId, c.companyId, createVendorInput.parse({ name: 'No Number B' })),
    ).resolves.toBeDefined();
  });

  it('lists only this company’s vendors, ordered by name', async () => {
    const a = await setup();
    const b = await setup();
    await createVendor(a.userId, a.companyId, createVendorInput.parse({ name: 'Zed' }));
    await createVendor(a.userId, a.companyId, createVendorInput.parse({ name: 'Alpha' }));
    await createVendor(b.userId, b.companyId, createVendorInput.parse({ name: 'Beta' }));
    const listed = await listVendors(a.userId, a.companyId);
    expect(listed.map((x) => x.name)).toEqual(['Alpha', 'Zed']);
  });

  it('updating a nonexistent / cross-company vendor is VENDOR_NOT_FOUND', async () => {
    const a = await setup();
    const b = await setup();
    const bVendor = await createVendor(b.userId, b.companyId, createVendorInput.parse({ name: 'B Vend' }));
    expect((await errOf(
      updateVendor(a.userId, a.companyId, bVendor.id, updateVendorInput.parse({ name: 'x' })),
    )).code).toBe('VENDOR_NOT_FOUND');
  });
});

describe('authorization', () => {
  it('a READ_ONLY member may view but not manage vendors', async () => {
    const c = await setup();
    const reader = await makeUser();
    await insertMembership(c.companyId, reader, 'READ_ONLY');
    await expect(listVendors(reader, c.companyId)).resolves.toBeDefined();
    await expect(
      createVendor(reader, c.companyId, createVendorInput.parse({ name: 'Nope' })),
    ).rejects.toThrow();
    expect(await auditCount(c.companyId, 'VENDOR_CREATED')).toBe(0);
  });

  it('a non-member is denied entirely', async () => {
    const c = await setup();
    const outsider = await setup();
    await expect(listVendors(outsider.userId, c.companyId)).rejects.toThrow();
  });
});

describe('structural tenancy — the composite FK, application bypassed', () => {
  it('rejects a journal line referencing another company’s vendor (raw SQL)', async () => {
    const a = await setup();
    const b = await setup();
    const aCash = await createAccount(a.userId, a.companyId, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
    const bVendor = await createVendor(b.userId, b.companyId, createVendorInput.parse({ name: 'B Vend' }));
    const db = await getTestDb();
    const entry = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${a.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${a.userId}, 'DRAFT') returning id`);
    await expectRejectsOnChain(
      db.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit, vendor_id)
        values (${entry.rows[0]!.id}, ${a.companyId}, ${aCash.id}, 1, '5.0000', '0.0000', ${bVendor.id})`),
      /foreign key|vendor_same_company/i,
    );
  });

  it('accepts a journal line tagged with a vendor in its OWN company', async () => {
    const a = await setup();
    const aCash = await createAccount(a.userId, a.companyId, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
    const aVendor = await createVendor(a.userId, a.companyId, createVendorInput.parse({ name: 'A Vend' }));
    const db = await getTestDb();
    const entry = await db.execute<{ id: string }>(sql`
      insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
      values (${a.companyId}, '2026-01-10', '2026-01-10', 'JOURNAL_ENTRY', ${a.userId}, 'DRAFT') returning id`);
    await expect(
      db.execute(sql`
        insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit, vendor_id)
        values (${entry.rows[0]!.id}, ${a.companyId}, ${aCash.id}, 1, '5.0000', '0.0000', ${aVendor.id})`),
    ).resolves.toBeDefined();
  });
});
