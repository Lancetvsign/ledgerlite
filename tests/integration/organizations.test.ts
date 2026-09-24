/**
 * Organizations + intercompany system accounts — LL-096 / ADR-043. Against a real DB.
 *
 * Proves: the structural rules of migration 0040 (pairing/self/template/active CHECKs, the
 * per-pair unique, the classic single-role unique still holds); the ALLOW-list trigger (only
 * an INTERCOMPANY posting or its REVERSAL moves a Due account, service bypassed); the
 * organization services (create / add / remove, authorization in BOTH companies, uniform
 * denial, currency rule, zero-balance leave, reactivation on rejoin, delete refused);
 * `ensureIntercompanyPair` (shapes, idempotence, 10-way race → one pair, number fallback);
 * and that every consumer refuses a pair account as a bank, category, deposit or cash account.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDbTx } from '@/db';
import { getAuth } from '@/lib/auth';
import { AccountError, createAccount, deactivateAccount, listAccounts, resolveSystemAccount } from '@/server/accounts';
import { ensureIntercompanyPair, installChartFromTemplate, installDefaultChart } from '@/server/accounts/internal';
import { isStatementAccount } from '@/server/accounts/statement-account';
import { AuthorizationDenied } from '@/server/authorization';
import { BankImportError, stageImport } from '@/server/bank-import';
import { cannedExtractor } from '@/server/bank-import/extract';
import { BillPaymentError, payBill } from '@/server/bill-payments';
import { createBill, finalizeBill } from '@/server/bills';
import { CompanyError, createCompanyWithOwner, deleteCompany, listCompaniesForUser, setCompanyTemplate, updateCompanySettings } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { LedgerError, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { OpeningBalanceError, setOpeningBalances } from '@/server/opening-balances';
import {
  addCompanyToOrganization,
  createOrganization,
  listOrganizationCompanies,
  OrganizationError,
  organizationsActorCanAddTo,
  removeCompanyFromOrganization,
} from '@/server/organizations';
import { PaymentError, receivePayment } from '@/server/payments';
import { ReconciliationError, startReconciliation } from '@/server/reconciliation';
import { ensureAppUser } from '@/server/users';
import { createVendor } from '@/server/vendors';
import { createAccountInput } from '@/validation/account';
import { createBillInput } from '@/validation/bill';
import { payBillInput } from '@/validation/bill-payment';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';
import { setOpeningBalancesInput } from '@/validation/opening-balance';
import { receivePaymentInput } from '@/validation/payment';
import { createVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';
import { rawPostedEntry } from '../helpers/raw-entry';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `org-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'O' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function makeCompany(owner: string, legalName: string, chart: 'standard' | 'system-only' | 'template' = 'standard'): Promise<string> {
  const { company } = await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName, timezone: 'America/Chicago' }), chart);
  return company.id;
}
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    const seen = new Set<unknown>();
    let cur: unknown = e;
    let text = '';
    while (cur instanceof Error && !seen.has(cur)) { seen.add(cur); text += ' ' + cur.message; cur = (cur as { cause?: unknown }).cause; }
    return text;
  }
}
async function codeOf<T extends { code: string }>(p: Promise<unknown>, cls: new (...a: never[]) => T): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    expect(e).toBeInstanceOf(cls);
    return (e as T).code;
  }
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A and B: two companies of one owner, in one organization. */
async function orgPair(): Promise<{ owner: string; a: string; b: string; orgId: string }> {
  const owner = await makeUser();
  const a = await makeCompany(owner, 'Alpha Co');
  const b = await makeCompany(owner, 'Beta Co');
  const org = await createOrganization(owner, a, { name: 'Lehr Group' });
  await addCompanyToOrganization(owner, b, org.id);
  return { owner, a, b, orgId: org.id };
}
async function pair(owner: string, a: string, b: string) {
  return await getDbTx().transaction(async (tx) => await ensureIntercompanyPair(tx, owner, a, b));
}
async function anyExpense(owner: string, companyId: string): Promise<string> {
  return (await createAccount(owner, companyId, createAccountInput.parse({ name: 'Some Expense', accountType: 'EXPENSE' }))).id;
}
/** Raw POSTED entry with the given source and lines — the services entirely bypassed (LL-104 shape: DRAFT → lines → POSTED). */
function rawEntry(companyId: string, userId: string, source: string, lines: { accountId: string; debit: string; credit: string }[], entryNumber = 95000): Promise<string> {
  return getDbTx().transaction((tx) =>
    rawPostedEntry(tx, { companyId, userId, sourceType: source, lines, entryNumber, transactionDate: '2026-03-10' }),
  );
}
async function auditActions(companyId: string): Promise<string[]> {
  const db = await getTestDb();
  return (await db.execute<{ action: string }>(sql`select action from audit_events where company_id = ${companyId} order by created_at, action`)).rows.map((r) => r.action);
}

beforeEach(async () => {
  await truncateAll();
});

describe('structural rules (migration 0040)', () => {
  it('pairing CHECK: a counterpart is set exactly on the intercompany roles — including the NULL-role case', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'A');
    const b = await makeCompany(owner, 'B');
    const db = await getTestDb();
    const plain = (await listAccounts(owner, a)).find((x) => x.systemAccountType === null)!;
    expect(await rejection(db.execute(sql`update accounts set intercompany_company_id = ${b} where id = ${plain.id}`))).toMatch(/accounts_intercompany_role_pairing/);
    expect(await rejection(db.execute(sql`insert into accounts (company_id, name, account_type, system_account_type) values (${a}, 'x', 'ASSET', 'INTERCOMPANY_RECEIVABLE')`))).toMatch(/accounts_intercompany_role_pairing/);
    expect(await rejection(db.execute(sql`insert into accounts (company_id, name, account_type, intercompany_company_id) values (${a}, 'x', 'ASSET', ${b})`))).toMatch(/accounts_intercompany_role_pairing/);
    expect(await rejection(db.execute(sql`insert into accounts (company_id, name, account_type, system_account_type, intercompany_company_id) values (${a}, 'x', 'ASSET', 'INTERCOMPANY_RECEIVABLE', ${a})`))).toMatch(/accounts_intercompany_not_self/);
  });

  it('one "Due from B" per company; "Due from C" beside it is fine; two A/R are still refused', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'A');
    const b = await makeCompany(owner, 'B');
    const c = await makeCompany(owner, 'C');
    const db = await getTestDb();
    const ins = (cp: string) => db.execute(sql`insert into accounts (company_id, name, account_type, system_account_type, intercompany_company_id) values (${a}, 'Due', 'ASSET', 'INTERCOMPANY_RECEIVABLE', ${cp})`);
    await ins(b);
    expect(await rejection(ins(b))).toMatch(/accounts_company_intercompany_pair_key/);
    await ins(c);
    expect(await rejection(db.execute(sql`insert into accounts (company_id, name, account_type, system_account_type) values (${a}, 'AR2', 'ASSET', 'ACCOUNTS_RECEIVABLE')`))).toMatch(/accounts_company_system_account_type_key/);
  });

  it('the template cannot be a member and a member must be ACTIVE (CHECKs)', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'A');
    const db = await getTestDb();
    const org = (await db.execute<{ id: string }>(sql`insert into organizations (name, created_by) values ('O', ${owner}) returning id`)).rows[0]!.id;
    await setCompanyTemplate(owner, a, true);
    expect(await rejection(db.execute(sql`update companies set organization_id = ${org} where id = ${a}`))).toMatch(/companies_template_not_in_organization/);
    await setCompanyTemplate(owner, a, false);
    await db.execute(sql`update companies set organization_id = ${org} where id = ${a}`);
    expect(await rejection(db.execute(sql`update companies set status = 'INACTIVE' where id = ${a}`))).toMatch(/companies_organization_member_is_active/);
  });
});

describe('the allow-list trigger: only INTERCOMPANY or REVERSAL moves a Due account (service bypassed)', () => {
  it('manual, invoice, payment, bank-import and opening-balance sources are refused; INTERCOMPANY and REVERSAL post; relabel refused; A/R rule unchanged', async () => {
    const { owner, a, b } = await orgPair();
    const { dueFrom } = await pair(owner, a, b);
    const exp = await anyExpense(owner, a);
    const line = (d: string, c: string) => [{ accountId: dueFrom.id, debit: d, credit: c }, { accountId: exp, debit: c, credit: d }];

    expect(await codeOf(postJournalEntry(postJournalEntryInput.parse({ companyId: a, actorUserId: owner, transactionDate: '2026-03-10', sourceType: 'JOURNAL_ENTRY', lines: [{ accountId: dueFrom.id, debit: '10.00' }, { accountId: exp, credit: '10.00' }] })), LedgerError)).toBe('CONTROL_ACCOUNT_MANUAL_POST');
    let n = 95001;
    for (const src of ['INVOICE', 'CUSTOMER_PAYMENT', 'BANK_IMPORT', 'OPENING_BALANCE', 'BILL_PAYMENT', 'BAD_DEBT_WRITEOFF', 'CREDIT_MEMO']) {
      expect(await rejection(rawEntry(a, owner, src, line('10.0000', '0.0000'), n)), src).toMatch(/CONTROL_ACCOUNT_MANUAL_POST/);
      n += 1;
    }
    const ic = await rawEntry(a, owner, 'INTERCOMPANY', line('10.0000', '0.0000'), n);
    const rv = await rawEntry(a, owner, 'REVERSAL', line('0.0000', '10.0000'), n + 1);
    expect(ic).toBeTruthy();
    expect(rv).toBeTruthy();
    // Relabel attack: an INTERCOMPANY entry cannot be flipped to a manual one after the fact.
    const db = await getTestDb();
    expect(await rejection(db.execute(sql`update journal_entries set source_type = 'JOURNAL_ENTRY' where id = ${ic}`))).toMatch(/CONTROL_ACCOUNT_MANUAL_POST|POSTED_ENTRY_IMMUTABLE/);
    // Relabel while DRAFT, then post (Gate 7 L10): the immutability trigger allows both updates, so
    // ONLY the relabel trigger's intercompany branch stands between a Due line and a manual posting.
    expect(await rejection(db.transaction(async (tx) => {
      const d = await tx.execute<{ id: string }>(sql`insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status) values (${a}, '2026-03-10', '2026-03-10', 'INTERCOMPANY', ${owner}, 'DRAFT') returning id`);
      await tx.execute(sql`insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit) values (${d.rows[0]!.id}, ${a}, ${dueFrom.id}, 1, '10.0000', '0.0000'), (${d.rows[0]!.id}, ${a}, ${exp}, 2, '0.0000', '10.0000')`);
      await tx.execute(sql`update journal_entries set source_type = 'JOURNAL_ENTRY' where id = ${d.rows[0]!.id}`);
      await tx.execute(sql`update journal_entries set status = 'POSTED', entry_number = ${n + 4} where id = ${d.rows[0]!.id}`);
    }))).toMatch(/CONTROL_ACCOUNT_MANUAL_POST/);
    // A/R keeps its rule: a document may still post there, a manual entry still may not.
    const ar = await resolveSystemAccount(getDbTx(), a, 'ACCOUNTS_RECEIVABLE');
    expect(await rejection(rawEntry(a, owner, 'JOURNAL_ENTRY', [{ accountId: ar!, debit: '1.0000', credit: '0.0000' }, { accountId: exp, debit: '0.0000', credit: '1.0000' }], n + 2))).toMatch(/CONTROL_ACCOUNT_MANUAL_POST/);
    await expect(rawEntry(a, owner, 'INVOICE', [{ accountId: ar!, debit: '1.0000', credit: '0.0000' }, { accountId: exp, debit: '0.0000', credit: '1.0000' }], n + 3)).resolves.toBeTruthy();
  });
});

describe('organization services', () => {
  it('create joins the creator company and audits both events; the list shows the name', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'Alpha Co');
    const org = await createOrganization(owner, a, { name: 'Lehr Group' });
    expect(org.name).toBe('Lehr Group');
    expect(await auditActions(a)).toEqual(expect.arrayContaining(['ORGANIZATION_CREATED', 'COMPANY_JOINED_ORGANIZATION']));
    expect((await listCompaniesForUser(owner)).find((c) => c.company.id === a)?.organizationName).toBe('Lehr Group');
    expect(await organizationsActorCanAddTo(owner)).toEqual([{ id: org.id, name: 'Lehr Group' }]);
    expect(await codeOf(createOrganization(owner, a, { name: 'Again' }), OrganizationError)).toBe('ALREADY_IN_ORGANIZATION');
  });

  it('the template cannot join, and a member cannot become the template', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'Alpha Co');
    const b = await makeCompany(owner, 'Beta Co');
    await setCompanyTemplate(owner, a, true);
    expect(await codeOf(createOrganization(owner, a, { name: 'O' }), OrganizationError)).toBe('TEMPLATE_IN_ORGANIZATION');
    await createOrganization(owner, b, { name: 'O' });
    await setCompanyTemplate(owner, a, false);
    expect(await codeOf(setCompanyTemplate(owner, b, true), CompanyError)).toBe('TEMPLATE_IN_ORGANIZATION');
  });

  it('adding needs the capability in the joining company AND a stake in the organization; failures are the uniform denial', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const admin = await makeUser();
    const a = await makeCompany(owner, 'Alpha Co');
    const b = await makeCompany(owner, 'Beta Co');
    const s = await makeCompany(stranger, 'Stranger Co');
    await insertMembership(b, admin, 'ADMIN');
    const org = await createOrganization(owner, a, { name: 'O' });

    await expect(addCompanyToOrganization(admin, b, org.id)).rejects.toBeInstanceOf(AuthorizationDenied);
    const noStake = await addCompanyToOrganization(stranger, s, org.id).catch((e: unknown) => e);
    expect(noStake).toBeInstanceOf(AuthorizationDenied);
    expect(noStake).not.toBeInstanceOf(OrganizationError);
    const unknown = await addCompanyToOrganization(owner, b, '00000000-0000-4000-8000-000000000000').catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(AuthorizationDenied);
    await expect(addCompanyToOrganization(owner, b, 'not-a-uuid')).rejects.toBeInstanceOf(AuthorizationDenied);
    expect(await organizationsActorCanAddTo(stranger)).toEqual([]);

    await addCompanyToOrganization(owner, b, org.id);
    expect(await listOrganizationCompanies(owner, a)).toEqual([{ id: b, legalName: 'Beta Co' }]);
    expect(await listOrganizationCompanies(owner, b)).toEqual([{ id: a, legalName: 'Alpha Co' }]);
    expect(await listOrganizationCompanies(stranger, s)).toEqual([]);
    await expect(listOrganizationCompanies(stranger, a)).rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('currency must match the members; a member cannot change its currency', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'Alpha Co');
    const b = await makeCompany(owner, 'Beta Co');
    const db = await getTestDb();
    await db.execute(sql`update companies set currency_code = 'EUR' where id = ${b}`);
    const org = await createOrganization(owner, a, { name: 'O' });
    expect(await codeOf(addCompanyToOrganization(owner, b, org.id), OrganizationError)).toBe('CURRENCY_MISMATCH');
    expect(await codeOf(updateCompanySettings(owner, a, { fiscalYearStartMonth: 1, currencyCode: 'EUR', timezone: 'America/Chicago' }), CompanyError)).toBe('SETTINGS_LOCKED');
    await expect(updateCompanySettings(owner, a, { fiscalYearStartMonth: 3, currencyCode: 'USD', timezone: 'America/Chicago' })).resolves.toBeTruthy();
  });

  it('leave: refused while a Due balance stands (either direction); at zero the pair is deactivated on both sides; rejoin reactivates the same rows', async () => {
    const { owner, a, b } = await orgPair();
    const { dueFrom, dueTo } = await pair(owner, a, b);
    const expA = await anyExpense(owner, a);
    const expB = await anyExpense(owner, b);
    const icA = await rawEntry(a, owner, 'INTERCOMPANY', [{ accountId: dueFrom.id, debit: '25.0000', credit: '0.0000' }, { accountId: expA, debit: '0.0000', credit: '25.0000' }]);
    expect(await codeOf(removeCompanyFromOrganization(owner, a), OrganizationError)).toBe('ORG_HAS_INTERCOMPANY_BALANCE');
    expect(await codeOf(removeCompanyFromOrganization(owner, b), OrganizationError)).toBe('ORG_HAS_INTERCOMPANY_BALANCE');
    // The manual reversal API refuses a non-manual root (ADR-025) — an intercompany entry is
    // undone by its own un-assign (LL-097/099). Here: a REVERSAL entry, which the trigger admits.
    expect(await codeOf(reverseJournalEntry(reverseJournalEntryInput.parse({ companyId: a, actorUserId: owner, entryId: icA, reversalDate: '2026-03-11' })), LedgerError)).toBe('DOCUMENT_REVERSAL_REQUIRES_VOID');
    await rawEntry(a, owner, 'REVERSAL', [{ accountId: dueFrom.id, debit: '0.0000', credit: '25.0000' }, { accountId: expA, debit: '25.0000', credit: '0.0000' }], 95010);
    // B's side: a balance on "Due to A" blocks A too (either direction).
    await rawEntry(b, owner, 'INTERCOMPANY', [{ accountId: expB, debit: '5.0000', credit: '0.0000' }, { accountId: dueTo.id, debit: '0.0000', credit: '5.0000' }]);
    expect(await codeOf(removeCompanyFromOrganization(owner, a), OrganizationError)).toBe('ORG_HAS_INTERCOMPANY_BALANCE');
    await rawEntry(b, owner, 'REVERSAL', [{ accountId: expB, debit: '0.0000', credit: '5.0000' }, { accountId: dueTo.id, debit: '5.0000', credit: '0.0000' }], 95011);

    await removeCompanyFromOrganization(owner, b);
    const db = await getTestDb();
    const statuses = (await db.execute<{ id: string; status: string }>(sql`select id, status from accounts where id in (${dueFrom.id}, ${dueTo.id})`)).rows;
    expect(statuses.map((r) => r.status)).toEqual(['INACTIVE', 'INACTIVE']);
    expect((await listCompaniesForUser(owner)).find((c) => c.company.id === b)?.organizationName).toBeNull();
    expect(await auditActions(b)).toContain('COMPANY_LEFT_ORGANIZATION');
    await expect(removeCompanyFromOrganization(owner, b)).resolves.toBeUndefined(); // idempotent on retry (Gate 7 L11)

    // Rejoin: the same rows come back ACTIVE — history intact, no duplicate pair.
    const orgId = (await organizationsActorCanAddTo(owner))[0]!.id;
    await addCompanyToOrganization(owner, b, orgId);
    const again = await pair(owner, a, b);
    expect([again.dueFrom.id, again.dueTo.id]).toEqual([dueFrom.id, dueTo.id]);
    expect([again.dueFrom.status, again.dueTo.status]).toEqual(['ACTIVE', 'ACTIVE']);
  });

  it('a member cannot be archived or purged; a company another still names as counterpart cannot be purged', async () => {
    const { owner, a, b } = await orgPair();
    await pair(owner, a, b);
    expect(await codeOf(deleteCompany(owner, a, { confirmLegalName: 'Alpha Co' }), CompanyError)).toBe('COMPANY_IN_ORGANIZATION');
    // Purge path, seeded raw so no audit row exists: still refused on org membership…
    const c = await makeCompany(owner, 'Gamma Co');
    const db = await getTestDb();
    const orgId = (await organizationsActorCanAddTo(owner))[0]!.id;
    await db.execute(sql`update companies set organization_id = ${orgId} where id = ${c}`);
    expect(await codeOf(deleteCompany(owner, c, { confirmLegalName: 'Gamma Co' }), CompanyError)).toBe('COMPANY_IN_ORGANIZATION');
    // …and, out of the org but still named by A's "Due from Gamma", refused rather than a raw FK error.
    await db.execute(sql`update companies set organization_id = null where id = ${c}`);
    await db.execute(sql`insert into accounts (company_id, name, account_type, system_account_type, intercompany_company_id) values (${a}, 'Due from Gamma', 'ASSET', 'INTERCOMPANY_RECEIVABLE', ${c})`);
    expect(await codeOf(deleteCompany(owner, c, { confirmLegalName: 'Gamma Co' }), CompanyError)).toBe('COMPANY_IN_ORGANIZATION');
  });

  it('join vs leave concurrently always ends consistent', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'Alpha Co');
    const b = await makeCompany(owner, 'Beta Co');
    const org = await createOrganization(owner, a, { name: 'O' });
    await addCompanyToOrganization(owner, b, org.id);
    const c = await makeCompany(owner, 'Gamma Co');
    await Promise.allSettled([addCompanyToOrganization(owner, c, org.id), removeCompanyFromOrganization(owner, b), removeCompanyFromOrganization(owner, a)]);
    const db = await getTestDb();
    const rows = (await db.execute<{ id: string; organization_id: string | null; status: string }>(sql`select id, organization_id, status from companies where id in (${a}, ${b}, ${c})`)).rows;
    for (const r of rows) expect(r.status).toBe('ACTIVE');
    // Whatever interleaving: c joined (a stake existed at lock time) or was denied; a and b left.
    expect(rows.find((r) => r.id === a)!.organization_id).toBeNull();
    expect(rows.find((r) => r.id === b)!.organization_id).toBeNull();
  });

  it('leave waits for a transaction holding a counterpart company row (a posting in flight)', async () => {
    const { owner, a, b } = await orgPair();
    await pair(owner, a, b);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = getDbTx().transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id = ${b} for key share`);
      await gate;
    });
    await pause(200);
    let settled = false;
    const leave = removeCompanyFromOrganization(owner, a).then(() => { settled = true; });
    await pause(700);
    expect(settled).toBe(false);
    release();
    await holder;
    await leave;
    expect(settled).toBe(true);
  });
});

describe('ensureIntercompanyPair', () => {
  it('creates both sides with the right shape, numbers from the 1300/2300 ranges, and audits; idempotent', async () => {
    const { owner, a, b } = await orgPair();
    const p1 = await pair(owner, a, b);
    expect(p1.dueFrom).toMatchObject({ companyId: a, intercompanyCompanyId: b, name: 'Due from Beta Co', accountType: 'ASSET', accountSubtype: 'intercompany_receivable', systemAccountType: 'INTERCOMPANY_RECEIVABLE', cashFlowCategory: 'OPERATING', accountNumber: '1300', status: 'ACTIVE' });
    expect(p1.dueTo).toMatchObject({ companyId: b, intercompanyCompanyId: a, name: 'Due to Alpha Co', accountType: 'LIABILITY', accountSubtype: 'intercompany_payable', systemAccountType: 'INTERCOMPANY_PAYABLE', cashFlowCategory: 'OPERATING', accountNumber: '2300', status: 'ACTIVE' });
    const p2 = await pair(owner, a, b);
    expect([p2.dueFrom.id, p2.dueTo.id]).toEqual([p1.dueFrom.id, p1.dueTo.id]);
    // The reverse direction is a DIFFERENT pair (B owes A vs A owes B): four accounts in all.
    const p3 = await pair(owner, b, a);
    expect(p3.dueFrom.companyId).toBe(b);
    expect(p3.dueFrom.accountNumber).toBe('1300');
    expect(p3.dueTo.accountNumber).toBe('2300'); // A's 2300 is free: the first pair's payable lives in B
    expect(await auditActions(a)).toEqual(expect.arrayContaining(['ACCOUNT_CREATED']));
    expect(isStatementAccount(p1.dueFrom)).toBe(false);
    await expect(resolveSystemAccount(getDbTx(), a, 'INTERCOMPANY_RECEIVABLE')).rejects.toThrow(/ensureIntercompanyPair/);
  });

  it('ten concurrent creators yield exactly one pair', async () => {
    const { owner, a, b } = await orgPair();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => pair(owner, a, b)));
    expect(results.filter((r) => r.status === 'rejected').map((r) => String(r.reason))).toEqual([]);
    const ids = new Set(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.dueFrom.id, r.value.dueTo.id] : [])));
    expect(ids.size).toBe(2);
    const db = await getTestDb();
    expect(Number((await db.execute<{ n: string }>(sql`select count(*)::text n from accounts where intercompany_company_id is not null`)).rows[0]!.n)).toBe(2);
  });

  it('a taken number falls back to the next free one, and to none when the range is full', async () => {
    const { owner, a, b } = await orgPair();
    await createAccount(owner, a, createAccountInput.parse({ name: 'Taken', accountType: 'ASSET', accountNumber: '1300' }));
    const p = await pair(owner, a, b);
    expect(p.dueFrom.accountNumber).toBe('1301');
    const c = await makeCompany(owner, 'Gamma Co');
    await addCompanyToOrganization(owner, c, (await organizationsActorCanAddTo(owner))[0]!.id);
    const db = await getTestDb();
    for (let n = 1301; n <= 1399; n += 1) {
      await db.execute(sql`insert into accounts (company_id, name, account_type, account_number) values (${a}, 'fill', 'ASSET', ${String(n)}) on conflict do nothing`);
    }
    const q = await pair(owner, a, c);
    expect(q.dueFrom.accountNumber).toBeNull();
  });

  it('refuses across organizations, with an inactive company, and for a company alone', async () => {
    const owner = await makeUser();
    const a = await makeCompany(owner, 'Alpha Co');
    const b = await makeCompany(owner, 'Beta Co');
    expect(await codeOf(pair(owner, a, b), AccountError)).toBe('INTERCOMPANY_NOT_ALLOWED');
    await createOrganization(owner, a, { name: 'One' });
    await createOrganization(owner, b, { name: 'Two' });
    expect(await codeOf(pair(owner, a, b), AccountError)).toBe('INTERCOMPANY_NOT_ALLOWED');
    expect(await codeOf(pair(owner, a, a), AccountError)).toBe('INTERCOMPANY_NOT_ALLOWED');
  });

  it('the chart installers never produce or copy a pair', async () => {
    const { owner, a, b } = await orgPair();
    await pair(owner, a, b);
    expect(await installDefaultChart(a, 'system-only')).toBe(0);
    // A template never copies intercompany rows (the CHECK keeps a template out of an org;
    // the copy filter keeps a stale INACTIVE pair out too). Seed one raw on a fresh template.
    const t = await makeCompany(owner, 'Template Co');
    await setCompanyTemplate(owner, t, true);
    const db = await getTestDb();
    await db.execute(sql`insert into accounts (company_id, name, account_type, system_account_type, intercompany_company_id, status) values (${t}, 'Due from X', 'ASSET', 'INTERCOMPANY_RECEIVABLE', ${b}, 'ACTIVE')`);
    // No chart at all: the template copy brings the numbered accounts (a system-only chart would collide on 1100).
    const fresh = (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName: 'Fresh Co', timezone: 'America/Chicago' }))).company.id;
    await getDbTx().transaction(async (tx) => { await installChartFromTemplate(fresh, t, tx); });
    const copied = await listAccounts(owner, fresh);
    expect(copied.filter((x) => x.intercompanyCompanyId !== null)).toEqual([]);
  });
});

describe('consumers refuse a pair account', () => {
  it('not a bank/statement account, not a category, not a deposit or cash account, not deactivatable', async () => {
    const { owner, a, b } = await orgPair();
    const { dueFrom } = await pair(owner, a, b);
    expect(await codeOf(stageImport(owner, a, { bankAccountId: dueFrom.id, filename: 's.pdf', fileBytes: new Uint8Array() }, cannedExtractor), BankImportError)).toBe('INVALID_BANK_ACCOUNT');
    expect(await codeOf(startReconciliation(owner, a, { bankAccountId: dueFrom.id, statementDate: '2026-03-31', statementEndingAmount: '0.00' }), ReconciliationError)).toBe('NOT_A_BANK_ACCOUNT');
    expect(await codeOf(deactivateAccount(owner, a, dueFrom.id), AccountError)).toBe('SYSTEM_ACCOUNT_PROTECTED');
    const obe = await resolveSystemAccount(getDbTx(), a, 'OPENING_BALANCE_EQUITY');
    expect(obe).not.toBeNull();
    expect(await codeOf(setOpeningBalances(owner, a, setOpeningBalancesInput.parse({ companyId: a, actorUserId: owner, conversionDate: '2026-01-01', lines: [{ accountId: dueFrom.id, debit: '10.00' }] })), OpeningBalanceError)).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');

    const customer = await createCustomer(owner, a, createCustomerInput.parse({ name: 'Cust' }));
    const rev = await createAccount(owner, a, createAccountInput.parse({ name: 'Rev', accountType: 'REVENUE' }));
    const inv = await createInvoice(owner, a, createInvoiceInput.parse({ customerId: customer.id, invoiceDate: '2026-03-01', dueDate: '2026-03-31', lines: [{ description: 'x', quantity: '1', unitPrice: '10.00', accountId: rev.id }] }));
    await finalizeInvoice(owner, a, inv.invoice.id);
    expect(await codeOf(receivePayment(owner, a, receivePaymentInput.parse({ customerId: customer.id, paymentDate: '2026-03-02', amount: '10.00', depositAccountId: dueFrom.id, applications: [{ invoiceId: inv.invoice.id, amountApplied: '10.00' }] })), PaymentError)).toBe('DEPOSIT_ACCOUNT_INVALID');

    const vendor = await createVendor(owner, a, createVendorInput.parse({ name: 'Vend' }));
    const exp = await anyExpense(owner, a);
    const bill = await createBill(owner, a, createBillInput.parse({ vendorId: vendor.id, billDate: '2026-03-01', dueDate: '2026-03-31', lines: [{ description: 'y', quantity: '1', unitPrice: '10.00', accountId: exp }] }));
    await finalizeBill(owner, a, bill.bill.id);
    expect(await codeOf(payBill(owner, a, payBillInput.parse({ vendorId: vendor.id, paymentDate: '2026-03-02', amount: '10.00', cashAccountId: dueFrom.id, applications: [{ billId: bill.bill.id, amountApplied: '10.00' }] })), BillPaymentError)).toBe('CASH_ACCOUNT_INVALID');
  });
});
