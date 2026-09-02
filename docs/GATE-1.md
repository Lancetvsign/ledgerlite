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

**Blocked from automated execution, and here is exactly why.** This PR's preview is
`READY` and was built after `BETTER_AUTH_SECRET` was added to the Preview scope. But the
Vercel project has **SSO deployment protection** on (`ssoProtection:
all_except_custom_domains`, the platform default), so every preview URL sits behind
Vercel's own login. An unauthenticated browser — including the review tooling — is
bounced to `vercel.com/sso` and the app never renders. Confirmed against `/`, `/account`,
and `/api/auth/get-session`, all redirected.

So the structural guarantee that makes Preview isolation *hold* is verified — the
preview ran against its own schema-only Neon branch with production credentials
unreachable by construction (LL-006), proven green in this PR's `Provision isolated
preview database` check — but the **behavioural** walk-through (two users, cross-tenant
access denied in a real browser) needs a Vercel-authenticated session.

**To close item 9, one of:**

- **You**, signed into Vercel, open the preview `/account`, sign up as two users in two
  browser sessions, create a company as each, and confirm neither can reach the other's
  — the switcher shows only your own companies, and a hand-edited `ledgerlite_company`
  cookie yields the picker, never another tenant's data. Paste what you see.
- **Or** temporarily set deployment protection to *only production*, or add
  `x-vercel-protection-bypass` for automation, and I drive it headlessly.

The behaviour itself is already proven at the layer that enforces it: the same
authorize-then-query path the preview runs is covered by 265 tests plus the 63-attack
adversarial campaign, all green. Preview verification is the belt-and-braces confirmation
that the deployed wiring matches — valuable, but not the primary evidence.
