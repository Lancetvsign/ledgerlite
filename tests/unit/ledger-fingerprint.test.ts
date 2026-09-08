import { describe, expect, it } from 'vitest';

import { fingerprintRequest } from '@/server/ledger';

/**
 * `fingerprintRequest` — LL-067. The document idempotency fingerprint: a stable hash of a
 * request's material content, used to tell an identical resubmit (return the original) from
 * a key reused for different content (conflict). Object keys are canonicalised (sorted) so
 * serialization order is immaterial; array order is preserved (callers sort where needed).
 */
describe('fingerprintRequest', () => {
  it('is deterministic for identical material', () => {
    const m = { vendorId: 'v1', amount: '40.0000', applications: [{ billId: 'b1', amountApplied: '40.0000' }] };
    expect(fingerprintRequest(m)).toBe(fingerprintRequest(m));
    expect(fingerprintRequest({ ...m })).toBe(fingerprintRequest(m)); // a fresh object with the same content
  });

  it('is independent of object KEY order', () => {
    const a = fingerprintRequest({ vendorId: 'v1', paymentDate: '2026-02-01', amount: '10.0000' });
    const b = fingerprintRequest({ amount: '10.0000', vendorId: 'v1', paymentDate: '2026-02-01' });
    expect(a).toBe(b);
  });

  it('is independent of nested object key order', () => {
    const a = fingerprintRequest({ applications: [{ billId: 'b1', amountApplied: '5.0000' }] });
    const b = fingerprintRequest({ applications: [{ amountApplied: '5.0000', billId: 'b1' }] });
    expect(a).toBe(b);
  });

  it('is SENSITIVE to array order (callers must sort applications)', () => {
    const a = fingerprintRequest({ apps: [{ id: 'b1' }, { id: 'b2' }] });
    const b = fingerprintRequest({ apps: [{ id: 'b2' }, { id: 'b1' }] });
    expect(a).not.toBe(b);
  });

  it('changes when any material value changes (amount, target, date)', () => {
    const base = { billId: 'b1', amount: '40.0000', creditDate: '2026-02-01' };
    expect(fingerprintRequest({ ...base, amount: '41.0000' })).not.toBe(fingerprintRequest(base));
    expect(fingerprintRequest({ ...base, billId: 'b2' })).not.toBe(fingerprintRequest(base)); // same total, different bill
    expect(fingerprintRequest({ ...base, creditDate: '2026-02-02' })).not.toBe(fingerprintRequest(base));
  });
});
