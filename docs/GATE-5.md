# Gate 5 — Sprint 6 (Accounts Payable) Acceptance · MANDATORY HUMAN REVIEW

> Sprint 6 — **LL-060 … LL-065** — is complete and merged to `main`. It builds the full Accounts
> Payable side as the structural mirror of A/R: **vendors** (LL-060), **bills + posting** (LL-061),
> **bill payments + the A/P control-account lock** (LL-062), **vendor credits** (LL-063), the **A/P
> aging + vendor statement** (LL-064), and the **A/P reporting UI** (LL-065).
>
> This gate is a **human acceptance review** before Sprint 7. Everything below is prepared evidence:
> the suites were run, a full Sprint 6 lifecycle scenario was executed and asserted, and two
> independent implementation-blind reviews (correctness + security) were performed. **The sign-off in
> §8 is the human reviewer's** — Claude does not pass its own gate.
>
> **Headline for the reviewer.** Sprint 6's A/P surface posts every document (bill, bill payment,
> vendor credit) through `LedgerService` (never a direct journal insert), corrects only by
> **reversal**, and keeps the **A/P subsidiary reconciled to the general-ledger control** across both
> reduction sources — payments and vendor credits — plus per-vendor (GL-T023…T026). The correctness
> review found **no defect that corrupts money, balance, atomicity, immutability, tenancy, or
> idempotency inside the A/P document paths**; the security review found **no exploitable
> vulnerability**. Findings sit at the *edges* of the "moves only through documents" claim: three
> MEDIUM items (a service-layer control-lock bypass inherited from A/R, missing money-out
> idempotency, and a test-coverage gap) and several LOW items — each **fixed, accepted, or ticketed**
> in §7 per the product owner's triage.

**Key term.** *Structural* = enforced by the database (holds even under raw SQL). *Conventional* =
enforced only by application code. The "confirm it in raw SQL too" column tells these apart.

---

## 1. Checklist

| # | Gate requirement | Status | Evidence |
|---|---|---|---|
| 1 | Sprint 6 schema + every constraint/FK/trigger read and understood | ✅ | §2; migrations 0021–0024; enforcement matrix §6 |
| 2 | Every A/P document (bill, bill payment, vendor credit) posts through `LedgerService`, never a direct journal insert | ✅ | `finalizeBill`/`payBill`/`issueVendorCredit` → `postEntryCore`; `void*` → `reverseEntryCore`; §5a |
| 3 | Money is `string`/`Decimal`, never `number`, across the A/P surface (incl. the UI) | ✅ | Zod rejects numeric money; decimal.js in derivations; **money-safety unit test** over `src/app/{reports,bills,bill-payments}`; §5 |
| 4 | Bill / payment / vendor credit post the right entry and derive open balance via the SHARED derivation | ✅ | Cr A/P (bill), Dr A/P / Cr cash (payment), Dr A/P / Cr expense (credit), all vendor-tagged; `bill-open-balance.ts` reused by aging + guards; §3; GL-T023/T024/T025 |
| 5 | **A/P control account is locked against manual JE** (generalizes the LL-050 0018 guard to A/P) | ✅ **structural** (labelled path) | Trigger `journal_lines_no_manual_control_post` (0023); `control-account-guard.test.ts` (raw-SQL, A/P + A/R). Scope caveat + service-layer gap → §7 item 1 (ticketed **LL-066**) |
| 6 | Void guards complete — a bill with a live reduction cannot be voided out from under it | ✅ | `voidBill` refuses `BILL_HAS_PAYMENTS` + `BILL_HAS_ADJUSTMENTS`; the two guards are exactly the two reduction sources in `bill-open-balance.ts`; §5a |
| 7 | Void is a **reversal** and requires a distinct `*.void` capability (LEDGER_WRITERS) | ✅ | `void*` → `reverseEntryCore`; `bill.void`/`bill_payment.void`/`vendor_credit.void` = LEDGER_WRITERS; `void-authorization.test.ts` (now covers A/P) |
| 8 | **A/P subsidiary ⇔ control reconciliation holds across payments, vendor credits, and per vendor** | ✅ | §3 three-way tie; **GL-T023/T024/T025/T026**; the **new** `gate5-acceptance.test.ts` lifecycle |
| 9 | No A/P / vendor balance is stored anywhere | ✅ | invariant 2; `bill-open-balance.ts` derives every time; vendor statement derives from journal lines |
| 10 | A/P reporting UI authorizes server-side, company-from-session, no existence leak, money display-only | ✅ | §5b; `report-context.ts` + per-service `report.view`; vendor statement cross-company → null; malformed id → not-found (§7 item 10 fix) |
| 11 | Tenant isolation holds for vendors, bills, bill payments, vendor credits | ✅ | Composite FKs; `isolation` descriptors (completeness test enforces coverage); §5b |
| 12 | `npm run ci` passes (lint, types, unit, build) | ✅ | typecheck clean · lint clean · unit **177** · build ok (§2b) |
| 13 | Full integration + GL regression pass; GL regression is a required check | ✅ | §2b; GL-T001…**T026** green on CI; the integration cap was raised to 45 min (§7 CI) |
| 14 | Manual Sprint 6 acceptance scenario derives correctly | ✅ | `gate5-acceptance.test.ts` — §3 |
| 15 | Independent correctness & security reviews | ✅ | §5a (correctness — no money-corrupting defect), §5b (security — no exploitable finding) |
| 16 | All Sprint 6 ADRs decided | ✅ | **ADR-023** (vendor credits), **ADR-024** (A/P aging + statement, scope caveat added) |

---

## 2. Read, personally — reading guide

- **Schema + triggers.** `src/db/schema/{vendors,bills,bill-payments,vendor-credits}.ts` (composite
  `(company_id, id)` FKs, positivity CHECKs, status). Migrations: `0021` (vendor tag FK on
  `journal_lines`), `0022` (bills + bill_lines + A/P numbering backfill), **`0023`** (bill payments +
  the **generalized control-account trigger** `assert_no_manual_post_to_control_account`, replacing
  the A/R-only 0018 guard — idempotent DROP/CREATE), `0024` (vendor credits).
- **Services.** `src/server/bills/index.ts` (`createBill`/`finalizeBill`/`voidBill`,
  `computeBillTotal`/`computeBillPosting`, the `BILL_HAS_PAYMENTS`+`BILL_HAS_ADJUSTMENTS` guards),
  `src/server/bill-payments/index.ts` (`payBill`/`voidBillPayment`/`listOpenBills`),
  `src/server/vendor-credits/index.ts` (`issueVendorCredit`/`voidVendorCredit`).
- **Shared A/P open balance.** `src/server/reports/bill-open-balance.ts` — `billReductionsExpr` /
  `billReductionsTotal`: open balance = `total − Σ(non-void bill payments + vendor credits)`,
  correlated subqueries (no fan-out), the single source of truth (used by aging, `listOpenBills`,
  `payBill`, `issueVendorCredit`).
- **Reports.** `src/server/reports/ap-aging.ts`, `vendor-statement.ts`, and `aging.ts` (the shared
  bucket helpers A/R and A/P both use).
- **A/P control-account lock.** The 0023 trigger + `src/server/ledger/internal.ts`
  (`CONTROL_ACCOUNT_MANUAL_POST` mapping, now worded A/R+A/P).
- **UI.** `src/app/{vendors,bills,bill-payments}/**`, `src/app/reports/{ap-aging,vendor-statement}/`,
  `report-context.ts`; `tests/unit/reports-money-safety.test.ts` (now scans the A/P UI dirs).
- **RBAC.** `src/server/rbac/capabilities.ts` — `expense.*`/`bill_payment.*`/`vendor_credit.*`.
- **Decisions.** [DECISIONS.md](DECISIONS.md) ADR-023, ADR-024 (with the Gate 5 scope caveat).

---

## 2b. Run — results

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run test:unit` | ✅ **177/177** (incl. `reports-money-safety` over the A/P UI) |
| `npm run build` | ✅ ok |
| GL regression incl. **GL-T023–T026** (A/P reconciliation) | ✅ green on CI (the `test:gl` job, ~47s) |
| Structural guard (raw SQL) | ✅ `control-account-guard.test.ts` — manual JE into **A/P** and **A/R** refused |
| `gate5-acceptance` + `adv6-ap-concurrency` + A/P `void-authorization` | ✅ on CI's ephemeral branch (see CI note) |

**CI.** LL-060…LL-065 were each green across every gating job on merge (`#48`–`#53`). The Integration
job (full DB-backed suite) had **outgrown its 30-min cap** — it timed out three times running at this
gate — so it was raised to **45 min** (`.github/workflows/ci.yml`; the growth is ticketed **LL-070**).
The gate's own reconciliation invariants (GL-T023–T026) run in the separate **GL regression** job,
which is fast and green; the `gate5-acceptance` narrative + `adv6-ap-concurrency` run in the full
Integration job. The **only** persistently-red workflow on `main` remains **"Production deploy"** —
the pre-existing infra gap ticketed as [LL-056](tickets/LL-056.md), not a Sprint 6 regression.

---

## 3. Manual acceptance scenario — executed

`tests/integration/gate5-acceptance.test.ts`, on a synthetic `standard`-chart company. Two vendors
(Globex, Initech). At **every** stage the test asserts the three-way tie — the derived GL **A/P
control** (trial balance), the **A/P aging subsidiary** total, and **Σ of every vendor's statement
closing** — are equal, the trial balance **balances**, and `assertLedgerIntegrity` passes.

| Stage | A/P control == aging == Σ statements |
|---|---|
| Globex bill#1 $1,000 + bill#2 $500; Initech bill#3 $300 | **1,800.00** ✅ |
| Pay Globex $400 on bill#1 (GL-T024) | **1,400.00** ✅ |
| Vendor credit remaining $600 of bill#1 → bill#1 **PAID** (GL-T025) | **800.00** ✅ |
| Partial vendor credit $200 on bill#2 (stays OPEN) | **600.00** ✅ |
| **Void** that credit (reversal; vendor tag preserved) | **800.00** ✅ |
| **Void** the $400 payment → bill#1 back to **OPEN** (900 open for Globex) | **1,200.00** ✅ |

A second case proves the **per-vendor decomposition** (GL-T026): Globex (1,000 − 250 paid − 150
credited = **600**) + Initech (**300**) = **900**, equal to the control. A third case proves the
**A/P control lock in raw SQL**: a service-bypassing manual `JOURNAL_ENTRY` line into A/P is refused
by the 0023 trigger (`CONTROL_ACCOUNT_MANUAL_POST`), leaving the tie untouched.

---

## 4. Negative cases — structural vs conventional

| Negative case | Through the service | Raw SQL (service bypassed) | Enforcement |
|---|---|---|---|
| **Manual JE to the A/P (or A/R) control account** | `CONTROL_ACCOUNT_MANUAL_POST` | **Rejected** — trigger `journal_lines_no_manual_control_post` (0023) | **Structural (labelled path)** |
| A document-*source* manual post / a `reverseJournalEntry` of a document entry | **posts / reverses** (service-layer gap) | n/a | **Gap — §7 item 1, ticketed LL-066** (not UI-reachable) |
| Bill line posts to a system control account (A/P) | `LINE_ACCOUNT_INVALID` (create + re-checked at finalize) | balanced but would break the tie | **Conventional** |
| Pay "from" A/R or A/P as the cash account | `CASH_ACCOUNT_INVALID` | — | **Conventional** |
| Payment / vendor credit beyond open balance (incl. **concurrent**) | `OVERAPPLIED` / `CREDIT_EXCEEDS_BALANCE` (decimal.js vs derived open, under `FOR UPDATE`) | **SUCCEEDS** — open balance is derived, not a stored ceiling | **Conventional** (proven under concurrency — `adv6`) |
| Void a bill with live payments / vendor credits | `BILL_HAS_PAYMENTS` / `BILL_HAS_ADJUSTMENTS` | **SUCCEEDS** — app-layer guard | **Conventional** |
| Void without the `*.void` capability (BOOKKEEPER) | `AuthorizationDenied` | n/a | **Conventional (capability)** |
| Entry per-side total exceeds NUMERIC(19,4) — **document path** | `ENTRY_AMOUNT_OUT_OF_RANGE` (now in `postEntryCore`, §7 item 9) | **Rejected** at write | app + **structural** |
| Cross-company vendor/bill/account/payment reference | `*_NOT_FOUND` (company-scoped) | **Rejected** — composite FKs | **Structural** |
| Malformed (non-UUID) id in a URL/action | **not-found** (§7 item 10 fix) | n/a | **Conventional** |
| Two payments locking the same bills in opposite orders | **both commit** (id-sorted lock order, §7 item 8) | — | **Conventional** (proven — `adv6`) |

---

## 5. Independent implementation-blind reviews

Two agents read the Sprint 6 surface without the authors' notes.

### 5a. Correctness / accounting — engine sound; edge-of-claim gaps, triaged

**Bottom line: no defect corrupts money / balance / atomicity / immutability / tenancy / idempotency
inside the A/P document paths.** Verified sound (with the line checked): posting directions and the
vendor tag surviving reversal; a single fan-out-free open-balance derivation used everywhere;
complete `voidBill` guards; PAID↔OPEN transitions under the right `FOR UPDATE` locks; exact 4dp
arithmetic (per-line `toDecimalPlaces(4)`, grouped debits summing to the total, stored-vs-recomputed
tripwire, zero-total refused); capability-in-service authz with voids narrowed to LEDGER_WRITERS;
composite-FK tenancy. The reviewer walked bill=100 through {P60+VC40, void P}, {VC30+P70, void VC},
{P100, void P, void bill} and found subsidiary == control in every state.

The gaps are at the *edges* of the "A/P moves only through documents" claim — see §7 items 1
(control-lock service bypass), 2 (money-out idempotency), 3 (no A/P concurrency test — **fixed this
gate**), plus LOW items 4–9.

### 5b. Security — no exploitable vulnerability found

The reviewer traced every reachable page, server action, and service and confirmed enforcement **in
code**: authentication then authorization in the service by capability (voids = LEDGER_WRITERS,
BOOKKEEPER denied); `companyId` always the server-revalidated session pointer, never from URL/query/
form; every lookup composite-scoped with composite FKs as the structural backstop; a foreign
well-formed id and a missing id producing byte-identical outcomes (no tenant oracle); all inputs
Zod-validated with money kept as strings; all `sql\`\`` parameterised; nothing sensitive in logs or
client errors; every new `company_id` table registered in the isolation completeness test. Residual
items were LOW/hardening — §7 items 10 (malformed-id 500 — **fixed**), 11 (vendor audit free-text —
ticketed), 12 (test-contract thinness — **fixed**), 13 (A/R-only error wording — **fixed**).

---

## 6. Invariant enforcement matrix (AGENTS §4) — the Sprint 6 surface

| # | Invariant | Enforced by (in Sprint 6) | Evidence |
|---|---|---|---|
| 1 | Debits = credits, exact at NUMERIC(19,4) | **DB** (deferred trigger) + app (balanced by construction; **range guard now in `postEntryCore`**) | §3; GL-T024/T025 |
| 2 | Balances derived, none stored | app (`bill-open-balance.ts`, vendor statement derive every time) | §3; §5a |
| 3 | Posted entries immutable; corrections by reversal | **DB** (0006/0011/0020) + app (`void*` → `reverseEntryCore`) | §4 |
| 4 | No cross-company line / reference | **DB** (composite FKs on vendors, bills, payments, credits, the vendor tag) | §4; §5b |
| 5 | No posting into a closed period | **DB** (period trigger) + app (resolve/check before the tx) | payBill/finalize resolve period pre-tx |
| 6 | Source posts once; retries idempotent | **DB** (`journal_entries_source_posted_once`) + app (`FOR UPDATE` + status) — **partial money-out retries: §7 item 2 (LL-067)** | §4; `adv6` |
| 7 | Posting atomic | **DB** (Pool tx); every A/P write uses `getDbTx()` only | §5a |
| 8 | `LedgerService` only posting path | app — A/P documents post only via `postEntryCore`/`reverseEntryCore` | §5a |
| — | **A/P subsidiary ⇔ control** (+ per vendor) | **DB** (0023 locks A/P to documents on the labelled path) + release gate | **GL-T023…T026**; §3 |

---

## 7. Items surfaced — triaged by the product owner

**CI (blocker, resolved).** The Integration job outgrew its 30-min cap (three consecutive timeouts).
**Fix applied:** raised to **45 min**; a proper sharding investigation is **[LL-070](tickets/LL-070.md)**.

| # | Sev | Item | Disposition |
|---|---|---|---|
| 1 | **MED** | Control-account lock only stops the *labelled* manual path — `postJournalEntry` accepts document source types and `reverseJournalEntry` will reverse a document's entry, either of which moves A/P (or A/R) without the subsidiary from the **service layer** (not UI-reachable; inherited from A/R). Includes the `BEFORE INSERT`-only DRAFT-flip hardening (finding 5 / security LOW-2). | **TICKETED [LL-066](tickets/LL-066.md)** + **ADR-024 wording corrected** to scope the guarantee. |
| 2 | **MED** | `payBill`/`issueVendorCredit`/`receivePayment` have no idempotency key — a lost-response retry of a *partial* payment double-disburses cash (reconciliation still holds, so it wouldn't flag). | **TICKETED [LL-067](tickets/LL-067.md)** (A/R + A/P together). |
| 3 | **MED** | No A/P concurrency/idempotency test against a real DB (AGENTS §7). | **✅ FIXED** — `tests/integration/adv6-ap-concurrency.test.ts`: two payments racing one bill (one `OVERAPPLIED`), a payment vs. a vendor credit racing, voiding one of two payments on a PAID bill, and the id-sorted lock order preventing deadlock. |
| 4 | LOW | Bills are source-typed `EXPENSE`, not a dedicated `BILL`. | **✅ ACCEPTED** (no collision — UUID source ids; revisit when cash expenses arrive). |
| 6 | LOW | `createBill`/`payBill` accept an INACTIVE vendor (parity with customers). | **✅ ACCEPTED** (parity; not money-corrupting). |
| 7 | LOW | The `system-only` chart lacks A/P (`AP_ACCOUNT_NOT_CONFIGURED` until `standard` installed; fails closed). | **TICKETED [LL-068](tickets/LL-068.md)**. |
| 8 | LOW | Lock-order deadlock if two payments apply to `[A,B]` and `[B,A]`. | **✅ FIXED** — applications locked in id-sorted order in `payBill` and `receivePayment`; regression in `adv6`. |
| 9 | LOW | `finalizeBill` (and every document path) skipped the NUMERIC(19,4) range pre-check the manual path has. | **✅ FIXED** — the guard now lives in `postEntryCore`, covering every document path uniformly. |
| 10 | LOW | Malformed (non-UUID) id → uncaught driver 500 instead of not-found (no tenant oracle; pre-existing in A/R). | **✅ FIXED** — `isUuid` boundary guard on the A/P detail pages/actions + statement, and the A/R twins for parity. |
| 11 | LOW | Vendor (and customer) audit rows store free-text `notes`/`address` unredacted (§9 — bank details). | **TICKETED [LL-069](tickets/LL-069.md)** (allow-list, both sides). |
| 12 | LOW | Test contracts thinner than they read: `void-authorization.test.ts` covered only A/R; no READ_ONLY denial for A/P writes. | **✅ FIXED** — A/P `bill.void`/`bill_payment.void`/`vendor_credit.void` splits + a READ_ONLY-denied-all-A/P-creates case added. |
| 13 | LOW | `toLedgerDomainError` worded the control-account error as A/R-only. | **✅ FIXED** — message + comment now name A/R and A/P. |

---

## 8. Human sign-off

The reviewer confirms, by reading the code and this evidence:

- [ ] I have read the Sprint 6 schema, the bill/bill-payment/vendor-credit services, the 0023
      trigger, the shared `bill-open-balance.ts`, the A/P aging + vendor statement, and the A/P UI (§2).
- [ ] The manual acceptance scenario derives correctly and the three-way tie (control ⇔ aging ⇔ Σ
      vendor statements) holds at every stage (§3).
- [ ] I accept the structural-vs-conventional split in §4 — including that the A/P control lock is
      **structural on the labelled manual path** (0023), with the service-layer completeness gap
      scoped in ADR-024 and ticketed as **LL-066**.
- [ ] I accept the §7 triage: items 3, 8, 9, 10, 12, 13 fixed in this gate; items 4, 6 accepted;
      items 1, 2, 7, 11 ticketed (LL-066–069); the CI cap raised (LL-070).
- [ ] The independent correctness (§5a) and security (§5b) reviews raise nothing money-corrupting or
      exploitable that remains open.
- [ ] **Gate 5 is passed. Sprint 7 may begin.**

_Prepared by Claude Code. Sign-off is the human reviewer's._
