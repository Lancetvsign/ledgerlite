import 'server-only';

import { sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

/**
 * Intercompany balances — LL-098 / ADR-043. For one company: every counterpart it holds a
 * "Due from" or "Due to" pair with, the company's own balance on each, the counterpart's
 * MIRROR figure (their "Due to us" / "Due from us") and the difference — which is 0.0000
 * whenever the books are consistent (GL-T029 proves it structurally: both sides of every
 * intercompany movement post in one transaction, and nothing else may move these accounts).
 *
 * The counterpart figure is a CROSS-COMPANY READ BY DESIGN: it is the other side of postings
 * this company took part in, and the report shows it only against this company's own pair
 * account. Nothing else of the counterpart's books is read. `report.view` in this company
 * is the authorization (AGENTS §6); the counterpart's membership is not required.
 *
 * Money stays NUMERIC in SQL and arrives as strings (ADR-004). Balances are in each
 * account's natural direction (a receivable debit-positive, a payable credit-positive), so a
 * consistent pair shows the SAME figure on both sides.
 */

export interface IntercompanyRow {
  readonly counterpartId: string;
  readonly counterpartLegalName: string;
  /** This company's "Due from <counterpart>" balance (receivable, debit-natural). */
  readonly dueFrom: string;
  /** The counterpart's "Due to <this company>" balance (their payable, credit-natural). */
  readonly counterpartDueTo: string;
  /** dueFrom − counterpartDueTo. */
  readonly receivableDifference: string;
  /** The part of that difference explained by transfers one side has posted and the other not yet matched (LL-099). */
  readonly receivableInTransit: string;
  /** This company's "Due to <counterpart>" balance (payable, credit-natural). */
  readonly dueTo: string;
  /** The counterpart's "Due from <this company>" balance. */
  readonly counterpartDueFrom: string;
  /** dueTo − counterpartDueFrom. */
  readonly payableDifference: string;
  readonly payableInTransit: string;
  /** Both differences are exactly explained by cash in transit (usually: exactly zero). */
  readonly mirrored: boolean;
}

export interface IntercompanyReport {
  readonly asOfDate: string;
  readonly organizationName: string | null;
  readonly rows: readonly IntercompanyRow[];
  readonly totalDueFrom: string;
  readonly totalDueTo: string;
  /** Every row mirrors (net of cash in transit) — the organization-wide statement GL-T029 makes at the gate. */
  readonly mirrored: boolean;
}

export async function getIntercompanyReport(
  actorUserId: string,
  companyId: string,
  asOfDate: string,
): Promise<IntercompanyReport> {
  await requirePermission(actorUserId, companyId, 'report.view');
  if (!isCalendarDate(asOfDate)) {
    throw new Error(`Intercompany report asOfDate must be a calendar date (YYYY-MM-DD): ${asOfDate}`);
  }
  const db = getDb();

  const org = await db.execute<{ name: string | null }>(sql`
    select o.name from companies c left join organizations o on o.id = c.organization_id where c.id = ${companyId}`);

  // One row per counterpart. `bal(account)` = natural-direction balance as of the date;
  // a missing account (the pair was never created in that direction) reads as 0.
  const rows = await db.execute<{
    counterpart_id: string;
    counterpart_legal_name: string;
    due_from_id: string | null;
    counterpart_due_to_id: string | null;
    due_to_id: string | null;
    counterpart_due_from_id: string | null;
    due_from: string;
    counterpart_due_to: string;
    due_to: string;
    counterpart_due_from: string;
  }>(sql`
    with bal as (
      select a.id as account_id,
             coalesce(sum(case when a.account_type in ('ASSET', 'EXPENSE', 'COGS') then l.debit - l.credit else l.credit - l.debit end), 0)::numeric(19,4) as balance
      from accounts a
      left join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
      left join journal_entries e on e.id = l.journal_entry_id and e.status in ('POSTED', 'REVERSED') and e.posting_date <= ${asOfDate}
      where a.intercompany_company_id is not null
        and (a.company_id = ${companyId} or a.intercompany_company_id = ${companyId})
        and (l.id is null or e.id is not null)
      group by a.id
    ),
    pairs as (
      select distinct case when a.company_id = ${companyId} then a.intercompany_company_id else a.company_id end as counterpart_id
      from accounts a
      where a.intercompany_company_id is not null
        and (a.company_id = ${companyId} or a.intercompany_company_id = ${companyId})
    )
    select p.counterpart_id::text as counterpart_id,
           c.legal_name as counterpart_legal_name,
           (select a.id::text from accounts a where a.company_id = ${companyId} and a.intercompany_company_id = p.counterpart_id and a.system_account_type = 'INTERCOMPANY_RECEIVABLE') as due_from_id,
           (select a.id::text from accounts a where a.company_id = p.counterpart_id and a.intercompany_company_id = ${companyId} and a.system_account_type = 'INTERCOMPANY_PAYABLE') as counterpart_due_to_id,
           (select a.id::text from accounts a where a.company_id = ${companyId} and a.intercompany_company_id = p.counterpart_id and a.system_account_type = 'INTERCOMPANY_PAYABLE') as due_to_id,
           (select a.id::text from accounts a where a.company_id = p.counterpart_id and a.intercompany_company_id = ${companyId} and a.system_account_type = 'INTERCOMPANY_RECEIVABLE') as counterpart_due_from_id,
           coalesce((select b.balance from accounts a join bal b on b.account_id = a.id
                     where a.company_id = ${companyId} and a.intercompany_company_id = p.counterpart_id and a.system_account_type = 'INTERCOMPANY_RECEIVABLE'), 0)::numeric(19,4)::text as due_from,
           coalesce((select b.balance from accounts a join bal b on b.account_id = a.id
                     where a.company_id = p.counterpart_id and a.intercompany_company_id = ${companyId} and a.system_account_type = 'INTERCOMPANY_PAYABLE'), 0)::numeric(19,4)::text as counterpart_due_to,
           coalesce((select b.balance from accounts a join bal b on b.account_id = a.id
                     where a.company_id = ${companyId} and a.intercompany_company_id = p.counterpart_id and a.system_account_type = 'INTERCOMPANY_PAYABLE'), 0)::numeric(19,4)::text as due_to,
           coalesce((select b.balance from accounts a join bal b on b.account_id = a.id
                     where a.company_id = p.counterpart_id and a.intercompany_company_id = ${companyId} and a.system_account_type = 'INTERCOMPANY_RECEIVABLE'), 0)::numeric(19,4)::text as counterpart_due_from
    from pairs p
    join companies c on c.id = p.counterpart_id
    order by c.legal_name, p.counterpart_id`);

  // Totals over this company's own pair accounts, by the database.
  const totals = await db.execute<{ f: string; t: string }>(sql`
    select
      coalesce(sum(case when a.system_account_type = 'INTERCOMPANY_RECEIVABLE' then l.debit - l.credit end), 0)::numeric(19,4)::text as f,
      coalesce(sum(case when a.system_account_type = 'INTERCOMPANY_PAYABLE' then l.credit - l.debit end), 0)::numeric(19,4)::text as t
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id and e.status in ('POSTED', 'REVERSED') and e.posting_date <= ${asOfDate}
    where a.company_id = ${companyId} and a.intercompany_company_id is not null`);

  // Cash in transit (LL-099): single-sided INTERCOMPANY groups — one company marked a bank
  // transfer from its statement, the other has not matched its own line yet. Per account,
  // natural direction, as of the date.
  const transit = new Map<string, string>();
  const transitRows = await db.execute<{ account_id: string; amt: string }>(sql`
    select a.id::text as account_id,
           coalesce(sum(case when a.account_type = 'ASSET' then l.debit - l.credit else l.credit - l.debit end), 0)::numeric(19,4)::text as amt
    from accounts a
    join journal_lines l on l.company_id = a.company_id and l.account_id = a.id
    join journal_entries e on e.id = l.journal_entry_id and e.source_type = 'INTERCOMPANY' and e.status = 'POSTED'
     and e.intercompany_group_id is not null and e.posting_date <= ${asOfDate}
     and not exists (select 1 from journal_entries o where o.intercompany_group_id = e.intercompany_group_id and o.id <> e.id)
    where a.intercompany_company_id is not null and (a.company_id = ${companyId} or a.intercompany_company_id = ${companyId})
    group by a.id`);
  for (const t of transitRows.rows) transit.set(t.account_id, t.amt);
  const tr = (id: string | null) => toMoney(id === null ? '0' : (transit.get(id) ?? '0'));

  // The differences are the one computation here: Decimal, exact at 4 dp (ADR-004).
  const out: IntercompanyRow[] = rows.rows.map((r) => {
    const receivableDifference = toMoney(r.due_from).minus(toMoney(r.counterpart_due_to)).toFixed(4);
    const payableDifference = toMoney(r.due_to).minus(toMoney(r.counterpart_due_from)).toFixed(4);
    const receivableInTransit = tr(r.due_from_id).minus(tr(r.counterpart_due_to_id)).toFixed(4);
    const payableInTransit = tr(r.due_to_id).minus(tr(r.counterpart_due_from_id)).toFixed(4);
    return {
      counterpartId: r.counterpart_id,
      counterpartLegalName: r.counterpart_legal_name,
      dueFrom: r.due_from,
      counterpartDueTo: r.counterpart_due_to,
      receivableDifference,
      receivableInTransit,
      dueTo: r.due_to,
      counterpartDueFrom: r.counterpart_due_from,
      payableDifference,
      payableInTransit,
      mirrored: toMoney(receivableDifference).eq(toMoney(receivableInTransit)) && toMoney(payableDifference).eq(toMoney(payableInTransit)),
    };
  });
  return {
    asOfDate,
    organizationName: org.rows[0]?.name ?? null,
    rows: out,
    totalDueFrom: totals.rows[0]?.f ?? '0.0000',
    totalDueTo: totals.rows[0]?.t ?? '0.0000',
    mirrored: out.every((r) => r.mirrored),
  };
}
