# Gate 1 — Tenant Security

> Sprint 1 is complete when every item below is **verified by execution**. Reviewed
> 2026-09-02, on the LL-014 content (`docs/gate-1-review`).

## Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Full tenant-isolation suite passes | ✅ | 265 tests green in a fresh run: 107 integration (incl. the 63-attack adversarial campaign), 158 unit, plus 13 e2e |
| 2 | Adversarial pass: nothing found, or every finding fixed with a test | ✅ | 63 blind attacks; boundary held everywhere exposed. Two architectural findings **fixed** (authorized `addMembershipAs`, member-scoped roster read; raw ops fenced in `internal.ts`) and pinned by regression tests |
| 3 | Company context server-authorized on every request | ✅ | Cookie revalidated on every read; forged/stale → null + picker, never fallback (integration + e2e forged-cookie spec) |
| 4 | No route trusts a browser-supplied `company_id` | ✅ | Server actions re-prove membership before the cookie moves; five forged transports deny uniformly; transport map in TESTING.md |
| 5 | Permissions centralized; no role-name comparisons in business code | ✅ | Single capability matrix; lint rule proven to fire on `===`/`switch` role comparisons |
| 6 | `requireCompanyMembership`/`requirePermission` fail closed under injected errors | ✅ | New `authorization-fail-closed.test.ts`: db module mocked to throw → uniform denial, outage text never surfaces to the caller |
| 7 | Cross-company access indistinguishable from not-found | ✅ | Denials byte-identical across six failure modes (adversarial GROUP 3 + authorization suite); timing delta 0.9ms on a 44ms round-trip, recorded as accepted residual |
| 8 | `UNIQUE (company_id, id)` on every tenant-owned table | ✅ | `pg_constraint` introspection: present on `company_memberships` (the only `company_id` table); completeness test forces future tables to register |
| 9 | Isolation verified in the Preview environment | ✅ | Verified in this PR's live Vercel preview — two real users, cross-tenant listing empty, forged active-company cookie yields picker (see below) |
| 10 | `/security-review` run and findings addressed | ✅ | Zero HIGH/MEDIUM findings. Advisory 1 (dynamic-import fence gap) **closed in this PR**, with a proof that both import forms are now caught; advisory 2 recorded below |

## The security review's two advisories

1. **Dynamic-import fence gap — closed here.** `no-restricted-imports` covers only static
   declarations; an `ImportExpression` selector now covers `import()` too. Fixing it
   surfaced a second bug: two flat-config blocks configuring `no-restricted-syntax` for
   overlapping files silently **replace** rather than merge, which had shipped the new
   selector inert. Selectors are now composed in one place, with a comment explaining why.
2. **ADMIN may grant OWNER** (`addMembershipAs`). Harmless while the OWNER and ADMIN
   grant sets are identical; it becomes a real escalation the day OWNER gains an
   exclusive capability (ownership transfer, billing). **Standing requirement:** the
   invite-flow ticket adds a role-ceiling check before any OWNER-exclusive capability is
   introduced.

## Preview-environment verification (item 9)

Performed against this PR's own preview deployment (schema-only Neon branch,
`BETTER_AUTH_SECRET` added to the Vercel Preview scope for the purpose):

1. Sign up user A → create a company → active badge shown; hidden switch input carries
   the company id.
2. Sign out → sign up user B → the company list is **empty**: A's company appears nowhere.
3. As B, plant A's company id in the `ledgerlite_company` cookie → reload → **picker, no
   active badge, no trace of A's company** — the forged claim is revalidated and dropped,
   with no fallback.

## What Gate 1 does NOT claim

- No accounting data exists yet; isolation is proven on identity/tenancy surfaces and
  the harness **forces** every future `company_id` table to register or fail CI.
- `BETTER_AUTH_SECRET` for **Production** remains unset, by design — production identity
  configuration is the operator's act, required before any production deploy.
- Timing side-channel: minimized, not equalized (0.9ms residual, documented).
