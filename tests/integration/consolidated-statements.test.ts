/**
 * Consolidated organization statements — LL-122 (ADR-047). Against a real DB.
 *
 * Proves: every company's column equals its own statement; intercompany receivables and payables
 * are eliminated in full and the consolidated sheet balances; a transfer one side has posted and the
 * other not yet matched shows as "in transit" for exactly its amount, and disappears once matched;
 * accounts combine by number (a renumbered control account by its role), a number used for another
 * type stays split, an unnumbered account stays per company; the consolidated income statement is the
 * sum of the members' and eliminates nothing; access needs report.view in every member; a company
 * outside any organization has nothing to consolidate; an outsider is denied.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { sumMoney, toMoney } from '@/lib/decimal';
import { createAccount, listAccounts, updateAccount } from '@/server/accounts';
import { AuthorizationDenied } from '@/server/authorization';
import { getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { postJournalEntry } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import {
  ConsolidationError,
  getBalanceSheet,
  getCashFlowStatement,
  getConsolidatedBalanceSheet,
  getConsolidatedCashFlow,
  getConsolidatedIncomeStatement,
  getIncomeStatement,
  type ConsolidatedRow,
} from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createAccountInput, updateAccountInput } from '@/validation/account';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { postJournalEntryInput } from '@/validation/journal';
import { createOrganizationInput } from '@/validation/organization';

import { getTestDb, truncateAll } from '../helpers/database';

const AS_OF = '2026-12-31';
const EMPTY = new Uint8Array();

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `cs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'C' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
async function company(owner: string, legalName: string): Promise<string> {
  return (await createCompanyWithOwner(owner, createCompanyInput.parse({ legalName, timezone: 'America/Chicago' }), 'standard')).company.id;
}
async function accountId(companyId: string, number: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ id: string }>(sql`select id::text as id from accounts where company_id = ${companyId} and account_number = ${number}`)).rows[0]!.id;
}
async function post(owner: string, companyId: string, date: string, debitId: string, creditId: string, amount: string) {
  await postJournalEntry(postJournalEntryInput.parse({
    companyId, actorUserId: owner, transactionDate: date, sourceType: 'JOURNAL_ENTRY',
    lines: [{ accountId: debitId, debit: amount }, { accountId: creditId, credit: amount }],
  }));
}

interface Group { owner: string; a: string; b: string }
/** Alpha and Beta in one organization; Alpha sells 500 (cash), Beta pays 200 rent. */
async function group(): Promise<Group> {
  const owner = await makeUser();
  const a = await company(owner, 'Alpha Co');
  const b = await company(owner, 'Beta Co');
  const org = await createOrganization(owner, a, createOrganizationInput.parse({ name: 'Alpha Group' }));
  await addCompanyToOrganization(owner, b, org.id);
  await post(owner, a, '2026-06-01', await accountId(a, '1000'), await accountId(a, '4000'), '500.00');
  const rentB = (await listAccounts(owner, b)).find((x) => x.accountType === 'EXPENSE')!.id;
  await post(owner, b, '2026-06-02', rentB, await accountId(b, '1000'), '200.00');
  return { owner, a, b };
}
/** Alpha marks a 300 transfer to Beta (in transit); `match` has Beta import and match it. */
async function transfer(g: Group, match: boolean) {
  const out = await stageImport(g.owner, g.a, { bankAccountId: await accountId(g.a, '1000'), fileBytes: EMPTY }, () => Promise.resolve([{ date: '2026-07-01', description: 'TFR TO BETA', amount: '-300.00' }]));
  const outLine = (await getImportBatch(g.owner, g.a, out.id))!.lines[0]!;
  await postImportLines(g.owner, g.a, out.id, { decisions: [{ lineId: outLine.id, action: 'intercompany_transfer', counterpartCompanyId: g.b }] });
  if (!match) return;
  const inB = await stageImport(g.owner, g.b, { bankAccountId: await accountId(g.b, '1000'), fileBytes: EMPTY }, () => Promise.resolve([{ date: '2026-07-02', description: 'FROM ALPHA', amount: '300.00' }]));
  const inLine = (await getImportBatch(g.owner, g.b, inB.id))!.lines[0]!;
  await postImportLines(g.owner, g.b, inB.id, { decisions: [{ lineId: inLine.id, action: 'match_intercompany', counterpartEntryId: inLine.intercompanyCandidate!.entryId }] });
}
const row = (rows: readonly ConsolidatedRow[], key: string): ConsolidatedRow | undefined => rows.find((r) => r.key === key);

beforeEach(async () => {
  await truncateAll();
});

describe('consolidated balance sheet', () => {
  it('each column equals the company\'s own statement; matched intercompany balances eliminate to zero and the group balances', async () => {
    const g = await group();
    await transfer(g, true);
    const cbs = await getConsolidatedBalanceSheet(g.owner, g.a, AS_OF);
    expect(cbs.members.map((m) => m.legalName)).toEqual(['Alpha Co', 'Beta Co']); // the active company first
    for (const id of [g.a, g.b]) {
      const own = await getBalanceSheet(g.owner, id, AS_OF);
      expect(cbs.assets.byCompany[id]).toBe(own.assets.total);
      expect(cbs.liabilities.byCompany[id]).toBe(own.liabilities.total);
      expect(cbs.equity.byCompany[id]).toBe(own.equity.total);
    }
    const receivable = row(cbs.assets.rows, 'ic:receivable')!;
    const payable = row(cbs.liabilities.rows, 'ic:payable')!;
    expect(receivable.byCompany[g.a]).toBe('300.0000');
    expect(payable.byCompany[g.b]).toBe('300.0000');
    expect([receivable.elimination, receivable.total, payable.elimination, payable.total]).toEqual(['-300.0000', '0.0000', '-300.0000', '0.0000']);
    expect(row(cbs.assets.rows, 'ic:in-transit')).toBeUndefined();
    expect(cbs.intercompanyInTransit).toBe('0.0000');
    expect(cbs.intercompanyState).toBe('mirrored');
    // Consolidated = Σ members − eliminations; cash combines by number (1000 in both).
    expect(cbs.assets.total).toBe(sumMoney(Object.values(cbs.assets.byCompany)).minus(toMoney('300')).toFixed(4));
    expect(row(cbs.assets.rows, 'num:1000:ASSET')!.total).toBe('300.0000'); // 500 − 300 + 300 − 200
    expect(cbs.balanced).toBe(true);
    expect(cbs.assets.total).toBe(cbs.liabilitiesAndEquity.total);
  });

  it('a transfer posted by one side only shows as "in transit" for exactly its amount', async () => {
    const g = await group();
    await transfer(g, false);
    const cbs = await getConsolidatedBalanceSheet(g.owner, g.a, AS_OF);
    expect(cbs.intercompanyInTransit).toBe('300.0000');
    expect(cbs.intercompanyState).toBe('in_transit');
    expect(row(cbs.assets.rows, 'ic:in-transit')).toMatchObject({ elimination: '300.0000', total: '300.0000' });
    expect(row(cbs.assets.rows, 'ic:receivable')!.total).toBe('0.0000');
    expect(cbs.balanced).toBe(true);
  });

  it('combines by number, a control account by its role, keeps a number used for another type split and an unnumbered account per company', async () => {
    const g = await group();
    // A/R in both (an invoice each); Beta renumbers its A/R — it still combines by role.
    for (const id of [g.a, g.b]) {
      const customer = await createCustomer(g.owner, id, createCustomerInput.parse({ name: 'Buyer' }));
      const { invoice } = await createInvoice(g.owner, id, createInvoiceInput.parse({ customerId: customer.id, invoiceDate: '2026-06-10', lines: [{ accountId: await accountId(id, '4000'), quantity: '1', unitPrice: '100.00' }] }));
      await finalizeInvoice(g.owner, id, invoice.id);
    }
    await updateAccount(g.owner, g.b, await accountId(g.b, '1100'), updateAccountInput.parse({ accountNumber: '1150' }));
    // 6990 is an asset in Alpha and an expense in Beta; "Petty cash" has no number in either.
    const assetA = await createAccount(g.owner, g.a, createAccountInput.parse({ accountNumber: '6990', name: 'Deposits', accountType: 'ASSET' }));
    const expenseB = await createAccount(g.owner, g.b, createAccountInput.parse({ accountNumber: '6990', name: 'Sundry', accountType: 'EXPENSE' }));
    await post(g.owner, g.a, '2026-06-11', assetA.id, await accountId(g.a, '1000'), '10.00');
    await post(g.owner, g.b, '2026-06-11', expenseB.id, await accountId(g.b, '1000'), '10.00');
    const pettyA = await createAccount(g.owner, g.a, createAccountInput.parse({ name: 'Petty cash', accountType: 'ASSET' }));
    const pettyB = await createAccount(g.owner, g.b, createAccountInput.parse({ name: 'Petty cash', accountType: 'ASSET' }));
    await post(g.owner, g.a, '2026-06-12', pettyA.id, await accountId(g.a, '1000'), '5.00');
    await post(g.owner, g.b, '2026-06-12', pettyB.id, await accountId(g.b, '1000'), '7.00');

    const cbs = await getConsolidatedBalanceSheet(g.owner, g.a, AS_OF);
    expect(row(cbs.assets.rows, 'role:ACCOUNTS_RECEIVABLE')).toMatchObject({ byCompany: { [g.a]: '100.0000', [g.b]: '100.0000' }, total: '200.0000', accountNumber: '1100' });
    const deposits = row(cbs.assets.rows, 'num:6990:ASSET')!;
    expect(deposits).toMatchObject({ numberSharedAcrossTypes: true, total: '10.0000' });
    expect(deposits.byCompany[g.b]).toBeUndefined();
    const petty = cbs.assets.rows.filter((r) => r.key.startsWith('acct:'));
    expect(petty.map((r) => [r.label, r.total])).toEqual([['Petty cash (Alpha Co)', '5.0000'], ['Petty cash (Beta Co)', '7.0000']]);
    expect(cbs.balanced).toBe(true);

    const cis = await getConsolidatedIncomeStatement(g.owner, g.a, '2026-01-01', AS_OF);
    expect(row(cis.expenses.rows, 'num:6990:EXPENSE')).toMatchObject({ numberSharedAcrossTypes: true, total: '10.0000' });
  });

  it('with no intercompany activity there are no intercompany lines, and the state is mirrored', async () => {
    const g = await group();
    const cbs = await getConsolidatedBalanceSheet(g.owner, g.a, AS_OF);
    expect(cbs.assets.rows.some((r) => r.key.startsWith('ic:'))).toBe(false);
    expect(cbs.intercompanyState).toBe('mirrored');
    expect(cbs.balanced).toBe(true);
  });
});

describe('consolidated income statement', () => {
  it('is the sum of the members\' statements and eliminates nothing', async () => {
    const g = await group();
    await transfer(g, true);
    const cis = await getConsolidatedIncomeStatement(g.owner, g.b, '2026-01-01', AS_OF);
    expect(cis.members.map((m) => m.legalName)).toEqual(['Beta Co', 'Alpha Co']);
    const own = await Promise.all([g.a, g.b].map((id) => getIncomeStatement(g.owner, id, '2026-01-01', AS_OF)));
    expect(cis.netIncome.total).toBe(sumMoney(own.map((s) => s.netIncome)).toFixed(4)); // 500 − 200
    expect(cis.netIncome.total).toBe('300.0000');
    expect(cis.netIncome.byCompany[g.a]).toBe(own[0]!.netIncome);
    for (const section of [cis.revenue, cis.cogs, cis.expenses]) expect(section.elimination).toBe('0.0000');
  });
});

describe('consolidated cash flow (LL-125)', () => {
  it('each column is the company\'s own cash flow; a matched transfer cancels out; the group reconciles to its cash', async () => {
    const g = await group();
    await transfer(g, true);
    const cf = await getConsolidatedCashFlow(g.owner, g.a, '2026-01-01', AS_OF);
    for (const id of [g.a, g.b]) {
      const own = await getCashFlowStatement(g.owner, id, '2026-01-01', AS_OF);
      expect(cf.operating.byCompany[id]).toBe(own.operatingTotal);
      expect(cf.netChangeInCash.byCompany[id]).toBe(own.netChangeInCash);
      expect(cf.endingCash.byCompany[id]).toBe(own.endingCash);
    }
    const ic = row(cf.operating.rows, 'ic:balances')!;
    expect(ic.byCompany).toEqual({ [g.a]: '-300.0000', [g.b]: '300.0000' });
    expect([ic.elimination, ic.total]).toEqual(['0.0000', '0.0000']);
    expect(row(cf.operating.rows, 'ic:in-transit')).toBeUndefined();
    expect(row(cf.operating.rows, 'derived:net-income')!.total).toBe('300.0000'); // 500 − 200
    expect(cf.netChangeInCash.total).toBe('300.0000'); // Alpha 200 + Beta 100
    expect(cf.reconciled).toBe(true);
  });

  it('a transfer one side has not recorded yet is cash in transit — it reduces the group\'s cash until it lands', async () => {
    const g = await group();
    await transfer(g, false);
    const cf = await getConsolidatedCashFlow(g.owner, g.a, '2026-01-01', AS_OF);
    expect(row(cf.operating.rows, 'ic:balances')).toMatchObject({ elimination: '300.0000', total: '0.0000' });
    expect(row(cf.operating.rows, 'ic:in-transit')).toMatchObject({ elimination: '-300.0000', total: '-300.0000' });
    expect(cf.netChangeInCash.total).toBe('0.0000'); // Alpha +500 −300, Beta −200: the 300 is on its way
    expect(cf.endingCash.total).toBe('0.0000');
    expect(cf.reconciled).toBe(true);
  });

  it('needs every member, like the other consolidated statements', async () => {
    const g = await group();
    const viewer = await makeUser();
    await insertMembership(g.a, viewer, 'READ_ONLY');
    await expect(getConsolidatedCashFlow(viewer, g.a, '2026-01-01', AS_OF)).rejects.toMatchObject({ code: 'MEMBER_ACCESS_REQUIRED', companies: ['Beta Co'] });
  });
});

describe('who may consolidate', () => {
  it('needs report.view in every member; outside an organization there is nothing to consolidate; an outsider is denied', async () => {
    const g = await group();
    const viewer = await makeUser();
    await insertMembership(g.a, viewer, 'READ_ONLY'); // Alpha only
    const err = await getConsolidatedBalanceSheet(viewer, g.a, AS_OF).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConsolidationError);
    expect(err).toMatchObject({ code: 'MEMBER_ACCESS_REQUIRED', companies: ['Beta Co'] });
    await insertMembership(g.b, viewer, 'READ_ONLY');
    expect((await getConsolidatedIncomeStatement(viewer, g.a, '2026-01-01', AS_OF)).members).toHaveLength(2);

    const alone = await company(g.owner, 'Solo Co');
    await expect(getConsolidatedBalanceSheet(g.owner, alone, AS_OF)).rejects.toMatchObject({ code: 'NOT_IN_ORGANIZATION' });

    const outsider = await makeUser();
    await expect(getConsolidatedBalanceSheet(outsider, g.a, AS_OF)).rejects.toBeInstanceOf(AuthorizationDenied);
    await expect(getConsolidatedIncomeStatement(outsider, g.a, '2026-01-01', AS_OF)).rejects.toBeInstanceOf(AuthorizationDenied);
  });
});
