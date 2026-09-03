# Architecture Decision Records

Decisions that later tickets depend on. Each ADR states one decision, not a menu.

**These are binding.** An agent that finds an ADR inconvenient must stop and report,
not reinterpret. Changing a decision means a new ADR that supersedes the old one —
the original is never edited or deleted, so the reasoning trail survives.

| ADR | Decision | Status |
|---|---|---|
| [001](#adr-001) | Two Neon drivers; financial writes use the Pool client | Accepted |
| [002](#adr-002) | `posting_date` determines the accounting period | Accepted |
| [003](#adr-003) | Gapless per-company entry numbers via a locked counter row | Accepted |
| [004](#adr-004) | Money is `string` at boundaries, `Decimal` in computation, never `number` | Accepted |
| [005](#adr-005) | `transaction_date` is a calendar DATE; company timezone defines "today" | Accepted |
| [006](#adr-006) | Records are deactivated, never deleted; `status` is the vocabulary | Accepted |
| [007](#adr-007) | Reversal date is caller-supplied, defaults to today, must be open | Accepted |
| [008](#adr-008) | No row-level security; composite FKs plus the authorization layer | Accepted |
| [009](#adr-009) | TypeScript pinned below 7.x and ESLint below 10.x to keep type-aware linting | Accepted |

ADR-001 through ADR-008 decided 2026-08-31 (LL-000); ADR-009 added 2026-08-31 (LL-001).

**Sequencing note (2026-09-01).** LL-005 (CI) is taken before LL-004 (structured
logging), departing from the documented ticket order. Nothing enforces lint, types, or
tests on a pull request yet, so every ticket merged before CI exists rests on a local
`npm run ci` and a human remembering to run it. Gate 0 already requires passing checks
before Sprint 1, so CI is needed regardless; moving it earlier means less code lands
unverified. LL-004 has no dependency on LL-005 or vice versa — unlike LL-030 → LL-031,
this part of the order was not load-bearing.
Verified against `drizzle-orm@0.45.2`, `@neondatabase/serverless@1.1.0`, Node 24.

## How to add an ADR

Keep it short. An ADR that takes an hour to write does not get written, and the decision
gets made in a commit message nobody finds later.

```markdown
<a id="adr-0NN"></a>
## ADR-0NN — Short title

**Status** Accepted · **Added by** LL-0XX

### Context
What forced a decision. Include evidence you actually gathered — a command you ran, an
error you reproduced — not what you recall being true.

### Decision
One decision, stated plainly. Name the rejected alternative and why it lost.

### Consequences
What this costs, including what it makes harder. If a future reader will be tempted to
undo it, say so explicitly and say what breaks.

### Revisit if
The specific condition under which this should be reopened.
```

**Never edit or delete an accepted ADR.** Append an amendment (see ADR-001) or write a
new ADR that supersedes it. The reasoning trail is the point; a tidy file that has lost
the record of why a decision changed is worth less than a messy one that kept it.

---

<a id="adr-001"></a>
## ADR-001 — Neon driver strategy

**Status** Accepted · **Supersedes** the single-driver assumption in the original pack

### Context

The original specification mandated `@neondatabase/serverless` while simultaneously
requiring that all financial posting occur atomically inside a database transaction.
These two requirements are not jointly satisfiable with one driver, so the conflict was
resolved empirically rather than from recollection.

**Verification performed.** A script constructed both Drizzle clients against a
non-resolving host and attempted an interactive callback transaction on each:

```
neon-http        .transaction typeof  → function
neon-http        interactive tx       → THREW Error
                 message              → "No transactions support in neon-http driver"
                 network call made?   → no — failed before I/O

neon-serverless  .transaction typeof  → function
neon-serverless  interactive tx       → reached the WebSocket layer
                                        (ErrorEvent from @neondatabase/serverless
                                         index.mjs:1087 — a DNS failure against the
                                         fake host, not an unsupported-operation error)
```

The critical detail is the **shape** of the HTTP driver's failure. `.transaction()`
exists as a function and is fully typed, so `db.transaction(async tx => …)` compiles,
passes typecheck, and passes review. It throws only at runtime. There is no compile-time
signal whatsoever that the atomicity guarantee is absent — which is precisely how an
accounting system ends up with partial postings in production.

The HTTP driver does offer a non-interactive `transaction([q1, q2])` array form, but
that form cannot read a value and branch on it. Ledger posting must resolve the period,
validate accounts, insert the header, insert lines, verify the balance, and only then
commit. That is inherently interactive.

### Decision

LedgerLite uses **two Drizzle clients**, both exported from `src/db/index.ts`:

| Client | Driver | Import | Use |
|---|---|---|---|
| `db` | Neon HTTP | `drizzle-orm/neon-http` | Reads, reports, single-statement writes |
| `dbTx` | Neon WebSocket Pool | `drizzle-orm/neon-serverless` | **Every financial write path** |

Enforcement, because a naming convention will not survive contact with a future agent:

1. `src/db/index.ts` carries a comment block above each export stating what it is for
   and what breaks if it is misused.
2. An ESLint `no-restricted-imports` rule forbids `src/server/ledger/**` from importing
   the HTTP client. Reaching for `db` inside `LedgerService` is a lint failure, not a
   runtime surprise.
3. Every route handler that posts financially declares `export const runtime = 'nodejs'`.
4. `AGENTS.md` §2 states the policy in the contract an agent reads before writing code.

**Explicitly prohibited:** simulating a transaction with sequential statements plus
compensating deletes. A compensating delete is not a rollback — it cannot undo work
another connection has already observed, and it does not run if the process dies
between statements.

### Consequences

- The Pool client holds a WebSocket connection, so financial routes cannot run on the
  Edge runtime. This is acceptable; accounting operations are not latency-critical and
  Node is the correct runtime for them regardless.
- Two clients means two connection lifecycles to manage. LL-002 owns this.
- Reads stay on the HTTP driver and keep its cold-start advantage, so the split costs
  nothing on the paths where latency actually matters.
- **The atomicity guarantee in `AGENTS.md` §4.7 is real rather than aspirational.**

### Revisit if

Neon ships interactive transaction support over HTTP, or LedgerLite adopts a driver
that supports transactions over a stateless connection. Verify empirically before
changing this ADR — the failure mode is invisible to the type system.

### Amendment — LL-002: accessor form

The decision above says the module "exports exactly two clients: `db` and `dbTx`". The
implementation exports **`getDb()` and `getDbTx()`** — memoized accessor functions rather
than eagerly constructed constants.

The substance is unchanged: two clients, the Pool one for every financial write, enforced
by lint. Only the call shape differs, and it differs for a concrete reason. Eager
construction runs `getDatabaseUrl()` at import time, so merely importing `@/db` throws
when `DATABASE_URL` is absent. That breaks `next build` and therefore `npm run ci` on any
machine or CI job without a database — including every run before LL-006 provisions one.

Importing the module must never throw. Only *using* it without configuration should.

Read `db`/`dbTx` in this ADR as `getDb()`/`getDbTx()`.


---

<a id="adr-002"></a>
## ADR-002 — Accounting period resolution

**Status** Accepted

### Context

`journal_entries` carries both `transaction_date` and `posting_date`. Every closed-period
check needs to know which one selects the period. Without this, DEV-064 / LL-031's period
validation is unimplementable, and two developers will reasonably implement it two ways.

`transaction_date` is when the economic event occurred — the invoice date, the date on
the receipt. `posting_date` is when the entry hits the general ledger.

### Decision

**`posting_date` determines the accounting period.** `assertPeriodOpen` and
`getAccountingPeriod` evaluate `posting_date` and nothing else.

`transaction_date` is descriptive and is what reports and documents display. It never
gates posting.

When the two dates fall in different periods, that is normal and permitted: an invoice
dated 28 December received in January is posted with a December transaction date and a
January posting date, and lands in January.

### Consequences

- Closing December does **not** block recording a December-dated transaction. It is
  posted into an open period instead. This is the correct behavior and is the entire
  reason the two-date design exists.
- Every ledger and trial balance query must be explicit about which date it filters on.
  Period-based reports (trial balance, P&L for a month) filter on `posting_date`.
  Document-oriented views filter on `transaction_date`. Getting this wrong produces
  reports that disagree with each other, so **every report query names its date column
  in a comment.**
- `posting_date` defaults to `transaction_date` when a caller does not supply one, which
  keeps the common single-date case simple.
- Accrual timing is a bookkeeping judgment expressed through the posting date, not a
  rule the system enforces.

### Revisit if

LedgerLite adds accrual automation that must place an entry in the period of the
economic event regardless of when it was recorded. That is a new feature with its own
rules, not a change to this one.

---

<a id="adr-003"></a>
## ADR-003 — Journal entry numbering

**Status** Accepted · **Decided by** product owner

### Context

`entry_number` is the human-readable identifier a bookkeeper, auditor, or support
conversation uses to refer to an entry. The question is whether the sequence may contain
gaps, and how numbers are allocated safely under concurrency.

The naive `MAX(entry_number) + 1` is not viable and must never appear in the codebase:
two concurrent transactions both read the same maximum and both insert the same number,
or they deadlock. LL-032's concurrency tests exist in part to catch exactly this.

### Decision

**Gapless sequential numbering, scoped per company.**

Allocation uses a counter row per company, locked inside the posting transaction:

```sql
SELECT next_entry_number FROM company_counters
  WHERE company_id = $1
  FOR UPDATE;
UPDATE company_counters
  SET next_entry_number = next_entry_number + 1
  WHERE company_id = $1;
```

The `SELECT … FOR UPDATE` runs inside the same transaction as the posting, so a rolled-back
posting also rolls back the allocation and the number is reused. That is what makes the
sequence gapless.

A PostgreSQL `SEQUENCE` is explicitly rejected: sequences are non-transactional by design,
so a failed posting permanently burns its number and leaves a visible gap.

### Consequences

- Concurrent postings **to the same company** serialize at that company's counter row.
  At LedgerLite's scale — a small business posting a handful of entries per second at
  worst — this is not a meaningful constraint.
- Different companies never contend, since the lock is per company.
- The counter row must be created atomically with the company itself (LL-011), or the
  first posting for a new company fails. Company creation, owner membership, and counter
  initialization are one transaction.
- A long-running posting transaction blocks other postings for that company for its
  duration. Financial posting transactions must therefore stay short — no external HTTP
  calls, no file I/O, no user interaction inside the transaction.
- LL-032 must include a test that concurrent postings to one company produce a contiguous
  sequence with no duplicates and no gaps.

### Revisit if

A single company sustains posting volume high enough for counter contention to show up
in latency — realistically, high-volume automated imports. The remedy would be batch
allocation under one lock, not a switch to gapped numbering.

---

<a id="adr-004"></a>
## ADR-004 — Monetary representation

**Status** Accepted

### Context

Floating-point arithmetic cannot represent decimal fractions exactly, which makes it
unusable as the authoritative representation of money. The contract for money crossing
each boundary must be explicit, because a single implicit `Number(...)` coercion
anywhere in the stack silently reintroduces the problem.

**Verification performed** against `drizzle-orm@0.45.2`:

```
numeric('debit', { precision: 19, scale: 4 }).getSQLType()  → numeric(19, 4)
driver value '10000.0000' → JS                              → "10000.0000"  (typeof string)

0.1 + 0.2 === 0.3                                           → false
(0.1 + 0.2).toFixed(20)                                     → 0.30000000000000004441
0.3333 * 3                                                  → 0.9999
new Decimal('0.1').plus('0.2').eq('0.3')                    → true
Decimal '0.3333' + '0.3333' + '0.3334'                      → 1
```

Drizzle already returns `NUMERIC` as a `string`. The correct decision is therefore to
preserve what the driver gives us, not to convert it.

### Decision

**PostgreSQL is authoritative. Money is `NUMERIC(19,4)` in the database, `string` at every
boundary, and `Decimal` only inside a computation.**

| Boundary | Type |
|---|---|
| PostgreSQL column | `NUMERIC(19,4)` |
| Drizzle read result | `string` — preserved as-is, never coerced |
| Zod schema | `z.string()` with a decimal-format refinement |
| Service input and output | `string` |
| JSON API | `string` |
| React props and state | `string` |
| Test fixtures | `string` |
| Inside a calculation | `Decimal` |
| **Anywhere** | **never `number`** |

Global configuration, set once in `src/lib/decimal.ts` and imported for its side effect:

```ts
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });
```

`ROUND_HALF_EVEN` (banker's rounding) is the accounting standard. It distributes
half-way cases evenly between rounding up and down, so summing many rounded values
does not accumulate the upward bias that `ROUND_HALF_UP` produces.

Comparison uses `Decimal.prototype.eq`. Never `===`, and never an epsilon tolerance —
an epsilon comparison is how an unbalanced entry gets accepted.

Zod schemas **reject** a JavaScript `number` in a money field rather than coercing it.
Silent coercion is the exact mechanism by which float error enters an accounting system,
so it fails loudly at the boundary instead.

### Consequences

- Aggregation happens in PostgreSQL (`SUM(debit)::numeric`), not by pulling rows into
  JavaScript. The database is the arithmetic engine.
- UI totals are computed with `Decimal` from strings. `parseFloat` is prohibited even for
  display — a displayed total that disagrees with the server total is a support ticket.
- `precision: 34` comfortably exceeds `NUMERIC(19,4)`, so intermediate results in a
  multi-step calculation never lose precision before the final rounding.
- Lint should flag arithmetic operators applied to any value typed as money.

### Revisit if

Multi-currency requires more than four decimal places (some crypto and FX rates do). That
is a schema change with a migration, and precision 34 already accommodates it.

---

<a id="adr-005"></a>
## ADR-005 — Dates and timezones

**Status** Accepted

### Context

A journal entry belongs to a calendar day, not to an instant. If server-local time leaks
into posting logic, an entry posted at 21:00 Pacific lands on the following day for a
server running UTC — silently moving a transaction into the wrong period, and doing so
only for entries near midnight, which makes it very hard to notice.

Verified: Drizzle's `date()` column maps to a JS `string` (`'2026-08-31'`), not a `Date`.
Preserving that avoids an entire class of timezone bug.

### Decision

- `transaction_date`, `posting_date`, and accounting period boundaries are PostgreSQL
  `DATE` columns, carried in TypeScript as `YYYY-MM-DD` **strings**. Never `Date`,
  never a timestamp.
- Audit and lifecycle columns — `created_at`, `posted_at`, `closed_at` — are
  `TIMESTAMPTZ`, because those record instants rather than calendar days.
- Each company stores a `timezone` (IANA identifier). **"Today" for a company is computed
  in that company's timezone**, never the server's and never the browser's.
- `new Date()` is prohibited inside posting logic. The current business date is obtained
  from a single helper that takes the company timezone as an argument, making the
  dependency explicit and testable.
- Fiscal year boundaries derive from the company's `fiscal_year_start_month`. Periods are
  monthly, aligned to that fiscal start.

### Consequences

- Date arithmetic is string and calendar based, never millisecond based. No
  `Date.getTime()` in period logic.
- Tests can inject a fixed business date, so period boundary behavior is deterministic
  and does not depend on when the suite runs.
- A company operating across timezones uses one canonical timezone for its books. This
  matches how accounting actually works — a business keeps one set of books on one
  calendar.
- CI must run with a non-UTC `TZ` at least once, so any accidental server-local
  dependency surfaces instead of hiding behind a UTC-configured runner.

### Revisit if

LedgerLite supports a company changing its timezone after it has financial activity.
That needs its own rules, since it would reinterpret which day existing entries fall on.

---

<a id="adr-006"></a>
## ADR-006 — Deletion policy

**Status** Accepted

### Context

Accounting records are evidence. A deleted record destroys the audit trail, and a record
referenced by a journal line cannot be removed without orphaning financial history. Two
competing vocabularies — an `active` boolean and a `deleted_at` timestamp — used
inconsistently across tables produce queries that filter on the wrong one and quietly
return records that should be hidden, or hide records that should appear.

### Decision

**Nothing is ever hard-deleted through application code. `status` is the single
vocabulary.**

- Every entity that can become unusable carries a `status` column typed as an enum
  specific to that entity — `ACTIVE` / `INACTIVE` for accounts and memberships,
  `DRAFT` / `POSTED` / `REVERSED` for journal entries, `OPEN` / `CLOSED` for periods.
- No table uses a bare `active` boolean and no table uses `deleted_at`. A boolean cannot
  express the third state that every one of these entities eventually needs.
- Application services expose no hard-delete operation at all. `DELETE` statements
  against accounting tables are blocked by the Claude Code guardrail hook and, for
  posted ledger rows, by a database trigger.
- Inactive records remain fully queryable for historical reporting. Deactivation removes
  a record from *selection for new work*, never from *history*.
- Draft journal entries — never posted, therefore not yet evidence — are the one
  exception and may be deleted by a permitted user.

### Consequences

- Every list query filters on `status` explicitly. There is no global default scope that
  silently excludes rows, because an invisible default is how a report ends up missing
  data nobody can account for.
- Account pickers exclude `INACTIVE` accounts for new postings, while historical entries
  referencing them still resolve and display normally.
- The database accumulates rows indefinitely. This is intended. Accounting data is
  retained for years by statute.
- Foreign keys never need `ON DELETE CASCADE` for accounting data, since the parent is
  never removed. The one exception is `journal_lines` cascading from `journal_entries`,
  which exists only so a draft entry can be discarded atomically.

### Revisit if

A data retention obligation requires genuine erasure — a GDPR request touching
personal data on a customer record, for instance. That is a separate, audited,
explicitly authorized workflow, and it does not change the default.

---

<a id="adr-007"></a>
## ADR-007 — Reversal date policy

**Status** Accepted · **Decided by** product owner

### Context

Reversal is the only way to correct a posted entry, since posted entries are immutable
(`AGENTS.md` §4.3). The reversing entry needs a date, and the period containing the
original entry is frequently closed by the time the error is found — which is usually
*how* it gets found, during a close or a review.

### Decision

**The caller supplies the reversal date. It defaults to the company's today. It must fall
in an OPEN period, and `LedgerService` rejects it with `PERIOD_CLOSED` if it does not.**

Mirroring the original entry's date is explicitly rejected: it would require posting into
the original period, which is closed in the common case, and reopening a closed period to
accommodate a correction defeats the purpose of closing it.

**The original entry's period is never reopened, never mutated, and never touched by a
reversal.** The original keeps its date, its lines, and its amounts exactly as posted. It
gains `reversed_by_id` and its status becomes `REVERSED`, and nothing else about it
changes.

### Consequences

- A January error found in March is reversed in March. January's closed books stay
  closed and continue to reconcile to what was reported.
- The reversal is visible in the period where the correction was actually made, which is
  the honest presentation and what an auditor expects to see.
- Comparative reporting shows the original effect in the original period and the
  offsetting effect in the correction period. This is intended, not a defect —
  restating a closed period silently is the thing to avoid.
- The reversal UI defaults the date to today and requires the user to acknowledge when
  the original falls in a different period, so the consequence is visible at the moment
  of the decision.
- Reversing a reversal is permitted — it is an ordinary posted entry — subject to the
  same rules. Reversing an entry that is *already* `REVERSED` is rejected.

### Revisit if

A soft-close workflow is added that permits authorized adjustments into a
recently-closed period. That would be a distinct authorized workflow with its own audit
events, not a relaxation of this rule.

---

<a id="adr-008"></a>
## ADR-008 — Row-level security

**Status** Accepted

### Context

PostgreSQL RLS can enforce tenant scoping in the database, so a query missing its
`WHERE company_id = …` returns nothing rather than another tenant's data. The question is
whether LedgerLite adopts it. An unconsidered absence is not an acceptable outcome here,
so the decision is recorded either way.

### Decision

**LedgerLite does not use row-level security.** Tenant isolation rests on three
mechanisms instead:

1. **Composite foreign keys.** Every tenant-owned table carries `UNIQUE (company_id, id)`,
   and every cross-table reference is a composite FK on `(company_id, ref_id)`. A journal
   line referencing another company's account is rejected by the database regardless of
   application code. This is structural and cannot be bypassed by a missing `WHERE`
   clause on a write path.
2. **A mandatory authorization layer.** Every company-scoped operation calls
   `requireCompanyMembership` / `requirePermission`, which fail closed (LL-013).
3. **A permanent isolation test suite** that every new entity must join (LL-014),
   including an adversarial pass by an agent with no knowledge of the implementation.

RLS was rejected on three grounds. It requires a per-request session variable
(`SET LOCAL app.company_id`) that the connection pool must set reliably on every checkout
— a pooled connection that keeps a stale value is itself a cross-tenant vulnerability,
so RLS would introduce a new failure mode of exactly the kind it is meant to eliminate.
It applies to reads, whereas the highest-severity risk in a ledger is a *write* that
creates a cross-company relationship, which composite FKs already prevent absolutely.
And it makes debugging materially harder, since queries silently return fewer rows rather
than failing.

### Consequences

- **A read query that omits its company scope will return other companies' rows.** This
  is the accepted risk of this decision, and it is why LL-014's suite is release-blocking
  rather than advisory, and why every new entity must register an isolation descriptor.
- Composite FKs require `UNIQUE (company_id, id)` on every tenant-owned table. This is a
  standing requirement recorded in `docs/DATABASE.md`, not a per-table choice.
- Direct database access by an operator bypasses all three mechanisms. Production
  database access is a human process governed by `docs/SECURITY.md`, not something the
  application can enforce.

### Revisit if

LedgerLite exposes direct SQL access — an analytics connection, a customer-facing query
API, a BI integration — to anything that is not the application itself. At that point the
authorization layer is no longer in the path and RLS becomes necessary rather than
redundant.

---

<a id="adr-009"></a>
## ADR-009 — Toolchain version pinning

**Status** Accepted · **Added by** LL-001

### Context

At the time of LL-001 the newest published versions were TypeScript 7.0.2 and
ESLint 10.9.1. Neither is usable here, and both failures were found by attempting the
upgrade rather than by reading changelogs.

**TypeScript 7.** `typescript-eslint@8.69.0` — including its `canary` build — declares
`peerDependencies.typescript: >=4.8.4 <6.1.0`. No release supports TypeScript 7. Adopting
TS 7 therefore means giving up **type-aware linting entirely**, since those rules require
typescript-eslint's type information.

The rules lost would include `no-floating-promises`. In an accounting application that is
not a style rule. An un-awaited `dbTx.transaction(...)` returns immediately, the caller
observes success, and the posting may never commit — a silent financial defect of exactly
the kind this project exists to prevent, and one no test reliably catches because it is
timing dependent.

**ESLint 10.** `eslint-config-next@16.3.4` declares `peerDependencies.eslint: >=9.0.0`,
which is optimistic rather than accurate. Under ESLint 10 the observed failures were:

```
src/app/page.tsx     TypeError: Error while loading rule 'react/display-name':
                     contextOrFilename.getFilename is not a function
eslint.config.mjs    TypeError: scopeManager.addGlobals is not a function
```

`eslint-plugin-react`, reached transitively through `eslint-config-next`, still calls the
ESLint 8 context API that ESLint 10 removed. Linting cannot run at all.

### Decision

| Package | Pinned | Newest available | Reason |
|---|---|---|---|
| `typescript` | `6.0.3` (exact) | 7.0.2 | typescript-eslint supports `<6.1.0`; type-aware lint is non-negotiable |
| `eslint` | `^9.39.5` | 10.9.1 | `eslint-config-next@16` is not ESLint 10 compatible |
| `next` | `16.3.4` (exact) | 16.3.4 | current |
| `react` / `react-dom` | `19.2.8` (exact) | 19.2.8 | current |

TypeScript and Next are pinned **exactly**, not with a caret. A minor TypeScript bump
can change type inference, and in this codebase type inference is a correctness control.
Upgrades are deliberate, reviewed changes, not something a `npm install` performs.

`baseUrl` is deliberately absent from `tsconfig.json`. It is deprecated in TypeScript 6
and removed in 7; `paths` resolves relative to the config file without it. This keeps the
eventual TS 7 upgrade unblocked by our own configuration.

### Consequences

- Type-aware linting works: `no-floating-promises`, `no-misused-promises`,
  `await-thenable`, `switch-exhaustiveness-check`, and the `no-unsafe-*` family are all
  active and were each verified to fire against a deliberately bad file.
- LedgerLite runs one major version behind on TypeScript and ESLint. This is accepted.
- **A future agent will see "outdated" dependencies and try to upgrade them.** That is
  the specific failure this ADR exists to prevent. Upgrading TypeScript past 6.0.x
  silently disables every type-aware rule, because typescript-eslint degrades rather than
  erroring loudly. Do not upgrade without re-verifying that the rules still fire.
- `npm outdated` will report these as behind. That is expected, not a defect.

### Revisit if

`typescript-eslint` ships TypeScript 7 support (check
`npm view typescript-eslint peerDependencies.typescript`), or `eslint-config-next` ships
genuine ESLint 10 compatibility. In both cases, upgrade and then **re-run the rule proof**
— confirm `no-floating-promises` still reports against a floating promise before trusting
the result. A green lint run proves nothing if the rules silently stopped applying.

---

## ADR-010 — Reversal entry mechanics

**Status** Accepted · **Added by** LL-033

### Context

ADR-007 settled the reversal *date*. Building the engine surfaced four further choices the
ticket left to implementation, each of which interacts with an existing invariant.

### Decision

**Source linkage.** The reversing entry carries `source_type = 'REVERSAL'` and
`source_id = <original entry id>`, and the authoritative link is `reversal_of_id`. The
original's own `source_type`/`source_id` are **not** copied. Copying them would post a
second POSTED row for the original's source (an invoice, a payment) and violate the
"one POSTED entry per source" index (invariant 6) — reversing an invoice's entry would
be indistinguishable from posting that invoice twice. The `'REVERSAL' → original.id`
source is also a second, independent guard: a repeat reversal of the same original
collides on `journal_entries_source_posted_once` even if every other check were bypassed.

**Dating.** Both `transaction_date` and `posting_date` on the reversal are set to the
reversal date. The correction is an event in the period where it is actually made
(ADR-007); backdating `transaction_date` to the original would drag the reversal toward
the original's (usually closed) period and split one entry across two periods.

**Audit.** A reversal writes **two** events in its single transaction: a
`JOURNAL_ENTRY_POSTED` on the new reversing entry (it is a posting like any other) and a
`JOURNAL_ENTRY_REVERSED` on the original (recording that it was reversed, and by which
entry). Both roll back with the operation.

**Deactivated accounts.** Reversal deliberately does **not** re-check that the referenced
accounts are active — the one validation from the posting path it omits. An account may
have been deactivated after the erroneous entry was posted; refusing to reverse against an
inactive account would trap the error permanently, with no correct way out. The composite
FK still guarantees the accounts belong to the company, and the amounts are copied
verbatim from the original's committed lines, so nothing unbalanced or cross-tenant can
result.

### Consequences

- The net effect of an entry and its reversal is exactly zero on every account, proven
  from the journal lines with decimal.js in every reversal test.
- Reversing a reversal is ordinary (each reversal is a plain POSTED entry with its own
  `REVERSAL` source pointing at what it reverses); reversing an already-`REVERSED` entry
  is rejected.
- A reversal is visible in reports for the period it lands in, never the original's — the
  honest presentation ADR-007 requires.

### Revisit if

A dedicated reversal `source_type` per original source is ever needed for reporting (e.g.
distinguishing an invoice reversal from a payment reversal at the source level). Today the
`reversal_of_id` join to the original supplies that, so the single `'REVERSAL'` source
suffices.

---

## ADR-011 — What "in the ledger" means for balances (POSTED **and** REVERSED)

**Status** Accepted · **Added by** LL-034

### Context

The LL-034 ticket says the trial balance should "include only `POSTED` entries." Taken
literally against the LL-033 reversal model, that is wrong, and the ticket's own test
("an entry plus its reversal nets to zero") is the proof.

A reversal does not erase the original. LL-033 leaves the original exactly as posted and
adds a **separate** offsetting entry, marking the original `REVERSED`. The two entries
together are what nets to zero. Consider Cash 100 / Revenue 100, then reversed:

| Entry | Status | Cash | Revenue |
|---|---|---|---|
| Original | `REVERSED` | +100 Dr | +100 Cr |
| Reversal | `POSTED` | −100 (Cr) | −100 (Dr) |
| **Net** | | **0** | **0** |

If balances counted only `POSTED` entries, the `REVERSED` original would drop out and the
reversal would stand alone — Cash would read −100, Revenue −100. The books would be wrong
*because* a correction was made. That is the opposite of what a reversal is for.

### Decision

**An entry is "in the ledger" when its status is `POSTED` or `REVERSED`, and excluded only
when `DRAFT`.** Every balance computation — the trial balance and all four integrity
assertions (`invariants.ts`) — uses `status in ('POSTED','REVERSED')`, never `= 'POSTED'`.
"Only POSTED" in the ticket is read as "only entries posted to the ledger" — i.e. not
drafts — which is the sense in which it is true.

A `REVERSED` entry is never hidden, deleted, or altered (invariant 3 / ADR-007); it keeps
its lines and its financial effect, offset by its reversal. `DRAFT` entries have never
been posted and carry no ledger effect, so they are the only thing excluded.

### Consequences

- The trial balance always balances, before and after any reversal, and shows an entry
  and its reversal netting to zero on every account — proven with `decimal.js` in the
  LL-034 tests.
- Every later report (general ledger, financial statements) must use the same
  `('POSTED','REVERSED')` population. A report that filters `= 'POSTED'` will silently
  drop reversed originals and misstate the books.

### Revisit if

A future "voided draft" or other non-ledger status is added; the exclusion rule is
"`DRAFT` (and anything equally pre-ledger) is out", not "only these two are in", so a new
pre-posting status would join `DRAFT` on the excluded side.

---

## ADR-012 — Closed-period enforcement is structural (a period-locking trigger)

**Status** Accepted · **Added by** Gate 2 remediation

### Context

The Gate 2 review found that invariant 5 — "no posting into a `CLOSED` period" (AGENTS
§4.5) — was enforced **only** by `LedgerService` (`assertPeriodOpen` and an in-transaction
re-read). Two consequences, both confirmed by independent review and the LL-036 adversarial
pass:

1. **Not structural.** A raw `INSERT` into `journal_entries` — the service bypassed —
   posted freely into a closed period. Every other financial invariant is backed by a DB
   constraint or trigger; this one was not, contradicting AGENTS §4's "enforced in the
   database … as well as in application code."
2. **A close-vs-post TOCTOU.** The period check was a non-locking `SELECT`. A posting that
   read the period OPEN could commit *after* a concurrent `closePeriod` committed — landing
   an entry in a just-closed period and silently changing that period's derived numbers
   after the close, the exact outcome ADR-007 exists to prevent.

### Decision

**A `BEFORE INSERT` trigger on `journal_entries` (migration 0010) enforces the rule in the
database, and does so with a lock that also closes the race.** For every `POSTED` insert it
reads the containing accounting period `FOR SHARE` and raises `PERIOD_CLOSED` if that period
is `CLOSED`.

- The **`FOR SHARE`** lock is held until the posting commits. `closePeriod`'s `UPDATE` takes
  a row-exclusive lock, so a close must **wait** for in-flight posts, and any post that
  begins after a close commits sees `CLOSED` and is refused. Lock acquisition and status
  read are one statement — no window between "checked open" and "committed". Concurrent
  posts into one period take compatible share locks (and already serialise on the
  per-company counter), so the only new interaction is post-vs-close.
- The trigger fires **only for `POSTED`** rows; drafts carry no ledger effect.
- A `posting_date` with **no** period row is left alone. The application always creates the
  OPEN period before posting (`getAccountingPeriod`), so this only matters to raw inserts,
  and a period-less posted row is a separate anomaly, not "posting into a closed period".
  This keeps the guard surgical and changes no open-period behaviour.

`LedgerService` keeps its early, non-locking period check so the common case returns a typed
`PERIOD_CLOSED` without reaching the trigger; the trigger's raise is mapped to the same typed
error for the rare race path and for any future caller.

### Consequences

- Invariant 5 is now **structural**: a raw-SQL insert into a closed period is rejected by
  the database, proven with the service bypassed.
- The close-vs-post TOCTOU is eliminated: a close serialises against in-flight posts.
- `closePeriod` needs no change — its existing `UPDATE` already conflicts with the share
  lock. No deadlock: postings acquire the counter before the period, and `closePeriod`
  touches only the period.

### Revisit if

A soft-close workflow (ADR-007's "revisit") is added, or posting throughput makes the
per-close wait on in-flight posts material — at which point a deferred trigger or an
advisory-lock scheme could replace the row `FOR SHARE`.

---

## ADR-013 — Invoice totals are stored, but always service-derived

**Status** Accepted · **Added by** LL-041 · **Decided by** product owner

### Context

Invariant 2 forbids storing an **account balance** — those derive from journal lines,
every time. An **invoice total** (subtotal, tax, grand total) is a different thing: a
property of a source *document*, computed from its line items. LL-041 had to choose
between deriving those totals on every read and storing them on the invoice row.

### Decision

**Store `subtotal`, `tax_total`, and `total` on `invoices` — but they are ALWAYS
recomputed from the line items by the service (`computeInvoiceTotals`, decimal.js,
ROUND_HALF_EVEN) and written on every create/update. No input carries a total; there is
no path for a caller to state one.** Per line: `amount = quantity × unit_price`,
`tax = amount × rate ÷ 100`, each rounded to `NUMERIC(19,4)`; the invoice totals are the
sums. When an invoice is finalized (DRAFT→OPEN, LL-042) the lines freeze and so do the
totals.

This is explicitly **not** a violation of invariant 2:
- It is a document total, not an account balance. A customer's *open balance* (what they
  owe) is still derived from posted journal lines against Accounts Receivable, never
  stored here.
- The stored total can never silently diverge from the lines, because the service is the
  only writer and always derives it, and a regression test asserts
  `stored total == recompute(lines)`.

### Consequences

- Reads and reports get the invoice's totals without recomputing across line items, and a
  posted invoice (LL-042) references a fixed, frozen total.
- The discipline is load-bearing: any future writer of `invoices.subtotal/tax_total/total`
  MUST go through `computeInvoiceTotals`. A raw `UPDATE` that sets a total by hand is a
  defect the consistency test is designed to catch. If invoices ever gain a
  hand-adjustable total (a manual discount line is the better model), that is a new ADR.

### Revisit if

Multi-currency or per-invoice rounding rules arrive, or the consistency test ever proves
insufficient — at which point a deferred CHECK/trigger recomputing the total in the
database (not just the service) would make the guarantee structural.
