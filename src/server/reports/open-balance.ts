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
 * The single definition of an invoice's A/R reductions — LL-050.
 *
 * An OPEN invoice's open balance is `invoice.total − reductions`, where reductions
 * are the NON-VOID payment applications, bad-debt write-offs, AND credit memos against
 * it. The aging subsidiary (`ar-aging`), the payment-application UI
 * (`listOpenInvoices`), and the over-application guards all derive open balance the
 * same way — so this lives ONCE, here, and they cannot drift (the drift was flagged
 * at Gate 3; each new reduction source — write-offs, credit memos, … — must be added
 * here and nowhere else).
 *
 * Correlated subqueries, deliberately NOT LEFT JOINs: joining these reduction tables
 * would multiply rows (a Cartesian fan-out) and overstate the sums. Nothing is stored
 * (invariant 2); PostgreSQL does the money aggregation.
 */

/**
 * The reductions expression for a query that aliases `invoices` as `i`, company-scoped.
 * Embed as `(i.total - ${invoiceReductionsExpr(companyId)})`.
 */
export function invoiceReductionsExpr(companyId: string): SQL {
  return sql`(
    coalesce((
      select sum(pa.amount_applied)
      from payment_applications pa
      join payments p on p.company_id = pa.company_id and p.id = pa.payment_id
      where pa.company_id = ${companyId} and pa.invoice_id = i.id and p.status <> 'VOID'
    ), 0)
    + coalesce((
      select sum(w.amount)
      from writeoffs w
      where w.company_id = ${companyId} and w.invoice_id = i.id and w.status <> 'VOID'
    ), 0)
    + coalesce((
      select sum(cm.amount)
      from credit_memos cm
      where cm.company_id = ${companyId} and cm.invoice_id = i.id and cm.status <> 'VOID'
    ), 0)
  )`;
}

/**
 * The same reductions total for ONE invoice, as a Decimal — for the open-balance
 * checks in `receivePayment` and `writeOffInvoice` (open balance = total − this).
 */
export async function invoiceReductionsTotal(
  executor: Executor,
  companyId: string,
  invoiceId: string,
): Promise<Decimal> {
  const rows = await executor.execute<{ reductions: string }>(sql`
    select (
      coalesce((
        select sum(pa.amount_applied)
        from payment_applications pa
        join payments p on p.company_id = pa.company_id and p.id = pa.payment_id
        where pa.company_id = ${companyId} and pa.invoice_id = ${invoiceId} and p.status <> 'VOID'
      ), 0)
      + coalesce((
        select sum(w.amount)
        from writeoffs w
        where w.company_id = ${companyId} and w.invoice_id = ${invoiceId} and w.status <> 'VOID'
      ), 0)
      + coalesce((
        select sum(cm.amount)
        from credit_memos cm
        where cm.company_id = ${companyId} and cm.invoice_id = ${invoiceId} and cm.status <> 'VOID'
      ), 0)
    )::text as reductions`);
  return toMoney(rows.rows[0]?.reductions ?? '0');
}
