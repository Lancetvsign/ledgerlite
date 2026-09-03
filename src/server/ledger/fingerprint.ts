import { createHash } from 'node:crypto';

import type { PostJournalEntryInput } from '@/validation/journal';

/**
 * A stable hash of a posting's MATERIAL content — LL-032.
 *
 * Two requests with the same idempotency key are "identical" iff their
 * fingerprints match. Included: everything that defines what was posted —
 * dates, source, description, and each line's account and amounts. Excluded:
 * actorUserId (a retry may come from a different session) and the key itself.
 *
 * Lines are canonicalised (sorted) so the same posting with lines in a
 * different array order still matches — order is not material to what the entry
 * records.
 */
export function fingerprintPosting(input: PostJournalEntryInput): string {
  const lines = input.lines
    .map((l) => ({
      a: l.accountId,
      d: l.debit,
      c: l.credit,
      desc: l.description ?? '',
      cust: l.customerId ?? '',
      vend: l.vendorId ?? '',
    }))
    .sort((x, y) => (x.a + x.d + x.c).localeCompare(y.a + y.d + y.c));

  const material = JSON.stringify({
    company: input.companyId,
    txn: input.transactionDate,
    post: input.postingDate ?? input.transactionDate,
    desc: input.description ?? '',
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? '',
    lines,
  });

  return createHash('sha256').update(material).digest('hex');
}
