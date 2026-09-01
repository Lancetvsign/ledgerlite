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
- **ADR-009** — TypeScript pinned to 6.0.3 and ESLint to 9.x. TypeScript 7 has no
  `typescript-eslint` support, which would silently disable every type-aware rule
  including `no-floating-promises`; `eslint-config-next@16` cannot run under ESLint 10.
