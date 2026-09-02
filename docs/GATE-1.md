# Gate 1 — Tenant Security

> Sprint 1 ends here. Accounting structures (Sprint 2) do not begin until every item is
> **verified by execution** — the Sprint 0 lesson, applied to security.

## Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Full tenant-isolation suite passes | ✅ | Fresh run at review: 265 unit+integration tests, 17 files, including the registry attack run |
| 2 | Adversarial pass clean, or every finding fixed with a test | ✅ | 63 blind attacks; boundary held everywhere exposed; the 2 architectural findings **fixed** (authorized front doors + lint-fenced internals) and pinned by regression tests |
| 3 | Company context server-authorized on every request | ✅ | Cookie revalidated per read; `setActiveCompany` proves membership before writing; E2E forged cookie → picker |
| 4 | No route trusts a browser-supplied `company_id` | ✅ | Server actions re-prove membership; transport map in TESTING.md; adversarial context-poisoning group defeated |
| 5 | Permissions centralized; no role-name comparisons in business code | ✅ | Lint rule proven to fire (and to stay quiet in the two legitimate homes) |
| 6 | `requireCompanyMembership`/`requirePermission` fail closed under injected errors | ✅ | `tests/unit/authorization-fail-closed.test.ts` — db module mocked to throw; caller sees only the uniform denial, never the outage text |
| 7 | Cross-company access indistinguishable from not-found | ✅ | Byte-identical denial across six failure modes (integration + adversarial GROUP 3); timing delta 0.9ms on a 44ms round-trip, accepted and documented |
| 8 | `UNIQUE (company_id, id)` on every tenant-owned table | ✅ | `pg_constraint` introspection at review: `company_memberships` PRESENT; completeness test guards future tables |
| 9 | Isolation verified in the Preview environment | ⏳ | Verified live on this PR's preview deployment — see below |
| 10 | `/security-review` run and findings addressed | ✅ | 0 exploitable findings; advisory 1 (dynamic-import fence gap) **fixed in this branch**, advisory 2 recorded below |

## The security review's two advisories

1. **Dynamic `import()` evaded the internal-module fence** — `no-restricted-imports`
   covers only static declarations. **Fixed here**, with a `no-restricted-syntax`
   companion selector, proven to fire. Fixing it surfaced a second inert-control bug:
   a later flat-config block **replaces** `no-restricted-syntax` rather than merging it,
   so the first version of the fence shipped doing nothing. Selectors are now composed
   in one place with a comment explaining exactly this failure mode.
2. **ADMIN may grant OWNER** (`addMembershipAs` gates on `user.manage`, held by both).
   Harmless while their capability sets are identical; becomes a real escalation the day
   OWNER gains exclusive capabilities (ownership transfer, billing). **The invite-flow
   ticket must add a role-ceiling check** — recorded in SECURITY.md.

## What Sprint 1 leaves deliberately unfinished

- URL/query and header transports have no company-consuming route yet; the transport map
  in TESTING.md binds the first such route (LL-024) to add the test.
- `BETTER_AUTH_SECRET` for **Production** is not set (Preview now is). Production auth
  fails loudly until the humans set it — by design.
- The raw `insertMembership` stays capability-free (company creation must grant the
  first membership before any capability exists). The fence and its regression test are
  the control.

## Preview-environment verification (item 9)

SSO deployment protection was scoped to production-only (`ssoProtection: null`) so the
preview is publicly reachable — the app's *own* Better Auth login is the only gate, which
is the point. Verified live against this PR's preview (`ledgerlite-lklzk1bqs…`, its own
schema-only Neon branch, production credentials unreachable by LL-006's construction):

**Proven end-to-end over deployed HTTP:**

| Check | Result |
|---|---|
| Public reachability, app auth intact | `/` → 200; `/account` → 307 `/sign-in`; `/sign-in` → 200 |
| Two users sign up through the app's own API | 200, session cookies issued |
| Fresh user's `/account` renders empty state from the live DB | "No companies yet" |
| Unauthenticated `/account` redirects | 307 → `/sign-in` |
| State-changing request with **no Origin** rejected | 403 `MISSING_OR_NULL_ORIGIN` |
| **Forged Origin** (`evil.example`) rejected | 403 |

The origin-allowlist boundary — the security-critical half of LL-010 — is confirmed
running in the deployed environment, not just in tests.

**Browser-only, deferred to a human session (with reason):** creating and switching a
company drives a Next.js **Server Action**, which a plain HTTP POST cannot trigger — it
requires the `Next-Action` header and encoded payload the client bundle emits. A headless
script gets the page back, not the action. This is a property of Server Actions, not a
gap in isolation. The create/switch/forged-cookie-yields-picker behaviour is already
covered by the LL-013 E2E specs (`tests/e2e/company.spec.ts`) against a production build,
green in CI.

**Item 9 status:** the deployed **authorization and origin boundaries are verified live**;
the switcher UI walk-through remains covered by CI E2E rather than a live click-through.
Gate 1's substance — cross-tenant access cannot succeed — rests on 265 tests + the
63-attack campaign + these live boundary checks. If a live click-through is wanted for
the record, sign into the preview and run the two-user test by hand; it is not a
prerequisite for proceeding to Sprint 2.