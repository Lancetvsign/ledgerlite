# Database

> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

Neon PostgreSQL, accessed through Drizzle ORM. PostgreSQL is authoritative for all
financial data and arithmetic.

## Two clients. Use the right one.

See [ADR-001](DECISIONS.md#adr-001). This is the single most consequential thing in this
document.

| Client | Driver | For | Transactions |
|---|---|---|---|
| `getDb()` | `drizzle-orm/neon-http` | reads, reports, single-statement writes | **no** |
| `getDbTx()` | `drizzle-orm/neon-serverless` (Pool) | **every financial write** | yes |

```ts
import { getDb, getDbTx } from '@/db';

const accounts = await getDb().select().from(accountsTable);      // read

await getDbTx().transaction(async (tx) => {                        // financial write
  await tx.insert(journalEntries).values(header);
  await tx.insert(journalLines).values(lines);
});
```

### The trap

The HTTP client exposes `.transaction()`. It is fully typed. It compiles. It passes
review and CI. Then at runtime it throws:

```
Error: No transactions support in neon-http driver
```

The type system cannot catch this, so two other mechanisms do:

1. ESLint forbids importing `drizzle-orm/neon-http` anywhere under `src/server/ledger/**`.
2. `src/db/index.ts` documents the split at the top of the file.

Inside a transaction, **every statement must run on `tx`**, not on the outer client. A
statement issued on `getDbTx()` while inside a `tx` callback executes on a different
connection, outside the transaction, and will not roll back.

Never simulate a transaction with sequential statements plus compensating deletes. A
compensating delete cannot undo work another connection already observed, and does not
run at all if the process dies between statements.

### Lazy initialisation

Both clients are memoized and created on first use, not at import. Importing `@/db` must
never throw — only *using* it without a `DATABASE_URL` should. This is what allows
`next build` and `npm run ci` to succeed with no database configured.

`src/db/index.ts` imports `server-only`. A Client Component that imports it fails the
build rather than leaking `DATABASE_URL` into the browser bundle. Verified in LL-002.

## Standing requirements

These apply to every table added from LL-011 onward. They are not per-table choices.

1. **Every tenant-owned table carries `UNIQUE (company_id, id)`.** This exists to enable
   composite foreign keys, which make cross-company references structurally impossible.
   See [ADR-008](DECISIONS.md#adr-008).
2. **Every cross-table reference within a tenant is a composite foreign key** on
   `(company_id, ref_id)`, never a bare `id` reference.
3. **Money is `NUMERIC(19,4)`.** See [ADR-004](DECISIONS.md#adr-004).
4. **Calendar dates are `DATE`; instants are `TIMESTAMPTZ`.** See [ADR-005](DECISIONS.md#adr-005).
5. **Every schema change is a committed migration.**
6. **Migrations run under a PostgreSQL advisory lock** so concurrent runners serialise.
7. **Nothing is hard-deleted.** `status` is the vocabulary. See [ADR-006](DECISIONS.md#adr-006).

## Migration workflow

```
edit src/db/schema/*.ts
        ↓
npm run db:generate -- --name=short_snake_case_description
        ↓
READ THE GENERATED SQL, LINE BY LINE          ← not optional
        ↓
npm run db:migrate          (your own dev branch)
        ↓
npm run db:verify           (proves it applies cleanly and is idempotent)
                            requires a database marked by db:mark-test — see below
        ↓
commit the migration WITH the schema change
        ↓
CI applies it to an ephemeral Neon branch
        ↓
human review
        ↓
merge → gated production migration job → deploy
```

### Naming

Always pass `--name`. Without it Drizzle invents a random codename
(`0000_milky_silver_sable`), which tells a reviewer nothing:

```bash
npm run db:generate -- --name=journal_entries_and_lines
```

Files land in `drizzle/migrations/` as `NNNN_name.sql`, with `meta/_journal.json`
recording the order. All three are source code.

### Migrations are immutable once committed

A committed migration may already be applied in CI, Preview, or Production. Editing it
desynchronises environments and leaves no record of what actually ran. Fix a mistake with
a **new** migration. The `guard-write.sh` hook blocks edits to committed migration files.

### `drizzle-kit push` is prohibited

In every environment, including your own development branch. It diffs and mutates the
schema directly, producing:

- no reviewable artifact — nothing for a human to read before it runs
- no shared history — your database and CI's diverge silently
- no ordering guarantee — nothing records what ran when
- **no safe path to production** — the schema becomes whatever was last pushed

`push` is convenient exactly when you are in a hurry, which is exactly when an accounting
schema should not change without review. It appears in no npm script, and the
`guard-bash.sh` hook blocks it.

Use `db:generate` + `db:migrate`.

### Pooled vs direct connections

Neon exposes two endpoints per branch. Both are needed, and using the wrong one for
migrations fails silently rather than loudly.

| Variable | Endpoint | Used by |
|---|---|---|
| `DATABASE_URL` | pooled (`-pooler` in the host) | the application at runtime — both clients |
| `DATABASE_URL_UNPOOLED` | direct | migrations, advisory locks, `db:verify` |

The pooled endpoint is PgBouncer in **transaction pooling mode**: a client session is not
pinned to one server backend, and the backend can change between statements. Session-level
state does not survive that — and `pg_advisory_lock()` is session-level.

On the pooled endpoint a migration runner can therefore acquire its lock on one backend,
apply migrations on another, and release on a third. Nothing errors. The lock simply stops
protecting anything, which is the worst way for a lock to be wrong.

`getDirectDatabaseUrl()` prefers `DATABASE_URL_UNPOOLED` and **refuses** to fall back to a
`DATABASE_URL` whose host contains `-pooler`.

### The advisory lock

`scripts/migrate.ts` takes `pg_advisory_lock(8312004771002119)` on a dedicated connection
held for the whole run, released in a `finally`. It runs over the **direct** endpoint, for
the reason above.

This is not theoretical. Vercel can retry or parallelise builds, and CI can start a job
while another is mid-deploy. Two runners applying the same migration simultaneously is
how a schema ends up half-applied. With the lock, the second runner waits and then finds
the work already done.

The lock connection stays checked out deliberately — returning it to the pool early would
drop the lock while migrations were still applying.

**The lock key is a shared namespace.** Do not reuse `8312004771002119` for anything else.

### Rollback philosophy

Drizzle does not generate down-migrations, and LedgerLite does not add them. This is
deliberate.

An automatic reverse migration against live financial data is more dangerous than the
problem it claims to solve: dropping a column that new code stopped writing does not
restore the data it held, and a reversal that runs unattended during an incident can
destroy records that were the only remaining evidence of a transaction.

Instead, follow **expand → migrate → contract** ([AGENTS.md](../AGENTS.md) §5):

1. Add the new structure as nullable or additive. Deploy.
2. Backfill. Validate.
3. Deploy code that uses the new structure while tolerating the old.
4. Only once nothing reads the old structure, remove it — in a separate, later migration.

Every step is independently reversible by deploying the previous code, because the schema
stays compatible with both. Recovery from a genuinely bad migration is a restore from a
Neon branch, performed deliberately by a human, not an automated down-migration.

## Commands

| Command | Does | Needs a database |
|---|---|---|
| `npm run db:generate -- --name=x` | Diff schema → new migration file | no |
| `npm run db:check` | Validate migration consistency | no |
| `npm run db:migrate` | Apply migrations under the advisory lock | yes |
| `npm run db:studio` | Drizzle Studio browser | yes |
| `npm run db:verify` | Prove migrations apply, are idempotent, and the lock serialises | yes, marked |
| `npm run db:mark-test` | Mark a database disposable, enabling destructive tests | yes |

`db:verify` and the integration suite are destructive — they drop and truncate tables. Both
refuse to run unless **all three** safety layers pass: `APP_ENV=test`, the host appears in
`TEST_DATABASE_ALLOWLIST`, and the database carries the marker table. See
[TESTING.md](TESTING.md#the-safety-guard).

### First-time setup for a development branch

Order matters — `db:verify` requires the marker, and `db:mark-test` requires the database
to exist:

```bash
# 1. Put YOUR OWN Neon dev branch URL in .env.local as DATABASE_URL
# 2. Ask which database that is, and what the guard still needs:
npm run db:target                    # redacted output only, safe to paste anywhere
# 3. Add the APP_ENV and TEST_DATABASE_ALLOWLIST lines it prints, then:
npm run db:migrate
npm run db:mark-test -- --host <endpoint-id>   # NEVER against production
npm run db:verify
```

`db:target` answers "which database am I actually pointed at?" — the question whose wrong
answer is most expensive here. It strips credentials, so its output is safe to paste into
an issue or a chat.

`db:mark-test` is deliberately not a migration. A migration would install the marker
everywhere, production included, defeating the guard entirely.

## Environment

`DATABASE_URL` is read from `.env.local` locally and from the environment in CI and
deployment. It is never committed, never logged, and never included in an error message —
`describeConnection()` strips credentials before anything is printed.

Every developer and AI workspace uses its **own** Neon branch (`dev/lance`, `dev/claude`).
Never point local development, tests, or Preview at the production branch.

## Current schema

One table, `_health`, created by `0000_initial_health_probe`. It is a connectivity probe
and deliberately not an accounting entity — it exists so LL-002 could prove the migration
path before any real schema was designed.

Accounting entities begin at LL-020 (accounts) and LL-030 (the ledger).
