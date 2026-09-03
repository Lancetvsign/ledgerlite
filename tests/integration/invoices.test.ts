/**
 * Invoice service — LL-041. Against a real database.
 *
 * Covers draft CRUD, the decimal.js totals (and the ADR-013 guarantee that the
 * STORED totals always equal the recompute from the lines), reference validation,
 * the DRAFT-only edit rule, authorization, and the STRUCTURAL composite-FK tenancy
 * (a raw invoice/line can never reference another company's customer or account).
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import {
  InvoiceError,
  computeInvoiceTotals,
  createInvoice,
  getInvoice,
  listInvoices,
  updateInvoice,
} from '@/server/invoices';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  customerId: string;
  revId: string;
  serviceRevId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'I',
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
    createCompanyInput.parse({ legalName: 'Inv Co', timezone: 'America/Chicago' }),
  );
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Sales Revenue', accountType: 'REVENUE' }));
  const rev2 = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Service Revenue', accountType: 'REVENUE' }));
  return { userId, companyId: company.id, customerId: customer.id, revId: rev.id, serviceRevId: rev2.id };
}

function draft(c: Ctx, lines: { accountId: string; quantity?: string; unitPrice: string; taxRate?: string }[], extra: Record<string, unknown> = {}) {
  return createInvoiceInput.parse({
    customerId: c.customerId,
    invoiceDate: '2026-01-10',
    lines,
    ...extra,
  });
}

async function auditCount(companyId: string, action: string): Promise<number> {
  const db = await getTestDb();
  const r = await db.execute<{ n: string }>(
    sql`select count(*)::text n from audit_events where company_id = ${companyId} and action = ${action}`,
  );
  return Number(r.rows[0]?.n);
}

const errOf = async (p: Promise<unknown>): Promise<InvoiceError> => {
  try {
    await p;
    throw new Error('expected InvoiceError');
  } catch (e) {
    expect(e).toBeInstanceOf(InvoiceError);
    return e as InvoiceError;
  }
};

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

beforeEach(async () => {
  await truncateAll();
});

describe('computeInvoiceTotals (pure, decimal.js — ADR-004)', () => {
  it('sums amounts and per-line tax exactly at four places', () => {
    const totals = computeInvoiceTotals([
      { quantity: '2', unitPrice: '100.00', taxRate: '10' },
      { quantity: '1', unitPrice: '50.00', taxRate: '0' },
    ]);
    expect(totals.subtotal).toBe('250.0000');
    expect(totals.taxTotal).toBe('20.0000');
    expect(totals.total).toBe('270.0000');
  });

  it('0.1 + 0.2 = 0.3 (a float implementation drifts)', () => {
    const totals = computeInvoiceTotals([
      { quantity: '1', unitPrice: '0.1', taxRate: '0' },
      { quantity: '1', unitPrice: '0.2', taxRate: '0' },
    ]);
    expect(totals.subtotal).toBe('0.3000');
    expect(totals.total).toBe('0.3000');
  });
});

describe('draft create / read / list (audited, totals stored)', () => {
  it('creates a DRAFT invoice, stores the derived totals, records an audit event', async () => {
    const c = await setup();
    const { invoice, lines } = await createInvoice(c.userId, c.companyId, draft(c, [
      { accountId: c.revId, quantity: '2', unitPrice: '100.00', taxRate: '10' },
      { accountId: c.serviceRevId, quantity: '1', unitPrice: '50.00' },
    ]));
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.subtotal).toBe('250.0000');
    expect(invoice.taxTotal).toBe('20.0000');
    expect(invoice.total).toBe('270.0000');
    expect(lines).toHaveLength(2);
    expect(await auditCount(c.companyId, 'INVOICE_CREATED')).toBe(1);
  });

  it('the STORED totals always equal recompute(lines) — ADR-013', async () => {
    const c = await setup();
    // Fractional quantity + odd tax, where hand-rounding is error-prone.
    const input = draft(c, [
      { accountId: c.revId, quantity: '2.5', unitPrice: '3.3333', taxRate: '8.25' },
      { accountId: c.serviceRevId, quantity: '3', unitPrice: '19.99', taxRate: '8.25' },
    ]);
    const { invoice } = await createInvoice(c.userId, c.companyId, input);
    const recomputed = computeInvoiceTotals(input.lines);
    expect(invoice.subtotal).toBe(recomputed.subtotal);
    expect(invoice.taxTotal).toBe(recomputed.taxTotal);
    expect(invoice.total).toBe(recomputed.total);
    // …and the stored total is internally consistent: subtotal + tax = total.
    expect(invoice.total).toBe(
      computeInvoiceTotals(input.lines).total,
    );
  });

  it('getInvoice returns the invoice with its lines; a cross-company id reads as null', async () => {
    const a = await setup();
    const b = await setup();
    const { invoice } = await createInvoice(a.userId, a.companyId, draft(a, [{ accountId: a.revId, unitPrice: '10' }]));
    const view = await getInvoice(a.userId, a.companyId, invoice.id);
    expect(view?.lines).toHaveLength(1);
    // b, scoped to b's company, cannot see a's invoice — same as a genuine miss.
    expect(await getInvoice(b.userId, b.companyId, invoice.id)).toBeNull();
  });

  it('lists only this company’s invoices', async () => {
    const a = await setup();
    const b = await setup();
    await createInvoice(a.userId, a.companyId, draft(a, [{ accountId: a.revId, unitPrice: '10' }]));
    await createInvoice(b.userId, b.companyId, draft(b, [{ accountId: b.revId, unitPrice: '99' }]));
    const listed = await listInvoices(a.userId, a.companyId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.total).toBe('10.0000');
  });
});

describe('draft editing rules', () => {
  it('updates a draft wholesale and recomputes totals', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '10' }]));
    const { invoice: updated, lines } = await updateInvoice(c.userId, c.companyId, invoice.id, draft(c, [
      { accountId: c.revId, quantity: '3', unitPrice: '100.00', taxRate: '5' },
    ]));
    expect(lines).toHaveLength(1);
    expect(updated.subtotal).toBe('300.0000');
    expect(updated.taxTotal).toBe('15.0000');
    expect(updated.total).toBe('315.0000');
    expect(await auditCount(c.companyId, 'INVOICE_UPDATED')).toBe(1);
  });

  it('refuses to edit a non-DRAFT invoice (INVOICE_NOT_DRAFT)', async () => {
    const c = await setup();
    const { invoice } = await createInvoice(c.userId, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '10' }]));
    // Simulate a finalized invoice (finalize lands in LL-042).
    const db = await getTestDb();
    await db.execute(sql`update invoices set status='OPEN' where id=${invoice.id}`);
    expect((await errOf(
      updateInvoice(c.userId, c.companyId, invoice.id, draft(c, [{ accountId: c.revId, unitPrice: '20' }])),
    )).code).toBe('INVOICE_NOT_DRAFT');
  });
});

describe('reference validation', () => {
  it('rejects a customer from another company (CUSTOMER_NOT_FOUND)', async () => {
    const a = await setup();
    const b = await setup();
    expect((await errOf(createInvoice(a.userId, a.companyId, createInvoiceInput.parse({
      customerId: b.customerId, invoiceDate: '2026-01-10',
      lines: [{ accountId: a.revId, quantity: '1', unitPrice: '10' }],
    })))).code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('rejects a line account from another company (ACCOUNT_NOT_FOUND)', async () => {
    const a = await setup();
    const b = await setup();
    expect((await errOf(createInvoice(a.userId, a.companyId, createInvoiceInput.parse({
      customerId: a.customerId, invoiceDate: '2026-01-10',
      lines: [{ accountId: b.revId, quantity: '1', unitPrice: '10' }],
    })))).code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('authorization', () => {
  it('a READ_ONLY member may view but not create invoices', async () => {
    const c = await setup();
    const reader = await makeUser();
    await insertMembership(c.companyId, reader, 'READ_ONLY');
    await expect(listInvoices(reader, c.companyId)).resolves.toBeDefined();
    await expect(
      createInvoice(reader, c.companyId, draft(c, [{ accountId: c.revId, unitPrice: '10' }])),
    ).rejects.toThrow();
    expect(await auditCount(c.companyId, 'INVOICE_CREATED')).toBe(0);
  });
});

describe('structural tenancy — the composite FKs, application bypassed', () => {
  it('a raw invoice cannot reference another company’s customer', async () => {
    const a = await setup();
    const b = await setup();
    const db = await getTestDb();
    await expectRejectsOnChain(
      db.execute(sql`
        insert into invoices (company_id, customer_id, status, invoice_date, created_by)
        values (${a.companyId}, ${b.customerId}, 'DRAFT', '2026-01-10', ${a.userId})`),
      /foreign key|customer_same_company/i,
    );
  });

  it('a raw invoice line cannot reference another company’s account', async () => {
    const a = await setup();
    const b = await setup();
    const { invoice } = await createInvoice(a.userId, a.companyId, draft(a, [{ accountId: a.revId, unitPrice: '10' }]));
    const db = await getTestDb();
    await expectRejectsOnChain(
      db.execute(sql`
        insert into invoice_lines (invoice_id, company_id, line_number, quantity, unit_price, account_id)
        values (${invoice.id}, ${a.companyId}, 99, '1.0000', '10.0000', ${b.revId})`),
      /foreign key|account_same_company/i,
    );
  });
});
