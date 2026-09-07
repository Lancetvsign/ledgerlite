import 'server-only';

import Decimal from 'decimal.js';

import '@/lib/decimal'; // configure decimal.js globally (ADR-004)

/**
 * Shared aging-bucket primitives — the common core of the A/R aging (LL-046) and the
 * A/P aging (LL-064). Both subsidiaries bucket an open balance by how overdue it is,
 * with the SAME cutoffs and the SAME decimal.js accumulation; this module is the one
 * definition so the two cannot drift. It is pure (no I/O): a report joins its own
 * documents and calls these to classify and total.
 */

export interface AgingBuckets {
  readonly current: string;
  readonly d1to30: string;
  readonly d31to60: string;
  readonly d61to90: string;
  readonly d90plus: string;
}

export type BucketKey = keyof AgingBuckets;

/** The bucket an item falls in given whole days past due (≤0 ⇒ not yet due). */
export function bucketFor(daysPastDue: number): BucketKey {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'd1to30';
  if (daysPastDue <= 60) return 'd31to60';
  if (daysPastDue <= 90) return 'd61to90';
  return 'd90plus';
}

/** Whole-day difference asOf − due for two calendar dates (UTC midnight, DST-free). */
export function daysPastDue(asOf: string, due: string): number {
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const d = Date.parse(`${due}T00:00:00Z`);
  return Math.round((a - d) / 86_400_000);
}

export function zeroBuckets(): Record<BucketKey, Decimal> {
  return {
    current: new Decimal(0),
    d1to30: new Decimal(0),
    d31to60: new Decimal(0),
    d61to90: new Decimal(0),
    d90plus: new Decimal(0),
  };
}

export function fixBuckets(b: Record<BucketKey, Decimal>): AgingBuckets {
  return {
    current: b.current.toFixed(4),
    d1to30: b.d1to30.toFixed(4),
    d31to60: b.d31to60.toFixed(4),
    d61to90: b.d61to90.toFixed(4),
    d90plus: b.d90plus.toFixed(4),
  };
}
