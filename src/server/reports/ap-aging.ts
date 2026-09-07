import 'server-only';

import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

import { type AgingBuckets, type BucketKey, bucketFor, daysPastDue, fixBuckets, zeroBuckets } from './aging';
import { billReductionsExpr } from './bill-open-balance';

/**
 * Accounts Payable aging — LL-064. The A/P mirror of the A/R aging (LL-046 / ADR-016).
 *
 * The A/P SUBSIDIARY ledger: every OPEN bill's open balance (total − what non-void bill
 * payments AND vendor credits have reduced, the shared derivation in
 * `bill-open-balance.ts`), bucketed by how overdue it is, per vendor. Its grand total
 * must equal the A/P CONTROL balance in the general ledger (derived from journal lines)
 * — the subsidiary⇔control reconciliation, the A/P analogue of GL-T018, asserted by
 * GL-T026. No balance is stored (invariant 2): open balances derive from bills + their
 * reductions, every time.
 *
 * "As of" a date buckets the CURRENT open balances by age (asOf − due date, or the bill
 * date when there is no due date); the grand total is age-independent, so the
 * reconciliation holds for any asOfDate. Money is a `string` at every boundary and
 * computed with decimal.js (ADR-004).
 */

export interface ApAgingVendor {
  readonly vendorId: string;
  readonly vendorName: string;
  readonly buckets: AgingBuckets;
  readonly total: string;
}
export interface ApAging {
  readonly asOfDate: string;
  readonly vendors: readonly ApAgingVendor[];
  readonly totals: AgingBuckets & { readonly total: string };
}

export async function getApAging(
  actorUserId: string,
  companyId: string,
  asOfDate: string,
): Promise<ApAging> {
  await requirePermission(actorUserId, companyId, 'report.view');
  if (!isCalendarDate(asOfDate)) {
    throw new Error(`A/P aging asOfDate must be a calendar date (YYYY-MM-DD): ${asOfDate}`);
  }

  // One open bill per row, with its open balance = total − non-void reductions (bill
  // payments + vendor credits), the shared A/P derivation (LL-062/063). PostgreSQL does
  // the money aggregation; we never sum raw reductions in JavaScript.
  const rows = await getDb().execute<{
    vendor_id: string;
    vendor_name: string;
    due_date: string | null;
    bill_date: string;
    open_balance: string;
  }>(sql`
    select
      b.vendor_id::text as vendor_id,
      v.name            as vendor_name,
      b.due_date        as due_date,
      b.bill_date       as bill_date,
      (b.total - ${billReductionsExpr(companyId)})::numeric(19,4)::text as open_balance
    from bills b
    join vendors v on v.company_id = b.company_id and v.id = b.vendor_id
    where b.company_id = ${companyId} and b.status = 'OPEN'
    order by v.name`);

  const byVendor = new Map<string, { name: string; buckets: Record<BucketKey, Decimal>; total: Decimal }>();
  const order: string[] = [];
  const grand = zeroBuckets();
  let grandTotal = new Decimal(0);

  for (const r of rows.rows) {
    const bal = toMoney(r.open_balance);
    if (bal.isZero()) continue; // an OPEN bill always owes > 0; skip defensively
    const key = bucketFor(daysPastDue(asOfDate, r.due_date ?? r.bill_date));

    let entry = byVendor.get(r.vendor_id);
    if (entry === undefined) {
      entry = { name: r.vendor_name, buckets: zeroBuckets(), total: new Decimal(0) };
      byVendor.set(r.vendor_id, entry);
      order.push(r.vendor_id);
    }
    entry.buckets[key] = entry.buckets[key].plus(bal);
    entry.total = entry.total.plus(bal);
    grand[key] = grand[key].plus(bal);
    grandTotal = grandTotal.plus(bal);
  }

  return {
    asOfDate,
    vendors: order.map((id) => {
      const e = byVendor.get(id)!;
      return { vendorId: id, vendorName: e.name, buckets: fixBuckets(e.buckets), total: e.total.toFixed(4) };
    }),
    totals: { ...fixBuckets(grand), total: grandTotal.toFixed(4) },
  };
}
