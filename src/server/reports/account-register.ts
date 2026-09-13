import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb, schema } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Account register — LL-085 (ADR-040).
 *
 * Every ledger line that touched ONE account over a period, with the balance the
 * account carried before the period (opening), a running balance after each line,
 * and the balance at the end (closing). It is the general-ledger detail an
 * accountant opens to answer "what is in this number?" — the per-account analogue
 * of the customer statement (ADR-022), derived ENTIRELY from `journal_lines`
 * (invariant 2: no balance is stored anywhere).
 *
 * Population and sign follow the existing reports exactly:
 * - `status in ('POSTED','REVERSED')`, never `= 'POSTED'` (ADR-011): a reversed
 *   entry and its reversal both appear and net to zero.
 * - Period by `posting_date` (ADR-002); opening = strictly before `fromDate`.
 * - Balance in the account's NORMAL side (ACCOUNTING_RULES §"normal balance"):
 *   ASSET/EXPENSE/COGS accumulate debit − credit, LIABILITY/EQUITY/REVENUE accumulate
 *   credit − debit — so the closing balance equals the trial balance's `balance`
 *   for the same account as of `toDate`.
 *
 * Each row carries enough to link back to its source (entry id, source type/id,
 * and for bank-import postings the batch id) — the page decides the URL.
 */

export interface AccountRegisterLine {
  /** Posting date (YYYY-MM-DD) — the date that determines the period (ADR-002). */
  readonly date: string;
  readonly entryId: string;
  /** Gapless entry number (ADR-003), as text. */
  readonly entryNumber: string;
  /** INVOICE, CUSTOMER_PAYMENT, EXPENSE (bills), BILL_PAYMENT, BANK_IMPORT, REVERSAL, JOURNAL_ENTRY, … */
  readonly sourceType: string;
  /** The originating record's id when the source has one (text — sources vary). */
  readonly sourceId: string | null;
  /** For REVERSAL entries, the entry being reversed. */
  readonly reversalOfId: string | null;
  /** For BANK_IMPORT postings, the batch the imported line belongs to. */
  readonly bankImportBatchId: string | null;
  /** The entry's description, else the line's memo. */
  readonly description: string | null;
  readonly debit: string;
  readonly credit: string;
  /** Running balance after this line, in the account's normal side. */
  readonly balance: string;
}

export interface AccountRegister {
  readonly accountId: string;
  readonly accountNumber: string | null;
  readonly accountName: string;
  readonly accountType: string;
  /** Which side increases the balance: true for ASSET/EXPENSE/COGS. */
  readonly debitNormal: boolean;
  readonly fromDate: string;
  readonly toDate: string;
  /** Balance the day before `fromDate` (normal side). */
  readonly openingBalance: string;
  readonly lines: readonly AccountRegisterLine[];
  readonly totalDebits: string;
  readonly totalCredits: string;
  /** Balance as of `toDate` = opening ± activity (normal side). */
  readonly closingBalance: string;
}

const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE', 'COGS']);

/**
 * The register for one account, or `null` if the account does not exist in this
 * company — a cross-company id reads as a genuine miss (do-not-leak, §6).
 */
export async function getAccountRegister(
  actorUserId: string,
  companyId: string,
  accountId: string,
  fromDate: string,
  toDate: string,
): Promise<AccountRegister | null> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate)) {
    throw new Error('Account register dates must be calendar dates (YYYY-MM-DD).');
  }
  // Calendar-date strings compare chronologically as plain strings.
  if (fromDate > toDate) {
    throw new Error('Account register fromDate must be on or before toDate.');
  }

  const db = getDb();
  const accountRows = await db
    .select({
      id: schema.accounts.id,
      accountNumber: schema.accounts.accountNumber,
      name: schema.accounts.name,
      accountType: schema.accounts.accountType,
    })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.id, accountId)))
    .limit(1);
  const account = accountRows[0];
  if (account === undefined) return null;
  const debitNormal = DEBIT_NORMAL.has(account.accountType);
  const signed = (debit: ReturnType<typeof toMoney>, credit: ReturnType<typeof toMoney>) =>
    debitNormal ? debit.minus(credit) : credit.minus(debit);

  // ---- Opening: Σ debit and Σ credit over this account's lines posted strictly
  // BEFORE fromDate; the sign is applied in decimal.js. --------------------------
  const opening = await db.execute<{ debits: string; credits: string }>(sql`
    select coalesce(sum(l.debit), 0)::numeric(19,4)::text  as debits,
           coalesce(sum(l.credit), 0)::numeric(19,4)::text as credits
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    where l.company_id = ${companyId}
      and l.account_id = ${accountId}
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date < ${fromDate}`);
  const openingBalance = signed(toMoney(opening.rows[0]?.debits ?? '0'), toMoney(opening.rows[0]?.credits ?? '0'));

  // ---- Activity: one row per line posted within [from, to], deterministically
  // ordered so the running balance is stable. The bank-import join resolves the
  // batch a BANK_IMPORT posting belongs to (its source_id is the imported line). ----
  const activity = await db.execute<{
    posting_date: string;
    entry_id: string;
    entry_number: string;
    source_type: string;
    source_id: string | null;
    reversal_of_id: string | null;
    batch_id: string | null;
    description: string | null;
    debit: string;
    credit: string;
  }>(sql`
    select
      e.posting_date::text            as posting_date,
      e.id::text                      as entry_id,
      e.entry_number::text            as entry_number,
      e.source_type::text             as source_type,
      e.source_id                     as source_id,
      e.reversal_of_id::text          as reversal_of_id,
      bil.batch_id::text              as batch_id,
      coalesce(e.description, l.description) as description,
      l.debit::numeric(19,4)::text    as debit,
      l.credit::numeric(19,4)::text   as credit
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    left join bank_import_lines bil
      on e.source_type = 'BANK_IMPORT'
     and bil.company_id = l.company_id
     and bil.id::text = e.source_id
    where l.company_id = ${companyId}
      and l.account_id = ${accountId}
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date between ${fromDate} and ${toDate}
    order by e.posting_date, e.entry_number, l.line_number`);

  // Running balance carried in decimal.js from the opening balance (ADR-004). A
  // sequential loop (not map): each row's balance depends on the previous row's.
  let running = openingBalance;
  let totalDebits = toMoney('0');
  let totalCredits = toMoney('0');
  const lines: AccountRegisterLine[] = [];
  for (const r of activity.rows) {
    const debit = toMoney(r.debit);
    const credit = toMoney(r.credit);
    totalDebits = totalDebits.plus(debit);
    totalCredits = totalCredits.plus(credit);
    running = running.plus(signed(debit, credit));
    lines.push({
      date: r.posting_date,
      entryId: r.entry_id,
      entryNumber: r.entry_number,
      sourceType: r.source_type,
      sourceId: r.source_id,
      reversalOfId: r.reversal_of_id,
      bankImportBatchId: r.batch_id,
      description: r.description,
      debit: debit.toFixed(4),
      credit: credit.toFixed(4),
      balance: running.toFixed(4),
    });
  }

  return {
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountName: account.name,
    accountType: account.accountType,
    debitNormal,
    fromDate,
    toDate,
    openingBalance: openingBalance.toFixed(4),
    lines,
    totalDebits: totalDebits.toFixed(4),
    totalCredits: totalCredits.toFixed(4),
    closingBalance: running.toFixed(4),
  };
}
