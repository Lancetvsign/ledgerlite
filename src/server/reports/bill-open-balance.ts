import 'server-only';

import { sql } from 'drizzle-orm';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)
import { toMoney } from '@/lib/decimal';

import type { PoolDatabase } from '@/db';
import type Decimal from 'decimal.js';
import type { SQL } from 'drizzle-orm';

/** An executor that runs reads: the pool/HTTP client or an open transaction. */
type Executor = PoolDatabase | Parameters<Parameters<PoolDatabase['transaction']>[0]>[0];

/**
 * The single definition of a bill's A/P reductions — LL-062 (the A/P mirror of
 * `open-balance.ts`).
 *
 * An OPEN bill's open balance is `bill.total − reductions`, where reductions are the
 * NON-VOID bill payments applied to it AND non-void vendor credits against it (LL-063).
 * The A/P aging subsidiary (`ap-aging`, LL-064), the bill-payment UI (`listOpenBills`),
 * and the over-application guards all derive open balance the same way — so this lives
 * ONCE, here, and they cannot drift. Each new A/P reduction source (vendor credits, …)
 * must be added here and nowhere else (memory `ledgerlite-ar-reduction-sources`).
 *
 * Correlated subqueries, deliberately NOT LEFT JOINs: joining these reduction tables
 * would multiply rows (a Cartesian fan-out) and overstate the sums. Nothing is stored
 * (invariant 2); PostgreSQL does the money aggregation.
 */

/**
 * The reductions expression for a query that aliases `bills` as `b`, company-scoped.
 * Embed as `(b.total - ${billReductionsExpr(companyId)})`.
 */
export function billReductionsExpr(companyId: string): SQL {
  return sql`(
    coalesce((
      select sum(bpa.amount_applied)
      from bill_payment_applications bpa
      join bill_payments bp on bp.company_id = bpa.company_id and bp.id = bpa.bill_payment_id
      where bpa.company_id = ${companyId} and bpa.bill_id = b.id and bp.status <> 'VOID'
    ), 0)
    + coalesce((
      select sum(vc.amount)
      from vendor_credits vc
      where vc.company_id = ${companyId} and vc.bill_id = b.id and vc.status <> 'VOID'
    ), 0)
  )`;
}

/**
 * The same reductions total for ONE bill, as a Decimal — for the open-balance check
 * in `payBill` (open balance = total − this).
 */
export async function billReductionsTotal(
  executor: Executor,
  companyId: string,
  billId: string,
): Promise<Decimal> {
  const rows = await executor.execute<{ reductions: string }>(sql`
    select (
      coalesce((
        select sum(bpa.amount_applied)
        from bill_payment_applications bpa
        join bill_payments bp on bp.company_id = bpa.company_id and bp.id = bpa.bill_payment_id
        where bpa.company_id = ${companyId} and bpa.bill_id = ${billId} and bp.status <> 'VOID'
      ), 0)
      + coalesce((
        select sum(vc.amount)
        from vendor_credits vc
        where vc.company_id = ${companyId} and vc.bill_id = ${billId} and vc.status <> 'VOID'
      ), 0)
    )::text as reductions`);
  return toMoney(rows.rows[0]?.reductions ?? '0');
}
