# API and Service Conventions

> Binding decisions live in [DECISIONS.md](DECISIONS.md). Accounting behaviour is in
> [ACCOUNTING_RULES.md](ACCOUNTING_RULES.md).

**No application API surface exists yet.** Authentication arrives in LL-010, company
authorization in LL-013, and the first financial service in LL-031. This file records the
conventions those tickets will follow, so the shape is decided once rather than
improvised per endpoint.

---

## Layers

```
Route handler / Server Action      HTTP concerns, nothing else
        │  validated input, authenticated identity
        ▼
Domain service  (src/server/**)    all business rules live here
        │
        ▼
Repository      (src/db/**)        queries only, no rules
```

A route handler does four things and no more: parse, validate, authorize, delegate. Any
business rule written in a route handler is a rule that the next caller — a background
job, a webhook, a different route — will not get.

## Every company-scoped operation authorizes itself

```ts
export async function postJournalEntry(input: PostJournalEntryInput) {
  const membership = await requirePermission(input.actorUserId, input.companyId, 'journal.post');
  // …
}
```

Not in middleware, not in the route handler alone — **in the service**. Middleware is a
convenience layer that a future background job, internal call, or webhook will bypass,
and the bypass will not look like a security decision at the time it is made.

A `companyId` arriving from the browser is untrusted input, always.

## Validation

All external input is validated server-side with Zod at the boundary. Services accept the
**parsed output type**, never the raw input type — a service whose signature accepts
unvalidated data is a service that will eventually receive some.

```ts
const PostJournalEntry = z.object({
  companyId: z.uuid(),
  transactionDate: z.iso.date(),          // calendar date, not a timestamp
  lines: z.array(JournalLineInput).min(2),
});
```

**Money fields are `z.string()` with a decimal refinement, and reject `number` rather
than coercing it.** See [ADR-004](DECISIONS.md#adr-004).

## Errors

Typed domain errors with stable machine-readable codes, listed in
[ACCOUNTING_RULES.md](ACCOUNTING_RULES.md#error-codes). Tests assert on the code, never on
message text.

Two rules about what an error may reveal:

1. **Never leak existence.** A request from Company A for a Company B entity returns the
   same response as a request for an entity that does not exist. Otherwise the error
   message is an enumeration oracle.
2. **Never leak internals.** Connection strings, stack traces and driver errors are
   logged (redacted — see [SECURITY.md](SECURITY.md#logging)), never returned.

| Situation | Status | Body |
|---|---|---|
| Validation failed | 400 | field-level messages, no internals |
| Not authenticated | 401 | generic |
| Authenticated, not permitted | 404 | **same as not-found**, per rule 1 |
| Domain rule violated | 422 | stable error code |
| Idempotent retry | 200 | the existing resource |
| Conflicting retry | 409 | `IDEMPOTENCY_KEY_CONFLICT` |

## Idempotency

Any endpoint that causes a financial posting accepts an idempotency key and is safe to
retry. An identical retry returns the original result as a success; the same key with a
materially different payload returns 409. See invariant 6 in
[ACCOUNTING_RULES.md](ACCOUNTING_RULES.md).

## Runtime

Routes that post financially declare:

```ts
export const runtime = 'nodejs';
```

Required for the Pool client's WebSocket and for `AsyncLocalStorage` request context. See
[ADR-001](DECISIONS.md#adr-001).

## Money on the wire

JSON carries money as a **string**: `{"amount": "10000.0000"}`. Never a number — JSON
numbers are IEEE-754 doubles, so `10000.0001` can survive a round-trip and
`0.1 + 0.2` cannot. The client formats for display; it never computes a total the server
has not confirmed.
