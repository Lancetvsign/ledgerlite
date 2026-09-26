/**
 * Bank-statement import — LL-076a. Against a real DB, with the extractor INJECTED (no
 * external model). Proves the pipeline: extracted rows are validated and staged with a
 * suggested account (extractor category → chart, else history), reviewed decisions post
 * categorised entries through the ledger once each, and control accounts are excluded.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { BankImportError, deleteImportBatch, getImportBatch, listImportBatches, postImportLines, stageImport } from '@/server/bank-import';
import { cannedExtractor, notConfiguredExtractor, type TransactionExtractor } from '@/server/bank-import/extract';
import { listOpenBills } from '@/server/bill-payments';
import { createBill, finalizeBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { insertMembership } from '@/server/companies/internal';
import { createCustomer } from '@/server/customers';
import { createInvoice, finalizeInvoice } from '@/server/invoices';
import { listOpenInvoices, voidPayment } from '@/server/payments';
import { closePeriod, getAccountingPeriod } from '@/server/periods';
import { getTrialBalance } from '@/server/reports';
import { getApAging } from '@/server/reports/ap-aging';
import { getArAging } from '@/server/reports/ar-aging';
import { ensureAppUser } from '@/server/users';
import { createVendor } from '@/server/vendors';
import { createAccountInput } from '@/validation/account';
import { createBillInput } from '@/validation/bill';
import { createCompanyInput } from '@/validation/company';
import { createCustomerInput } from '@/validation/customer';
import { createInvoiceInput } from '@/validation/invoice';
import { voidPaymentInput } from '@/validation/payment';
import { createVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  bankId: string;
  salesId: string;
  suppliesId: string;
  rentId: string;
  customerId: string;
  vendorId: string;
}

/** Create + finalize an invoice (status OPEN) for the ctx customer; returns its id. */
async function openInvoice(c: Ctx, unitPrice: string): Promise<string> {
  const { invoice } = await createInvoice(c.userId, c.companyId, createInvoiceInput.parse({
    customerId: c.customerId, invoiceDate: '2026-05-20', lines: [{ accountId: c.salesId, quantity: '1', unitPrice }],
  }));
  await finalizeInvoice(c.userId, c.companyId, invoice.id);
  return invoice.id;
}

/** Create + finalize a bill (status OPEN) for the ctx vendor; returns its id. */
async function openBill(c: Ctx, price: string): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId: c.vendorId, billDate: '2026-05-20', lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

async function docStatus(table: 'invoices' | 'bills', id: string): Promise<string> {
  const db = await getTestDb();
  const q = table === 'invoices' ? sql`select status from invoices where id = ${id}` : sql`select status from bills where id = ${id}`;
  return (await db.execute<{ status: string }>(q)).rows[0]!.status;
}

async function paymentCount(companyId: string, table: 'payments' | 'bill_payments'): Promise<number> {
  const db = await getTestDb();
  const q = table === 'payments'
    ? sql`select count(*)::text n from payments where company_id = ${companyId}`
    : sql`select count(*)::text n from bill_payments where company_id = ${companyId}`;
  return Number((await db.execute<{ n: string }>(q)).rows[0]?.n ?? '0');
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `bi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'B' },
    returnHeaders: true,
  });
  const user = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return user.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(userId, createCompanyInput.parse({ legalName: 'BI Co', timezone: 'America/Chicago' }), 'standard');
  const bank = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Operating Bank', accountType: 'ASSET', cashFlowCategory: 'CASH' }));
  const sales = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Consulting Sales', accountType: 'REVENUE' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies Expense', accountType: 'EXPENSE' }));
  const rent = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Rent Expense', accountType: 'EXPENSE' }));
  const customer = await createCustomer(userId, company.id, createCustomerInput.parse({ name: 'Acme Corp' }));
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Office Depot' }));
  return {
    userId, companyId: company.id, bankId: bank.id, salesId: sales.id, suppliesId: supplies.id, rentId: rent.id,
    customerId: customer.id, vendorId: vendor.id,
  };
}

const fixed = (rows: { date: string; description: string; amount: string; category?: string }[]): TransactionExtractor =>
  () => Promise.resolve(rows);

/** The injected extractors ignore the bytes; the pipeline never needs a real PDF here. */
const EMPTY = new Uint8Array();

/** A typical little statement: one deposit (in), two payments (out). */
const STATEMENT = fixed([
  { date: '2026-06-01', description: 'DEPOSIT ACME', amount: '1500.00', category: 'Consulting Sales' },
  { date: '2026-06-03', description: 'OFFICE DEPOT', amount: '-120.50', category: 'Supplies Expense' },
  { date: '2026-06-05', description: 'MONTHLY RENT', amount: '-2000.00' }, // no category → history/none
]);

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  return (await db.execute<{ id: string }>(sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`)).rows[0]!.id;
}

async function balance(c: Ctx, accountId: string): Promise<string> {
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  return tb.rows.find((r) => r.accountId === accountId)?.balance ?? '0.0000';
}

async function entryCount(companyId: string): Promise<number> {
  const db = await getTestDb();
  return Number((await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${companyId} and source_type = 'BANK_IMPORT' and status = 'POSTED'`)).rows[0]?.n ?? '0');
}

async function assertLedgerIntegrityFor(c: Ctx): Promise<void> {
  const tb = await getTrialBalance(c.userId, c.companyId, '2026-12-31');
  expect(tb.balanced).toBe(true);
}

const errOf = async (p: Promise<unknown>): Promise<BankImportError> => {
  try {
    await p;
    throw new Error('expected BankImportError');
  } catch (e) {
    expect(e).toBeInstanceOf(BankImportError);
    return e as BankImportError;
  }
};

beforeEach(async () => {
  await truncateAll();
});

describe('stageImport — validates and stages with suggestions', () => {
  it('stages every extracted row, mapping the extractor category to a chart account', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'june.pdf', fileBytes: EMPTY }, STATEMENT);
    const view = await getImportBatch(c.userId, c.companyId, batch.id);
    expect(view).not.toBeNull();
    expect(view!.lines).toHaveLength(3);
    expect(view!.lines.every((l) => l.status === 'STAGED')).toBe(true);
    expect(view!.lines[0]?.suggestedAccountId).toBe(c.salesId); // 'Consulting Sales' mapped by name
    expect(view!.lines[1]?.suggestedAccountId).toBe(c.suppliesId);
    expect(view!.lines[2]?.suggestedAccountId).toBeNull(); // no category, no history yet
    expect(view!.lines[0]?.amount).toBe('1500.0000');
    expect(view!.lines[1]?.amount).toBe('-120.5000');
  });

  it('falls back to history: the account confirmed before for the same description', async () => {
    const c = await setup();
    const first = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const v1 = await getImportBatch(c.userId, c.companyId, first.id);
    const rentLine = v1!.lines[2]!;
    await postImportLines(c.userId, c.companyId, first.id, { decisions: [{ lineId: rentLine.id, action: 'post', accountId: c.rentId }] });

    // A later statement with the same description (still no category) is suggested Rent.
    const second = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-07-05', description: 'MONTHLY RENT', amount: '-2000.00' },
    ]));
    const v2 = await getImportBatch(c.userId, c.companyId, second.id);
    expect(v2!.lines[0]?.suggestedAccountId).toBe(c.rentId);
  });

  it('rejects a malformed extracted row rather than staging a partial batch', async () => {
    const c = await setup();
    const bad = fixed([{ date: '2026-06-01', description: 'X', amount: '12.34567' }]); // 5 decimals
    const err = await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, bad));
    expect(err.code).toBe('EXTRACTION_FAILED');
    const zero = fixed([{ date: '2026-06-01', description: 'X', amount: '0.00' }]);
    expect((await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, zero))).code).toBe('EXTRACTION_FAILED');
  });

  it('rejects a bank account that is not an active cash asset', async () => {
    const c = await setup();
    const err = await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.salesId, fileBytes: EMPTY }, STATEMENT));
    expect(err.code).toBe('INVALID_BANK_ACCOUNT');
  });

  it('reports not-configured when no extractor is wired (the production default until LL-076b)', async () => {
    const c = await setup();
    const err = await errOf(stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, notConfiguredExtractor));
    expect(err.code).toBe('EXTRACTION_NOT_CONFIGURED');
  });
});

describe('postImportLines — categorised entries through the ledger, once each', () => {
  it('posts money-in as Dr bank / Cr category and money-out as Cr bank / Dr category', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const view = await getImportBatch(c.userId, c.companyId, batch.id);
    const [dep, supplies, rent] = view!.lines;

    const result = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: dep!.id, action: 'post', accountId: c.salesId },
        { lineId: supplies!.id, action: 'post', accountId: c.suppliesId },
        { lineId: rent!.id, action: 'ignore' },
      ],
    });
    expect(result).toEqual({ posted: 2, matched: 0, ignored: 1, applied: 0, personal: 0, intercompany: 0 });

    // Bank (asset, debit-natural): +1500 − 120.50 = 1379.50. Sales credited 1500; supplies debited 120.50.
    expect(await balance(c, c.bankId)).toBe('1379.5000');
    expect(await balance(c, c.salesId)).toBe('1500.0000');
    expect(await balance(c, c.suppliesId)).toBe('120.5000');
    expect(await balance(c, c.rentId)).toBe('0.0000'); // ignored

    const after = await getImportBatch(c.userId, c.companyId, batch.id);
    expect(after!.lines.map((l) => l.status)).toEqual(['POSTED', 'POSTED', 'IGNORED']);
    expect(after!.lines[0]?.journalEntryId).not.toBeNull();
    expect(after!.lines[0]?.chosenAccountId).toBe(c.salesId);
  });

  it('is post-once: re-submitting a posted line is a no-op', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const line = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.salesId }] });
    const again = await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.suppliesId }] });
    expect(again.posted).toBe(0);
    expect(await entryCount(c.companyId)).toBe(1);
    expect(await balance(c, c.salesId)).toBe('1500.0000'); // the original stands; not re-categorised
  });

  it('rejects a control account, the OBE account, and the bank account itself', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const line = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    for (const bad of [await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE'), await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE'), await sysAccount(c.companyId, 'OPENING_BALANCE_EQUITY'), await sysAccount(c.companyId, 'RETAINED_EARNINGS'), c.bankId]) {
      const err = await errOf(postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: line.id, action: 'post', accountId: bad }] }));
      expect(err.code).toBe('CONTROL_ACCOUNT_NOT_ALLOWED');
    }
    expect(await entryCount(c.companyId)).toBe(0);
  });

  it('requires an account to post, and rejects a closed period before posting anything', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const [dep, supplies] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep!.id, action: 'post' }] }))).code).toBe('ACCOUNT_REQUIRED');

    const period = await getAccountingPeriod(c.companyId, '2026-06-03');
    await closePeriod(c.userId, c.companyId, period.id);
    await expect(
      postImportLines(c.userId, c.companyId, batch.id, {
        decisions: [
          { lineId: dep!.id, action: 'post', accountId: c.salesId },
          { lineId: supplies!.id, action: 'post', accountId: c.suppliesId },
        ],
      }),
    ).rejects.toThrow(/closed/i);
    expect(await entryCount(c.companyId)).toBe(0); // validated up front — nothing posted
  });

  it('flags a re-imported transaction as a possible duplicate', async () => {
    const c = await setup();
    const one = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const line = (await getImportBatch(c.userId, c.companyId, one.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, one.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.salesId }] });

    const two = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const v2 = await getImportBatch(c.userId, c.companyId, two.id);
    expect(v2!.lines[0]?.isDuplicate).toBe(true); // same deposit already posted
    expect(v2!.lines[1]?.isDuplicate).toBe(false); // supplies was never posted
  });

  it('denies a non-member', async () => {
    const c = await setup();
    const outsider = await makeUser();
    await expect(stageImport(outsider, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT)).rejects.toThrow();
  });
});

/**
 * LL-077 (ADR-035): a line applied to an open document creates a REAL customer payment /
 * bill payment inside the line's transaction — never a BANK_IMPORT entry touching A/R or
 * A/P — so revenue is not double-counted and the aging⇔control reconciliation holds.
 */
describe('postImportLines — apply to open invoices / bills (LL-077)', () => {
  it('applies money in to an open invoice: a customer payment Dr bank / Cr A/R, invoice PAID, revenue not double-counted', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '1500.00');
    const arId = await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE');
    expect(await balance(c, c.salesId)).toBe('1500.0000'); // recognised by the invoice
    expect(await balance(c, arId)).toBe('1500.0000');

    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    const result = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: invoiceId }],
    });
    expect(result).toEqual({ posted: 1, matched: 0, ignored: 0, applied: 1, personal: 0, intercompany: 0 });

    // The money landed in the bank and cleared A/R; revenue is unchanged (no double count).
    expect(await balance(c, c.bankId)).toBe('1500.0000');
    expect(await balance(c, arId)).toBe('0.0000');
    expect(await balance(c, c.salesId)).toBe('1500.0000');
    expect(await entryCount(c.companyId)).toBe(0); // no BANK_IMPORT entry at all
    expect(await paymentCount(c.companyId, 'payments')).toBe(1);
    expect(await docStatus('invoices', invoiceId)).toBe('PAID');

    const after = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    expect(after.status).toBe('POSTED');
    expect(after.paymentId).not.toBeNull();
    expect(after.chosenAccountId).toBeNull();
    const db = await getTestDb();
    const entry = (await db.execute<{ id: string; deposit: string }>(sql`
      select je.id, p.deposit_account_id::text as deposit from payments p
      join journal_entries je on je.source_type = 'CUSTOMER_PAYMENT' and je.source_id = p.id::text
      where p.id = ${after.paymentId!}`)).rows[0]!;
    expect(after.journalEntryId).toBe(entry.id); // the line points at the PAYMENT's entry
    expect(entry.deposit).toBe(c.bankId);
  });

  it('a partial application leaves the invoice OPEN with the remaining balance', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '2000.00');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!; // +1500
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: invoiceId }] });
    expect(await docStatus('invoices', invoiceId)).toBe('OPEN');
    const open = (await listOpenInvoices(c.userId, c.companyId)).find((i) => i.id === invoiceId);
    expect(open?.openBalance).toBe('500.0000');
    // Subsidiary == control after an import-driven payment.
    const aging = await getArAging(c.userId, c.companyId, '2026-12-31');
    expect(aging.totals.total).toBe(await balance(c, await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE')));
  });

  it('rejects an over-application BEFORE anything in the submit posts', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '1000.00'); // line is +1500
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const [dep, supplies] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    const err = await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: supplies!.id, action: 'post', accountId: c.suppliesId }, // valid, listed FIRST
        { lineId: dep!.id, action: 'apply_invoice', documentId: invoiceId },
      ],
    }));
    expect(err.code).toBe('OVERAPPLIED');
    expect(await balance(c, c.suppliesId)).toBe('0.0000'); // the valid line did NOT post
    expect(await paymentCount(c.companyId, 'payments')).toBe(0);
    expect((await getImportBatch(c.userId, c.companyId, batch.id))!.lines.every((l) => l.status === 'STAGED')).toBe(true);
  });

  it('over-application is cumulative within one submit (two lines aimed at one document)', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '2000.00');
    const two = fixed([
      { date: '2026-06-01', description: 'DEPOSIT A', amount: '1500.00' },
      { date: '2026-06-02', description: 'DEPOSIT B', amount: '1500.00' },
    ]);
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, two);
    const [a, b] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    const err = await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: a!.id, action: 'apply_invoice', documentId: invoiceId },
        { lineId: b!.id, action: 'apply_invoice', documentId: invoiceId },
      ],
    }));
    expect(err.code).toBe('OVERAPPLIED');
    expect(await paymentCount(c.companyId, 'payments')).toBe(0); // NOT "first posted, second failed"
  });

  it('enforces direction: money out cannot apply to an invoice, money in cannot apply to a bill', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '120.50');
    const billId = await openBill(c, '1500.00');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const [dep, supplies] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: supplies!.id, action: 'apply_invoice', documentId: invoiceId }],
    }))).code).toBe('WRONG_DIRECTION');
    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: dep!.id, action: 'apply_bill', documentId: billId }],
    }))).code).toBe('WRONG_DIRECTION');
  });

  it('requires a document, and treats a foreign or PAID document as not open (no existence leak)', async () => {
    const c = await setup();
    const other = await setup(); // another company with its own open invoice
    const foreignInvoice = await openInvoice(other, '1500.00');
    const paidInvoice = await openInvoice(c, '1500.00');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;

    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: dep.id, action: 'apply_invoice' }],
    }))).code).toBe('DOCUMENT_REQUIRED');
    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: foreignInvoice }],
    }))).code).toBe('DOCUMENT_NOT_OPEN');

    // Pay the invoice through the import, then a second identical statement must not re-apply.
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: paidInvoice }] });
    const again = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep2 = (await getImportBatch(c.userId, c.companyId, again.id))!.lines[0]!;
    expect(dep2.isDuplicate).toBe(true);
    expect((await errOf(postImportLines(c.userId, c.companyId, again.id, {
      decisions: [{ lineId: dep2.id, action: 'apply_invoice', documentId: paidInvoice }],
    }))).code).toBe('DOCUMENT_NOT_OPEN');
  });

  it('re-submitting an applied line is a no-op: one payment, unchanged balances', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '3000.00');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: invoiceId }] });
    const again = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: dep.id, action: 'apply_invoice', documentId: invoiceId },
        { lineId: dep.id, action: 'post', accountId: c.salesId }, // even re-categorising is refused
      ],
    });
    expect(again).toEqual({ posted: 0, matched: 0, ignored: 0, applied: 0, personal: 0, intercompany: 0 });
    expect(await paymentCount(c.companyId, 'payments')).toBe(1);
    expect(await balance(c, c.bankId)).toBe('1500.0000');
  });

  it('applies money out to an open bill: a bill payment Dr A/P / Cr bank, bill PAID, A/P aging == control', async () => {
    const c = await setup();
    const billId = await openBill(c, '120.50');
    const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
    expect(await balance(c, apId)).toBe('120.5000');

    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const supplies = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[1]!; // −120.50
    const result = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: supplies.id, action: 'apply_bill', documentId: billId }],
    });
    expect(result).toEqual({ posted: 1, matched: 0, ignored: 0, applied: 1, personal: 0, intercompany: 0 });

    expect(await balance(c, c.bankId)).toBe('-120.5000');
    expect(await balance(c, apId)).toBe('0.0000');
    expect(await balance(c, c.suppliesId)).toBe('120.5000'); // expense recognised ONCE, by the bill
    expect(await entryCount(c.companyId)).toBe(0);
    expect(await paymentCount(c.companyId, 'bill_payments')).toBe(1);
    expect(await docStatus('bills', billId)).toBe('PAID');
    const line = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[1]!;
    expect(line.billPaymentId).not.toBeNull();
    expect(line.paymentId).toBeNull();
    expect(line.chosenAccountId).toBeNull();

    const aging = await getApAging(c.userId, c.companyId, '2026-12-31');
    expect(aging.totals.total).toBe('0.0000');
    expect(await paymentCount(c.companyId, 'payments')).toBe(0);
  });

  it('a partially paid bill stays OPEN; a mixed submit posts category lines and applied lines together', async () => {
    const c = await setup();
    const billId = await openBill(c, '500.00');
    const invoiceId = await openInvoice(c, '1500.00');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const [dep, supplies, rent] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    const result = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: dep!.id, action: 'apply_invoice', documentId: invoiceId },
        { lineId: supplies!.id, action: 'apply_bill', documentId: billId },
        { lineId: rent!.id, action: 'post', accountId: c.rentId },
      ],
    });
    expect(result).toEqual({ posted: 3, matched: 0, ignored: 0, applied: 2, personal: 0, intercompany: 0 });
    expect(await docStatus('bills', billId)).toBe('OPEN');
    expect((await listOpenBills(c.userId, c.companyId)).find((b) => b.id === billId)?.openBalance).toBe('379.5000');
    expect(await balance(c, c.bankId)).toBe('-620.5000'); // +1500 −120.50 −2000
    expect(await entryCount(c.companyId)).toBe(1); // only the rent line is a BANK_IMPORT entry
  });

  it('a BOOKKEEPER (has payment.create, lacks journal.post) is refused at the outer gate', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '1500.00');
    const bookkeeper = await makeUser();
    await insertMembership(c.companyId, bookkeeper, 'BOOKKEEPER');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    await expect(postImportLines(bookkeeper, c.companyId, batch.id, {
      decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: invoiceId }],
    })).rejects.toThrow();
    expect(await paymentCount(c.companyId, 'payments')).toBe(0);
  });

  it('voiding the payment reopens the invoice and returns the import line to review, where it can be applied again (LL-110 supersedes ADR-035\'s "stays POSTED")', async () => {
    const c = await setup();
    const invoiceId = await openInvoice(c, '1500.00');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, STATEMENT);
    const dep = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: invoiceId }] });
    const line = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    expect(line.status).toBe('POSTED');
    expect(await balance(c, c.bankId)).toBe('1500.0000');
    await voidPayment(c.userId, c.companyId, line.paymentId!, voidPaymentInput.parse({ reversalDate: '2026-06-30' }));
    expect(await docStatus('invoices', invoiceId)).toBe('OPEN');
    expect(await balance(c, await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE'))).toBe('1500.0000');
    // The void reversed the deposit's entry, so the line no longer claims a posting: it is back in
    // review, unlinked, and the bank account no longer carries the deposit until it is applied again.
    const after = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    expect(after).toMatchObject({ status: 'STAGED', paymentId: null, journalEntryId: null, chosenAccountId: null });
    expect(await balance(c, c.bankId)).toBe('0.0000');
    // Re-applied to the same invoice, it settles it again through a new payment.
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: dep.id, action: 'apply_invoice', documentId: invoiceId }] });
    const reapplied = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines[0]!;
    expect(reapplied.status).toBe('POSTED');
    expect(reapplied.paymentId).not.toBe(line.paymentId);
    expect(await docStatus('invoices', invoiceId)).toBe('PAID');
    expect(await balance(c, c.bankId)).toBe('1500.0000');
    expect(await balance(c, await sysAccount(c.companyId, 'ACCOUNTS_RECEIVABLE'))).toBe('0.0000');
  });
});

describe('stageImport — chart-aware categorisation that learns from corrections (LL-080)', () => {
  it('hands the extractor the company chart and its past decisions', async () => {
    const c = await setup();
    // A prior import where the user CORRECTED the model's suggestion (Supplies → Rent) and posted.
    const first = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-06-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Supplies Expense' },
    ]));
    const line = (await getImportBatch(c.userId, c.companyId, first.id))!.lines[0]!;
    expect(line.suggestedAccountId).toBe(c.suppliesId);
    await postImportLines(c.userId, c.companyId, first.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.rentId }] });

    let seen: { accounts: readonly { number: string | null; name: string; type: string }[]; examples: readonly { description: string; account: string }[] } | undefined;
    const spy: TransactionExtractor = (input) => {
      seen = input.context;
      return Promise.resolve([{ date: '2026-07-05', description: 'SOMETHING NEW', amount: '-1.00' }]);
    };
    await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, spy);
    expect(seen).toBeDefined();
    const names = seen!.accounts.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['Consulting Sales', 'Supplies Expense', 'Rent Expense']));
    expect(names).not.toContain('Operating Bank'); // the bank account itself is never a category
    expect(seen!.accounts.find((a) => a.name === 'Rent Expense')?.type).toBe('EXPENSE');
    expect(seen!.examples).toEqual([{ description: 'MONTHLY RENT PAYMENT', account: 'Rent Expense' }]);
  });

  it('the company’s past decision wins over the model’s suggestion (learns from corrections)', async () => {
    const c = await setup();
    const first = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-06-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Supplies Expense' },
    ]));
    const line = (await getImportBatch(c.userId, c.companyId, first.id))!.lines[0]!;
    await postImportLines(c.userId, c.companyId, first.id, { decisions: [{ lineId: line.id, action: 'post', accountId: c.rentId }] });

    // Same description again; the model insists on Supplies — history says Rent.
    const second = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-07-05', description: 'MONTHLY RENT PAYMENT', amount: '-2000.00', category: 'Supplies Expense' },
    ]));
    expect((await getImportBatch(c.userId, c.companyId, second.id))!.lines[0]?.suggestedAccountId).toBe(c.rentId);
  });

  it('matches a recurring payee whose reference number changes (payee key), exact match first', async () => {
    const c = await setup();
    const first = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-06-03', description: 'OFFICE DEPOT #1234', amount: '-120.50' },
      { date: '2026-06-04', description: 'CHECK 1042 - ACME', amount: '-50.00' },
    ]));
    const [depot, check] = (await getImportBatch(c.userId, c.companyId, first.id))!.lines;
    await postImportLines(c.userId, c.companyId, first.id, {
      decisions: [
        { lineId: depot!.id, action: 'post', accountId: c.suppliesId },
        { lineId: check!.id, action: 'post', accountId: c.rentId },
      ],
    });

    const second = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, fileBytes: EMPTY }, fixed([
      { date: '2026-07-03', description: 'OFFICE DEPOT #9876', amount: '-98.00' }, // new reference number
      { date: '2026-07-04', description: 'CHECK 1057 - ACME', amount: '-50.00' }, // new check number
      { date: '2026-07-05', description: 'office depot #1234', amount: '-1.00' }, // exact (case-insensitive)
      { date: '2026-07-06', description: 'TOTALLY NEW PAYEE', amount: '-1.00', category: 'Consulting Sales' }, // model only
    ]));
    const lines = (await getImportBatch(c.userId, c.companyId, second.id))!.lines;
    expect(lines.map((l) => l.suggestedAccountId)).toEqual([c.suppliesId, c.rentId, c.suppliesId, c.salesId]);
  });
});


describe('deleteImportBatch (LL-087)', () => {
  it('removes an unposted batch and its lines; the same statement can be uploaded again without duplicate flags', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'oops.pdf', fileBytes: EMPTY }, STATEMENT);
    expect((await listImportBatches(c.userId, c.companyId)).map((b) => b.id)).toEqual([batch.id]);

    await expect(deleteImportBatch(c.userId, c.companyId, batch.id)).resolves.toEqual({ lines: 3 });
    expect(await getImportBatch(c.userId, c.companyId, batch.id)).toBeNull();
    expect(await listImportBatches(c.userId, c.companyId)).toEqual([]);
    const db = await getTestDb();
    expect(Number((await db.execute<{ n: string }>(sql`select count(*)::text n from bank_import_lines where batch_id = ${batch.id}`)).rows[0]!.n)).toBe(0);
    expect(await entryCount(c.companyId)).toBe(0);

    const again = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'oops.pdf', fileBytes: EMPTY }, STATEMENT);
    const view = (await getImportBatch(c.userId, c.companyId, again.id))!;
    expect(view.lines.every((l) => !l.isDuplicate)).toBe(true);
  });

  it('ignored lines do not protect a batch, but one POSTED line does — and the ledger keeps its entry', async () => {
    const c = await setup();
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 's.pdf', fileBytes: EMPTY }, STATEMENT);
    const view = (await getImportBatch(c.userId, c.companyId, batch.id))!;
    const [l0, l1, l2] = view.lines;
    await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: l2!.id, action: 'ignore' }],
    });
    // Still deletable: nothing posted.
    const other = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'other.pdf', fileBytes: EMPTY }, STATEMENT);
    await postImportLines(c.userId, c.companyId, other.id, { decisions: [{ lineId: (await getImportBatch(c.userId, c.companyId, other.id))!.lines[2]!.id, action: 'ignore' }] });
    await expect(deleteImportBatch(c.userId, c.companyId, other.id)).resolves.toEqual({ lines: 3 });

    await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: l0!.id, action: 'post', accountId: c.salesId }],
    });
    expect((await errOf(deleteImportBatch(c.userId, c.companyId, batch.id))).code).toBe('BATCH_HAS_POSTINGS');
    const after = (await getImportBatch(c.userId, c.companyId, batch.id))!;
    expect(after.lines.map((l) => l.status)).toEqual(['POSTED', 'STAGED', 'IGNORED']); // the refused delete rolled back
    expect(after.lines[1]!.id).toBe(l1!.id);
    expect(await entryCount(c.companyId)).toBe(1);
  });

  it('a foreign or unknown batch is BATCH_NOT_FOUND; a BOOKKEEPER is denied', async () => {
    const a = await setup();
    const b = await setup();
    const batch = await stageImport(a.userId, a.companyId, { bankAccountId: a.bankId, filename: 's.pdf', fileBytes: EMPTY }, STATEMENT);
    expect((await errOf(deleteImportBatch(b.userId, b.companyId, batch.id))).code).toBe('BATCH_NOT_FOUND');
    expect((await errOf(deleteImportBatch(a.userId, a.companyId, '00000000-0000-4000-8000-000000000000'))).code).toBe('BATCH_NOT_FOUND');
    const keeper = await makeUser();
    await insertMembership(a.companyId, keeper, 'BOOKKEEPER');
    await expect(deleteImportBatch(keeper, a.companyId, batch.id)).rejects.toMatchObject({ name: 'AuthorizationDenied' });
    expect(await getImportBatch(a.userId, a.companyId, batch.id)).not.toBeNull();
  });
});

describe('credit-card statements (LL-088)', () => {
  async function cardSetup(): Promise<Ctx & { cardId: string }> {
    const c = await setup();
    const card = await createAccount(c.userId, c.companyId, createAccountInput.parse({ accountNumber: '2150', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card', cashFlowCategory: 'OPERATING' }));
    return { ...c, cardId: card.id };
  }

  it('stages into a credit-card account, tells the extractor so, and posts charges as credits and payments as debits to the card', async () => {
    const c = await cardSetup();
    let seenKind: string | undefined;
    const capturing: TransactionExtractor = (input) => {
      seenKind = input.context?.statementKind;
      return STATEMENT(input);
    };
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY }, capturing);
    expect(seenKind).toBe('credit_card');

    const view = (await getImportBatch(c.userId, c.companyId, batch.id))!;
    const [payment, charge, other] = view.lines; // +1500 (a payment to the card), -120.50 (a purchase), -2000
    await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: payment!.id, action: 'post', accountId: c.bankId },      // paid from the bank
        { lineId: charge!.id, action: 'post', accountId: c.suppliesId },   // a purchase
        { lineId: other!.id, action: 'ignore' },
      ],
    });
    // Card is credit-normal: charges (credits) 120.50 − payments (debits) 1500 = −1379.50.
    expect(await balance(c, c.cardId)).toBe('-1379.5000');
    expect(await balance(c, c.suppliesId)).toBe('120.5000');
    expect(await balance(c, c.bankId)).toBe('-1500.0000');
    expect(await entryCount(c.companyId)).toBe(2);
  });

  it('a card statement line cannot be applied to an invoice or bill; a non-card liability is not importable', async () => {
    const c = await cardSetup();
    await openBill(c, '120.50');
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY }, STATEMENT);
    const view = (await getImportBatch(c.userId, c.companyId, batch.id))!;
    const bills = await listOpenBills(c.userId, c.companyId);
    expect((await errOf(postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [{ lineId: view.lines[1]!.id, action: 'apply_bill', documentId: bills[0]!.id }],
    }))).code).toBe('CARD_CANNOT_APPLY');
    expect(await entryCount(c.companyId)).toBe(0);

    const tax = await sysAccount(c.companyId, 'SALES_TAX_PAYABLE');
    expect((await errOf(stageImport(c.userId, c.companyId, { bankAccountId: tax, filename: 'x.pdf', fileBytes: EMPTY }, STATEMENT))).code).toBe('INVALID_BANK_ACCOUNT');
  });
});

describe('card guard placement (LL-093 / Gate 6 L2)', () => {
  it('an apply decision on an already-decided card line is an idempotent no-op; the live post decisions go through', async () => {
    const c = await setup();
    const card = await createAccount(c.userId, c.companyId, createAccountInput.parse({ accountNumber: '2160', name: 'Amex', accountType: 'LIABILITY', accountSubtype: 'credit_card' }));
    const batch = await stageImport(c.userId, c.companyId, { bankAccountId: card.id, filename: 'amex.pdf', fileBytes: EMPTY }, STATEMENT);
    const [l0, l1, l2] = (await getImportBatch(c.userId, c.companyId, batch.id))!.lines;
    await postImportLines(c.userId, c.companyId, batch.id, { decisions: [{ lineId: l2!.id, action: 'ignore' }] });

    // A stale re-submit carries an apply decision for the IGNORED line: skipped, not refused.
    const r = await postImportLines(c.userId, c.companyId, batch.id, {
      decisions: [
        { lineId: l2!.id, action: 'apply_bill', documentId: '00000000-0000-4000-8000-000000000000' },
        { lineId: l0!.id, action: 'post', accountId: c.bankId },
        { lineId: l1!.id, action: 'post', accountId: c.suppliesId },
      ],
    });
    expect(r.posted).toBe(2);
    // A LIVE apply decision on a card line is still refused.
    const again = await stageImport(c.userId, c.companyId, { bankAccountId: card.id, filename: 'amex2.pdf', fileBytes: EMPTY }, STATEMENT);
    const live = (await getImportBatch(c.userId, c.companyId, again.id))!.lines[1]!;
    expect((await errOf(postImportLines(c.userId, c.companyId, again.id, {
      decisions: [{ lineId: live.id, action: 'apply_bill', documentId: '00000000-0000-4000-8000-000000000000' }],
    }))).code).toBe('CARD_CANNOT_APPLY');
  });
});

describe('transfers between two statement accounts post once (LL-094 / Gate 6 M1)', () => {
  async function withCard(): Promise<Ctx & { cardId: string }> {
    const c = await setup();
    const card = await createAccount(c.userId, c.companyId, createAccountInput.parse({ accountNumber: '2170', name: 'Visa', accountType: 'LIABILITY', accountSubtype: 'credit_card' }));
    return { ...c, cardId: card.id };
  }
  /** Bank statement posted: the −2000 "rent" line is really the card payment, categorised to the card. */
  async function postCardPaymentFromBank(c: Ctx & { cardId: string }): Promise<{ bankLineId: string; entryId: string }> {
    const bank = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'bank.pdf', fileBytes: EMPTY }, STATEMENT);
    const lines = (await getImportBatch(c.userId, c.companyId, bank.id))!.lines;
    await postImportLines(c.userId, c.companyId, bank.id, {
      decisions: [
        { lineId: lines[0]!.id, action: 'post', accountId: c.salesId },
        { lineId: lines[1]!.id, action: 'post', accountId: c.suppliesId },
        { lineId: lines[2]!.id, action: 'post', accountId: c.cardId },
      ],
    });
    const after = (await getImportBatch(c.userId, c.companyId, bank.id))!.lines[2]!;
    return { bankLineId: after.id, entryId: after.journalEntryId! };
  }

  it('the card statement flags the posted mirror, matching marks it posted against the SAME entry, and nothing double-counts', async () => {
    const c = await withCard();
    const { bankLineId, entryId } = await postCardPaymentFromBank(c);
    expect(await entryCount(c.companyId)).toBe(3);

    const card = await stageImport(c.userId, c.companyId, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY }, cannedExtractor);
    const view = (await getImportBatch(c.userId, c.companyId, card.id))!;
    const [purchase, fuel, payment] = view.lines;
    expect(payment!.amount).toBe('2000.0000');
    expect(payment!.transferCandidate).toMatchObject({ lineId: bankLineId, status: 'POSTED', journalEntryId: entryId, accountId: c.bankId });
    expect(purchase!.transferCandidate).toBeNull();

    const r = await postImportLines(c.userId, c.companyId, card.id, {
      decisions: [
        { lineId: purchase!.id, action: 'post', accountId: c.suppliesId },
        { lineId: fuel!.id, action: 'post', accountId: c.rentId },
        { lineId: payment!.id, action: 'match_transfer', counterpartLineId: bankLineId },
      ],
    });
    expect(r).toMatchObject({ posted: 2, matched: 1, ignored: 0, applied: 0 });
    const done = (await getImportBatch(c.userId, c.companyId, card.id))!.lines[2]!;
    expect(done).toMatchObject({ status: 'POSTED', journalEntryId: entryId, chosenAccountId: c.bankId });
    expect(await entryCount(c.companyId)).toBe(5); // 3 + 2 purchases; the payment made NO new entry
    // Card is credit-normal: charges 120.50 + 45 − payment 2000 = −1834.50; bank −2000 for the payment.
    expect(await balance(c, c.cardId)).toBe('-1834.5000');
    expect(await balance(c, c.bankId)).toBe('-620.5000'); // 1500 − 120.50 − 2000
    await assertLedgerIntegrityFor(c);
  });

  it('posting the exact mirror again is refused; a wrong or staged counterpart is a mismatch; one mirror per entry', async () => {
    const c = await withCard();
    const { bankLineId } = await postCardPaymentFromBank(c);
    const card = await stageImport(c.userId, c.companyId, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY }, cannedExtractor);
    const [purchase, , payment] = (await getImportBatch(c.userId, c.companyId, card.id))!.lines;

    expect((await errOf(postImportLines(c.userId, c.companyId, card.id, {
      decisions: [{ lineId: payment!.id, action: 'post', accountId: c.bankId }],
    }))).code).toBe('TRANSFER_ALREADY_POSTED');
    // Posting it to a different category is the reviewer's call (not a mirror of that entry).
    expect((await errOf(postImportLines(c.userId, c.companyId, card.id, {
      decisions: [{ lineId: payment!.id, action: 'match_transfer', counterpartLineId: purchase!.id }],
    }))).code).toBe('TRANSFER_MISMATCH');
    expect((await errOf(postImportLines(c.userId, c.companyId, card.id, {
      decisions: [{ lineId: payment!.id, action: 'match_transfer' }],
    }))).code).toBe('TRANSFER_MISMATCH');

    await postImportLines(c.userId, c.companyId, card.id, { decisions: [{ lineId: payment!.id, action: 'match_transfer', counterpartLineId: bankLineId }] });
    // A second card statement carrying the same payment cannot match the same entry again.
    const card2 = await stageImport(c.userId, c.companyId, { bankAccountId: c.cardId, filename: 'visa-again.pdf', fileBytes: EMPTY }, cannedExtractor);
    const payment2 = (await getImportBatch(c.userId, c.companyId, card2.id))!.lines[2]!;
    expect((await errOf(postImportLines(c.userId, c.companyId, card2.id, {
      decisions: [{ lineId: payment2.id, action: 'match_transfer', counterpartLineId: bankLineId }],
    }))).code).toBe('TRANSFER_ALREADY_POSTED');
  });

  it('when both sides are only staged, the candidate is flagged but cannot be matched until one side posts', async () => {
    const c = await withCard();
    const bank = await stageImport(c.userId, c.companyId, { bankAccountId: c.bankId, filename: 'bank.pdf', fileBytes: EMPTY }, STATEMENT);
    const card = await stageImport(c.userId, c.companyId, { bankAccountId: c.cardId, filename: 'visa.pdf', fileBytes: EMPTY }, cannedExtractor);
    const bankRent = (await getImportBatch(c.userId, c.companyId, bank.id))!.lines[2]!;
    const payment = (await getImportBatch(c.userId, c.companyId, card.id))!.lines[2]!;
    expect(payment.transferCandidate).toMatchObject({ lineId: bankRent.id, status: 'STAGED', journalEntryId: null });
    expect((await errOf(postImportLines(c.userId, c.companyId, card.id, {
      decisions: [{ lineId: payment.id, action: 'match_transfer', counterpartLineId: bankRent.id }],
    }))).code).toBe('TRANSFER_MISMATCH');
  });
});
