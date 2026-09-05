import 'server-only';

import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { getDb } from '@/db';
import { isCalendarDate } from '@/lib/dates';
import { toMoney } from '@/lib/decimal';
import { requirePermission } from '@/server/authorization';

import { invoiceReductionsExpr } from './open-balance';

/**
 * Accounts Receivable aging — LL-046.
 *
 * The A/R SUBSIDIARY ledger: every OPEN invoice's open balance (total − what
 * non-void payments have applied, ADR-015), bucketed by how overdue it is. Its
 * grand total must equal the A/R CONTROL balance in the general ledger (derived
 * from journal lines) — the subsidiary⇔control reconciliation, enforced by a
 * release-gate test (GL-T018) and recorded in ADR-016. No balance is stored
 * (invariant 2): open balances derive from invoices + applications, every time.
 *
 * "As of" a date buckets the CURRENT open balances by age (asOf − due date, or the
 * invoice date when there is no due date); the grand total is age-independent, so
 * the reconciliation holds for any asOfDate. Money is a `string` at every boundary
 * and computed with decimal.js (ADR-004).
 */

export interface AgingBuckets {
  readonly current: string;
  readonly d1to30: string;
  readonly d31to60: string;
  readonly d61to90: string;
  readonly d90plus: string;
}
export interface ArAgingCustomer {
  readonly customerId: string;
  readonly customerName: string;
  readonly buckets: AgingBuckets;
  readonly total: string;
}
export interface ArAging {
  readonly asOfDate: string;
  readonly customers: readonly ArAgingCustomer[];
  readonly totals: AgingBuckets & { readonly total: string };
}

type BucketKey = keyof AgingBuckets;

function bucketFor(daysPastDue: number): BucketKey {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'd1to30';
  if (daysPastDue <= 60) return 'd31to60';
  if (daysPastDue <= 90) return 'd61to90';
  return 'd90plus';
}

/** Whole-day difference asOf − due for two calendar dates (UTC midnight, DST-free). */
function daysPastDue(asOf: string, due: string): number {
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const d = Date.parse(`${due}T00:00:00Z`);
  return Math.round((a - d) / 86_400_000);
}

function zeroBuckets(): Record<BucketKey, Decimal> {
  return {
    current: new Decimal(0),
    d1to30: new Decimal(0),
    d31to60: new Decimal(0),
    d61to90: new Decimal(0),
    d90plus: new Decimal(0),
  };
}
function fixBuckets(b: Record<BucketKey, Decimal>): AgingBuckets {
  return {
    current: b.current.toFixed(4),
    d1to30: b.d1to30.toFixed(4),
    d31to60: b.d31to60.toFixed(4),
    d61to90: b.d61to90.toFixed(4),
    d90plus: b.d90plus.toFixed(4),
  };
}

export async function getArAging(
  actorUserId: string,
  companyId: string,
  asOfDate: string,
): Promise<ArAging> {
  await requirePermission(actorUserId, companyId, 'report.view');
  if (!isCalendarDate(asOfDate)) {
    throw new Error(`A/R aging asOfDate must be a calendar date (YYYY-MM-DD): ${asOfDate}`);
  }

  // One open invoice per row, with its open balance = total − non-void reductions
  // (payments applied + write-offs), the shared A/R derivation (LL-050). PostgreSQL
  // does the money aggregation; we never sum raw reductions in JavaScript.
  const rows = await getDb().execute<{
    customer_id: string;
    customer_name: string;
    due_date: string | null;
    invoice_date: string;
    open_balance: string;
  }>(sql`
    select
      i.customer_id::text as customer_id,
      cu.name             as customer_name,
      i.due_date          as due_date,
      i.invoice_date      as invoice_date,
      (i.total - ${invoiceReductionsExpr(companyId)})::numeric(19,4)::text as open_balance
    from invoices i
    join customers cu on cu.company_id = i.company_id and cu.id = i.customer_id
    where i.company_id = ${companyId} and i.status = 'OPEN'
    order by cu.name`);

  const byCustomer = new Map<string, { name: string; buckets: Record<BucketKey, Decimal>; total: Decimal }>();
  const order: string[] = [];
  const grand = zeroBuckets();
  let grandTotal = new Decimal(0);

  for (const r of rows.rows) {
    const bal = toMoney(r.open_balance);
    if (bal.isZero()) continue; // an OPEN invoice always owes > 0; skip defensively
    const key = bucketFor(daysPastDue(asOfDate, r.due_date ?? r.invoice_date));

    let entry = byCustomer.get(r.customer_id);
    if (entry === undefined) {
      entry = { name: r.customer_name, buckets: zeroBuckets(), total: new Decimal(0) };
      byCustomer.set(r.customer_id, entry);
      order.push(r.customer_id);
    }
    entry.buckets[key] = entry.buckets[key].plus(bal);
    entry.total = entry.total.plus(bal);
    grand[key] = grand[key].plus(bal);
    grandTotal = grandTotal.plus(bal);
  }

  return {
    asOfDate,
    customers: order.map((id) => {
      const e = byCustomer.get(id)!;
      return { customerId: id, customerName: e.name, buckets: fixBuckets(e.buckets), total: e.total.toFixed(4) };
    }),
    totals: { ...fixBuckets(grand), total: grandTotal.toFixed(4) },
  };
}
