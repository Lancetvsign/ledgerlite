# LedgerLite documentation

Start here if you are a human joining the project, or an AI session with no prior context.

## Read in this order

| # | File | What it answers |
|---|---|---|
| 1 | [../AGENTS.md](../AGENTS.md) | The binding engineering contract. Read first, always. |
| 2 | [DECISIONS.md](DECISIONS.md) | Every ambiguous choice, already settled. **Authoritative.** |
| 3 | [ACCOUNTING_RULES.md](ACCOUNTING_RULES.md) | The eight invariants and which layer holds each |
| 4 | [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, layout, TypeScript and lint conventions |
| 5 | [DATABASE.md](DATABASE.md) | Two clients, migrations, the advisory lock, pooled vs direct |
| 6 | [SECURITY.md](SECURITY.md) | Authorization model, logging and redaction |
| 7 | [TESTING.md](TESTING.md) | Suites, the three-layer safety guard, CI |
| 8 | [DEPLOYMENT.md](DEPLOYMENT.md) | Environments, preview isolation, the production gate |
| 9 | [API.md](API.md) | Service and route conventions (no API surface exists yet) |
| — | [tickets/](tickets/) | The 25 ticket definitions |
| — | [PR_TEMPLATE.md](PR_TEMPLATE.md) | Pull request format |

## The five things most likely to trip you up

1. **Two database clients, not one.** `getDb()` for reads, `getDbTx()` for every
   financial write. The HTTP driver's `.transaction()` compiles and typechecks, then
   throws at runtime. [ADR-001](DECISIONS.md#adr-001)
2. **Migrations need the *direct* endpoint**, not the pooled one. Neon's pooler is
   PgBouncer in transaction mode, where the session-level advisory lock silently protects
   nothing. [DATABASE.md](DATABASE.md)
3. **Do not upgrade TypeScript or ESLint.** Both are pinned one major behind on purpose.
   TypeScript 7 *silently* disables every type-aware lint rule rather than erroring.
   [ADR-009](DECISIONS.md#adr-009)
4. **Money is `string` at boundaries, `Decimal` in computation, never `number`.**
   [ADR-004](DECISIONS.md#adr-004)
5. **Guardrail hooks only load when `ledgerlite/` is the project root.** Opening a parent
   directory silently loads nothing. [TESTING.md](TESTING.md#guardrail-hooks--scope-matters)

## Where the project is

Sprint 0 (engineering foundation) is complete or nearly so. **No accounting code exists
yet** — that is deliberate. Accounts arrive in LL-020, the ledger engine in LL-030.

The sequencing is the point: Sprint 3 builds and proves the ledger before any invoice,
payment or expense is written, because a sophisticated interface on a weak ledger is a
failed accounting product.

## A note on what "verified" means here

Several documents distinguish **verified** from **implemented**. That distinction is
deliberate and worth preserving: code that has never executed against a real database, or
a workflow that has never run, is unverified regardless of how carefully it was written.

Sprint 0 found several defects that only surfaced when something actually ran — a
migration advisory lock that was inert on a pooled connection, an allowlist entry that
matched the application but not the migration runner, a branch reaper that would have
deleted branches it could not date. None was visible by reading the code.
