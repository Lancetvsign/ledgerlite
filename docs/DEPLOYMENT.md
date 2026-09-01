# Deployment

> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

## Environments

| Environment | Git branch | Database | Provisioned by |
|---|---|---|---|
| Local | any | your own Neon branch (`dev/lance`) | you, once |
| CI | pull request | ephemeral `test/pr-N-run-M`, deleted after the run | `ci.yml` |
| Preview | pull request | **schema-only** `preview/pr-N`, deleted when the PR closes | `preview-database.yml` |
| Production | `main` | production Neon branch | `production-deploy.yml` |

The production database is never used for local development, tests, pull request
testing, or Preview deployments.

## Preview databases carry no production data

This is the requirement the environment design exists to satisfy.

A normal Neon branch is **copy-on-write from its parent**. Branching production for a
Preview deployment would therefore hand a complete copy of the company's financial
records to whoever can open the preview URL. That must be impossible, not merely
discouraged.

Three mechanisms, in order of strength:

1. **`--schema-only` branches.** `preview-database.yml` creates the branch with
   `neonctl branches create --schema-only`, which copies the schema and no rows.
2. **An emptiness assertion.** Before the branch is exposed, the workflow counts rows in
   the `public` schema and **fails** if any exist. If the `--schema-only` guarantee ever
   silently regresses, the workflow stops rather than serving production data.
3. **Production credentials are not in Vercel's Preview scope at all.** `DATABASE_URL`,
   `DATABASE_URL_UNPOOLED` and every `POSTGRES_*` / `PG*` variable target `production`
   only. A Preview deployment whose provisioning failed gets no database URL and fails
   loudly; it cannot fall back to production, because there is nothing to fall back to.

Each PR's Preview deployment is pointed at its own branch using a Vercel **branch-scoped**
Preview variable, set by the workflow and removed when the PR closes.

Synthetic seed data comes from `npm run db:seed`, which refuses to run against any
database not carrying the disposable-test marker.

## Where migrations run

**Never in the Vercel build command for production.** Builds are not guaranteed to run
exactly once — retries and concurrent builds can invoke the runner in parallel. Worse, the
build step is not the deploy step: a build can succeed, apply a migration, and then fail to
promote, leaving the database ahead of the deployed code. That is exactly the state
`expand → migrate → contract` exists to prevent.

| Environment | When migrations run |
|---|---|
| Local | manually, `npm run db:migrate`, against your own branch |
| CI | in the Actions job, against the ephemeral branch, before tests |
| Preview | in `preview-database.yml`, before the deployment is pointed at the branch |
| Production | in `production-deploy.yml`, as a gated step **before** promotion |

**Vercel's automatic deployment from `main` is disabled** in `vercel.json`
(`git.deploymentEnabled.main = false`). That is what makes the gate real: production is
promoted by `production-deploy.yml`, and only after migrations succeed. Re-enabling
auto-deploy would silently remove the gate.

A failed migration exits non-zero and the job stops. Nothing is promoted, and production
keeps running the previous deployment against the previous schema — a consistent state.
Never add `continue-on-error` or `|| true` to a migration step.

The advisory lock applies everywhere; migrations always use the **direct** (unpooled)
endpoint. See [DATABASE.md](DATABASE.md).

## Workflows

| File | Trigger | Purpose |
|---|---|---|
| `ci.yml` | PR, push to `main` | lint, types, unit, build, e2e, integration |
| `preview-database.yml` | PR opened/synchronized/closed | provision and destroy the preview database |
| `production-deploy.yml` | push to `main` | migrate, then promote |
| `neon-branch-reaper.yml` | daily | delete leaked `test/*` branches |

`preview/*` branches are removed by the PR-closed teardown. The reaper deliberately does
not reap them by age, because a long-lived PR is a legitimate reason for one to persist.
If teardown fails, the warning in that job is the signal to clean up by hand.

## Required GitHub secrets

| Secret | Used by | Where to find it |
|---|---|---|
| `NEON_API_KEY` | ci, preview, reaper | Neon → Account settings → API keys |
| `NEON_PROJECT_ID` | ci, preview, reaper | Neon → Project settings → General |
| `VERCEL_TOKEN` | preview, production | Vercel → Account settings → Tokens |
| `VERCEL_ORG_ID` | production | `.vercel/project.json` → `orgId` |
| `VERCEL_PROJECT_ID` | production | `.vercel/project.json` → `projectId` |
| `PRODUCTION_DATABASE_URL` | production | Neon production branch, pooled |
| `PRODUCTION_DATABASE_URL_UNPOOLED` | production | Neon production branch, direct |

Jobs **fail rather than skip** when a secret is missing. A skipped job renders as a grey
tick that reads like success, and "the deployment gate never ran" must not look like a pass.

Scope the Neon API key to this project if the option is offered: it can create and delete
branches, and a key that cannot reach your other Neon projects is a smaller blast radius.

## Environment variables by environment

| Variable | Development | Preview | Production |
|---|---|---|---|
| `DATABASE_URL` | `.env.local` | branch-scoped, set per PR | Vercel, production only |
| `DATABASE_URL_UNPOOLED` | `.env.local` | branch-scoped, set per PR | Vercel, production only |
| `APP_ENV` | `test` locally | `preview` | `production` |
| `TEST_DATABASE_ALLOWLIST` | `.env.local` | set by the workflow | never set |
| `BETTER_AUTH_SECRET` | `.env.local` | distinct value | distinct value |
| `BETTER_AUTH_URL` | `http://localhost:3000` | the preview URL | the production domain |

Never share a `BETTER_AUTH_SECRET` across environments: a session minted in Preview would
then be valid in Production.

Connection strings are stripped of credentials by `describeConnection()` before being
printed, and masked with `::add-mask::` in CI before use.

## Runtime

Financial write paths use the Neon Pool client over WebSocket, which requires the Node
runtime. Routes that post financially declare `export const runtime = 'nodejs'`.

Node is pinned to **24** in `.nvmrc`, `engines`, and the Vercel project settings
(confirmed: Vercel reports Node.js 24.x). Local, CI, and Vercel match.

## Verified vs unverified

Verified in LL-006:

- Vercel project is connected to `Lancetvsign/ledgerlite`; pushes create Preview deployments.
- Production database credentials were **removed from Vercel's Preview scope** — confirmed
  `production` retains `DATABASE_URL`, `preview` has zero database variables.
- Vercel Node version is 24.x, matching `.nvmrc`.
- All four workflow files parse as valid YAML.

**Not yet verified** — these need `VERCEL_TOKEN` and a real run:

- Preview database provisioning end to end.
- The `--schema-only` emptiness assertion firing against a real branch.
- Production gated deploy, including that a failed migration blocks promotion.
