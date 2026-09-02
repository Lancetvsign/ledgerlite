# SECURITY

> **Status: skeleton.** Populated by **LL-007 — Engineering Documentation**.
> Tickets before LL-007 append to this file as they establish facts; LL-007 consolidates
> and completes it.
>
> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

## Authentication (LL-010)

Better Auth, email/password, with its own password hashing and session management — we
add no crypto of our own. Its four tables (`user`, `session`, `account`, `verification`)
were captured as migration `0001_better_auth_tables` and follow the same review rules as
any schema change.

**Authentication grants nothing.** A session proves identity, full stop. Company
membership and capabilities are separate application concerns (LL-013), every
company-scoped service authorizes independently, and an integration test asserts the
session object carries no roles, permissions or company access to smuggle.

### The base-URL boundary

The base URL decides where auth cookies are scoped and which origins may make
state-changing requests — so **nothing about it is derived from a request**. No `Host`,
no `X-Forwarded-Host`. `src/lib/auth/origins.ts` builds an explicit allowlist from
environment configuration only:

- `BETTER_AUTH_URL` (explicit, wins)
- `VERCEL_URL` / `VERCEL_BRANCH_URL` — injected by the platform per deployment, not
  client-controlled
- localhost variants, excluded in production

There is deliberately no `*.vercel.app` wildcard — that would trust every Vercel
deployment on the planet — and a unit test fails if anyone adds a wildcard. Production
with no configured base URL **refuses to start** rather than guessing. An integration
test sends a forged `Host` + `Origin` and asserts rejection; the same request from a
trusted origin succeeds.

### Session semantics, tested against the real database

- unauthenticated request → no session
- tampered token → no session
- **sign-out revokes server-side**: the old cookie stops working, asserted directly —
  not inferred from a page rendering signed-out

`BETTER_AUTH_SECRET` is server-only, required (startup fails loudly without it), and
**every environment gets its own** — a shared secret would make a session minted in
Preview valid in Production.

## Authorization model (LL-012 onward)

Capability-based. Business code asks `roleHasCapability(role, 'journal.post')` — it never
compares role names. A role-name comparison outside `src/server/rbac` is a **lint error**
(assignments stay legal; branching on names is what scatters policy into places nobody
can audit).

The grant matrix is keyed by capability and typed as a total `Record`, so adding a
capability without deciding who holds it is a compile error, not a silent default. The
tests carry an independent hand-written copy of the whole matrix: a permission change is
always a two-file diff that reads as a permission change.

Roles: OWNER and ADMIN hold everything; ACCOUNTANT works the ledger (journals, periods,
account structure, exports); BOOKKEEPER works documents (invoices, payments, expenses,
reconciliation) but never raw journals; READ_ONLY sees and cannot change.

**No role bypasses membership.** The module's entire surface is role-scoped — a
capability question is unanswerable without a role, and a role only exists inside an
ACTIVE membership in one company. OWNER of Company A is nobody in Company B. LL-013
enforces that end to end.

## Logging

`src/lib/logging` is the only approved logging path. `console.log` in server code is a
defect: it bypasses redaction entirely.

```ts
import { log } from '@/lib/logging';

log.info('journal entry posted', { entryNumber, companyId });
log.error('posting failed', { err });          // Error objects are safe to pass
```

### Redaction is applied at the boundary, not by callers

Every value passed to the logger goes through `redact()` before serialisation. There is
no code path from `log.info(...)` to output that skips it.

This placement is the whole design. A redaction step each caller must remember is a
redaction step that will eventually be forgotten, and the once it is forgotten is the
once it mattered. Callers cannot opt out, and new code written years from now inherits
the protection without knowing it exists.

Two independent strategies, because each covers the other's blind spot:

| Strategy | Catches |
|---|---|
| **By key name** | `{ password: "hunter2" }` — value looks like nothing in particular |
| **By value shape** | `{ detail: "postgres://u:pw@host/db" }` — credential under an innocuous key, or as free text in a message |

Protected key patterns include password, secret, token, authorization, cookie, session
id, API key, private key, salt, `DATABASE_URL`, connection string, DSN — and, specific
to this product, EIN, TIN, SSN, tax id, account number, routing number, IBAN, card
number, CVV, and uploaded file contents.

Protected value shapes include connection strings with an inline password, JWTs, Bearer
and Basic headers, and provider tokens from GitHub, Neon, Vercel, OpenAI, Stripe, Slack
and AWS.

### What it handles that a naive redactor does not

- **Nested objects and arrays**, to a depth limit, plus `Map` and `Set`.
- **Circular references** — emitted as `[Circular]` rather than hanging.
- **The log message itself**, not just the fields. A caller writing
  `log.error(\`connect failed: ${url}\`)` has made a mistake, but it must not become a
  credential in a log aggregator.
- **`Error.cause` chains, walked recursively.** Database drivers wrap errors repeatedly
  and the connection string is usually carried by the innermost one. A redactor that
  stringifies the top-level error leaks it.
- **Binary payloads** (`Buffer`, typed arrays) are replaced wholesale — they are receipts
  and statements, never useful in a log.

Values matched by key name are replaced entirely, never masked in place. A masked
password still reveals its length.

### The tests are mutation-checked

Redaction is only as good as the proof it works, and a test asserting the *presence* of
expected output will pass while a secret sits in a neighbouring field. Every assertion in
`tests/unit/logging-redaction.test.ts` therefore takes the form "this sentinel does not
appear anywhere in the output".

The suite was verified by deliberately breaking the implementation:

| Mutation | Tests that failed |
|---|---|
| `redact()` made a pass-through | 58 |
| key-name matching disabled | 43 |
| `Error.cause` chain not walked | 3 |

That last row matters most: the adversarial cause-chain tests fail *only* when the cause
chain regresses, so they are testing what they claim to. Re-run this check after any
change to the redactor.

### Correlation

`withRequestContext({ requestId }, fn)` attaches an id to every line emitted inside it,
including across `await` boundaries, via `AsyncLocalStorage`. Concurrent requests stay
separate.

The alternative — threading a logger through every function signature — fails exactly
where it matters: deep inside `LedgerService`, several layers below the route handler,
where the interesting failures happen and where nobody wants to add a parameter to six
functions to get an id.

`withAdditionalContext` attaches `userId` and `companyId` once known. **Neither is ever
used for authorization** — they are diagnostic labels. Authorization goes through
`requireCompanyMembership` / `requirePermission` every time.

Requires the Node runtime, which financial paths already declare for the Pool client.

### Format

Development emits a readable coloured line. Deployed environments emit one JSON object
per line for Vercel's log ingestion. `LOG_LEVEL` selects the threshold; `warn` and
`error` go to stderr so they survive stdout redirection.
