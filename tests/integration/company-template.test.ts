/**
 * Master template company — LL-083 (ADR-039). Against a real DB. Proves: OWNER-only
 * designation with the single-template index arbitrating (including under concurrency),
 * the zero-postings invariant from both sides, copy fidelity (fields, parents, system
 * types, INACTIVE skipped, settings copied), no live link after creation, the
 * required-accounts safety net, release/archive freeing the slot, and settings edits.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount, deactivateAccount, listAccounts, updateAccount } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import {
  CompanyError,
  createCompanyWithOwner,
  deleteCompany,
  hasTemplateCompany,
  listCompaniesForUser,
  setCompanyTemplate,
  updateCompanySettings,
} from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { LedgerError, postJournalEntry } from '@/server/ledger';
import { ensureAppUser } from '@/server/users';
import { createAccountInput, updateAccountInput } from '@/validation/account';
import { createCompanyInput, updateCompanySettingsInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { postJournalEntryInput } from '@/validation/journal';

import { getTestDb, truncateAll } from '../helpers/database';

import type { CoaChoice } from '@/server/accounts/default-coa';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: {
      email: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`,
      password: 'synthetic-password-1',
      name: 'T',
    },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

const INPUT = createCompanyInput.parse({ legalName: 'Master Co', timezone: 'America/Chicago' });

/** `chart: null` creates a company with NO chart at all (an explicit `undefined` would fall into the default). */
async function makeCompany(ownerId: string, chart: CoaChoice | 'template' | null = 'standard', legalName = 'Some Co'): Promise<string> {
  const { company } = await createCompanyWithOwner(ownerId, { ...INPUT, legalName }, chart ?? undefined);
  return company.id;
}

async function postOne(userId: string, companyId: string): Promise<void> {
  const bank = await createAccount(userId, companyId, createAccountInput.parse({ name: 'Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const sales = await createAccount(userId, companyId, createAccountInput.parse({ name: 'Sales', accountType: 'REVENUE' }));
  await postJournalEntry(postJournalEntryInput.parse({
    companyId, actorUserId: userId, transactionDate: '2026-06-01', sourceType: 'JOURNAL_ENTRY',
    lines: [{ accountId: bank.id, debit: '100.00' }, { accountId: sales.id, credit: '100.00' }],
  }));
}

const errOf = async (p: Promise<unknown>): Promise<CompanyError> => {
  try {
    await p;
    throw new Error('expected CompanyError');
  } catch (e) {
    expect(e).toBeInstanceOf(CompanyError);
    return e as CompanyError;
  }
};

async function auditActions(companyId: string): Promise<string[]> {
  const db = await getTestDb();
  const r = await db.execute<{ action: string }>(sql`select action from audit_events where company_id = ${companyId} and action = 'COMPANY_UPDATED'`);
  return r.rows.map((x) => x.action);
}

beforeEach(async () => {
  await truncateAll();
});

describe('setCompanyTemplate — designation', () => {
  it('an OWNER designates the template; it is audited, visible as a flag, and hasTemplateCompany flips', async () => {
    const owner = await makeUser();
    const id = await makeCompany(owner);
    expect(await hasTemplateCompany()).toBe(false);

    const view = await setCompanyTemplate(owner, id, true);
    expect(view.isTemplate).toBe(true);
    expect(await hasTemplateCompany()).toBe(true);
    expect((await listCompaniesForUser(owner)).find((c) => c.company.id === id)?.company.isTemplate).toBe(true);
    expect(await auditActions(id)).toEqual(['COMPANY_UPDATED']);
    // Idempotent: designating again writes nothing more.
    await setCompanyTemplate(owner, id, true);
    expect(await auditActions(id)).toEqual(['COMPANY_UPDATED']);
  });

  it('only one template exists: a second designation fails, and of two concurrent ones exactly one wins', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const idA = await makeCompany(a);
    const idB = await makeCompany(b);
    await setCompanyTemplate(a, idA, true);
    expect((await errOf(setCompanyTemplate(b, idB, true))).code).toBe('TEMPLATE_EXISTS');

    await setCompanyTemplate(a, idA, false);
    const results = await Promise.allSettled([setCompanyTemplate(a, idA, true), setCompanyTemplate(b, idB, true)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ name: 'CompanyError', code: 'TEMPLATE_EXISTS' });
  });

  it('a company with posted history cannot become the template; the template cannot post', async () => {
    const owner = await makeUser();
    const posted = await makeCompany(owner);
    await postOne(owner, posted);
    expect((await errOf(setCompanyTemplate(owner, posted, true))).code).toBe('TEMPLATE_HAS_POSTINGS');

    const tpl = await makeCompany(owner);
    await setCompanyTemplate(owner, tpl, true);
    await expect(postOne(owner, tpl)).rejects.toMatchObject({ name: 'LedgerError', code: 'TEMPLATE_COMPANY' });
    const caught = await postOne(owner, tpl).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(LedgerError);
  });

  it('ADMIN, a stranger and a malformed id are all the same denial', async () => {
    const owner = await makeUser();
    const admin = await makeUser();
    const stranger = await makeUser();
    const id = await makeCompany(owner);
    await insertMembership(id, admin, 'ADMIN');
    for (const p of [
      setCompanyTemplate(admin, id, true),
      setCompanyTemplate(stranger, id, true),
      setCompanyTemplate(owner, 'not-a-uuid', true),
    ]) {
      await expect(p).rejects.toBeInstanceOf(AuthorizationDenied);
    }
    expect(await hasTemplateCompany()).toBe(false);
  });

  it('releasing frees the slot for another company; archiving the template frees it too', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const idA = await makeCompany(a);
    const idB = await makeCompany(b);
    await setCompanyTemplate(a, idA, true);
    await setCompanyTemplate(a, idA, false);
    expect(await hasTemplateCompany()).toBe(false);
    await setCompanyTemplate(b, idB, true);

    // idB now has an audit row (the designation), so deleteCompany archives it.
    await expect(deleteCompany(b, idB, { confirmLegalName: 'Some Co' })).resolves.toEqual({ mode: 'archived' });
    expect(await hasTemplateCompany()).toBe(false);
    await setCompanyTemplate(a, idA, true);
    expect(await hasTemplateCompany()).toBe(true);
  });
});

describe('createCompanyWithOwner from the template', () => {
  it('copies every ACTIVE account with its fields, remaps parents, keeps the four system types, skips INACTIVE, copies settings', async () => {
    const owner = await makeUser();
    const tpl = await makeCompany(owner, 'standard', 'Master Co');
    await setCompanyTemplate(owner, tpl, true);
    await updateCompanySettings(owner, tpl, updateCompanySettingsInput.parse({ fiscalYearStartMonth: '4', currencyCode: 'CAD', timezone: 'America/Toronto' }));

    const parent = await createAccount(owner, tpl, createAccountInput.parse({ accountNumber: '7000', name: 'Vehicles', accountType: 'EXPENSE', accountSubtype: 'operating_expense', description: 'All vehicle costs', cashFlowCategory: 'OPERATING' }));
    await createAccount(owner, tpl, createAccountInput.parse({ accountNumber: '7010', name: 'Fuel', accountType: 'EXPENSE', parentAccountId: parent.id }));
    const gone = await createAccount(owner, tpl, createAccountInput.parse({ accountNumber: '7999', name: 'Old', accountType: 'EXPENSE' }));
    await deactivateAccount(owner, tpl, gone.id);

    const creator = await makeUser();
    const { company } = await createCompanyWithOwner(creator, INPUT, 'template');
    expect(company.fiscalYearStartMonth).toBe(4);
    expect(company.currencyCode).toBe('CAD');
    expect(company.timezone).toBe('America/Toronto');
    expect(company.isTemplate).toBe(false);

    const templateAccounts = (await listAccounts(owner, tpl)).filter((a) => a.status === 'ACTIVE');
    const copied = await listAccounts(creator, company.id);
    expect(copied).toHaveLength(templateAccounts.length);
    for (const t of templateAccounts) {
      const c = copied.find((x) => x.accountNumber === t.accountNumber);
      expect(c, t.name).toBeDefined();
      expect(c).toMatchObject({
        companyId: company.id,
        name: t.name,
        accountType: t.accountType,
        accountSubtype: t.accountSubtype,
        systemAccountType: t.systemAccountType,
        cashFlowCategory: t.cashFlowCategory,
        description: t.description,
      });
      expect(c!.id).not.toBe(t.id);
    }
    expect(copied.find((a) => a.accountNumber === '7999')).toBeUndefined();
    const copiedParent = copied.find((a) => a.accountNumber === '7000')!;
    const copiedChild = copied.find((a) => a.accountNumber === '7010')!;
    expect(copiedChild.parentAccountId).toBe(copiedParent.id);
    expect(copied.filter((a) => a.systemAccountType !== null).map((a) => a.systemAccountType).sort()).toEqual(
      ['ACCOUNTS_PAYABLE', 'ACCOUNTS_RECEIVABLE', 'OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS', 'SALES_TAX_PAYABLE'],
    );
  });

  it('is a copy, not a link: later template edits do not touch the created company', async () => {
    const owner = await makeUser();
    const tpl = await makeCompany(owner);
    await setCompanyTemplate(owner, tpl, true);
    const creator = await makeUser();
    const { company } = await createCompanyWithOwner(creator, INPUT, 'template');
    const before = (await listAccounts(creator, company.id)).map((a) => [a.accountNumber, a.name]);

    await createAccount(owner, tpl, createAccountInput.parse({ accountNumber: '8000', name: 'Added Later', accountType: 'EXPENSE' }));
    const checking = (await listAccounts(owner, tpl)).find((a) => a.accountNumber === '1000')!;
    await updateAccount(owner, tpl, checking.id, updateAccountInput.parse({ name: 'Renamed Checking' }));

    expect((await listAccounts(creator, company.id)).map((a) => [a.accountNumber, a.name])).toEqual(before);
  });

  it('safety net: a renumbered A/R still yields exactly one, and a chart-less template still yields the four required accounts', async () => {
    const owner = await makeUser();
    const tpl = await makeCompany(owner);
    await setCompanyTemplate(owner, tpl, true);
    const ar = (await listAccounts(owner, tpl)).find((a) => a.systemAccountType === 'ACCOUNTS_RECEIVABLE')!;
    await updateAccount(owner, tpl, ar.id, updateAccountInput.parse({ accountNumber: '1150' }));

    const creator = await makeUser();
    const { company } = await createCompanyWithOwner(creator, INPUT, 'template');
    const arRows = (await listAccounts(creator, company.id)).filter((a) => a.systemAccountType === 'ACCOUNTS_RECEIVABLE');
    expect(arRows).toHaveLength(1);
    expect(arRows[0]!.accountNumber).toBe('1150');

    await setCompanyTemplate(owner, tpl, false);
    const bare = await makeCompany(owner, null, 'Bare Co');
    await setCompanyTemplate(owner, bare, true);
    const { company: fromBare } = await createCompanyWithOwner(creator, INPUT, 'template');
    expect((await listAccounts(creator, fromBare.id)).map((a) => a.systemAccountType).sort()).toEqual(
      ['ACCOUNTS_PAYABLE', 'ACCOUNTS_RECEIVABLE', 'OPENING_BALANCE_EQUITY', 'RETAINED_EARNINGS'],
    );
  });

  it('safety net: a chart-less template whose custom account squats on 1100 still yields an (unnumbered) A/R', async () => {
    const owner = await makeUser();
    const bare = await makeCompany(owner, null, 'Bare Co');
    await createAccount(owner, bare, createAccountInput.parse({ accountNumber: '1100', name: 'Not Receivables', accountType: 'ASSET' }));
    await setCompanyTemplate(owner, bare, true);

    const creator = await makeUser();
    const { company } = await createCompanyWithOwner(creator, INPUT, 'template');
    const accounts = await listAccounts(creator, company.id);
    const ar = accounts.filter((a) => a.systemAccountType === 'ACCOUNTS_RECEIVABLE');
    expect(ar).toHaveLength(1);
    expect(ar[0]!.accountNumber).toBeNull();
    expect(accounts.find((a) => a.accountNumber === '1100')?.name).toBe('Not Receivables');
    expect(accounts.filter((a) => a.systemAccountType !== null)).toHaveLength(4);
  });

  it("'template' with no template designated is NO_TEMPLATE; the hardcoded charts are unchanged", async () => {
    const owner = await makeUser();
    expect((await errOf(createCompanyWithOwner(owner, INPUT, 'template'))).code).toBe('NO_TEMPLATE');
    const std = await makeCompany(owner, 'standard');
    const sys = await makeCompany(owner, 'system-only');
    expect(await listAccounts(owner, std)).toHaveLength(24);
    expect(await listAccounts(owner, sys)).toHaveLength(4);
  });
});

describe('updateCompanySettings', () => {
  it('ADMIN may edit; it is audited; BOOKKEEPER is denied; posted history locks it', async () => {
    const owner = await makeUser();
    const admin = await makeUser();
    const keeper = await makeUser();
    const id = await makeCompany(owner);
    await insertMembership(id, admin, 'ADMIN');
    await insertMembership(id, keeper, 'BOOKKEEPER');
    const input = updateCompanySettingsInput.parse({ fiscalYearStartMonth: '10', currencyCode: 'EUR', timezone: 'Europe/Berlin' });

    const view = await updateCompanySettings(admin, id, input);
    expect(view).toMatchObject({ fiscalYearStartMonth: 10, currencyCode: 'EUR', timezone: 'Europe/Berlin' });
    expect(await auditActions(id)).toEqual(['COMPANY_UPDATED']);
    await expect(updateCompanySettings(keeper, id, input)).rejects.toBeInstanceOf(AuthorizationDenied);

    await createCustomer(owner, id, createCustomerInput.parse({ name: 'Anyone' })); // history that is not a posting: still editable
    await updateCompanySettings(owner, id, input);
    await postOne(owner, id);
    expect((await errOf(updateCompanySettings(owner, id, input))).code).toBe('SETTINGS_LOCKED');
  });
});
