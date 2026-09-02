import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gate 1 evidence: the authorization layer fails CLOSED when the database
 * itself fails — not just when records are missing or ids are malformed.
 *
 * The db module is mocked to throw on any use, which is the one failure mode
 * integration tests cannot honestly produce against a healthy Neon branch.
 */
vi.mock('@/db', () => ({
  getDbTx: () => {
    throw new Error('synthetic outage: connection pool exploded');
  },
  getDb: () => {
    throw new Error('synthetic outage: connection pool exploded');
  },
  schema: {},
}));

// The logger writes the real reason; keep the test output quiet and prove the
// raw error is not re-thrown to the caller.
vi.mock('@/lib/logging', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AuthorizationDenied, requireCompanyMembership, requirePermission } from '@/server/authorization';

const USER = '00000000-0000-4000-8000-0000000000a1';
const COMPANY = '00000000-0000-4000-8000-00000000000a';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorization under database failure', () => {
  it('requireCompanyMembership denies — it does not surface the outage', async () => {
    await expect(requireCompanyMembership(USER, COMPANY)).rejects.toBeInstanceOf(
      AuthorizationDenied,
    );
    await expect(requireCompanyMembership(USER, COMPANY)).rejects.toThrow('Not found.');
    // The caller must never see the infrastructure error text.
    await expect(requireCompanyMembership(USER, COMPANY)).rejects.not.toThrow(/outage|pool/);
  });

  it('requirePermission denies identically', async () => {
    await expect(requirePermission(USER, COMPANY, 'journal.post')).rejects.toBeInstanceOf(
      AuthorizationDenied,
    );
  });
});
