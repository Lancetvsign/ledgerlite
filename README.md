# LedgerLite

A double-entry accounting application for small businesses.

**Correctness, security, traceability and data integrity outrank development speed.**
A slow correct ledger is a product. A fast incorrect ledger is a liability.

---

## Status

Sprint 0 — engineering foundation. The application shell exists; **no accounting
functionality yet**, by design. The ledger engine is Sprint 3.

| | |
|---|---|
| Sprint 0 | **Complete** — Gate 0 closed |
| Sprint 1 | LL-010 ✅ · LL-011 ✅ · LL-012 RBAC ✅ |
| Next | LL-013 — company authorization layer |
| Gate | Gate 0 not yet reached |

## Start here

If you are a human joining this project, or an AI agent with no prior context, read in
this order:

1. **[AGENTS.md](AGENTS.md)** — the binding engineering contract
2. **[docs/DECISIONS.md](docs/DECISIONS.md)** — eight ADRs that later tickets depend on
3. **[docs/tickets/](docs/tickets/)** — the ticket you are implementing
4. The `docs/` file relevant to your area

The repository is the source of truth. Do not assume prior chat history.

## Architecture

| Layer | Choice |
|---|---|
| Application | Next.js App Router · React · TypeScript (strict) · Tailwind |
| Database | Neon PostgreSQL · Drizzle ORM · Drizzle Kit |
| Money | `NUMERIC(19,4)` in Postgres · `decimal.js` in code · never `number` |
| Auth | Better Auth (authentication) + an independent authorization layer |
| Validation | Zod |
| Testing | Vitest · Playwright · GitHub Actions |
| Hosting | Vercel |

**Two database clients, deliberately.** `db` (Neon HTTP) for reads; `dbTx` (Neon
WebSocket Pool) for every financial write. The HTTP driver's `.transaction()` compiles
and typechecks but throws at runtime — see [ADR-001](docs/DECISIONS.md#adr-001).

## Repository layout

```
src/app/          Next.js routes
src/components/   UI
src/server/       domain services — LedgerService lives here
src/db/           schema, clients, migrations
src/lib/          shared utilities, decimal config, logging
src/validation/   Zod schemas
tests/            unit · integration · e2e · fixtures · helpers
docs/             architecture, accounting rules, ADRs, ticket definitions
scripts/          guardrail hooks
```

## Development

```bash
nvm use          # Node 24 (current LTS), pinned in .nvmrc
npm install
cp .env.example .env.local   # then fill in YOUR OWN Neon dev branch URL
npm run dev
```

| Command | Does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run lint` | ESLint, type-aware |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Production build; type errors fail it |
| `npm run ci` | lint → typecheck → test → build |

Database: `npm run db:generate -- --name=x`, `db:migrate`, `db:check`, `db:studio`,
and `db:verify` (proves migrations apply, are idempotent, and the advisory lock
serialises concurrent runners). There is deliberately **no `db:push`**.

Tests: `npm test` (unit, no database), `test:integration` (requires a marked test
database — see [TESTING.md](docs/TESTING.md)), `test:e2e` (builds and serves production
on port 3200, then drives Chromium).

Destructive database work refuses to run unless `APP_ENV=test`, the host is on
`TEST_DATABASE_ALLOWLIST`, **and** the database carries a marker table created by
`npm run db:mark-test`. All three, all failing closed.

**Toolchain versions are pinned deliberately** — TypeScript 6.0.3 and ESLint 9.x, both
one major behind. Read [ADR-009](docs/DECISIONS.md#adr-009) before upgrading either:
TypeScript 7 silently disables every type-aware lint rule rather than failing loudly.

## Working on a ticket

```bash
git checkout main && git pull
git checkout -b feat/ll-0XX-description
```

Then in Claude Code: `/ticket LL-0XX`

Before opening a pull request: `npm run ci`, read the full diff, run `/code-review high`,
and use [docs/PR_TEMPLATE.md](docs/PR_TEMPLATE.md).

**Never push to `main`. Never merge your own pull request.**

## Guardrails

`.claude/settings.json` installs PreToolUse hooks that block, deterministically:

- pushes targeting `main`, force pushes, `git merge`, `gh pr merge`
- `drizzle-kit push` in any form
- destructive SQL against accounting tables
- reading or writing `.env.local` / `.env.production`
- editing an already-committed migration

These are enforcement, not advice. `AGENTS.md` explains why each rule exists; the hooks
are what hold when an agent is optimizing to get a ticket to green.
