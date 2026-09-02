/**
 * Capability-based authorization — LL-012.
 *
 * THE SINGLE SOURCE. Business code asks "may this membership `journal.post`?",
 * never "is this user an ADMIN?". Role names appearing in comparisons outside
 * this module are a lint error (see eslint.config.mjs) — scattered role checks
 * are the failure mode this file exists to prevent, because each one is a
 * permission decision nobody can find later.
 *
 * A capability is a typed union member: a typo is a compile error, never a
 * silently-false permission check.
 */

export const CAPABILITIES = [
  'company.manage',
  'user.manage',
  'account.view',
  'account.manage',
  'period.view',
  'period.close',
  'journal.view',
  'journal.create',
  'journal.post',
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
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The five roles, mirroring the membership_role enum in the database. */
export const ROLES = ['OWNER', 'ADMIN', 'BOOKKEEPER', 'ACCOUNTANT', 'READ_ONLY'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Which roles hold each capability.
 *
 * Keyed by CAPABILITY, not by role, and typed as a total Record — so adding a
 * capability without deciding who gets it is a COMPILE ERROR, not a silent
 * default to granted or denied.
 *
 * The matrix, reasoned rather than arbitrary:
 * - READ_ONLY sees everything, changes nothing.
 * - BOOKKEEPER does day-to-day money work through documents (invoices,
 *   payments, expenses, reconciliation) but does NOT touch raw journals or
 *   close periods — manual journal entries are the accountant's instrument
 *   (LL-035 restricts that UI to ACCOUNTANT/ADMIN).
 * - ACCOUNTANT works the ledger: journals, periods, account structure, exports
 *   — but does not manage the company or its people.
 * - ADMIN and OWNER hold everything. OWNER is not "ADMIN plus bypass": neither
 *   role bypasses anything, and NO role bypasses membership — a role only has
 *   meaning inside an ACTIVE membership in the company at hand (LL-013
 *   enforces that; nothing in this module can, and nothing in this module
 *   pretends to).
 */
const EVERYONE = ['OWNER', 'ADMIN', 'BOOKKEEPER', 'ACCOUNTANT', 'READ_ONLY'] as const;
const ALL_WRITERS = ['OWNER', 'ADMIN', 'BOOKKEEPER', 'ACCOUNTANT'] as const;
const LEDGER_WRITERS = ['OWNER', 'ADMIN', 'ACCOUNTANT'] as const;
const MANAGERS = ['OWNER', 'ADMIN'] as const;

export const CAPABILITY_GRANTS: Record<Capability, readonly Role[]> = {
  'company.manage': MANAGERS,
  'user.manage': MANAGERS,
  'account.view': EVERYONE,
  'account.manage': LEDGER_WRITERS,
  'period.view': EVERYONE,
  'period.close': LEDGER_WRITERS,
  'journal.view': EVERYONE,
  'journal.create': LEDGER_WRITERS,
  'journal.post': LEDGER_WRITERS,
  'invoice.view': EVERYONE,
  'invoice.create': ALL_WRITERS,
  'invoice.post': ALL_WRITERS,
  'payment.view': EVERYONE,
  'payment.create': ALL_WRITERS,
  'expense.view': EVERYONE,
  'expense.create': ALL_WRITERS,
  'reconciliation.view': EVERYONE,
  'reconciliation.complete': ALL_WRITERS,
  'report.view': EVERYONE,
  'accountant_export.create': LEDGER_WRITERS,
};

/** Derived, so the grant matrix above stays the only authored truth. */
const CAPABILITIES_BY_ROLE: ReadonlyMap<Role, ReadonlySet<Capability>> = (() => {
  const map = new Map<Role, Set<Capability>>(ROLES.map((role) => [role, new Set()]));
  for (const capability of CAPABILITIES) {
    for (const role of CAPABILITY_GRANTS[capability]) {
      map.get(role)?.add(capability);
    }
  }
  return map;
})();

/**
 * Pure and role-scoped by design. There is no (user) → boolean form here:
 * a capability question without a membership's role is unanswerable, which is
 * exactly the property that keeps OWNER from meaning anything outside the
 * company that granted it.
 */
export function roleHasCapability(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE.get(role)?.has(capability) ?? false;
}

export function capabilitiesForRole(role: Role): ReadonlySet<Capability> {
  return CAPABILITIES_BY_ROLE.get(role) ?? new Set();
}
