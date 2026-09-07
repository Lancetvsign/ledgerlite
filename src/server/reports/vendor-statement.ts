import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb, schema } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Vendor statement — LL-064. The A/P mirror of the customer statement (LL-054 / ADR-022).
 *
 * One vendor's Accounts Payable over a period: the balance we owed at the start
 * (opening), every ledger event that moved it (activity), and the balance we owe at the
 * end (closing). Computed ENTIRELY from `journal_lines` — no balance is stored
 * (invariant 2) — and money crosses every boundary as a `string`, computed with
 * decimal.js (ADR-004).
 *
 * WHY THIS IS LEDGER-DERIVED AND HISTORICALLY EXACT. Every A/P document (bill, bill
 * payment, vendor credit) posts its A/P line VENDOR-TAGGED, and a reversal preserves
 * that tag (`reverseEntryCore`). Manual journal entries are forbidden from touching the
 * A/P control account (the 0023 control-account guard). So a vendor's A/P balance as of
 * any date is exactly `Σ(credit − debit)` over the A/P journal lines tagged with that
 * vendor whose entry posted on or before that date — A/P is credit-natural (a liability),
 * the sign mirror of the customer statement's `debit − credit`. It follows that this
 * statement's closing balance is that vendor's slice of the GL A/P control balance as of
 * `toDate`: the per-vendor analogue of the subsidiary⇔control reconciliation, asserted by
 * GL-T026.
 *
 * SCOPE. This is the period statement (opening / activity / closing). It is NOT the
 * open-bill aging — that is the A/P aging's job (`getApAging`).
 *
 * `POSTED` and `REVERSED` entries both count (a reversed entry and its reversal net to
 * zero — the honest presentation); drafts never appear.
 */

export interface VendorStatementLine {
  /** Posting date (YYYY-MM-DD) — the date that determines the period (ADR-002). */
  readonly date: string;
  /** Gapless entry number of the posting this A/P line belongs to. */
  readonly entryNumber: string;
  /** EXPENSE (bill), BILL_PAYMENT, VENDOR_CREDIT, REVERSAL, … */
  readonly sourceType: string;
  readonly description: string | null;
  /** Credit to A/P — increases what we owe the vendor (a bill). */
  readonly charge: string;
  /** Debit to A/P — decreases what we owe the vendor (a payment or vendor credit). */
  readonly payment: string;
  /** Running A/P balance after this line (opening + Σ charges − Σ payments so far). */
  readonly balance: string;
}

export interface VendorStatement {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly fromDate: string;
  readonly toDate: string;
  /** A/P balance owed at the day before `fromDate`. */
  readonly openingBalance: string;
  readonly lines: readonly VendorStatementLine[];
  /** A/P balance owed as of `toDate` = opening + Σ(activity). */
  readonly closingBalance: string;
}

/**
 * A period statement for one vendor, or `null` if the vendor does not exist in this
 * company. The null is deliberate: a cross-company vendor id reads as a genuine miss,
 * never revealing that it exists elsewhere (do-not-leak, §6).
 */
export async function getVendorStatement(
  actorUserId: string,
  companyId: string,
  vendorId: string,
  fromDate: string,
  toDate: string,
): Promise<VendorStatement | null> {
  await requirePermission(actorUserId, companyId, 'report.view');

  if (!isCalendarDate(fromDate)) {
    throw new Error(`Vendor statement fromDate must be a calendar date (YYYY-MM-DD): ${fromDate}`);
  }
  if (!isCalendarDate(toDate)) {
    throw new Error(`Vendor statement toDate must be a calendar date (YYYY-MM-DD): ${toDate}`);
  }
  // Calendar-date strings compare chronologically as plain strings.
  if (fromDate > toDate) {
    throw new Error(`Vendor statement fromDate (${fromDate}) must be on or before toDate (${toDate}).`);
  }

  const db = getDb();

  // The vendor must belong to THIS company. A cross-company / unknown id returns null —
  // same response as a genuine miss (do-not-leak, §6).
  const vendorRows = await db
    .select({ name: schema.vendors.name })
    .from(schema.vendors)
    .where(and(eq(schema.vendors.companyId, companyId), eq(schema.vendors.id, vendorId)))
    .limit(1);
  const vendor = vendorRows[0];
  if (vendor === undefined) return null;

  // ---- Opening balance: Σ(credit − debit) over this vendor's A/P lines whose entry
  // posted strictly BEFORE fromDate. A/P is credit-natural. PostgreSQL does the
  // arithmetic. ------------------------------------------------------------------------
  const opening = await db.execute<{ opening: string }>(sql`
    select coalesce(sum(l.credit - l.debit), 0)::numeric(19,4)::text as opening
    from journal_lines l
    join journal_entries e on e.id = l.journal_entry_id
    join accounts a on a.company_id = l.company_id and a.id = l.account_id
    where l.company_id = ${companyId}
      and l.vendor_id = ${vendorId}
      and a.system_account_type = 'ACCOUNTS_PAYABLE'
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date < ${fromDate}`);
  const openingBalance = toMoney(opening.rows[0]?.opening ?? '0');

  // ---- Activity: this vendor's A/P lines whose entry posted within [from, to], one row
  // per line, deterministically ordered so the running balance is stable. --------------
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
      and l.vendor_id = ${vendorId}
      and a.system_account_type = 'ACCOUNTS_PAYABLE'
      and e.status in ('POSTED', 'REVERSED')
      and e.posting_date between ${fromDate} and ${toDate}
    order by e.posting_date, e.entry_number, l.line_number`);

  // Running balance carried in decimal.js from the opening balance (ADR-004). A
  // sequential loop (not map): each row's balance depends on the previous row's. A/P
  // grows by a credit (a bill) and shrinks by a debit (a payment / vendor credit).
  let running = openingBalance;
  const lines: VendorStatementLine[] = [];
  for (const r of activity.rows) {
    const charge = toMoney(r.credit);
    const payment = toMoney(r.debit);
    running = running.plus(charge).minus(payment);
    lines.push({
      date: r.posting_date,
      entryNumber: r.entry_number,
      sourceType: r.source_type,
      description: r.description,
      charge: charge.toFixed(4),
      payment: payment.toFixed(4),
      balance: running.toFixed(4),
    });
  }

  // Closing = opening + Σ(activity) — the accumulator's final value, which is also this
  // vendor's contribution to the GL A/P control as of toDate (GL-T026).
  return {
    vendorId,
    vendorName: vendor.name,
    fromDate,
    toDate,
    openingBalance: openingBalance.toFixed(4),
    lines,
    closingBalance: running.toFixed(4),
  };
}
