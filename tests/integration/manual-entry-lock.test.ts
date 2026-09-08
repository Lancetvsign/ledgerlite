/**
 * Manual-entry lock — LL-066 (ADR-025). Against a real database.
 *
 * The 0023 control-account trigger blocks a manual (`JOURNAL_ENTRY`) line into A/R or
 * A/P, but only for that labelled source. LL-066 confines the manual ledger APIs so the
 * "a control account moves only through its documents" guarantee holds at the SERVICE
 * layer, not just the UI:
 *
 *   1. `postJournalEntry` posts only `JOURNAL_ENTRY` — a document source is refused
 *      (`MANUAL_SOURCE_TYPE_REQUIRED`), so a caller cannot land a control-account line
 *      under a non-`JOURNAL_ENTRY` source and dodge the 0023 guard.
 *   2. `reverseJournalEntry` reverses only a MANUAL entry — a document's entry, and a
 *      document void's REVERSAL, are refused (`DOCUMENT_REVERSAL_REQUIRES_VOID`); they
 *      must be undone through the document's own void, which keeps the subsidiary in step.
 *   3. A raw-SQL DRAFT-then-relabel that would evade the BEFORE INSERT guard is refused
 *      STRUCTURALLY by the 0025 BEFORE UPDATE trigger.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAuth } from '@/lib/auth';
import { createAccount } from '@/server/accounts';
import { createBill, finalizeBill, voidBill } from '@/server/bills';
import { createCompanyWithOwner } from '@/server/companies';
import { assertLedgerIntegrity, LedgerError, postJournalEntry, reverseJournalEntry } from '@/server/ledger';
import { createVendor } from '@/server/vendors';
import { ensureAppUser } from '@/server/users';
import { createAccountInput } from '@/validation/account';
import { createBillInput, voidBillInput } from '@/validation/bill';
import { createCompanyInput } from '@/validation/company';
import { postJournalEntryInput, reverseJournalEntryInput } from '@/validation/journal';
import { createVendorInput } from '@/validation/vendor';

import { getTestDb, truncateAll } from '../helpers/database';

interface Ctx {
  userId: string;
  companyId: string;
  vendorId: string;
  cashId: string;
  revId: string;
  suppliesId: string;
}

async function makeUser(): Promise<string> {
  const { response } = await getAuth().api.signUpEmail({
    body: { email: `mel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@synthetic.test`, password: 'synthetic-password-1', name: 'M' },
    returnHeaders: true,
  });
  const u = await ensureAppUser({ id: response.user.id, email: response.user.email, name: response.user.name });
  return u.id;
}

async function setup(): Promise<Ctx> {
  const userId = await makeUser();
  const { company } = await createCompanyWithOwner(
    userId,
    createCompanyInput.parse({ legalName: 'Manual Lock Co', timezone: 'America/Chicago' }),
    'standard',
  );
  const vendor = await createVendor(userId, company.id, createVendorInput.parse({ name: 'Globex' }));
  const cash = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Cash', accountType: 'ASSET' }));
  const rev = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Revenue', accountType: 'REVENUE' }));
  const supplies = await createAccount(userId, company.id, createAccountInput.parse({ name: 'Supplies', accountType: 'EXPENSE' }));
  return { userId, companyId: company.id, vendorId: vendor.id, cashId: cash.id, revId: rev.id, suppliesId: supplies.id };
}

async function sysAccount(companyId: string, type: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(
    sql`select id from accounts where company_id = ${companyId} and system_account_type = ${type} limit 1`,
  );
  return r.rows[0]!.id;
}

/** The POSTED entry a bill produced, by source. */
async function billEntryId(companyId: string, billId: string, sourceType: string): Promise<string> {
  const db = await getTestDb();
  const r = await db.execute<{ id: string }>(sql`
    select id from journal_entries
    where company_id = ${companyId} and source_type = ${sourceType} and source_id = ${billId} and status = 'POSTED' limit 1`);
  return r.rows[0]!.id;
}

async function openBill(c: Ctx, price: string): Promise<string> {
  const { bill } = await createBill(c.userId, c.companyId, createBillInput.parse({
    vendorId: c.vendorId, billDate: '2026-01-10', lines: [{ accountId: c.suppliesId, unitPrice: price }],
  }));
  await finalizeBill(c.userId, c.companyId, bill.id);
  return bill.id;
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '<<resolved>>';
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    return (e as LedgerError).code;
  }
};

/** Assert a query rejects with `re` anywhere on the error's cause chain. */
async function expectRejectsOnChain(p: Promise<unknown>, re: RegExp): Promise<void> {
  let thrown: unknown;
  try { await p; } catch (e) { thrown = e; }
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

function manualPost(c: Ctx, lines: { accountId: string; debit?: string; credit?: string }[], sourceType = 'JOURNAL_ENTRY') {
  return postJournalEntry(postJournalEntryInput.parse({
    companyId: c.companyId, actorUserId: c.userId, transactionDate: '2026-02-10', sourceType, lines,
  }));
}

beforeEach(async () => {
  await truncateAll();
});

describe('postJournalEntry posts only JOURNAL_ENTRY (LL-066)', () => {
  it('a JOURNAL_ENTRY to ordinary accounts still posts', async () => {
    const c = await setup();
    const { entry } = await manualPost(c, [
      { accountId: c.cashId, debit: '10.00' },
      { accountId: c.revId, credit: '10.00' },
    ]);
    expect(entry.status).toBe('POSTED');
    await assertLedgerIntegrity(c.companyId);
  });

  it('a document source (EXPENSE / BILL_PAYMENT / VENDOR_CREDIT) is refused', async () => {
    const c = await setup();
    for (const src of ['EXPENSE', 'BILL_PAYMENT', 'VENDOR_CREDIT', 'INVOICE'] as const) {
      expect(await codeOf(manualPost(c, [
        { accountId: c.cashId, debit: '5.00' },
        { accountId: c.revId, credit: '5.00' },
      ], src))).toBe('MANUAL_SOURCE_TYPE_REQUIRED');
    }
    // Nothing posted — the pin fires before any I/O.
    const db = await getTestDb();
    const n = await db.execute<{ n: string }>(sql`select count(*)::text n from journal_entries where company_id = ${c.companyId}`);
    expect(Number(n.rows[0]?.n)).toBe(0);
  });
});

describe('reverseJournalEntry reverses only a MANUAL entry (LL-066)', () => {
  it('reversing a manual JE works, and re-reversing that reversal works', async () => {
    const c = await setup();
    const { entry: je } = await manualPost(c, [
      { accountId: c.cashId, debit: '20.00' },
      { accountId: c.revId, credit: '20.00' },
    ]);
    const { entry: rev1 } = await reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: je.id, reversalDate: '2026-02-15',
    }));
    expect(rev1.sourceType).toBe('REVERSAL');
    // Re-reverse the reversal — its chain roots at a JOURNAL_ENTRY, so it is allowed.
    const { entry: rev2 } = await reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: rev1.id, reversalDate: '2026-02-16',
    }));
    expect(rev2.reversalOfId).toBe(rev1.id);
    await assertLedgerIntegrity(c.companyId);
  });

  it("a document's entry cannot be manually reversed — use the document's void", async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00'); // posts an EXPENSE entry (Cr A/P)
    const expenseEntry = await billEntryId(c.companyId, billId, 'EXPENSE');
    expect(await codeOf(reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: expenseEntry, reversalDate: '2026-02-15',
    })))).toBe('DOCUMENT_REVERSAL_REQUIRES_VOID');
    await assertLedgerIntegrity(c.companyId);
  });

  it("a document VOID's reversal cannot be manually reversed either (the chain-root guard)", async () => {
    const c = await setup();
    const billId = await openBill(c, '100.00');
    const expenseEntry = await billEntryId(c.companyId, billId, 'EXPENSE'); // POSTED, before the void
    await voidBill(c.userId, c.companyId, billId, voidBillInput.parse({ reversalDate: '2026-02-15' }));
    // voidBill produced a REVERSAL whose reversal_of_id is the bill's EXPENSE entry (its
    // source_id is that entry's id, not the bill's) — its chain roots at the EXPENSE source.
    const db = await getTestDb();
    const reversalEntry = (await db.execute<{ id: string }>(sql`
      select id from journal_entries
      where company_id = ${c.companyId} and reversal_of_id = ${expenseEntry} and status = 'POSTED' limit 1`)).rows[0]!.id;
    expect(await codeOf(reverseJournalEntry(reverseJournalEntryInput.parse({
      companyId: c.companyId, actorUserId: c.userId, entryId: reversalEntry, reversalDate: '2026-02-16',
    })))).toBe('DOCUMENT_REVERSAL_REQUIRES_VOID');
    await assertLedgerIntegrity(c.companyId);
  });
});

describe('the manual-post lock is STRUCTURAL — a raw-SQL DRAFT relabel is refused (0025)', () => {
  it('inserting a DRAFT EXPENSE entry with an A/P line then flipping it to a POSTED JOURNAL_ENTRY is rejected', async () => {
    const c = await setup();
    const apId = await sysAccount(c.companyId, 'ACCOUNTS_PAYABLE');
    const db = await getTestDb();
    // Insert a DRAFT entry sourced EXPENSE, then an A/P line — the BEFORE INSERT guard
    // (0023) allows the line because the parent is not JOURNAL_ENTRY. The relabel to a
    // POSTED JOURNAL_ENTRY must be refused by the BEFORE UPDATE guard (0025).
    await expectRejectsOnChain(
      db.transaction(async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, transaction_date, posting_date, source_type, created_by, status)
          values (${c.companyId}, '2026-02-10', '2026-02-10', 'EXPENSE', ${c.userId}, 'DRAFT')
          returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`
          insert into journal_lines (journal_entry_id, company_id, account_id, line_number, debit, credit)
          values (${id}, ${c.companyId}, ${apId}, 1, '1.0000', '0.0000')`);
        // The attack: relabel to a manual, posted entry.
        await tx.execute(sql`
          update journal_entries set source_type = 'JOURNAL_ENTRY', status = 'POSTED', entry_number = 96000 where id = ${id}`);
      }),
      /CONTROL_ACCOUNT_MANUAL_POST/,
    );
    await assertLedgerIntegrity(c.companyId);
  });
});
