# AGENTS.md — LedgerLite AI Engineering Contract

You are working on a **double-entry financial accounting application**.
Correctness, security, traceability and data integrity outrank development speed.
A slow correct ledger is a product. A fast incorrect ledger is a liability.

---

## 0. Before you modify any code

1. Read this file completely.
2. Read `/docs/DECISIONS.md`. It is the authority on every ambiguous choice.
3. Read the `/docs` files relevant to the ticket.
4. Inspect the existing implementation and its tests before proposing changes.
5. Confirm you are on a feature branch, not `main`.

If this file and the code disagree, **stop and report the inconsistency**.
Do not silently reconcile them.

---

## 1. Approved architecture — do not substitute

Next.js (App Router) · React · TypeScript (strict) · Tailwind
Neon PostgreSQL · Drizzle ORM · Drizzle Kit
Better Auth · Zod · decimal.js
Vitest · Playwright · GitHub Actions · Vercel

You may not swap a framework, ORM, auth provider, or validation library because you
prefer an alternative. Architecture changes require a new ADR in `/docs/DECISIONS.md`
and explicit human approval **before** implementation.

---

## 2. Database driver policy — MANDATORY

Neon exposes two drivers with different capabilities. Using the wrong one on a
financial path silently destroys atomicity.

| Path | Driver | Import | Transactions |
|---|---|---|---|
| Reads, reports, single-statement writes | HTTP | `drizzle-orm/neon-http` | ✗ not supported |
| **All financial writes** | WebSocket Pool | `drizzle-orm/neon-serverless` | ✓ interactive |

- `src/db/index.ts` exports exactly two clients: `db` (HTTP) and `dbTx` (Pool).
- `LedgerService` and every financial write path may import **only** `dbTx`.
- Any route that posts financially declares `export const runtime = 'nodejs'`.
- If you find yourself wanting `db.transaction()` on the HTTP client, you have the
  wrong client. Do not work around it. Do not simulate a transaction with sequential
  statements plus compensating deletes.

---

## 3. Money

- Storage: PostgreSQL `NUMERIC(19,4)`. PostgreSQL is authoritative.
- Drizzle returns `NUMERIC` as `string`. Keep it that way at every boundary.
- Computation: `decimal.js` only, configured once globally
  (`precision: 34`, `ROUND_HALF_EVEN`).
- **The JavaScript `number` type must never hold a monetary value.** Not in a DTO,
  not in a Zod schema, not in a test fixture, not "just for the UI total".
- Comparison and equality use `Decimal.prototype.eq`, never `===` or `Math.abs(a-b) < ε`.

Boundary rule: `string` in → `Decimal` to compute → `string` out.

---

## 4. Financial invariants — never violate

1. A posted journal entry's debits equal its credits, exactly, at `NUMERIC(19,4)`.
2. Account balances are **derived from journal lines**. No table stores a balance.
   No cached balance column, no materialized total, no "denormalize for speed".
3. Posted journal entries are immutable. There is no edit-posted-entry function.
   Corrections are made by **reversal**, which creates a new entry.
4. No journal line may reference an account belonging to a different company.
5. No posting into a `CLOSED` accounting period, except through the explicitly
   authorized reopen workflow.
6. A source transaction posts exactly once. Retries are idempotent.
7. All financial posting is atomic. Partial postings must be impossible, not unlikely.
8. `LedgerService` is the **only** approved mechanism for creating posted entries.
   Feature modules never insert into `journal_entries` or `journal_lines` directly.

These invariants are enforced in the database (constraints and triggers) as well as in
application code. **Do not remove, weaken, or defer a database constraint to make code
pass.** If a constraint blocks you, the code is wrong.

---

## 5. Database rules

- Every schema change produces a committed Drizzle migration. Migrations are source
  code and are reviewed like source code.
- `drizzle-kit push` is **prohibited** in every environment. Use generate + migrate.
- Migrations run under a PostgreSQL advisory lock so concurrent runners serialize.
- Production schema is never modified by hand.
- Preview and CI never point at the production database.
- Production migrations follow **expand → migrate → contract**. Never ship a single
  migration that drops a column, transforms financial data, and requires new code all
  at once.
- Test fixtures contain synthetic data only. Never real financial or customer data.

---

## 6. Authorization

Authentication and authorization are separate concerns.
Being logged in grants access to nothing.

- Every company-scoped server operation independently calls
  `requireCompanyMembership(userId, companyId)` and, where relevant,
  `requirePermission(userId, companyId, capability)`.
- These fail **closed**.
- Middleware is a convenience layer, never the sole enforcement point. Services
  authorize independently.
- A `company_id` from the browser is an untrusted input. Always.
- Do not leak existence: a request for another company's entity returns the same
  response as a request for an entity that does not exist.
- Permission checks reference **capabilities**, not role-name string comparisons
  scattered through business logic.

---

## 7. Testing

- Do not weaken, skip, or delete a legitimate test to make new code pass.
  Fix the behavior.
- Every financial defect gets a regression test before the fix is considered done.
- Database-backed tests refuse to run against a database identified as production.
- Tests ship in the same pull request as the code they cover.
- Concurrency and idempotency are tested against a **real database**, not mocks.

---

## 8. Git

- Work on a feature branch. Never commit or push to `main`.
- Never merge your own pull request.
- Before requesting review: `npm run ci` must pass, and you must read the full diff.
- Conventional commits.

---

## 9. Secrets

Never place secrets in source, commits, test fixtures, error responses, logs,
documentation, or PR descriptions. `.env.example` carries names and explanations only.
Never read or write `.env.local` or `.env.production`.

Never log: passwords, tokens, session cookies, `DATABASE_URL`, bank credentials,
EIN/TIN values, or receipt file contents. Use the central redaction helper.

---

## 10. When you are blocked

If a ticket cannot be completed as specified — the spec is ambiguous, a dependency is
missing, or the correct implementation would violate a rule in this file — **stop and
report**. Do not:

- weaken a constraint, rule, or test to get to green
- silently substitute a different technical approach
- mark a ticket complete with known failing behavior
- expand scope beyond the ticket to "fix" something you noticed

A blocked ticket reported honestly is a good outcome. A ticket completed by
quietly relaxing an accounting invariant is the worst possible outcome.

---

## 11. Report at the end of every ticket

```
Ticket:
Branch:
Files changed:
Migrations created:       (filename + one-line description of what the SQL does)
DB constraints added:
Tests added:              (name + what invariant it proves)
Test results:             lint / typecheck / unit / integration / e2e / build
Accounting implications:
Security implications:
Decisions made that were not specified in the ticket:
Known limitations:
Recommended follow-up:
```

Be honest in the test results section. Report failures as failures.
