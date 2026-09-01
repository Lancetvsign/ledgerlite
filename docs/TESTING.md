# Testing

> Binding decisions live in [DECISIONS.md](DECISIONS.md).

## The rule that matters most

**Never weaken, skip, or delete a legitimate test to make new code pass.** Fix the
behaviour. A test that was correct yesterday and is inconvenient today is telling you
something.

There is one legitimate exception, and it is narrow: when the *assertion itself* was
wrong. LL-003 hit this twice — one test asserted a redacted URL contained no `:` when
`postgresql://` obviously does, and another used `0.3333 + 0.3333 + 0.3334` as an example
of float error when that sum happens to be exact. Both assertions were corrected to say
what they actually meant. Neither was loosened to accommodate failing code.

If you cannot tell which case you are in, you are in the first one.

Every financial defect gets a regression test **before** the fix is considered done.

## Layout

| Directory | Runner | Needs a database |
|---|---|---|
| `tests/unit/` | Vitest | no |
| `tests/integration/` | Vitest | yes |
| `tests/e2e/` | Playwright | yes, from LL-010 |
| `tests/fixtures/` | — | synthetic data |
| `tests/helpers/` | — | harness and guards |

```bash
npm test                  # unit only — fast, no database
npm run test:unit
npm run test:integration  # requires a marked test database
npm run test:e2e          # builds and serves production, then drives Chromium
npm run test:watch
```

`npm run ci` runs lint → typecheck → **unit** → build. It deliberately does **not** run
integration tests: including a database-dependent step would make `npm run ci` fail on
any machine without one, which trains people to ignore CI failures. CI runs the
integration project separately against an ephemeral Neon branch (LL-005).

## The safety guard

Integration tests truncate tables. `db:verify` drops them. Both are correct against a
development branch and catastrophic against production.

A Neon connection string does **not** contain the branch name — the host is an opaque
endpoint id like `ep-cool-fire-123` — so no amount of string inspection can reliably tell
a test branch from production. That is why the guard has three layers and why the third
one is the one that actually holds.

| Layer | Check | Where |
|---|---|---|
| 1 | `APP_ENV` must be exactly `test` | config |
| 2 | Target must not look like production **and** must appear in `TEST_DATABASE_ALLOWLIST` | config |
| 3 | The database must carry the `_ledgerlite_test_marker` table | the database itself |

All three must pass. Every layer fails closed — an unset allowlist approves nothing, and
a probe that *errors* is treated as a no, never as a maybe.

Layer 3 is decisive: production will never carry the marker, because nobody ever ran
`db:mark-test` against it. Layers 1 and 2 reason about a string a person typed; layer 3
asks the database what it is.

The marker is deliberately **not** a migration. A migration would install it everywhere,
including production, defeating the entire mechanism.

### One-time setup

```bash
# 1. Put YOUR OWN Neon dev branch URL in .env.local (never production)
# 2. Ask what the guard still needs — prints redacted output plus the exact
#    APP_ENV / TEST_DATABASE_ALLOWLIST lines to add
npm run db:target
# 3. Add those lines to .env.local, then:
npm run db:migrate
npm run db:mark-test                 # NEVER against production
npm run test:integration
```

## Isolation: truncate, not transaction rollback

Integration tests truncate and reseed between tests. They do **not** wrap each test in a
transaction that is rolled back. Rollback is the more common pattern and is faster; it is
wrong here for three reasons specific to accounting:

1. **LedgerService owns its own transactions.** An outer wrapping transaction makes the
   code under test run in a *nested* transaction. A rollback inside the service would
   unwind to a savepoint rather than aborting a real transaction — so the test would
   exercise semantics that never occur in production.
2. **The balance invariant fires at COMMIT.** LL-030 enforces debits-equal-credits with a
   `DEFERRABLE INITIALLY DEFERRED` constraint trigger. A test that never commits never
   fires it. Per-test rollback would leave the single most important guarantee in the
   product untested, while showing green.
3. **Concurrency tests need real concurrent transactions.** LL-032 posts the same
   idempotency key from two connections at once. That cannot exist inside one wrapping
   transaction.

Truncation is slower. Being able to test what actually happens at COMMIT is worth far
more than the milliseconds.

`truncateAll()` discovers tables from `information_schema` rather than hard-coding them,
so a table added in a later ticket cannot silently leak rows between tests. It preserves
`__drizzle_migrations` and the test marker.

## Fixtures

Rules, enforced by `tests/unit/fixtures.test.ts` — a meta-test, so a violation fails the
build rather than relying on review:

1. **Never real data.** Not anonymised real data — synthetic. Anonymisation fails, and a
   fixture is the least-guarded artifact in the repository.
2. **Money is always a string.** A fixture holding `1000.50` as a JavaScript number would
   seed float error into the tests meant to prove we have none. See
   [ADR-004](DECISIONS.md#adr-004).
3. **Identifiers are fixed, never generated.** A test that fails one run in fifty is a
   test people learn to re-run instead of read.
4. **Dates are fixed ISO calendar strings**, never `new Date()`. See
   [ADR-005](DECISIONS.md#adr-005).
5. **Placeholder credentials are written to be unmistakably synthetic.** The redaction
   tests must contain password-shaped strings — that is what they assert the absence of —
   so they use `SYNTHETIC-NOT-A-REAL-CREDENTIAL-0001` rather than anything resembling a
   real token. A string beginning `npg_` would look exactly like a live Neon password to
   a secret scanner, and a scanner that cries wolf on test fixtures is a scanner people
   switch off.

## End-to-end

Playwright drives a **production build**, not the dev server. Dev and production differ
in bundling, error handling, and rendering — and the dev server's HMR WebSocket emits
console errors of its own. A suite that filters infrastructure noise eventually filters a
real error by accident, so the noise is removed at the source instead.

This is what lets `reports no console errors on load` be a strict assertion against an
empty array.

Retries are off locally so flakiness surfaces immediately rather than being absorbed.

E2E binds port **3200**, deliberately not the dev server's port. `reuseExistingServer`
would otherwise latch onto a running dev server and silently test a dev build — which is
exactly the HMR-console-error failure this configuration exists to avoid. Verified: with
E2E pointed at the dev server's port and a dev server running, the no-console-errors test
fails; on 3200 it passes with the dev server still up.

| Port | Used by |
|---|---|
| 3000 | `npm run dev` with no arguments |
| 3100 | the `ledgerlite-dev` launch config, from either working directory |
| 3200 | Playwright's production build — never shared |

`ledgerlite-dev` is defined twice: in this repo's `.claude/launch.json`, and in the parent
workspace's, because the Browser pane resolves launch configs against the session's
working directory. Both pin 3100 so the name means one thing either way — and so neither
collides with Seatboard, which owns 3000 in the parent workspace.

### Authentication

`tests/e2e/global-setup.ts` prepares browser storage state once and specs reuse it.
Logging in per test is the usual reason an E2E suite becomes too slow to run — and then
stops being run.

Authentication itself arrives in **LL-010**; the setup currently writes an empty but
valid storage state so the seam exists and the file path is agreed. When LL-010 lands,
seed the user through the application's own signup path — never by writing auth tables
directly, which would test a state the application cannot actually produce.

## Current coverage

| Suite | Tests | Status |
|---|---|---|
| Unit — safety guard | 25 | passing |
| Unit — fixtures and redaction | 10 | passing |
| Integration — database smoke | 6 | **written, never executed** — no database available |
| E2E — application shell | 3 | passing |

The integration suite is delivered and typechecked but has never run. It proves
connection, applied migrations, transaction commit, **transaction rollback leaving
nothing behind**, and that `NUMERIC` returns a string. Until it executes against a real
database, those properties are asserted but unverified.
