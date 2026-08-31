# DATABASE

> **Status: skeleton.** Populated by **LL-007 — Engineering Documentation**.
> Tickets before LL-007 append to this file as they establish facts; LL-007 consolidates
> and completes it.
>
> Binding decisions live in [DECISIONS.md](DECISIONS.md). Where this file and an ADR
> disagree, the ADR wins and this file is wrong.

## Standing requirements

These apply to every table added from LL-011 onward. They are not per-table choices.

1. **Every tenant-owned table carries `UNIQUE (company_id, id)`.** This exists to enable
   composite foreign keys, which make cross-company references structurally impossible.
   See [ADR-008](DECISIONS.md#adr-008).
2. **Every cross-table reference within a tenant is a composite foreign key** on
   `(company_id, ref_id)`, never a bare `id` reference.
3. **Money is `NUMERIC(19,4)`.** See [ADR-004](DECISIONS.md#adr-004).
4. **Calendar dates are `DATE`; instants are `TIMESTAMPTZ`.** See [ADR-005](DECISIONS.md#adr-005).
5. **Every schema change is a committed migration.** `drizzle-kit push` is prohibited in
   every environment and is blocked by the guardrail hook.
6. **Migrations run under a PostgreSQL advisory lock** so concurrent runners serialize.
7. **Nothing is hard-deleted.** `status` is the vocabulary. See [ADR-006](DECISIONS.md#adr-006).
