# Gate 2 — General Ledger Acceptance · MANDATORY HUMAN REVIEW

> Sprint 3 — the ledger engine, **LL-030 … LL-036** — is complete and merged to `main`.
> This gate is a **human acceptance review** before any Sprint 4 feature (customers,
> invoices) is built on the foundation.
>
> Everything below is **prepared evidence**: the required suites were run, the acceptance
> scenario was executed and asserted, and two independent implementation‑blind reviews
> were performed. **The sign‑off in §8 is the human reviewer's to make** — Claude does not
> pass its own gate. Read §3, §4, and §7 closely.
>
> **Update — the one invariant‑level finding was remediated during this review.** Both
> reviews flagged that invariant 5 (no posting into a closed period) was enforced by
> application code only. That is now **structural**: **ADR‑012 / migration 0010** (merged)
> adds a period‑locking `BEFORE INSERT` trigger, so a raw‑SQL insert into a closed period
> is rejected by the database and the close‑vs‑post race is closed. §4, §6, and §7 reflect
> the fixed state.

**Key term.** *Structural* = enforced by the database, so it holds even when the
application is bypassed (raw SQL). *Conventional* = enforced only by application code.
The gate's "confirm each failure in raw SQL too" exists precisely to tell these apart.

---

## 1. Checklist

| # | Gate requirement | Status | Evidence |
|---|---|---|---|
| 1 | Ledger schema + every constraint/trigger read and understood | ✅ evidence assembled | Reading guide §2; enforcement matrix §6 |
| 2 | `LedgerService` (post, reverse, idempotency, immutability, audit, authz) read | ✅ | §2 reading guide; §5 reviews |
| 3 | Decimal config + every money boundary correct | ✅ | `src/lib/decimal.ts` (precision 34, ROUND_HALF_EVEN); money is `string` at every boundary; §5a |
| 4 | Transaction implementation / atomicity | ✅ | Pool client only on writes; GL‑T012 (failed tx → 0 rows); adv2 concurrency |
| 5 | `npm run ci` passes | ✅ (CI) | CI "Lint, types, unit tests, build" green on `main`; local src lint clean, typecheck clean, unit 175, build ok. (Local `eslint .` is polluted by a gitignored `.claude/worktrees/*/.next` from a concurrent task — CI's clean checkout is unaffected.) |
| 6 | Full integration suite passes | ✅ | 277/277 this session (23 files) + 2 acceptance = 279; CI "Integration" green on `main` |
| 7 | GL regression suite passes and is a required check | ✅ | GL‑T001…T015 (15/15); dedicated required check "GL regression suite (release gate)" on `main` |
| 8 | Tenant isolation suite passes | ✅ | `isolation` 5/5; completeness test fails CI for any unregistered `company_id` table |
| 9 | `/code-review high` across the Sprint 3 surface | ✅ | Implementation‑blind correctness review — §5a |
| 10 | `/security-review` across the Sprint 3 surface | ✅ | Implementation‑blind security review — **no exploitable finding** — §5b |
| 11 | Manual acceptance scenario derives correctly | ✅ with a criteria discrepancy | Executed as `gate2-acceptance.test.ts` — §3. **Finding G2‑1** below. |
| 12 | Every negative case fails (service **and** raw SQL) | ✅ (after ADR‑012) | §4 — closed‑period is now **structural** (0010 trigger); inactive‑account stays conventional **by design**, authorization is app‑layer **by nature** |
| 13 | No balance stored anywhere — verified from the schema | ✅ | `information_schema` scan finds no balance/total/cached column (test in `gate2-acceptance.test.ts`) |
| 14 | All ADRs decided | ✅ | ADR‑001 … **ADR‑012** in [DECISIONS.md](DECISIONS.md) |

Row 11 (the acceptance‑script number, Finding G2‑1) is a **doc‑only** note for the reviewer
— the engine is correct. Everything else is verified.

---

## 2. Read, personally — reading guide

The gate says to read these yourself. Exact locations:

- **Schema + constraints/triggers:** `src/db/schema/ledger.ts`; `drizzle/migrations/0006_journal_ledger.sql` — the sign `CHECK` (`journal_lines_sign`), composite FKs (`journal_lines_account_same_company_fk`, `journal_lines_entry_same_company_fk`), unique indexes (`journal_entries_idempotency_unique`, `journal_entries_source_posted_once`), the **deferred** balance constraint triggers (`assert_entry_balanced` → `journal_lines_balanced`/`journal_entries_balanced`), and the immutability triggers (`journal_entries_no_mutate_posted`, `journal_lines_no_mutate_posted`). Migrations `0007`/`0008`/`0009` add the posted/reversed audit actions and the idempotency fingerprint column.
- **Posting engine:** `src/server/ledger/index.ts` (`postJournalEntry`: authorization → structural/balance validation → resolve period **before** the tx → transaction {company/account checks, period re‑read, gapless `allocateEntryNumber`, insert POSTED, audit inside tx}; idempotency resolved on the unique violation).
- **Reversal:** `src/server/ledger/reversal.ts` (swaps debit/credit, links `reversal_of_id`/`reversed_by_id`, drives the one permitted POSTED→REVERSED transition; date per ADR‑007).
- **Idempotency:** `resolveIdempotentRetry` + `src/server/ledger/fingerprint.ts`.
- **Immutability (service):** `toLedgerDomainError` in `src/server/ledger/internal.ts`.
- **Money:** `src/lib/decimal.ts`, `src/validation/journal.ts`.
- **Period validation:** `src/server/periods/index.ts` (`getAccountingPeriod`, `assertPeriodOpen`).
- **Tenant validation:** composite FKs above; `tests/integration/isolation.test.ts`.
- **Trial balance & integrity assertions:** `src/server/reports/trial-balance.ts`, `src/server/ledger/invariants.ts`.
- **Authorization:** `src/server/authorization/index.ts`, `src/server/rbac/capabilities.ts`.
- **UI (LL‑035):** `src/app/journal/new/*`, `src/app/journal/[id]/page.tsx`, `src/app/journal/actions.ts`, `src/server/ledger/queries.ts`.

---

## 2b. Run — results

| Command | Result |
|---|---|
| `npm run ci` | ✅ (CI verify check green on `main`; see checklist #5 for the local‑worktree caveat) |
| `npm run test:integration` | ✅ all green — LL‑036 baseline 277 + 2 acceptance + 5 closed‑period‑guard; CI "Integration" green on `main` and on this PR |
| `npm run test:gl` (release gate) | ✅ 15/15 |
| `isolation` suite | ✅ 5/5 |
| adversarial battery (`adv1…adv5`) | ✅ 32/32 — **no invariant violation found** (LL‑036) |
| `closed-period-guard` suite | ✅ 5/5 — raw‑SQL insert into a closed period rejected by the DB (ADR‑012) |

---

## 3. Manual acceptance scenario — executed

Reproduced exactly as `tests/integration/gate2-acceptance.test.ts` (system‑only chart +
the four named accounts). Balances are the natural‑direction balances the trial balance
derives from journal lines alone.

| Account | After entries 1–3 | After reversing entry 2 |
|---|---|---|
| Checking (ASSET) | **7,500.00** | **8,000.00** |
| Office Supplies (EXPENSE) | 500.00 | **0.00** |
| Savings (ASSET) | 2,000.00 | 2,000.00 |
| Owner Contributions (EQUITY) | 10,000.00 | 10,000.00 |
| Trial balance (gross Dr = Cr) | 12,500.00 = 12,500.00 ✅ | 13,000.00 = 13,000.00 ✅ |

Also confirmed by the test: the reversal nets entry 2 to **exactly zero** on every account
(`assertReversalNetsToZero`); entry 2 remains **visible and unmodified**, marked
`REVERSED`, with its original lines intact; and **no balance is stored anywhere** —
`information_schema` shows no balance/total/cached column on any table.

### Finding G2‑1 — the acceptance script's "Checking 7,500" is the pre‑reversal value
The script (prompt pack) lists, in one breath, "Checking is 7,500.00" **and** "Office
Supplies 0.00 after reversal." Those are two different instants. $7,500 is Checking after
entries 1–3; the reversal of entry 2 (Office Supplies Dr / Checking Cr) must, by double
entry, **credit Checking back**, so once Office Supplies returns to 0, Checking is
**8,000.00**. **The engine is correct** (8,000); the script conflated the pre‑ and
post‑reversal states. *Recommendation: correct the acceptance script to read "Checking
7,500 after entries 1–3; 8,000 after the reversal."*

---

## 4. Negative cases — structural vs conventional

Each case was confirmed to fail **through the service**, and its **raw‑SQL** behaviour
determines whether the guarantee is structural or conventional.

| Negative case | Through the service | Raw SQL (service bypassed) | Enforcement |
|---|---|---|---|
| Unbalanced entry | `UNBALANCED_JOURNAL_ENTRY` (GL‑T002) | **Rejected** at COMMIT — deferred balance trigger (`ledger-schema` "rejects an unbalanced POSTED entry at commit") | **Structural** |
| Mutation of a posted entry | `POSTED_ENTRY_IMMUTABLE` (GL‑T007) | **Rejected** — immutability triggers (`ledger-schema` inv‑7; GL‑T007 raw UPDATE; `adv`) | **Structural** |
| Cross‑company account line | `ACCOUNT_NOT_FOUND` (GL‑T003) | **Rejected** — composite FK (`ledger-schema` inv‑2) | **Structural** |
| Duplicate idempotency key | same entry / `IDEMPOTENCY_KEY_CONFLICT` (GL‑T005) | **Rejected** — partial unique index (`ledger-schema` inv‑3&4) | **Structural** |
| Two simultaneous identical postings | exactly one entry (GL‑T014, adv2‑C1) | **Rejected** second — unique index + counter lock | **Structural** |
| Zero / single‑line posting | rejected (GL‑T008 / Zod) | **Rejected** at COMMIT — `assert_entry_balanced` ≥2‑line check | **Structural** |
| **Posting into a CLOSED period** | `PERIOD_CLOSED` (GL‑T004) | **Rejected** — the period‑locking `BEFORE INSERT` trigger (ADR‑012, migration 0010; `closed-period-guard` test posts a raw entry into a closed period with the service bypassed) | **Structural** (was app‑only; remediated) |
| **Posting to an inactive account** | `INACTIVE_ACCOUNT` (GL‑T009) | **SUCCEEDS** — no account‑status constraint (deliberate: reversal must work against a since‑deactivated account) | **Conventional (by design)** |
| Posting without `journal.post` | `AuthorizationDenied` (`ledger-service` READ_ONLY test) | N/A — capabilities are application‑layer by nature; the DB enforces **tenancy** (composite FK), not app‑user permissions | **Conventional (by nature)** |

The journal tables carry the sign check, composite FKs, idempotency/source unique indexes,
the deferred balance triggers, and the immutability triggers (`0006_journal_ledger.sql`),
**plus the period‑status guard trigger** (`0010_closed_period_guard.sql`, ADR‑012). No
trigger references **account** status — that is deliberate (reversal must post against a
since‑deactivated account), so inactive‑account rejection stays application‑layer by design.

---

## 5. Independent implementation‑blind reviews

### 5a. Correctness / accounting review — engine is strong; one invariant‑level decision
An implementation‑blind agent read every Sprint 3 file plus boundary code and ran targeted
greps (money‑as‑number, non‑Decimal comparison, http‑client‑on‑write, direct journal
inserts). **Bottom line: no defect that corrupts balance, atomicity, immutability, tenancy,
idempotency, or gapless numbering** — all six are enforced in depth (app + DB triggers/
constraints + the continuous integrity audit in test teardown) and backed by adversarial
tests it verified encode the correct behaviour. Money is string‑at‑boundary /
Decimal‑in‑computation throughout — no `number`, `===`, epsilon, `parseFloat`, or
http‑client on any write path.

It confirmed correctness of: the deferred balance triggers on **both** journal tables;
multi‑line reversal net‑zero (incl. reverse‑of‑reversal chains, leap‑day, deactivated
account, 5‑deep); gapless numbering under 20‑way concurrency; idempotency
resolve‑on‑unique‑violation; the trial balance's `('POSTED','REVERSED')` population and
exhaustive natural‑direction signs over the six `account_type` values; composite‑FK
tenancy; and driver policy (HTTP client only on reads).

The **one invariant‑level item** it raised was **invariant 5 (closed periods)** — no DB
enforcement and a real (if serializably‑correct) TOCTOU window, unscoped by any ADR and
contradicting AGENTS §4's "enforced in the database" claim. **This was remediated during the
review** (ADR‑012 / migration 0010): a period‑locking `BEFORE INSERT` trigger now makes it
structural and closes the race. Its remaining findings map to §7 items 6 (fingerprint
trigger), 5 (sum‑overflow), and items 8–9; all lower severity, none exploitable, none
corrupting.

### 5b. Security review — **no exploitable vulnerability found**
An implementation‑blind agent traced the Sprint 3 journal surface end‑to‑end and confirmed
the AGENTS §6/§9 contract is enforced **in code**, not merely in tests:

- Authorization fails **closed** — `postJournalEntry`/`reverseJournalEntry`/`getJournalEntry` call `requirePermission` first; a missing membership or a DB error in that check is a denial, not a retryable error.
- The active company is derived from **server session context** (`getActiveCompanyMembership`), never from a form field or query param; a forged company cookie revalidates and yields `null` (never a fallback to another tenant).
- **No existence leak** — a cross‑company entry id resolves to `null`/`ENTRY_NOT_FOUND` identically to a genuine miss; the denial shape is uniform.
- A **tampered account line** cannot reach another tenant — the service re‑validates every account is in the caller's company (`ACCOUNT_NOT_FOUND`), so the client‑side picker scoping is correctly only advisory.
- All `sql\`\`` is **parameterized**; secrets/PII pass through a mandatory `redact()` boundary; `DATABASE_URL` never reaches a log or client error.
- The capability model is a typed total record; a lint fence keeps role‑name comparisons out of business logic.

Two **low‑severity, non‑exploitable** hardening notes (see §7): the `only()` helper's
`sql.raw(column)` (test‑only, hardcoded inputs) and a stray non‑ASCII character in an
auth error message.

---

## 6. Invariant enforcement matrix (AGENTS §4)

| # | Invariant | Enforced by | Evidence |
|---|---|---|---|
| 1 | Debits = credits, exact at NUMERIC(19,4) | **DB** (deferred trigger) + app | GL‑T001/002/011; `ledger-schema` |
| 2 | Balances derived, none stored | **DB** (no balance column) + app | §3 schema scan; trial balance derives from lines |
| 3 | Posted entries immutable | **DB** (triggers) + app (`POSTED_ENTRY_IMMUTABLE`) | GL‑T007; `ledger-schema` inv‑7 |
| 4 | No cross‑company line | **DB** (composite FKs) + app | GL‑T003; `ledger-schema` inv‑2; isolation suite |
| 5 | No posting into a CLOSED period | **DB** (period‑locking trigger, ADR‑012) + app | GL‑T004; `closed-period-guard` (raw‑SQL rejected) |
| 6 | Source posts once; retries idempotent | **DB** (unique indexes) + app | GL‑T005/T014; adv2 |
| 7 | Posting is atomic | **DB** (tx + deferred trigger at COMMIT) | GL‑T012; adv |
| 8 | `LedgerService` is the only posting path | **App / convention** (inherently) | AGENTS §4.8; no feature module inserts into journal tables |

Invariant 8 is, by its nature, not expressible as a single DB constraint. Invariant 5 was
made structural during this review (ADR‑012 / migration 0010).

---

## 7. Items surfaced (items 2 & 4 were fixed during the review)

1. **Finding G2‑1 (acceptance script number).** Post‑reversal Checking is **8,000**, not
   7,500. Engine correct; script wording should be fixed. *(Doc‑only.)*
2. **✅ RESOLVED — closed‑period is now structural.** Was app‑only; **ADR‑012 / migration
   0010** (merged) added a period‑locking `BEFORE INSERT` trigger, so a raw‑SQL insert into a
   `CLOSED` period is now rejected by the database (`closed-period-guard` test proves it with
   the service bypassed).
3. **Inactive‑account is conventional (by design).** No DB block on posting to an inactive
   account, because **reversal must work against a since‑deactivated account** (ADR‑007 /
   LL‑033). This is deliberate; noted so the reviewer accepts it explicitly.
4. **✅ RESOLVED — the close‑vs‑post TOCTOU is closed.** The same ADR‑012 trigger reads the
   period `FOR SHARE`, so `closePeriod` waits for in‑flight posts and no post can commit into
   an already‑closed period. (The prior follow‑up task was dismissed as superseded.)
5. **Sum‑overflow robustness.** A balanced entry whose per‑side SUM exceeds NUMERIC(19,4)
   is rejected at COMMIT with an opaque (non‑typed) error but leaves **no partial state**.
   A typed magnitude guard would be nicer. *(Low priority.)*
6. **Trigger defense‑in‑depth.** The balance/immutability triggers guard `status='POSTED'`
   only, and the immutability trigger's frozen‑column list predates `idempotency_fingerprint`
   (0008). Both are **unreachable through the application**; follow‑up task filed to widen
   them to `('POSTED','REVERSED')` and include the column.
7. **Security hardening (non‑exploitable):** replace `only()`'s `sql.raw(column)` with a
   closed set of fragments; fix the stray non‑ASCII character in the `BETTER_AUTH_SECRET`
   error text.
8. **`isIdempotencyViolation` robustness** (`src/server/ledger/index.ts`). It matches a
   generic `duplicate key` and inspects only one `cause` level, whereas `toLedgerDomainError`
   walks the full chain. Two consequences: (a) a same‑source/different‑key collision surfaces
   as `IDEMPOTENCY_KEY_CONFLICT` rather than a dedicated `SOURCE_ALREADY_POSTED` — by design
   and tested (adv2‑C2), never a double‑post, but the code reads misleadingly; (b) if the
   driver ever nests the constraint text deeper, a *legitimate* idempotent retry could
   surface a raw error instead of resolving. Holds against real Neon today. *Recommend:
   match the specific index name and walk the full cause chain.* Low severity.
9. **Manual journal entries have no idempotency key** (`src/app/journal/actions.ts`). A
   double‑submit posts two distinct **balanced** entries (two entry numbers). Not an
   invariant violation — "one source posts once" applies only to source‑backed postings —
   but a duplicate‑entry UX exposure guarded today only by redirect‑after‑post. *Consider a
   submit‑once guard or a per‑form idempotency key when invoices arrive.* Low severity.
10. **Informational (no action required):** the ESLint driver fence bans the raw
    `neon-http` import in the ledger module but not `getDb()` re‑exported from `@/db`
    (runtime throw is the backstop for any future ledger *write* via the HTTP client); and
    `sourceType='REVERSAL'` is postable directly as an ordinary balanced entry — harmless,
    but future reporting must key reversal linkage off `reversal_of_id`, never `source_type`.

---

## 8. Human sign‑off

The reviewer confirms, by reading the code and this evidence:

- [ ] I have read the schema, every constraint/trigger (including the 0010 period guard),
      and `LedgerService` in full (§2).
- [ ] The manual acceptance scenario derives correctly (§3), and I accept Finding G2‑1
      (the acceptance‑script number, doc‑only).
- [ ] I accept the structural‑vs‑conventional split in §4: closed‑period is now **structural**
      (ADR‑012); I accept that inactive‑account is app‑layer **by design** and authorization
      is app‑layer **by nature**.
- [ ] The independent correctness (§5a) and security (§5b) reviews raise nothing blocking.
- [ ] The remaining §7 items (5–10, all low‑severity/informational) are each accepted or
      ticketed.
- [ ] **Gate 2 is passed. Sprint 4 (Customers & Invoices) may begin.**

_Prepared by Claude Code. Sign‑off is the human reviewer's._
