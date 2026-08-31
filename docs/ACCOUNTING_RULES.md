# ACCOUNTING RULES

> **Status: skeleton.** Populated by **LL-007 — Engineering Documentation**.
> Tickets before LL-007 append to this file as they establish facts; LL-007 consolidates
> and completes it.
>
> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

## Invariants

Each invariant records **which layer enforces it**. That distinction is the honest
measure of how strong the guarantee actually is — a rule enforced only by a test is a
rule that a future change can silently remove.

| Invariant | Enforced by | Ticket | Status |
|---|---|---|---|
| Debits equal credits on every posted entry | DB — deferred constraint trigger | LL-030 | pending |
| Posted journal entries are immutable | DB trigger + service layer | LL-030 / LL-033 | pending |
| No table stores an account balance | Schema review + LL-034 derivation | LL-020 / LL-034 | pending |
| No floating-point money | ADR-004 + Zod boundary rejection | LL-031 | pending |
| Company isolation on ledger references | DB — composite foreign keys | LL-030 | pending |
| Closed periods reject postings | Service — `assertPeriodOpen` | LL-022 / LL-031 | pending |
| A source transaction posts exactly once | DB — partial unique index | LL-030 | pending |
| Posting is atomic | Pool driver + single transaction (ADR-001) | LL-031 | pending |

Mark an invariant `enforced` only when the constraint exists and a test proves the
violation is rejected **in raw SQL with the application bypassed**.
