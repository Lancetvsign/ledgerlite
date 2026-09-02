# Gate 2A — Accounting Configuration

> Sprint 2 ends here. The **ledger engine** (Sprint 3, LL-030 onward) does not begin
> until every item is **verified by execution**, most of it against the live database
> with the application bypassed.

## Checklist

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | No table stores an account balance | ✅ | `information_schema`: `accounts` has no balance/total column |
| 2 | Default COA installs correctly and is idempotent under concurrency | ✅ | `default-coa` suite 9/9, including two simultaneous installs → exact count, no duplicates |
| 3 | System accounts protected — no delete, no `system_account_type` reassignment | ✅ | `accounts` + `accounts-ui-authz` suites: deactivating a system account rejected even for OWNER |
| 4 | Parent account cannot cross companies — verified in raw SQL | ✅ | Direct insert of a B-account with an A-parent **rejected by the composite FK**, application bypassed |
| 5 | Period overlap prevented by a database constraint | ✅ | `EXCLUDE` constraint `accounting_periods_no_overlap`; raw overlapping insert rejected |
| 6 | `assertPeriodOpen` exists and is the single home of the closed-period rule | ✅ | `periods` suite 13/13; built LL-022, wired into posting in LL-031 |
| 7 | `audit_events` rejects `UPDATE` and `DELETE` at the database | ✅ | Enabled trigger `audit_events_no_update_delete`; `audit` suite proves both rejected, row survives |
| 8 | Audit events write inside the action's transaction | ✅ | `audit` suite: a rolled-back action leaves zero audit rows |
| 9 | Standing `UNIQUE (company_id, id)` on every tenant-owned table | ✅ | All four (`accounts`, `accounting_periods`, `audit_events`, `company_memberships`) confirmed from `pg_constraint` |
| 10 | Tenant isolation still passes with the new entities registered | ✅ | `isolation` suite 5/5; completeness test would fail CI for any unregistered `company_id` table |
| 11 | `npm run ci` passes | ✅ | lint, typecheck, 330 unit+integration, build |
| 12 | `/security-review` over the Sprint 2 surface | ✅ | Implementation-blind agent: **no exploitable findings**; 2 of 5 sub-threshold observations fixed here |

## What was proven with the application bypassed

The strongest items are database-level, so they were attacked directly in SQL — the only
honest test of "the database enforces this", per the project's standing definition:

- A `company_id`/`parent_account_id` composite FK **rejects** an account whose parent
  belongs to another company. No application code is in the path.
- An `EXCLUDE USING gist` constraint **rejects** an overlapping period in the same
  company, regardless of what the service does.
- The `audit_events` trigger **rejects** `UPDATE` and `DELETE` for every role including
  the table owner; the row is still present afterward.

## Invariant ledger (from ACCOUNTING_RULES.md)

Sprint 2 moved three invariants from `pending` to partially enforced:

| Invariant | Now |
|---|---|
| 2 — no stored balance | `accounts` has no balance column (structural); full derivation is LL-034 |
| 4 — no cross-company reference | the composite-FK pattern is proven on `accounts.parent`; journal lines are LL-030 |
| 5 — no posting into a closed period | `assertPeriodOpen` built and tested; wired into posting at LL-031 |

The remaining five invariants are the ledger's own and belong to Sprint 3. **No account
stores a balance and no journal table exists yet** — exactly the state Gate 2A requires
before the engine is built.

## Security review

An implementation-blind agent traced every mutating entry point, every id-based
read/write, the unauthorized internal functions, system-account/closed-period
protection, and the injection surface. **No HIGH/MEDIUM exploitable vulnerability.**
Confirmed clean: all seven app-reachable service actions authorize with the correct
capability before any write; every account/period read and write is scoped
`company_id AND id` (no IDOR); the installer and audit recorder are unauthorized
internals with no `src/app` path to them; system accounts and closed periods cannot be
tampered with through any reachable path; Drizzle is fully parameterised (no `sql.raw`
of user input); audit `before/after` JSON is redacted.

Five sub-threshold observations. **Two fixed in this branch:**

1. **Installer fence gap** — `installDefaultChart` (unauthorized) lived in `installer.ts`,
   which the LL-014 `*/internal` lint fence did not cover, so it was one import away from a
   route with no lint to stop an attacker-supplied `companyId`. **Moved to
   `accounts/internal.ts`**, now fence-covered (proven to fire); `installer.ts` keeps only
   the authorized `installDefaultChartFor`.
2. **`updateAccount` emitted no audit event** while create and deactivate did — an
   audit-trail gap before the ledger arrives. **Now records `ACCOUNT_UPDATED` inside the
   edit's transaction**, with a test asserting before/after.

**Three recorded as accepted, not exploitable:**

3. `closePeriod`/`reopenPeriod` UPDATE `WHERE` also now carries `company_id` (was safe via
   the preceding `(company_id, id)` SELECT; added for defense in depth in the same pass).
4. `accountNumber` is redacted in audit JSON because the shared redactor matches the key
   name — fail-safe over-redaction, not a leak. Left as-is: loosening the redactor risks
   under-redacting a real bank account number elsewhere.
5. Period server actions surface `PeriodError` to a generic page while swallowing
   `AuthorizationDenied` — a UX inconsistency, not a cross-tenant oracle (both foreign and
   nonexistent ids resolve to the same company-scoped `PERIOD_NOT_FOUND`).

## Verdict

Gate 2A passes. The accounting-configuration layer is sound: no stored balances, structural
tenant isolation proven in raw SQL, system accounts and periods protected, an append-only
audit trail that now covers every account mutation, and no exploitable authorization gap.
Sprint 3 may build the ledger engine on this foundation.
