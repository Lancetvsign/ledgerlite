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

/**
 * A stable hash of a document REQUEST's material content — LL-067 (submit-once
 * idempotency). Distinct from `fingerprintPosting`: a document's derived ledger posting
 * (e.g. Dr A/P total / Cr cash) does NOT capture WHICH bills/invoices the applications
 * targeted, nor the document's own row id (fresh per retry). So the document services
 * fingerprint the REQUEST itself — the caller passes the material fields (ids, dates,
 * amounts, and its applications, pre-sorted so order is immaterial), and this hashes them
 * with object keys canonicalised (sorted) recursively, so an identical resubmit matches
 * and a key reused for different content does not.
 */
export function fingerprintRequest(material: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(material))).digest('hex');
}

/** Recursively sort object keys so serialization is order-independent (arrays keep order). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
