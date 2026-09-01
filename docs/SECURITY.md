# SECURITY

> **Status: skeleton.** Populated by **LL-007 — Engineering Documentation**.
> Tickets before LL-007 append to this file as they establish facts; LL-007 consolidates
> and completes it.
>
> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

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
