# Accounting Rules

> The invariants this product exists to uphold. If code and this file disagree, **stop
> and report** — do not reconcile them silently.
>
> Binding technical decisions live in [DECISIONS.md](DECISIONS.md).

LedgerLite is a **double-entry** accounting system. Every financial event is recorded as
a journal entry whose debits equal its credits, and every figure the product ever shows a
user is derived from those entries. There is no second source of truth.

---

## The eight invariants

Each is stated as a rule, followed by why it exists and which layer enforces it. The
enforcement column is the honest measure of how strong the guarantee actually is: a rule
enforced only by a test is a rule a future change can quietly remove.

| # | Invariant | Enforced by | Ticket | Status |
|---|---|---|---|---|
| 1 | Debits equal credits on every posted entry | DB — deferred constraint trigger | LL-030 | pending |
| 2 | No table stores an account balance | schema review + derivation | LL-020 / LL-034 | pending |
| 3 | Posted entries are immutable | DB trigger + service layer | LL-030 / LL-033 | pending |
| 4 | No cross-company journal line | DB — composite foreign keys | LL-030 | pending |
| 5 | No posting into a closed period | service — `assertPeriodOpen` | LL-022 / LL-031 | pending |
| 6 | A source transaction posts exactly once | DB — partial unique index | LL-030 | pending |
| 7 | Posting is atomic | Pool driver + one transaction | LL-031 | pending |
| 8 | Money is never a float | ADR-004 + Zod boundary rejection | LL-031 | pending |

Everything is `pending` because **Sprint 3 has not started**. Sprint 0 built the
foundation; the ledger itself is LL-030 onward. Mark an invariant `enforced` only when
the constraint exists *and* a test proves the violation is rejected **in raw SQL with the
application bypassed**.

---

### 1. Debits equal credits

Every posted journal entry balances exactly, at `NUMERIC(19,4)`. Not approximately, not
within a tolerance.

This is the definition of double-entry bookkeeping. An unbalanced entry means the books
no longer describe a coherent set of facts, and every report derived from them is wrong
in a way that compounds silently.

**Enforcement:** a `DEFERRABLE INITIALLY DEFERRED` constraint trigger. Deferral is
essential — lines are inserted one at a time, so an entry is legitimately unbalanced
mid-transaction and only has to balance at COMMIT. A non-deferred trigger would reject
every valid posting.

Application-level validation also runs, using `decimal.js` with exact equality. Never
`===` on numbers, never an epsilon comparison — an epsilon is how an unbalanced entry
gets accepted.

### 2. No table stores an account balance

Balances are computed from `journal_lines`, every time. There is no `balance` column, no
cached total, no materialised view, no "denormalise for speed".

A stored balance is a second source of truth, and the moment it diverges from the journal
— a missed update, a failed transaction, a race — the product is lying to its user with
no way to detect it. Deriving is slower and always correct.

Adding a balance column requires a new ADR and explicit approval. The schema files carry
a comment saying so, because the temptation arrives with the first slow report.

### 3. Posted entries are immutable

Once an entry's status is `POSTED`, nothing about it changes: not the dates, not the
company, not the source, not the lines, not the accounts, not the amounts.

**There is no edit-posted-entry function and none will be added.** Corrections are made
by **reversal**, which creates a *new* entry with debits and credits swapped and leaves
the original untouched and visible. The audit trail is the product.

The single permitted transition is `POSTED` → `REVERSED` with `reversed_by_id` set.
Everything else raises `POSTED_ENTRY_IMMUTABLE`.

### 4. No cross-company journal line

A journal line may never reference an account belonging to a different company.

**Enforcement is structural, not conventional.** Every tenant-owned table carries
`UNIQUE (company_id, id)`, and references are composite foreign keys on
`(company_id, ref_id)`:

```sql
ALTER TABLE journal_lines
  ADD CONSTRAINT jl_account_same_company
  FOREIGN KEY (company_id, account_id) REFERENCES accounts (company_id, id);
```

The database rejects it regardless of what the application does, what a future feature
module forgets, or what an agent misunderstands. See [ADR-008](DECISIONS.md#adr-008) for
why this is used instead of row-level security.

### 5. No posting into a closed period

Closing a period is a promise that its numbers will not change. Posting into a closed
period breaks that promise and invalidates every report already filed from it.

The period is resolved from **`posting_date`**, not `transaction_date` — see
[ADR-002](DECISIONS.md#adr-002). A December-dated invoice received in January is posted
with a December transaction date and a January posting date, and lands in January. That
is correct behaviour and the reason the two-date design exists.

`assertPeriodOpen(companyId, date)` is the single home of this rule. It is never
duplicated in a UI check.

### 6. A source transaction posts exactly once

An invoice, payment or expense produces one journal entry, no matter how many times the
request is retried.

The scenario is mundane and inevitable: a caller posts, the network times out, the caller
retries. Without idempotency the books now show the transaction twice, and nobody notices
until a reconciliation fails months later.

**Enforcement:** a partial unique index on `(company_id, source_type, source_id)` where
`status = 'POSTED'`, plus one on `(company_id, idempotency_key)`. Implemented by
attempting the insert and resolving on conflict — never check-then-insert, which has a
race window between the two.

An identical retry returns the existing posting as a success. The same key with a
materially different payload fails loudly rather than silently returning the original.

### 7. Posting is atomic

A posting either fully succeeds or leaves nothing behind. No orphan header, no partial
lines, no audit event describing something that did not happen.

**Enforcement:** one database transaction on the **Pool** client. The Neon HTTP driver's
`.transaction()` compiles, typechecks, and throws at runtime — see
[ADR-001](DECISIONS.md#adr-001), verified against a live database.

Simulating a transaction with sequential statements plus compensating deletes is
prohibited. A compensating delete cannot undo work another connection already observed,
and does not run at all if the process dies between statements.

The audit event is written **inside** the same transaction. An audit record that survives
a rolled-back posting describes an event that never occurred.

### 8. Money is never a float

`0.1 + 0.2 !== 0.3`. That is sufficient reason on its own.

| Layer | Type |
|---|---|
| PostgreSQL | `NUMERIC(19,4)` — authoritative |
| Drizzle result | `string` — preserved, never coerced |
| Zod schema | `z.string()` with a decimal refinement |
| Service in/out, JSON, React props, fixtures | `string` |
| Inside a calculation | `Decimal` |
| **Anywhere** | **never `number`** |

Zod **rejects** a JavaScript number in a money field rather than coercing it. Silent
coercion is precisely how float error enters an accounting system.

Rounding is `ROUND_HALF_EVEN` (banker's rounding), the accounting standard: it
distributes half-way cases evenly rather than accumulating the upward bias
`ROUND_HALF_UP` produces across many values.

Aggregation happens in PostgreSQL (`SUM(...)::numeric`), not by pulling rows into
JavaScript.

---

## Chart of accounts

Account types: `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `COGS`, `EXPENSE`.

Normal balances — the side on which a positive balance sits:

| Type | Normal balance | Increased by |
|---|---|---|
| Asset | Debit | debit |
| Liability | Credit | credit |
| Equity | Credit | credit |
| Revenue | Credit | credit |
| COGS | Debit | debit |
| Expense | Debit | debit |

The accounting equation holds at all times: **Assets = Liabilities + Equity**, with
revenue and expense as temporary equity accounts closed into retained earnings at year
end.

Accounts are never deleted — see [ADR-006](DECISIONS.md#adr-006). Deactivation removes an
account from selection for *new* postings, never from *history*. System accounts
(Accounts Receivable, Retained Earnings, Opening Balance Equity) cannot be deleted or
have their `system_account_type` reassigned.

---

## Worked example

Owner contributes $10,000 cash:

| Account | Debit | Credit |
|---|---|---|
| Checking (asset) | 10000.0000 | |
| Owner Contributions (equity) | | 10000.0000 |

Purchase $500 of office supplies, then reverse it:

| Entry | Account | Debit | Credit |
|---|---|---|---|
| #2 | Office Supplies (expense) | 500.0000 | |
| #2 | Checking (asset) | | 500.0000 |
| #3 reversal of #2 | Checking (asset) | 500.0000 | |
| #3 reversal of #2 | Office Supplies (expense) | | 500.0000 |

After the reversal, Office Supplies is `0.0000` and Checking is back to `10000.0000` —
computed from the four lines, not by mutating a stored figure. Entry #2 remains visible
and unaltered, marked `REVERSED`. That is the whole design in miniature.

---

## Error codes

Stable, machine-readable, and asserted on by name in tests rather than by message text.

| Code | Meaning |
|---|---|
| `UNBALANCED_JOURNAL_ENTRY` | Debits do not equal credits |
| `PERIOD_CLOSED` | The resolved accounting period is closed |
| `POSTED_ENTRY_IMMUTABLE` | Attempted mutation of a posted entry |
| `CROSS_COMPANY_REFERENCE` | A line references another company's account |
| `INACTIVE_ACCOUNT` | Posting to a deactivated account |
| `IDEMPOTENCY_KEY_CONFLICT` | Same key, materially different payload |
| `INSUFFICIENT_LINES` | Fewer than two meaningful lines |

---

## For a future session

If you are implementing Sprint 3, read this file and [DECISIONS.md](DECISIONS.md) before
writing any schema. The invariants above are not preferences — they are what makes the
output of this system admissible as a financial record.

The single most valuable habit: **push each invariant down to the strongest layer that
can hold it.** A database constraint outlives every refactor, every new feature module,
and every agent that will touch this codebase. Application code and tests are the second
and third lines, not the first.
