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
| Production | in `production-deploy.yml`, as a gated step **before** promotion (promotion = a Vercel REST git-source deployment of the same commit; the CLI is not used — see the workflow header) |

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

The **CI** jobs (lint, types, unit, build, Integration, GL regression, E2E) **fail rather
than skip** when a secret is missing: a skipped job renders as a grey tick that reads like
success, and "the correctness gate never ran" must not look like a pass.

The **production deploy is the one deliberate exception** (LL-056). A deploy is an *action*,
not a correctness gate — before go-live, "did not deploy" is the correct state, not a hidden
failure. So `production-deploy.yml` runs a small `preflight` job that decides whether production
is provisioned, keyed on the **production database URL** (`PRODUCTION_DATABASE_URL_UNPOOLED`):

- **Absent** → production is not stood up: the deploy job **skips** (neutral, with an explanatory
  `::notice`) instead of reddening every push to `main`.
- **Present** → the full gated migrate-then-promote runs.

The production DB URL is the signal *precisely because* it is absent exactly when production has
not been provisioned. The Vercel credentials (`VERCEL_TOKEN` / `VERCEL_ORG_ID` /
`VERCEL_PROJECT_ID`) are **not** used as the signal — they already exist for Preview deploys and
Vercel linkage (LL-006), so keying the skip on them would misread this repo's normal pre-go-live
state as a misconfiguration. The deploy job's own `Require credentials` step still fail-closes on
the **full** set (Vercel creds + DB URL) immediately before touching production, so a prod DB set
without the Vercel creds fails loudly rather than half-deploying.

Adding the production secrets **self-enables** the deploy on the next push — no workflow edit
needed. (The skip is safe precisely because a non-deploy cannot be mistaken for a successful
deploy: nothing is promoted, so production keeps running exactly what it already ran.)

Scope the Neon API key to this project if the option is offered: it can create and delete
branches, and a key that cannot reach your other Neon projects is a smaller blast radius.

## Production deploy status — deferred (LL-056)

**As of LL-056, production is intentionally not stood up.** No hosted production environment is
provisioned, the production deploy secrets are not set, and so the deploy job **skips** on every
push to `main` (it no longer hard-fails). This is a deliberate, documented deferral, not an
outage: the app is developed and fully tested (CI is green on `main`) but not yet publicly
deployed.

**To go live, provision the infra and add the secrets — in this order:**

1. **Neon** — create (or confirm) the **production branch**; copy its **pooled** and **direct
   (unpooled)** connection strings.
2. **Vercel** — confirm the project is linked; read `orgId` / `projectId` from
   `.vercel/project.json`; create a **Vercel token** (Account → Settings → Tokens). Keep
   `git.deploymentEnabled.main = false` in `vercel.json` so this workflow stays the only gate.
3. **Auth (Vercel Production scope)** — set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`,
   distinct from Preview) and `BETTER_AUTH_URL` (the production domain).
4. **GitHub Actions secrets** (Settings → Secrets and variables → Actions) — add
   `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `PRODUCTION_DATABASE_URL` (pooled),
   `PRODUCTION_DATABASE_URL_UNPOOLED` (direct). `NEON_API_KEY` / `NEON_PROJECT_ID` already exist.
5. **Manual gate (optional)** — the deploy job targets the `production` GitHub *environment*; add
   required reviewers there to approve each promotion.
6. **Trigger** — push to `main` or run the workflow via `workflow_dispatch`. Migrations apply to
   the production branch under the advisory lock on the **direct** endpoint, and Vercel promotes
   **only if migrations succeed** (expand → migrate → contract).

These are operational steps performed by a human in the Neon / Vercel / GitHub UIs; secrets are
never committed to source (§9), and migrations are never run against production by hand — the
workflow does it.

## Environment variables by environment

| Variable | Development | Preview | Production |
|---|---|---|---|
| `DATABASE_URL` | `.env.local` | branch-scoped, set per PR | Vercel, production only |
| `DATABASE_URL_UNPOOLED` | `.env.local` | branch-scoped, set per PR | Vercel, production only |
| `APP_ENV` | `test` locally | `preview` | `production` |
| `TEST_DATABASE_ALLOWLIST` | `.env.local` | set by the workflow | never set |
| `BETTER_AUTH_SECRET` | `.env.local` | distinct value | distinct value |
| `BETTER_AUTH_URL` | `http://localhost:3000` | the preview URL | the production domain |
| `AI_GATEWAY_API_KEY` | `.env.local` (optional) | not needed — Vercel OIDC | not needed — Vercel OIDC |
| `BANK_IMPORT_MODEL` | optional | optional | optional (`provider/model` id) |
| `BANK_IMPORT_TEST_EXTRACTOR` | e2e only (`playwright.config.ts`) | never | never |

Bank-statement extraction (LL-076, ADR-034) calls a model through **Vercel AI Gateway**. On
Vercel the gateway authenticates with the deployment's OIDC token, so nothing is provisioned
per environment beyond enabling AI Gateway on the Vercel team (usage is billed there); locally a
gateway API key is needed. Without a credential the upload page reports "extraction not
configured" and the rest of the app is unaffected. Note that Preview deployments also carry the
OIDC token, so a statement uploaded on a preview URL performs real, billed extraction.

Never share a `BETTER_AUTH_SECRET` across environments: a session minted in Preview would
then be valid in Production.

> **Action required since LL-010:** auth is live in the app, so `BETTER_AUTH_SECRET`
> must now actually exist in Vercel's Preview and Production scopes (distinct values,
> `openssl rand -base64 32` each) and `BETTER_AUTH_URL` in Production. Until then,
> deployed auth routes fail loudly with a clear error — by design, rather than running
> with a guessed identity.

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
