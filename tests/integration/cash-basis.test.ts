/**
 * Cash-basis income statement — LL-126 (ADR-048). Against a real DB.
 *
 * Proves the owner's rules: an invoice's revenue counts when the customer pays (the sales-tax share
 * left out, a split invoice split in proportion) and a bill's expense when it is paid; a voided
 * payment is taken back on the void's date; credit memos, write-offs and vendor credits are left out;
 * everything else — a manual (non-cash) journal entry, a bank-statement posting — counts as posted on
 * both bases; the consolidated statement on a cash basis is the sum of its members'. The accrual
 * statement is unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { sumMoney } from '@/lib/decimal';
import { createAccount, listAccounts } from '@/server/accounts';
import { getImportBatch, postImportLines, stageImport } from '@/server/bank-import';
import { payBill } from '@/server/bill-payments';
import { createBill, finalizeBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { issueCreditMemo } from '@/server/credit-memos';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { postJournalEntry } from '@/server/ledger';
import { addCompanyToOrganization, createOrganization } from '@/server/organizations';
import { receivePayment, voidPayment } from '@/server/payments';
import { getConsolidatedIncomeStatement, getIncomeStatement, type IncomeStatement } from '@/server/reports';
import { ensureAppUser } from '@/server/users';
import { createVendor } from '@/server/vendors';
import { issueVendorCredit } from '@/server/vendor-credits';
import { writeOffInvoice } from '@/server/writeoffs';
import { createAccountInput } from '@/validation/account';
import { createBillInput } from '@/validation/bill';
import { payBillInput } from '@/validation/bill-payment';
import { createCompanyInput } from '@/validation/company';
import { issueCreditMemoInput } from '@/validation/credit-memo';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { postJournalEntryInput } from '@/validation/journal';
import { createOrganizationInput } from '@/validation/organization';
import { receivePaymentInput, voidPaymentInput } from '@/validation/payment';
import { issueVendorCreditInput } from '@/validation/vendor-credit';
import { createVendorInput } from '@/validation/vendor';
import { writeOffInvoiceInput } from '@/validation/writeoff';

import { truncateAll } from '../helpers/database';

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `cb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'C' },
    returnHeaders: true,
  });
  return (await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name })).id;
}
interface Ctx { owner: string; companyId: string; bank: string; sales: string; services: string; rent: string; customer: string; vendor: string }
async function setup(owner?: string, legalName = 'Cash Co'): Promise<Ctx> {
  const user = owner ?? (await makeUser());
  const { company } = await createCompanyWithOwner(user, createCompanyInput.parse({ legalName, timezone: 'America/Chicago' }), 'standard');
  const accounts = await listAccounts(user, company.id);
  const byNumber = (n: string) => accounts.find((a) => a.accountNumber === n)!.id;
  const customer = await createCustomer(user, company.id, createCustomerInput.parse({ name: 'Buyer' }));
  const vendor = await createVendor(user, company.id, createVendorInput.parse({ name: 'Landlord' }));
  return {
    owner: user, companyId: company.id, bank: byNumber('1000'), sales: byNumber('4000'), services: byNumber('4100'),
    rent: accounts.find((a) => a.accountType === 'EXPENSE')!.id, customer: customer.id, vendor: vendor.id,
  };
}
async function invoice(c: Ctx, date: string, lines: { accountId: string; price: string; taxRate?: string }[]): Promise<string> {
  const { invoice: inv } = await createInvoice(c.owner, c.companyId, createInvoiceInput.parse({
    customerId: c.customer, invoiceDate: date,
    lines: lines.map((l) => ({ accountId: l.accountId, quantity: '1', unitPrice: l.price, ...(l.taxRate === undefined ? {} : { taxRate: l.taxRate }) })),
  }));
  await finalizeInvoice(c.owner, c.companyId, inv.id);
  return inv.id;
}
async function pay(c: Ctx, invoiceId: string, date: string, amount: string) {
  return (await receivePayment(c.owner, c.companyId, receivePaymentInput.parse({
    customerId: c.customer, paymentDate: date, depositAccountId: c.bank, applications: [{ invoiceId, amountApplied: amount }],
  }))).payment;
}
const month = (m: string) => [`2026-${m}-01`, `2026-${m}-${m === '06' ? '30' : '31'}`] as const;
async function is(c: Ctx, m: string, basis: 'accrual' | 'cash'): Promise<IncomeStatement> {
  const [from, to] = month(m);
  return await getIncomeStatement(c.owner, c.companyId, from, to, basis);
}
const amountOf = (s: IncomeStatement, accountId: string) =>
  [...s.revenue.rows, ...s.cogs.rows, ...s.expenses.rows].find((r) => r.accountId === accountId)?.amount ?? '0.0000';

beforeEach(async () => {
  await truncateAll();
});

describe('revenue when the customer pays', () => {
  it('a June invoice with 8% tax, paid half in July and half in August: cash revenue follows the payments, without the tax', async () => {
    const c = await setup();
    const inv = await invoice(c, '2026-06-10', [{ accountId: c.sales, price: '1000.00', taxRate: '8' }]); // 1,080
    await pay(c, inv, '2026-07-05', '540.00');
    await pay(c, inv, '2026-08-05', '540.00');
    expect((await is(c, '06', 'accrual')).revenue.total).toBe('1000.0000');
    expect((await is(c, '07', 'accrual')).revenue.total).toBe('0.0000');
    expect((await is(c, '06', 'cash')).revenue.total).toBe('0.0000');
    expect((await is(c, '07', 'cash')).revenue.total).toBe('500.0000');
    expect((await is(c, '08', 'cash')).revenue.total).toBe('500.0000');
    expect((await is(c, '07', 'cash')).basis).toBe('cash');
  });

  it('a split invoice splits its payment in proportion', async () => {
    const c = await setup();
    const inv = await invoice(c, '2026-06-10', [{ accountId: c.sales, price: '600.00' }, { accountId: c.services, price: '400.00' }]);
    await pay(c, inv, '2026-07-05', '250.00');
    const july = await is(c, '07', 'cash');
    expect([amountOf(july, c.sales), amountOf(july, c.services)]).toEqual(['150.0000', '100.0000']);
  });

  it('a voided payment counts on its date and is taken back on the void\'s', async () => {
    const c = await setup();
    const inv = await invoice(c, '2026-06-10', [{ accountId: c.sales, price: '1000.00', taxRate: '8' }]);
    const p = await pay(c, inv, '2026-07-05', '540.00');
    await voidPayment(c.owner, c.companyId, p.id, voidPaymentInput.parse({ reversalDate: '2026-08-10' }));
    expect((await is(c, '07', 'cash')).revenue.total).toBe('500.0000');
    expect((await is(c, '08', 'cash')).revenue.total).toBe('-500.0000');
    expect((await is(c, '06', 'accrual')).revenue.total).toBe('1000.0000'); // accrual is unaffected by the payment
  });

  it('credit memos and write-offs are left out: only what was collected counts', async () => {
    const c = await setup();
    const returns = await createAccount(c.owner, c.companyId, createAccountInput.parse({ name: 'Sales Returns', accountType: 'REVENUE' }));
    const badDebt = await createAccount(c.owner, c.companyId, createAccountInput.parse({ name: 'Bad Debt', accountType: 'EXPENSE' }));
    const inv = await invoice(c, '2026-06-10', [{ accountId: c.sales, price: '1000.00' }]);
    await issueCreditMemo(c.owner, c.companyId, issueCreditMemoInput.parse({ invoiceId: inv, revenueAccountId: returns.id, creditDate: '2026-06-20', amount: '100.00' }));
    await writeOffInvoice(c.owner, c.companyId, writeOffInvoiceInput.parse({ invoiceId: inv, expenseAccountId: badDebt.id, writeoffDate: '2026-06-25', amount: '50.00' }));
    await pay(c, inv, '2026-07-05', '850.00');
    const juneAccrual = await is(c, '06', 'accrual');
    expect([amountOf(juneAccrual, c.sales), amountOf(juneAccrual, returns.id), amountOf(juneAccrual, badDebt.id)]).toEqual(['1000.0000', '-100.0000', '50.0000']);
    const juneCash = await is(c, '06', 'cash');
    expect([juneCash.revenue.total, juneCash.expenses.total]).toEqual(['0.0000', '0.0000']);
    const julyCash = await is(c, '07', 'cash');
    expect(amountOf(julyCash, c.sales)).toBe('850.0000');
    expect(amountOf(julyCash, returns.id)).toBe('0.0000');
    expect(amountOf(julyCash, badDebt.id)).toBe('0.0000');
  });
});

describe('expenses when the bill is paid', () => {
  it('a June bill paid in July is a July expense on a cash basis; a vendor credit is left out', async () => {
    const c = await setup();
    const { bill } = await createBill(c.owner, c.companyId, createBillInput.parse({ vendorId: c.vendor, billDate: '2026-06-10', lines: [{ accountId: c.rent, unitPrice: '300.00' }] }));
    await finalizeBill(c.owner, c.companyId, bill.id);
    const { bill: credited } = await createBill(c.owner, c.companyId, createBillInput.parse({ vendorId: c.vendor, billDate: '2026-06-12', lines: [{ accountId: c.rent, unitPrice: '200.00' }] }));
    await finalizeBill(c.owner, c.companyId, credited.id);
    await issueVendorCredit(c.owner, c.companyId, issueVendorCreditInput.parse({ billId: credited.id, expenseAccountId: c.rent, creditDate: '2026-06-20', amount: '50.00' }));
    await payBill(c.owner, c.companyId, payBillInput.parse({
      vendorId: c.vendor, paymentDate: '2026-07-15', cashAccountId: c.bank,
      applications: [{ billId: bill.id, amountApplied: '300.00' }, { billId: credited.id, amountApplied: '150.00' }],
    }));
    expect(amountOf(await is(c, '06', 'accrual'), c.rent)).toBe('450.0000'); // 300 + 200 − 50
    expect(amountOf(await is(c, '06', 'cash'), c.rent)).toBe('0.0000');
    expect(amountOf(await is(c, '07', 'cash'), c.rent)).toBe('450.0000'); // 300 + 150 paid
  });
});

describe('everything else counts as posted', () => {
  it('a manual non-cash entry and a bank-statement posting are the same on both bases', async () => {
    const c = await setup();
    const depreciation = await createAccount(c.owner, c.companyId, createAccountInput.parse({ name: 'Depreciation', accountType: 'EXPENSE' }));
    const accumulated = await createAccount(c.owner, c.companyId, createAccountInput.parse({ name: 'Accumulated Depreciation', accountType: 'ASSET' }));
    await postJournalEntry(postJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.owner, transactionDate: '2026-06-30', sourceType: 'JOURNAL_ENTRY',
      lines: [{ accountId: depreciation.id, debit: '100.00' }, { accountId: accumulated.id, credit: '100.00' }],
    }));
    const batch = await stageImport(c.owner, c.companyId, { bankAccountId: c.bank, fileBytes: new Uint8Array() }, () => Promise.resolve([{ date: '2026-06-15', description: 'CASH SALE', amount: '75.00' }]));
    const line = (await getImportBatch(c.owner, c.companyId, batch.id))!.lines[0]!;
    await postImportLines(c.owner, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.sales }] });
    const accrual = await is(c, '06', 'accrual');
    const cash = await is(c, '06', 'cash');
    for (const s of [accrual, cash]) {
      expect(amountOf(s, depreciation.id)).toBe('100.0000');
      expect(amountOf(s, c.sales)).toBe('75.0000');
    }
    expect(cash.netIncome).toBe(accrual.netIncome);
  });
});

describe('consolidated on a cash basis', () => {
  it('is the sum of the members\' cash-basis statements', async () => {
    const a = await setup(undefined, 'Alpha Cash');
    const b = await setup(a.owner, 'Beta Cash');
    const org = await createOrganization(a.owner, a.companyId, createOrganizationInput.parse({ name: 'Cash Group' }));
    await addCompanyToOrganization(a.owner, b.companyId, org.id);
    for (const [c, price, paid] of [[a, '1000.00', '400.00'], [b, '500.00', '500.00']] as const) {
      const inv = await invoice(c, '2026-06-10', [{ accountId: c.sales, price }]);
      await pay(c, inv, '2026-07-05', paid);
    }
    const cons = await getConsolidatedIncomeStatement(a.owner, a.companyId, '2026-07-01', '2026-07-31', 'cash');
    expect(cons.basis).toBe('cash');
    const own = await Promise.all([a, b].map((c) => is(c, '07', 'cash')));
    expect(cons.netIncome.total).toBe(sumMoney(own.map((s) => s.netIncome)).toFixed(4));
    expect(cons.netIncome.total).toBe('900.0000');
    expect((await getConsolidatedIncomeStatement(a.owner, a.companyId, '2026-07-01', '2026-07-31')).netIncome.total).toBe('0.0000'); // accrual: June
  });
});
