import 'server-only';

import { sql, type SQL } from 'drizzle-orm';

/**
 * Cash-basis P&L — LL-126 (ADR-048). The owner's rules (2026-09-29):
 *  - revenue counts when the customer PAYS and expenses when the bill is PAID;
 *  - credit memos, bad-debt write-offs and vendor credits are LEFT OUT (they adjust amounts never
 *    received or paid);
 *  - every other entry counts as posted — bank-statement postings, manual journal entries (non-cash
 *    ones such as depreciation included), intercompany takes.
 *
 * A payment is allocated over the document it pays by that document's OWN profit-and-loss journal
 * lines, scaled by `amount_applied / document total` — so an invoice's sales-tax share (credited to a
 * liability) is simply not carried, and a split invoice splits its payment in proportion. Each
 * (payment, line) share is rounded to 4 decimals. A void is its REVERSAL entry, on the void's own date:
 * the payment counts on its date and is taken back on the void's. All figures come from
 * `journal_lines` (ADR-002); money stays NUMERIC in PostgreSQL (ADR-004).
 *
 * Returns one row per (company, P&L account) with the amount in the account's natural direction
 * (revenue credit − debit; COGS / expense debit − credit), like the accrual statement's query.
 */

/** Source types that are A/R or A/P document accounting — replaced (or left out) on a cash basis. */
const DOCUMENT_SOURCES = sql`('INVOICE', 'EXPENSE', 'CREDIT_MEMO', 'BAD_DEBT_WRITEOFF', 'VENDOR_CREDIT', 'CUSTOMER_PAYMENT', 'BILL_PAYMENT', 'CLOSING')`;

export type CashBasisRow = {
  company_id: string;
  account_id: string;
  account_number: string | null;
  account_name: string;
  account_type: string;
  system_account_type: string | null;
  amount: string;
};

export function cashBasisPnlQuery(companyIds: readonly string[], fromDate: string, toDate: string): SQL {
  const ids = sql.join(companyIds.map((id) => sql`${id}`), sql`, `);
  // A payment entry in the period counts +1; a REVERSAL of one (its void) in the period counts −1.
  const paymentEntries = (sourceType: 'CUSTOMER_PAYMENT' | 'BILL_PAYMENT') => sql`
    select e.company_id, e.source_id, 1 as sign
      from journal_entries e
     where e.company_id in (${ids}) and e.source_type = ${sourceType}
       and e.status in ('POSTED', 'REVERSED') and e.posting_date between ${fromDate} and ${toDate}
    union all
    select oe.company_id, oe.source_id, -1 as sign
      from journal_entries e
      join journal_entries oe on oe.id = e.reversal_of_id
     where e.company_id in (${ids}) and e.source_type = 'REVERSAL' and oe.source_type = ${sourceType}
       and e.status in ('POSTED', 'REVERSED') and e.posting_date between ${fromDate} and ${toDate}`;

  return sql`
    with pl as (
      -- 1. Everything that is not A/R or A/P document accounting, as posted.
      select l.company_id, l.account_id, (l.credit - l.debit) as cd
        from journal_lines l
        join journal_entries e on e.id = l.journal_entry_id
        left join journal_entries oe on oe.id = e.reversal_of_id
       where l.company_id in (${ids})
         and e.status in ('POSTED', 'REVERSED')
         and e.posting_date between ${fromDate} and ${toDate}
         and e.source_type::text not in ${DOCUMENT_SOURCES}
         and (e.source_type <> 'REVERSAL' or oe.source_type is null or oe.source_type::text not in ${DOCUMENT_SOURCES})
      union all
      -- 2. Customer payments, allocated over each paid invoice's own P&L lines.
      select dl.company_id, dl.account_id,
             round((dl.credit - dl.debit) * pa.amount_applied / nullif(i.total, 0), 4) * pe.sign as cd
        from (${paymentEntries('CUSTOMER_PAYMENT')}) pe
        join payments p on p.company_id = pe.company_id and p.id::text = pe.source_id
        join payment_applications pa on pa.company_id = p.company_id and pa.payment_id = p.id
        join invoices i on i.company_id = pa.company_id and i.id = pa.invoice_id
        join journal_entries de on de.company_id = i.company_id and de.source_type = 'INVOICE'
                                and de.source_id = i.id::text and de.reversal_of_id is null
                                and de.status in ('POSTED', 'REVERSED')
        join journal_lines dl on dl.company_id = de.company_id and dl.journal_entry_id = de.id
      union all
      -- 3. Bill payments, allocated over each paid bill's own P&L lines.
      select dl.company_id, dl.account_id,
             round((dl.credit - dl.debit) * ba.amount_applied / nullif(b.total, 0), 4) * pe.sign as cd
        from (${paymentEntries('BILL_PAYMENT')}) pe
        join bill_payments bp on bp.company_id = pe.company_id and bp.id::text = pe.source_id
        join bill_payment_applications ba on ba.company_id = bp.company_id and ba.bill_payment_id = bp.id
        join bills b on b.company_id = ba.company_id and b.id = ba.bill_id
        join journal_entries de on de.company_id = b.company_id and de.source_type = 'EXPENSE'
                                and de.source_id = b.id::text and de.reversal_of_id is null
                                and de.status in ('POSTED', 'REVERSED')
        join journal_lines dl on dl.company_id = de.company_id and dl.journal_entry_id = de.id
    )
    select
      a.company_id::text        as company_id,
      a.id::text                as account_id,
      a.account_number          as account_number,
      a.name                    as account_name,
      a.account_type::text      as account_type,
      a.system_account_type     as system_account_type,
      (case when a.account_type = 'REVENUE' then sum(pl.cd) else -sum(pl.cd) end)::numeric(19,4)::text as amount
    from pl
    join accounts a on a.company_id = pl.company_id and a.id = pl.account_id
    where a.account_type in ('REVENUE', 'COGS', 'EXPENSE')
    group by a.company_id, a.id, a.account_number, a.name, a.account_type, a.system_account_type
    order by a.account_number nulls last, a.name`;
}
