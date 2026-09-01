# Architecture

> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack) | pinned exactly — [ADR-009](DECISIONS.md#adr-009) |
| UI | React 19, Tailwind CSS 4 | Tailwind v4 is CSS-first; no `tailwind.config.js` |
| Language | TypeScript 6.0.3, strict | pinned exactly — [ADR-009](DECISIONS.md#adr-009) |
| Database | Neon PostgreSQL + Drizzle ORM | two clients — [ADR-001](DECISIONS.md#adr-001) |
| Money | `NUMERIC(19,4)` + decimal.js | never `number` — [ADR-004](DECISIONS.md#adr-004) |
| Auth | Better Auth + independent authorization layer | LL-010, LL-013 |
| Validation | Zod | all external input, server side |
| Tests | Vitest + Playwright | LL-003 |

## Directory structure

```
src/app/          Next.js routes, layouts, route handlers
src/components/   React components
src/server/       domain services — LedgerService lives in src/server/ledger/
src/db/           Drizzle schema, the two clients, migrations
src/lib/          shared utilities — decimal config, logging, redaction
src/validation/   Zod schemas
tests/unit/       pure logic, no database
tests/integration/database-backed
tests/e2e/        Playwright
tests/fixtures/   deterministic synthetic data — never real financial data
tests/helpers/    test utilities, ledger invariant assertions
docs/             architecture, accounting rules, ADRs, ticket definitions
scripts/          Claude Code guardrail hooks
drizzle/          generated migrations (committed, reviewed, never edited after commit)
```

## Path aliases

One alias, deliberately. `@/*` → `./src/*`.

```ts
import { getDbTx } from '@/db';
import { LedgerService } from '@/server/ledger';
```

The database clients are exposed as memoized accessor functions rather than eagerly
constructed constants, so that importing `@/db` never throws and `next build` succeeds
without a `DATABASE_URL`. See [DATABASE.md](DATABASE.md).

Relative imports (`../../db`) are permitted within a directory but `@/` is preferred
across module boundaries — it survives file moves and makes the boundary visible.

`baseUrl` is intentionally absent: deprecated in TypeScript 6, removed in 7. `paths`
resolves relative to `tsconfig.json` without it.

## TypeScript conventions

### The strictness settings are not negotiable

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`, and
`noImplicitReturns`.

**None of these may be disabled to make code compile.** If code does not typecheck, the
code is wrong. Loosening a compiler flag to clear an error trades a local inconvenience
for a global loss of guarantee, across a codebase whose entire value is that its
guarantees hold.

The same applies to `next.config.ts`: `typescript.ignoreBuildErrors` stays `false`.

### Type categories

| Category | Lives in | Shape |
|---|---|---|
| **Domain types** | `src/server/**/types.ts` | What the business means. `JournalEntry`, `Account`. Never mirror the database row shape by default. |
| **Database types** | `src/db/schema/**` | Inferred from Drizzle: `typeof accounts.$inferSelect`. Never hand-written. |
| **Input types** | `src/validation/**` | Inferred from Zod: `z.infer<typeof schema>`. Represent *unvalidated* shape at the boundary. |
| **Validated input** | output of `schema.parse()` | The only form business logic accepts. A service that takes an unvalidated type is a bug. |

Money is `string` in every one of these categories. See
[ADR-004](DECISIONS.md#adr-004).

### `any`

`@typescript-eslint/no-explicit-any` is an error, as is the whole `no-unsafe-*` family.
Where `any` is genuinely unavoidable — an untyped third-party surface — disable the rule
inline with a reason on the line above, so review sees the justification, not just the
suppression.

`@ts-expect-error` requires a description of at least 10 characters. `@ts-ignore` is
banned outright: it silently keeps passing after the underlying error is fixed, whereas
`@ts-expect-error` fails once the error is gone.

## Lint philosophy

Rules are chosen for **correctness and security**, not style. There are deliberately no
formatting rules — formatting noise trains reviewers to skim, and this codebase needs
reviewers who read.

The highest-value rules are the async ones. `no-floating-promises` and
`no-misused-promises` catch the defect where an un-awaited transaction returns before it
commits while the caller believes it succeeded. These are errors, never warnings.

### The ADR-001 boundary is enforced by lint

The Neon HTTP driver's `.transaction()` exists and typechecks, then throws at runtime.
The type system cannot catch that, so `no-restricted-imports` does: anything under
`src/server/ledger/**` is forbidden from importing `drizzle-orm/neon-http`.

The rule is active before `src/server/ledger/` exists, so the boundary holds from the
first line written there rather than being retrofitted afterwards.

### Verifying the rules actually fire

A green lint run proves nothing if the rules stopped applying — which is precisely what a
TypeScript upgrade past 6.0.x would cause. After any toolchain change, write a file with
a floating promise and an `any`, confirm lint reports them, then delete it. LL-001 did
this and recorded which rules fired.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Next dev server |
| `npm run build` | Production build; type errors fail it |
| `npm run lint` | ESLint, type-aware |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Placeholder until LL-003 installs Vitest |
| `npm run db:generate -- --name=x` | Schema diff → migration file |
| `npm run db:migrate` | Apply migrations under an advisory lock |
| `npm run db:verify` | Prove migrations apply, are idempotent, lock serialises |
| `npm run ci` | lint → typecheck → test → build |

`npm run ci` is what must pass before any pull request.
