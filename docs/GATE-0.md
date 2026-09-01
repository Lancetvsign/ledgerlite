# Gate 0 — Engineering Foundation

> Sprint 0 is complete when every item below is **verified**, not merely implemented.
> The distinction matters: several Sprint 0 defects were invisible by reading the code
> and only appeared when something actually ran.

## Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `main` protected — PR required, force-push and deletion blocked | ✅ | GitHub API reports 3 required checks, `enforce_admins: true` |
| 2 | CI required: lint, typecheck, unit, integration, build | ✅ | 3 required contexts; every PR since #1 gated on them |
| 3 | Migrations apply cleanly to a clean database | ✅ | `db:verify` against a live Neon branch |
| 4 | Migrations are idempotent on re-run | ✅ | `db:verify` — re-run left 1 migration record |
| 5 | Advisory lock serialises concurrent runners | ✅ | `db:verify` — two simultaneous runners, both exit 0, 1 record |
| 6 | Production-database test guard aborts | ✅ | 25 unit tests; all three layers fail closed |
| 7 | Guardrail hooks demonstrably block | ⚠️ | Script verified against a 12-case matrix. **Hooks only load when `ledgerlite/` is the project root** — see [TESTING.md](TESTING.md#guardrail-hooks--scope-matters) |
| 8 | `npm run ci` passes | ✅ | lint, typecheck, 122 unit tests, build |
| 9 | No secrets committed | ✅ | Full history scanned; only synthetic fixtures. Push protection enabled |
| 10 | All ADRs decided | ✅ | ADR-001…ADR-009 in [DECISIONS.md](DECISIONS.md) |
| 11 | Feature branches produce Preview deployments | ✅ | Vercel connected to the GitHub repo |
| 12 | Preview uses an isolated database with no production data | ✅ | Verified by this PR — see below |

## Item 12 — the one that matters

Preview deployments must never see production financial data. Before LL-006, **every
database variable in the Vercel project targeted both `preview` and `production`** — a
preview deployment wrote to the production database. Harmless while production was empty;
catastrophic once it holds real books.

Three mechanisms now stand between a Preview URL and production data:

1. `--schema-only` Neon branches — schema, zero rows
2. an **emptiness assertion** that fails the workflow before the branch is exposed, so a
   silent regression in that flag cannot leak data
3. production credentials removed from Vercel's Preview scope entirely, so failed
   provisioning yields no `DATABASE_URL` rather than a fallback

This PR was the first execution of that workflow, and it took five runs to go green —
each failure a real defect that reading the code had not surfaced:

| Run | Failed at | Cause |
|---|---|---|
| 1 | credentials gate | `VERCEL_TOKEN` did not exist yet (deliberate fail-not-skip) |
| 2 | emptiness assertion | inline `tsx -e` with top-level await never compiled — the check had silently not run |
| 3 | migrations | a schema-only branch copies the schema but an **empty** `__drizzle_migrations`, so Drizzle re-creates existing tables |
| 4 | emptiness assertion | on a re-run the branch is reused and legitimately holds our own seed data — the assertion is only meaningful on a fresh branch |
| 5 | Vercel env step | the CLI resolves projects from a gitignored link file; switched to the REST API |

Final state, verified: schema-only branch created → **emptiness proven by `count(*)` per
table** → schema reset → migrations applied from committed files → marked disposable →
seeded → this PR's Preview pointed at it via branch-scoped variables. Confirmed in the
Vercel dashboard: `DATABASE_URL` scoped to `Preview (docs/gate-0-verification)` only.

## What Sprint 0 found by running things

Recorded because each was invisible to review and only surfaced under execution:

| Defect | How it was found |
|---|---|
| Migration advisory lock was inert on the pooled endpoint (PgBouncer transaction mode discards session state) | Asking which connection string to use |
| Allowlist entry derived from the pooled host matched the app but not the migration runner | Running `db:target` for the first time |
| Branch reaper would have **deleted** branches whose age it could not determine (`Date.parse(undefined ?? 0)` = year 2000) | Testing the selection logic locally |
| Preview and Production shared a `DATABASE_URL` | Inspecting Vercel env targets |
| E2E silently tested the dev server when it shared the dev port | Reproducing the flake both ways |
| Guardrail hooks were never loading | Noticing a `git merge` succeed that should have been blocked |

The pattern: **testing the thing next to the thing proves nothing.** A script verified by
piping JSON into it says nothing about whether the hook fires. A green concurrency check
says nothing if the lock it exercises is inert.

## Not yet verified

- **Production deploy gate** — `production-deploy.yml` has never run. Needs
  `PRODUCTION_DATABASE_URL` / `_UNPOOLED`, and there is nothing to promote yet.
- **`preview/*` teardown on PR close** — runs when this PR closes or merges. Closing this
  PR is therefore the final verification step, and whoever merges it should glance at the
  `Destroy preview database` job afterwards.
