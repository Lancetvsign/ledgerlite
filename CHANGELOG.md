# Changelog

All notable changes to LedgerLite are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Repository scaffold: governance files, guardrail hooks, documentation skeleton,
  directory structure. No application code.
- **LL-000** — Architecture decisions. `docs/DECISIONS.md` with ADR-001 through ADR-008,
  the pull request template, and the 25 ticket definitions for Sprints 0–3.
  ADR-001 and ADR-004 were verified empirically against `drizzle-orm@0.45.2` and
  `@neondatabase/serverless@1.1.0` rather than asserted.
- **LL-001** — Next.js 16 App Router application with React 19, Tailwind 4, and strict
  TypeScript. Type-aware ESLint with the ADR-001 ledger import boundary enforced.
  `npm run ci` chains lint, typecheck, test, and build.
- **LL-002** — Neon + Drizzle foundation. Two memoized clients per ADR-001: `getDb()`
  (HTTP, reads) and `getDbTx()` (WebSocket Pool, financial writes). `server-only` keeps
  `DATABASE_URL` out of the browser bundle. Migration runner holds a PostgreSQL advisory
  lock for the whole run. `db:generate` / `db:migrate` / `db:studio` / `db:check` /
  `db:verify`; no `db:push`, ever. First migration creates `_health`, a connectivity
  probe and deliberately not an accounting entity.
- **LL-003** — Test foundation. Vitest (unit + integration projects) and Playwright.
  Three-layer production guard: APP_ENV opt-in, connection denylist plus mandatory
  allowlist, and a marker table the database must carry — all failing closed. 35 unit
  tests and 3 E2E tests pass; the 6 integration tests are written but unexecuted pending
  a database. E2E runs against a production build so "no console errors" is a real
  assertion.
- **Follow-ups to LL-001–003** — Playwright moved to a dedicated port (3200) after
  confirming a running dev server on the shared port silently caused the
  no-console-errors test to fail. Node pinned to 24 (current LTS, and the version every
  ticket was actually tested on) instead of an uninstalled 22. ADR-001 amended to record
  that the clients are accessor functions, not constants, and why. DATABASE.md's setup
  workflow corrected — it omitted `db:mark-test`, so following it would fail at
  `db:verify`.
- **`npm run db:target`** — reports which database `DATABASE_URL` points at with
  credentials stripped, whether the safety guard approves it, and the exact
  `TEST_DATABASE_ALLOWLIST` line to add if not.
- **`db:mark-test` now requires `-- --host <endpoint-id>`** and refuses on mismatch. It is
  the one command that cannot rely on the marker check (it creates it), so it is the one
  able to arm the safety system on the wrong database — a risk that grows when
  `DATABASE_URL` is injected by tooling rather than chosen.
- **Migrations now require a direct (unpooled) connection.** Neon's pooled endpoint is
  PgBouncer in transaction pooling mode, where session-level advisory locks silently stop
  protecting anything. `DATABASE_URL_UNPOOLED` is now required for migrations and
  `db:verify`; the runner refuses a `-pooler` host rather than appearing to work.
- **Database foundation verified against a real Neon branch.** The integration suite (6
  tests) and `db:verify` (9 checks) had never executed. Both now pass, clearing the
  unverified debt carried since LL-002: migration idempotency, the advisory lock under
  two concurrent runners, transaction rollback leaving no partial state, `NUMERIC`
  returning a string, and ADR-001's driver split confirmed end to end.
- **LL-005** — GitHub Actions CI. `verify` (lint, typecheck, unit, build) and `e2e` run
  without secrets; `integration` provisions an ephemeral Neon branch, migrates, marks it,
  runs the integration suite and `db:verify`, then deletes the branch with
  `if: always()`. A daily reaper removes leaked `test/*` branches. The integration job
  **fails rather than skips** when secrets are missing.
- **LL-004** — Structured logging. Redaction applied at the logger boundary so callers
  cannot skip it, matching both by key name and by value shape, walking nested
  structures and `Error.cause` chains. Correlation ids via `AsyncLocalStorage`. JSON in
  deployed environments, readable output locally. 78 tests, verified by mutation.
- **LL-006** — Vercel and Neon environments. Production database credentials removed from
  Vercel's Preview scope (they targeted both). Preview deployments now get a `--schema-only`
  Neon branch per PR — schema, zero rows — with an emptiness assertion that fails rather
  than exposing data if that guarantee regresses. Vercel's auto-deploy from `main` is
  disabled in `vercel.json`; production is promoted by a workflow that runs migrations
  first and stops if they fail. Adds `npm run db:seed`.
- **LL-011** — Identity and tenancy. `users` (linked once to the auth identity,
  provisioned idempotently on first entry), `companies` (fiscal month, currency and
  non-blank legal name enforced by CHECK constraints in the database), and
  `company_memberships` (roles as an enum; duplicate membership impossible by unique
  constraint). Company + OWNER membership created in one transaction — a forced failure
  test proves no ownerless company survives. `company_memberships` carries the first
  standing `UNIQUE (company_id, id)`; the protected `ein` column exists but has no path
  into any default select shape or creation input.
- **LL-010** — Authentication. Better Auth (email/password) with its schema captured as
  migration `0001_better_auth_tables` — including an `issuer` column the deprecated
  generator omitted, added after introspecting the installed version. Base URL and
  trusted origins are an environment-derived allowlist (never the Host header; no
  wildcards; production refuses to guess). Verified against a real database: tampered
  tokens refused, sign-out kills the old cookie server-side, forged Host+Origin
  rejected. E2E signs in through the real UI; the CI e2e job now provisions its own
  Neon branch.
- **LL-007** — Engineering documentation. `ACCOUNTING_RULES.md` states the eight
  invariants with the layer that enforces each; `API.md` records service and route
  conventions before any surface exists; `docs/README.md` orients a session with no prior
  context. Adds an ADR authoring format.
- **Guardrail corrections.** The hooks were never loading — they live in
  `ledgerlite/.claude/settings.json` but a session opened in a parent directory reads
  nothing. Documented. Two rules were also over-broad: `git merge` blocked merging `main`
  INTO a feature branch (routine and safe), and the force-push rule blocked
  `--force-with-lease` on feature branches. Both now key on the actual risk.
- **ADR-009** — TypeScript pinned to 6.0.3 and ESLint to 9.x. TypeScript 7 has no
  `typescript-eslint` support, which would silently disable every type-aware rule
  including `no-floating-promises`; `eslint-config-next@16` cannot run under ESLint 10.
