import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  CAPABILITY_GRANTS,
  ROLES,
  capabilitiesForRole,
  roleHasCapability,
  type Capability,
} from '@/server/rbac';

/**
 * THE EXHAUSTIVE MATRIX, written out by hand.
 *
 * Deliberately not derived from the implementation — it is the independent
 * statement of intended policy. If someone edits CAPABILITY_GRANTS, this file
 * must be edited too, which is the point: a permission change should never be
 * a one-line diff that reads as refactoring.
 */
const EXPECTED: Record<(typeof ROLES)[number], readonly Capability[]> = {
  OWNER: [
    'company.manage',
    'user.manage',
    'account.view',
    'account.manage',
    'period.view',
    'period.close',
    'journal.view',
    'journal.create',
    'journal.post',
    'customer.view',
    'customer.manage',
    'invoice.view',
    'invoice.create',
    'invoice.post',
    'payment.view',
    'payment.create',
    'expense.view',
    'expense.create',
    'reconciliation.view',
    'reconciliation.complete',
    'report.view',
    'accountant_export.create',
  ],
  ADMIN: [
    'company.manage',
    'user.manage',
    'account.view',
    'account.manage',
    'period.view',
    'period.close',
    'journal.view',
    'journal.create',
    'journal.post',
    'customer.view',
    'customer.manage',
    'invoice.view',
    'invoice.create',
    'invoice.post',
    'payment.view',
    'payment.create',
    'expense.view',
    'expense.create',
    'reconciliation.view',
    'reconciliation.complete',
    'report.view',
    'accountant_export.create',
  ],
  BOOKKEEPER: [
    'account.view',
    'period.view',
    'journal.view',
    'customer.view',
    'customer.manage',
    'invoice.view',
    'invoice.create',
    'invoice.post',
    'payment.view',
    'payment.create',
    'expense.view',
    'expense.create',
    'reconciliation.view',
    'reconciliation.complete',
    'report.view',
  ],
  ACCOUNTANT: [
    'account.view',
    'account.manage',
    'period.view',
    'period.close',
    'journal.view',
    'journal.create',
    'journal.post',
    'customer.view',
    'customer.manage',
    'invoice.view',
    'invoice.create',
    'invoice.post',
    'payment.view',
    'payment.create',
    'expense.view',
    'expense.create',
    'reconciliation.view',
    'reconciliation.complete',
    'report.view',
    'accountant_export.create',
  ],
  READ_ONLY: [
    'account.view',
    'period.view',
    'journal.view',
    'customer.view',
    'invoice.view',
    'payment.view',
    'expense.view',
    'reconciliation.view',
    'report.view',
  ],
};

describe('the capability matrix, exhaustively', () => {
  it.each(ROLES)('%s holds exactly its documented capabilities', (role) => {
    const actual = [...capabilitiesForRole(role)].sort();
    expect(actual).toEqual([...EXPECTED[role]].sort());
  });

  it('covers every capability in the expectation — nothing unmapped on either side', () => {
    const everyExpected = new Set(Object.values(EXPECTED).flat());
    expect([...everyExpected].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('grants every capability to at least one role', () => {
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_GRANTS[capability].length).toBeGreaterThan(0);
    }
  });
});

describe('policy properties', () => {
  it('READ_ONLY can see and never change', () => {
    for (const capability of capabilitiesForRole('READ_ONLY')) {
      expect(capability).toMatch(/\.(view)$|^report\.view$/);
    }
  });

  it('everyone with any role can view the basics', () => {
    for (const role of ROLES) {
      expect(roleHasCapability(role, 'report.view')).toBe(true);
      expect(roleHasCapability(role, 'journal.view')).toBe(true);
    }
  });

  it('manual journal work is the instrument of ledger writers, not bookkeepers', () => {
    expect(roleHasCapability('BOOKKEEPER', 'journal.create')).toBe(false);
    expect(roleHasCapability('BOOKKEEPER', 'journal.post')).toBe(false);
    expect(roleHasCapability('BOOKKEEPER', 'invoice.post')).toBe(true);
    expect(roleHasCapability('ACCOUNTANT', 'journal.post')).toBe(true);
  });

  it('only OWNER and ADMIN manage the company and its people', () => {
    for (const capability of ['company.manage', 'user.manage'] as const) {
      expect(CAPABILITY_GRANTS[capability]).toEqual(['OWNER', 'ADMIN']);
    }
  });
});

describe('no bypass exists to find', () => {
  it('OWNER holds an explicit list, not a wildcard', () => {
    // OWNER currently holds everything — but as an enumerated grant per
    // capability, not an "all" flag. A future capability NOT granted to OWNER
    // must be possible, and nothing here special-cases the role name.
    expect([...capabilitiesForRole('OWNER')].sort()).toEqual([...CAPABILITIES].sort());
    expect(Object.keys(CAPABILITY_GRANTS)).toHaveLength(CAPABILITIES.length);
  });

  it('a capability question is unanswerable without a role', () => {
    // The module's entire surface is role-scoped. There is no user-level or
    // global check to call — which is what keeps OWNER meaningless outside
    // the membership that granted it (enforced end-to-end in LL-013).
    expect(roleHasCapability('OWNER', 'journal.post')).toBe(true);
    // @ts-expect-error — a typo'd capability must not compile
    roleHasCapability('OWNER', 'journal.psot');
    // @ts-expect-error — a typo'd role must not compile
    roleHasCapability('OWNRE', 'journal.post');
  });
});
