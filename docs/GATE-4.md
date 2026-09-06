# Gate 4 — Sprint 5 (A/R adjustments, hardening & reporting) Acceptance · MANDATORY HUMAN REVIEW

> Sprint 5 — **LL-050 … LL-055** — is complete and merged to `main`. It finishes the A/R
> adjustment surface on the Sprint 4 ledger: bad-debt **write-offs** (LL-050), customer
> **credit memos** (LL-051), **ledger hardening** (LL-052), a distinct **void capability +
> locking** split (LL-053), the customer **statement** (LL-054), and the read-only
> **reporting UI** (LL-055). It also **closes the last Gate 3 gap**: the A/R control account is
> now STRUCTURALLY locked against manual journal entry (LL-050 PR2).
>
> This gate is a **human acceptance review** before Sprint 6. Everything below is prepared
> evidence: the suites were run, a full Sprint 5 lifecycle scenario was executed and asserted,
> and two independent implementation-blind reviews (correctness + security) were performed.
> **The sign-off in §8 is the human reviewer's** — Claude does not pass its own gate.
>
> **Headline for the reviewer.** Sprint 5's adjustment surface posts every document through
> `LedgerService` (never a direct journal insert), corrects only by **reversal**, and keeps the
> **A/R subsidiary reconciled to the general-ledger control** across all three reduction sources
> — payments, write-offs, and credit memos — plus per-customer (GL-T018…T022). The correctness
> review found **one HIGH reconciliation defect** — `voidInvoice` guarded live payments but not
> live write-offs/credit memos, so voiding an invoice with a *partial* adjustment drove the
> customer's A/R negative and broke the aging⇔control tie. **It was remediated during this
> review** (a symmetric `INVOICE_HAS_ADJUSTMENTS` guard + release-gate regression GL-T022). The
> security review found **no exploitable vulnerability**. The remaining items are LOW and each
> accepted, fixed, or ticketed (§7).

**Key term.** *Structural* = enforced by the database (holds even under raw SQL). *Conventional*
= enforced only by application code. The "confirm it in raw SQL too" column exists to tell these
apart.

---

## 1. Checklist

| # | Gate requirement | Status | Evidence |
|---|---|---|---|
| 1 | Sprint 5 schema + every constraint/FK/trigger read and understood | ✅ | Reading guide §2; migrations 0017–0020; enforcement matrix §6 |
| 2 | Every document (write-off, credit memo) posts through `LedgerService`, never a direct journal insert | ✅ | `writeOffInvoice`/`issueCreditMemo` → `postEntryCore`; `void*` → `reverseEntryCore`; §5a |
| 3 | Money is `string`/`Decimal`, never `number`, across the Sprint 5 surface (incl. the UI) | ✅ | Zod rejects numeric money; decimal.js in derivations; **money-safety unit test** over `src/app/reports`; §5a/§5b |
| 4 | Write-off / credit memo post the right entry and reduce open balance via the SHARED derivation | ✅ | Dr Bad Debt / Cr A/R and Dr Sales Returns / Cr A/R, customer-tagged; `open-balance.ts` reused by aging + guards; §3; GL-T019/T020 |
| 5 | **A/R control account is locked against manual JE** (closes Gate 3 item 2) | ✅ **structural** | Trigger `journal_lines_no_manual_ar_post` (migration 0018); `control-account-guard.test.ts` (raw-SQL) |
| 6 | REVERSED entries (and their lines) are immutable; entry totals bounded | ✅ **structural** | Trigger bodies in 0020; `ledger-hardening.test.ts` (raw UPDATE/DELETE rejected; ceiling) |
| 7 | Void is a **reversal** and requires a distinct `*.void` capability (LEDGER_WRITERS) | ✅ | `void*` → `reverseEntryCore`; `capabilities.ts` grants `*.void` to OWNER/ADMIN/ACCOUNTANT only; `void-authorization.test.ts` |
| 8 | **Subsidiary ⇔ control reconciliation holds across payments, write-offs, credit memos, and per customer** | ✅ | §3 three-way tie; **GL-T018/T019/T020/T021**; the void-invoice gap is closed by **GL-T022** (§7 item 1) |
| 9 | No A/R / customer balance is stored anywhere | ✅ | invariant 2; `open-balance.ts` derives every time; statement derives from journal lines |
| 10 | Reporting UI authorizes server-side, company-from-session, no existence leak, money display-only | ✅ | §5b; `report-context.ts` + per-service `report.view`; statement cross-company → null |
| 11 | Tenant isolation holds for write-offs and credit memos | ✅ | Composite FKs; `isolation` descriptors; §5b |
| 12 | `npm run ci` passes (lint, types, unit, build) | ✅ | typecheck clean · lint clean · unit **177** · build ok (§2b) |
| 13 | Full integration + GL regression pass; GL regression is a required check | ✅ | §2b; CI green on the LL-054/LL-055 merges; GL-T001…**T022** |
| 14 | Manual Sprint 5 acceptance scenario derives correctly | ✅ | `gate4-acceptance.test.ts` — §3 |
| 15 | Independent correctness & security reviews | ✅ | §5a (correctness — **1 HIGH found & fixed**), §5b (security — **no exploitable finding**) |
| 16 | All Sprint 5 ADRs decided | ✅ | **ADR-017 … ADR-022** in [DECISIONS.md](DECISIONS.md) |

---

## 2. Read, personally — reading guide

- **Schema + triggers.** `src/db/schema/{writeoffs,credit-memos}.ts` (composite FKs, positivity,
  status). Migrations: `0017_writeoffs.sql`, `0019_credit_memos.sql` (tables/FKs/indexes);
  **`0018_control_account_guard.sql`** (the `BEFORE INSERT` trigger `assert_no_manual_post_to_ar`
  that blocks a `JOURNAL_ENTRY`-source line into the A/R control account); **`0020_freeze_reversed_entries.sql`**
  (`journal_entries_immutable` / `journal_lines_immutable` widened to freeze REVERSED entries).
- **Write-off service.** `src/server/writeoffs/index.ts` — `writeOffInvoice` (authorize
  `writeoff.create` → resolve period → lock invoice `FOR UPDATE` → open balance via
  `invoiceReductionsTotal` → Dr Bad Debt Expense / Cr A/R customer-tagged via `postEntryCore`
  sourceType `BAD_DEBT_WRITEOFF` → mark PAID if cleared), `voidWriteoff` (`writeoff.void`;
  explicit `FOR UPDATE`; revert PAID→OPEN).
- **Credit-memo service.** `src/server/credit-memos/index.ts` — mirror of write-offs (Dr Sales
  Returns / Cr A/R; `CREDIT_MEMO`; `credit_memo.create` / `credit_memo.void`).
- **Shared open-balance.** `src/server/reports/open-balance.ts` — `invoiceReductionsExpr` /
  `invoiceReductionsTotal`: open balance = `total − Σ(non-void payments + write-offs + credit
  memos)`, correlated subqueries (no fan-out), the single source of truth.
- **Customer statement.** `src/server/reports/customer-statement.ts` — opening / activity (running
  balance) / closing from the customer-tagged A/R lines; closing = that customer's control slice.
- **Ledger hardening + void.** `src/server/ledger/{index,reversal,internal,errors}.ts` —
  `ENTRY_AMOUNT_OUT_OF_RANGE` bound; `reverseEntryCore` preserves the customer tag; the four void
  paths (`voidInvoice`/`voidPayment`/`voidWriteoff`/`voidCreditMemo`) and their explicit locks.
- **RBAC.** `src/server/rbac/capabilities.ts` — `invoice.void`/`payment.void`/`writeoff.void`/
  `credit_memo.void` = LEDGER_WRITERS.
- **Reporting UI.** `src/app/reports/*` — `report-context.ts` (auth + company-from-session +
  timezone), the three screens, `as-of-form.tsx`; `tests/unit/reports-money-safety.test.ts`.
- **Decisions.** [DECISIONS.md](DECISIONS.md) ADR-017 (write-off), ADR-018 (control-account lock),
  ADR-019 (credit memos), ADR-020 (REVERSED immutability + bounded totals), ADR-021 (void
  capabilities + locking), ADR-022 (customer statement), and the ADR-016 update (void-adjustment
  guard, item 1).

---

## 2b. Run — results

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run test:unit` | ✅ **177/177** (incl. `reports-money-safety`) |
| `npm run build` | ✅ ok |
| `gate4-acceptance` (this gate's scenario) | ✅ 2/2 (§3) |
| GL regression incl. **GL-T022** (the void-adjustment fix) | ✅ (§7 item 1) |
| Structural guards (raw SQL) | ✅ `control-account-guard.test.ts` (0018), `ledger-hardening.test.ts` (0020) |
| Full `npm run test:integration` (post-fix) | ✅ **416/416** (38 files) — incl. `gate4-acceptance` + **GL-T022** |

CI was green across every gating job on the LL-054 (`#44`) and LL-055 (`#45`) merges to `main`
(Lint/types/unit/build, Integration, GL regression, E2E). The **only** red workflow on `main` is
**"Production deploy"**, which is a **pre-existing** infra gap (§7 item 5), not a Sprint 5 regression.

---

## 3. Manual acceptance scenario — executed

`tests/integration/gate4-acceptance.test.ts`, on a synthetic `standard`-chart company. Two
customers (Acme, Beta). At **every** stage the test asserts the three-way tie — the derived GL
**A/R control** (trial balance), the **aging subsidiary** total, and **Σ of every customer's
statement closing** — are equal, the trial balance **balances**, and `assertLedgerIntegrity`
passes.

| Stage | A/R control == aging == Σ statements |
|---|---|
| Acme inv#1 $1,000 + inv#2 $500; Beta inv#3 $300 | **1,800.00** ✅ |
| Acme pays $400 on inv#1 | **1,400.00** ✅ |
| Write off remaining $600 of inv#1 → inv#1 **PAID** (GL-T019) | **800.00** ✅ |
| Credit memo $200 on inv#2 (GL-T020) | **600.00** ✅ |
| **Void** the credit memo (reversal; customer tag preserved) | **800.00** ✅ |

A second case proves the **per-customer decomposition** (GL-T021): Acme (1,000 − 250 paid − 150
written off = **600**) + Beta (**300**) = **900**, equal to the control.

---

## 4. Negative cases — structural vs conventional

| Negative case | Through the service | Raw SQL (service bypassed) | Enforcement |
|---|---|---|---|
| **Manual JE to the A/R control account** | `CONTROL_ACCOUNT_MANUAL_POST` | **Rejected** — trigger `journal_lines_no_manual_ar_post` (0018) | **Structural (NEW — closes Gate 3 item 2)** |
| Manual JE to another system account (Sales Tax Payable) | posts | posts | Allowed by design (0018 scopes to A/R only) |
| **Raw UPDATE/DELETE of a REVERSED entry or its lines** | n/a | **Rejected** — `POSTED_ENTRY_IMMUTABLE` (0020) | **Structural (NEW)** |
| Entry per-side total exceeds NUMERIC(19,4) | `ENTRY_AMOUNT_OUT_OF_RANGE` (pre-check) | **Rejected** at write (numeric range) | app + **structural** |
| Cross-company write-off/credit/account reference | `*_NOT_FOUND` (company-scoped) | **Rejected** — composite FKs | **Structural** |
| Write-off / credit beyond open balance | `WRITEOFF_EXCEEDS_BALANCE` / `CREDIT_MEMO_EXCEEDS_BALANCE` (decimal.js vs derived open) | **SUCCEEDS** — open balance is derived, not a stored ceiling | **Conventional** |
| Void without the `*.void` capability (e.g. BOOKKEEPER) | `AuthorizationDenied` | n/a (app authz) | **Conventional (capability)** |
| **Void an invoice with live write-offs / credit memos** | **Rejected** — `INVOICE_HAS_ADJUSTMENTS` (§7 item 1 fix) | **SUCCEEDS** — the guard is an app-layer query | **Conventional (remediated)** |

---

## 5. Independent implementation-blind reviews

### 5a. Correctness / accounting — engine sound; one HIGH reconciliation gap, remediated

An implementation-blind agent read the full Sprint 5 surface (write-offs, credit memos,
`open-balance.ts`, the statement, ledger hardening/reversal, all four void paths, RBAC, migrations
0017–0020) and the reconciliation context. **Bottom line: no defect corrupts
money/balance/atomicity/immutability/tenancy/idempotency on normal flows** — the double-entry math,
reversals, the shared open-balance derivation, the two new adjustment types, the customer
statement, and the 0018/0020 triggers are correct. Verified specifically: the 0020 immutability
permits only the single POSTED→REVERSED transition and freezes lines for `status IN
('POSTED','REVERSED')`; `ENTRY_AMOUNT_OUT_OF_RANGE` is exact at the NUMERIC(19,4) ceiling (accepts
max, rejects only strictly larger); `open-balance.ts` uses correlated subqueries (no fan-out) with
all three sources filtered `<> 'VOID'`; the over-application guards re-derive under `FOR UPDATE`;
the statement's opening (`< from`) + activity (`between`) is exactly `<= to`, so closing = the
customer's control slice.

The **one HIGH defect**: **`voidInvoice` guarded live payments but not live write-offs / credit
memos** (§7 item 1). Voiding an invoice carrying a *partial* adjustment (which leaves it OPEN)
reversed the invoice's **full** A/R while the adjustment's Cr A/R remained → the customer's A/R went
negative and the VOID invoice left the aging, silently breaking the aging⇔control tie, with
`assertLedgerIntegrity` still passing (the ledger balances). **Remediated during this review** — see
§7 item 1.

### 5b. Security — no exploitable vulnerability found

An implementation-blind agent traced every reachable Sprint 5 operation against AGENTS §6/§9 and
confirmed enforcement **in code**:

- **Reporting UI:** every page calls `requireReportContext()` (redirect to `/sign-in` when
  unauthenticated) **and** each service independently calls `requirePermission('report.view')`;
  `runtime='nodejs'` + `dynamic='force-dynamic'` so checks run per request. `companyId` comes only
  from the session context, never `searchParams`/body. A cross-company/unknown `customerId` on the
  statement returns `null` → the same "not found" shape. `asOf`/`from`/`to` are `isCalendarDate`-
  validated server-side and only filter dates; money is rendered from the service's `string` with
  **no** `Number()`/`parseFloat()`/`parseInt()`/unary-plus coercion (the money-safety test enforces
  this; it was hardened during the gate — §7 item 4).
- **Write-off / credit-memo services:** authorize-before-write with the correct capability; every
  lookup is composite-scoped `and(eq(companyId), eq(id))` with composite FKs as the structural
  backstop; `customerId`/`arAccountId` are server-derived, not client-supplied; not-found parity
  holds; parameterized SQL only.
- **Void capability split (LL-053):** `*.void` = LEDGER_WRITERS (BOOKKEEPER excluded); no void path
  checks an old create/post capability.
- **Secrets/PII:** no `console.*`, no `error.message`/stack returned; audit `before`/`after` route
  through `redact()`.

Two LOW/non-exploitable items (§7 items 3, 4) — a stale doc comment and a non-exhaustive money-safety
regex — both **fixed during the gate**.

---

## 6. Invariant enforcement matrix (AGENTS §4) — the Sprint 5 surface

| # | Invariant | Enforced by (in Sprint 5) | Evidence |
|---|---|---|---|
| 1 | Debits = credits, exact at NUMERIC(19,4) | **DB** (ledger deferred trigger) + app (balanced by construction; bounded totals) | §3; GL-T019/T020 |
| 2 | Balances derived, none stored | app (`open-balance.ts`, statement derive every time) | §3; §5a |
| 3 | Posted entries immutable; **REVERSED now immutable too**; correct by reversal | **DB** (0006/0011 + **0020**) + app (`void*` → `reverseEntryCore`) | §4; `ledger-hardening.test.ts` |
| 4 | No cross-company line / reference | **DB** (composite FKs on write-offs, credit memos, customer tag) | §4; §5b |
| 5 | No posting into a closed period | **DB** (ADR-012 trigger) + app (resolve/check before the tx) | write-off/credit resolve period pre-tx |
| 6 | Source posts once; retries idempotent | **DB** (`journal_entries_source_posted_once`) + app (`FOR UPDATE` + status) | §4 |
| 7 | Posting atomic | **DB** (Pool tx + deferred trigger at COMMIT); Sprint 5 writes use `getDbTx()` only | §5a |
| 8 | `LedgerService` only posting path | app — write-offs/credit-memos post only via `postEntryCore`/`reverseEntryCore` | §5a |
| — | **A/R subsidiary ⇔ control** (+ per customer) | **DB** (0018 locks A/R to documents) + release gate | **GL-T018…T022** |

---

## 7. Items surfaced

1. **✅ RESOLVED (was HIGH) — `voidInvoice` stranded live write-offs / credit memos, breaking the
   aging⇔control tie.** It guarded only `INVOICE_HAS_PAYMENTS`. Sprint 5 added write-offs (LL-050)
   and credit memos (LL-051) as A/R reduction sources but did not extend the guard. A *partial*
   write-off/credit leaves the invoice OPEN; `voidInvoice` then reversed the invoice's **full** A/R
   while the reduction's Cr A/R remained — driving the customer's A/R **negative** and dropping the
   VOID invoice from the aging, so **aging (0) ≠ control (−30)** in the review's worked example,
   with `assertLedgerIntegrity` and the whole GL suite still passing (the case was untested).
   Found by the correctness review, **confirmed in code**, rated HIGH (it defeats the release-gate
   invariant Gate 4 exists to protect). **Fixed during this review:** `voidInvoice` now refuses when
   non-void write-offs or credit memos reference the invoice (`INVOICE_HAS_ADJUSTMENTS`), symmetric
   with the payments guard — void the adjustments first. Payments, write-offs, and credit memos are
   the only movers of an invoice's open balance (`open-balance.ts`), so the guard is complete.
   Release-gate regression **GL-T022** proves the void is refused (both arms), reconciliation stays
   intact, and after voiding the adjustment the invoice voids cleanly to zero. ADR-016 updated.
2. **✅ ACCEPTED (LOW) — the 0018 A/R guard is a denylist, not an allowlist.** It blocks an A/R line
   only when the parent's `source_type = 'JOURNAL_ENTRY'`. For the application this is airtight —
   the manual path hardcodes `'JOURNAL_ENTRY'` server-side and the other enum sources are the
   legitimate A/R movers, so there is no over-blocking and no app-reachable bypass. A raw INSERT
   using a non-`JOURNAL_ENTRY` source with an A/R line could bypass it — defense-in-depth only, not
   reachable in any normal flow. **Ratified as-is** by the product owner; an allowlist can be
   adopted later if raw-SQL threat models change.
3. **✅ FIXED (LOW) — stale doc comment.** `src/server/invoices/index.ts` said `voidInvoice` was
   "Authorized at `invoice.post`"; the code correctly uses `invoice.void` (LL-053). Comment corrected
   (AGENTS §0 — code/doc consistency).
4. **✅ FIXED (LOW) — money-safety test hardened.** `tests/unit/reports-money-safety.test.ts` now
   also forbids unary-plus (`+total`) and multiply-by-one (`total * 1`) coercions, not just
   `Number(`/`parseFloat(`/`parseInt(`. No coercion shipped; this closes the defense-in-depth gap.
5. **✅ TICKETED (LOW / infra, pre-existing) — production deploy fails on "Require credentials".**
   The "Production deploy" workflow is red on **every** commit back through Sprint 4 — production
   deploy secrets are not configured, so the job fails fast by design. Not a Sprint 5 regression and
   out of scope for a code gate. Filed as **[LL-056](tickets/LL-056.md)** to configure the deploy
   credentials (in GitHub secrets, never source) or make the workflow an intentional, documented
   skip before go-live.

---

## 8. Human sign-off

The reviewer confirms, by reading the code and this evidence:

- [ ] I have read the Sprint 5 schema, the write-off/credit-memo services, the 0018 and 0020
      triggers, the shared `open-balance.ts`, the customer statement, and the reporting UI (§2).
- [ ] The manual acceptance scenario derives correctly and the three-way tie (control ⇔ aging ⇔ Σ
      statements) holds at every stage (§3).
- [ ] I accept the structural-vs-conventional split in §4 — and that the **manual-JE-to-A/R gap
      from Gate 3 is now STRUCTURAL** (0018), and REVERSED entries are structurally immutable (0020).
- [ ] I accept the **§7 item 1 remediation** (`voidInvoice` refuses live adjustments;
      `INVOICE_HAS_ADJUSTMENTS`; GL-T022). §7 item 2 is ratified as-is; items 3–4 are fixed; item 5
      is ticketed as [LL-056](tickets/LL-056.md).
- [ ] The independent correctness (§5a) and security (§5b) reviews raise nothing blocking that
      remains open.
- [ ] **Gate 4 is passed. Sprint 6 may begin.**

_Prepared by Claude Code. Sign-off is the human reviewer's._
