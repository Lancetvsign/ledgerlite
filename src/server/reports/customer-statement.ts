import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb, schema } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Customer statement — LL-054.
 *
 * One customer's Accounts Receivable over a period: the balance they owed at the
 * start (opening), every ledger event that moved it (activity), and the balance
 * they owe at the end (closing). Computed ENTIRELY from `journal_lines` — no
 * balance is stored (invariant 2) — and money crosses every boundary as a `string`,
 * computed with decimal.js (ADR-004).
 *
 * WHY THIS IS LEDGER-DERIVED AND HISTORICALLY EXACT. Every document (invoice,
 * payment, write-off, credit memo) posts its A/R line CUSTOMER-TAGGED, and a
 * reversal preserves that tag (`reverseEntryCore`, LL-033). Manual journal entries
 * are forbidden from touching the A/R control account (the LL-050 trigger). So a
 * customer's A/R balance as of any date is exactly `Σ(debit − credit)` over the
 * A/R journal lines tagged with that customer whose entry posted on or before that
 * date — the same point-in-time rule the trial balance uses (`posting_date <=`).
 * It follows that this statement's closing balance is that customer's slice of the
 * GL A/R control balance as of `toDate`: the per-customer analogue of the
 * subsidiary⇔control reconciliation (GL-T018 / ADR-016), asserted by GL-T021.
 *
 * SCOPE. This is the period statement (opening / activity / closing). It is NOT the
 * open-invoice aging — that is the aging report's job (LL-046), and a *historical*
 * open-items-as-of-a-past-date needs the point-in-time aging ADR-016 deferred.
 *
 * `POSTED` and `REVERSED` entries both count (a reversed entry and its reversal net
 * to zero — the honest presentation); drafts never appear.
 */

export interface CustomerStatementLine {
  /** Posting date (YYYY-MM-DD) — the date that determines the period (ADR-002). */
  readonly date: string;
  /** Gapless entry number of the posting this A/R line belongs to. */
  readonly entryNumber: string;
  /** INVOICE, CUSTOMER_PAYMENT, BAD_DEBT_WRITEOFF, CREDIT_MEMO, REVERSAL, … */
  readonly sourceType: string;
  readonly description: string | null;
  /** Debit to A/R — increases what the customer owes. */
  readonly charge: string;
  /** Credit to A/R — decreases what the customer owes. */
  readonly credit: string;
  /** Running A/R balance after this line (opening + Σ charges − Σ credits so far). */
  readonly balance: string;
}

export interface CustomerStatement {
  readonly customerId: string;
  readonly customerName: string;
  readonly fromDate: string;
  readonly toDate: string;
  /** A/R balance owed at the day before `fromDate`. */
  readonly openingBalance: string;
  readonly lines: readonly CustomerStatementLine[];
  /** A/R balance owed as of `toDate` = opening + Σ(activity). */
  readonly closingBalance: string;
}

/**
 * A period statement for one customer, or `null` if the customer does not exist in
 * this company. The null is deliberate: a cross-company customer id reads as a
 * genuine miss, never revealing that it exists elsewhere (do-not-leak, §6).
 */
export async function getCustomerStatement(
  actorUserId: string,
  companyId: string,
  customerId: string,
  fromDate: string,
  toDate: string,
): Promise<CustomerStatement | null> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(fromDate)) {
    throw new Error(`Customer statement fromDate must be a calendar date (YYYY-MM-DD): ${fromDate}`);
  }
  if (!isCalendarDate(toDate)) {
    throw new Error(`Customer statement toDate must be a calendar date (YYYY-MM-DD): ${toDate}`);
  }
  // Calendar-date strings compare chronologically as plain strings.
  if (fromDate > toDate) {
    throw new Error(`Customer statement fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  }

  const db = getDb();

  // The customer must belong to THIS company. A cross-company / unknown id returns
  // null — same response as a genuine miss (do-not-leak, §6).
  const customerRows = await db
    .select({ name: schema.customers.name })
    .from(schema.customers)
    .where(and(eq(schema.customers.companyId, companyId), eq(schema.customers.id, customerId)))
    .limit(1);
  const customer = customerRows[0];
  if (customer === undefined) return null;

  // ---- Opening balance: Σ(debit − credit) over this customer's A/R lines whose
  // entry posted strictly BEFORE fromDate. PostgreSQL does the arithmetic. --------
  const opening = await db.execute<{ opening: string }>(sql`
    select coalesce(sum(l.debit - l.credit), 0)::numeric(19,4)::text as opening
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    join accounts a on a.company_id = l.company_id and a.id = l.account_id
    where l.company_id = ${companyId}
      and l.customer_id = ${customerId}
      and a.system_account_type = 'ACCOUNTS_RECEIVABLE'
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date < ${fromDate}`);
  const openingBalance = toMoney(opening.rows[0]?.opening ?? '0');

  // ---- Activity: this customer's A/R lines whose entry posted within [from, to],
  // one row per line, deterministically ordered so the running balance is stable. -
  const activity = await db.execute<{
    posting_date: string;
    entry_number: string;
    source_type: string;
    description: string | null;
    debit: string;
    credit: string;
  }>(sql`
    select
      e.posting_date::text     as posting_date,
      e.entry_number::text     as entry_number,
      e.source_type::text      as source_type,
      e.description            as description,
      l.debit::numeric(19,4)::text  as debit,
      l.credit::numeric(19,4)::text as credit
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    join accounts a on a.company_id = l.company_id and a.id = l.account_id
    where l.company_id = ${companyId}
      and l.customer_id = ${customerId}
      and a.system_account_type = 'ACCOUNTS_RECEIVABLE'
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date between ${fromDate} and ${toDate}
    order by e.posting_date, e.entry_number, l.line_number`);

  // Running balance carried in decimal.js from the opening balance (ADR-004). A
  // sequential loop (not map): each row's balance depends on the previous row's.
  let running = openingBalance;
  const lines: CustomerStatementLine[] = [];
  for (const r of activity.rows) {
    const charge = toMoney(r.debit);
    const credit = toMoney(r.credit);
    running = running.plus(charge).minus(credit);
    lines.push({
      date: r.posting_date,
      entryNumber: r.entry_number,
      sourceType: r.source_type,
      description: r.description,
      charge: charge.toFixed(4),
      credit: credit.toFixed(4),
      balance: running.toFixed(4),
    });
  }

  // Closing = opening + Σ(activity) — the accumulator's final value, which is also
  // this customer's contribution to the GL A/R control as of toDate (GL-T021).
  return {
    customerId,
    customerName: customer.name,
    fromDate,
    toDate,
    openingBalance: openingBalance.toFixed(4),
    lines,
    closingBalance: running.toFixed(4),
  };
}
