# Gate 3 — Accounts Receivable Acceptance · MANDATORY HUMAN REVIEW

> Sprint 4 — Accounts Receivable, **LL-040 … LL-046** — is complete and merged to `main`.
> It builds the A/R subsystem end to end on the Sprint 3 ledger: customers → invoices →
> **finalize (post to the ledger)** → **payments (apply to A/R)** → void → **aging**.
> This gate is a **human acceptance review** before any Sprint 5 feature is built on it.
>
> Everything below is **prepared evidence**: the required suites were run, a full A/R
> lifecycle acceptance scenario was executed and asserted, and two independent
> implementation-blind reviews (correctness + security) were performed. **The sign-off in
> §8 is the human reviewer's to make** — Claude does not pass its own gate. Read §3, §4,
> §5, and §7 closely.
>
> **Headline for the reviewer.** The A/R subsystem posts every document through
> `LedgerService` (never a direct journal insert), corrects only by **reversal** (never
> mutation), and its **subsidiary ledger reconciles exactly to the general-ledger A/R
> control account** — a release-gate invariant (GL-T018), verified correct by both
> independent reviews. Both reviews converged on one reconciliation gap: the tie *assumes*
> A/R is moved only by invoices and payments, and **two in-tenant paths violate that
> assumption** — (1) a crafted invoice line naming the A/R control account, and (2) a
> manual journal entry to A/R (both documented in ADR-016; GL-T018 proves the tie for
> normal document flows but prevents neither).
>
> **Update — path (1) was remediated during this review.** The invoice service now
> **rejects any line account that is a system control account** (`LINE_ACCOUNT_INVALID`),
> enforced at create/edit **and** at finalize (defense in depth), with regression tests.
> Path (2) — a manual JE to A/R — is left as a **policy decision** (some manual A/R entries,
> e.g. bad-debt write-offs and opening balances, are legitimate, so a blanket lock would be
> wrong; it needs a considered design). §4, §5a, and §7 reflect the fixed state. §7 item 2
> (manual JE to A/R) has been **accepted by the product owner as a known limitation and
> ticketed as [LL-050](tickets/LL-050.md)** — so the gate carries no open blocker; what
> remains is the reviewer's read-and-sign in §8.

**Key term.** *Structural* = enforced by the database, so it holds even when the
application is bypassed (raw SQL). *Conventional* = enforced only by application code. The
gate's "confirm it in raw SQL too" exists precisely to tell these apart.

---

## 1. Checklist

| # | Gate requirement | Status | Evidence |
|---|---|---|---|
| 1 | A/R schema + every constraint/FK read and understood | ✅ | Reading guide §2; enforcement matrix §6; migrations 0012–0016 |
| 2 | Every document posts through `LedgerService`, never a direct journal insert | ✅ | `finalizeInvoice`/`receivePayment` call `postEntryCore`; `void*` call `reverseEntryCore`; grep finds no `insert…journal*` in `invoices`/`payments` (§5a) |
| 3 | Money is `string`/`Decimal`, never `number`, across the A/R surface | ✅ | Zod rejects numeric money (`validation/{invoice,payment}.ts`); decimal.js in totals/aging; §5a grep |
| 4 | Invoice finalize posts a balanced, correctly-classified entry | ✅ | §3 scenario (Dr A/R / Cr revenue by account / Cr tax); GL-T016; `invoice-posting` suite |
| 5 | Payment posts Dr deposit / Cr A/R and applies correctly | ✅ | §3 scenario; GL-T017; `payments` suite; deposit account must be ACTIVE ASSET and not A/R |
| 6 | Void is a **reversal**, not a mutation | ✅ | `voidInvoice`/`voidPayment` → `reverseEntryCore`; §3 marks the payment `VOID` and restores the receivable; invariant 3 (ledger, Gate 2) |
| 7 | **Aging reconciles to the GL A/R control balance** | ✅ | §3 asserts it at every stage; **GL-T018** is a required release-gate check |
| 8 | No A/R / customer balance is stored anywhere | ✅ | §3 schema scan (no balance/outstanding/running/cached column on the A/R tables); invariant 2 |
| 9 | Tenant isolation holds for all A/R entities | ✅ | Composite FKs (§6); `isolation` suite; §5b confirms no cross-tenant IDOR / no existence leak |
| 10 | `npm run ci` passes (lint, types, unit, build) | ✅ | typecheck clean · lint clean · unit **175** · build ok (§2b); CI verify green on the LL-046 merge |
| 11 | Full integration suite passes | ✅ | `test:integration` green (§2b); CI "Integration" green on the LL-046 merge commit |
| 12 | GL regression suite passes and is a required check | ✅ | GL-T001…**T018**; required check "GL regression suite (release gate)" green on `main` |
| 13 | Manual A/R acceptance scenario derives correctly | ✅ | Executed as `gate3-acceptance.test.ts` — §3 |
| 14 | Every negative case fails (service; raw SQL where structural) | ✅ (path 1 remediated; path 2 is a decision) | §4 — tenancy is structural; document guards conventional; the **invoice-line → A/R path is now rejected** (`LINE_ACCOUNT_INVALID`, §7 item 1); the **manual-JE → A/R path** remains a policy decision (§7 item 2) |
| 15 | Independent correctness & security reviews of the A/R surface | ✅ | Two implementation-blind agents: §5a (correctness), §5b (security — **no exploitable finding**). Each Sprint 4 ticket also passed `/code-review high` at PR time. |
| 16 | All A/R ADRs decided | ✅ | **ADR-013 … ADR-016** in [DECISIONS.md](DECISIONS.md) |

Row 14's one remaining open item (§7 item 2 — a manual JE to the A/R control account) is
what needs an explicit **accept-or-design** decision at this gate; path 1 was fixed during
the review. Everything else is verified.

---

## 2. Read, personally — reading guide

The gate says to read these yourself. Exact locations:

- **Schema + constraints/FKs:** `src/db/schema/{customers,invoices,payments}.ts`; the
  customer tag on ledger lines in `src/db/schema/ledger.ts` (composite FK
  `journal_lines_customer_same_company_fk`). Migrations:
  `drizzle/migrations/0012_customers.sql`, `0014_invoices.sql`,
  `0015_invoice_posting.sql` (the `SALES_TAX_PAYABLE` system account, the
  `company_counters.next_invoice_number`, the `INVOICE_FINALIZED/VOIDED` audit actions),
  `0016_payments.sql` (`payments` + `payment_applications`, their composite FKs and
  positivity checks).
- **Invoice service:** `src/server/invoices/index.ts` — `computeInvoiceTotals` /
  `computeInvoicePosting` (pure, decimal.js), `finalizeInvoice` (authorize → resolve
  period before the tx → lock invoice `FOR UPDATE` → recompute & assert totals → resolve
  A/R + tax accounts → build Dr A/R / Cr revenue-by-account / Cr tax → allocate the
  invoice number atomically → `postEntryCore` sourceType `INVOICE` → audit), `voidInvoice`
  (has-payments guard → `reverseEntryCore`).
- **Payment service:** `src/server/payments/index.ts` — `receivePayment` (amount = Σ
  applications; lock each invoice `FOR UPDATE`; validate OPEN + same customer + ≤ open
  balance; deposit account must be in-company, ACTIVE, ASSET, and **not** A/R; Dr deposit
  / Cr A/R customer-tagged; mark fully-paid invoices PAID), `voidPayment` (reverse +
  revert PAID→OPEN), `listOpenInvoices`, `invoiceAppliedTotal`.
- **Aging report:** `src/server/reports/ar-aging.ts` — `getArAging` (`report.view`;
  open balance = total − Σ non-void applications, one SQL aggregation; buckets by due date,
  fallback invoice date; decimal.js sums).
- **System-account resolution:** `src/server/accounts/index.ts` `resolveSystemAccount`.
- **Ledger cores used by A/R:** `src/server/ledger/index.ts` `postEntryCore`,
  `src/server/ledger/reversal.ts` `reverseEntryCore`.
- **Money boundaries:** `src/validation/{invoice,payment,customer}.ts` (numeric money is
  rejected, not coerced).
- **Authorization / capabilities:** `src/server/authorization/index.ts`,
  `src/server/rbac/capabilities.ts` (the A/R capabilities and their role grants).
- **Decisions:** [DECISIONS.md](DECISIONS.md) ADR-013 (invoice totals stored but derived),
  ADR-014 (invoice posting), ADR-015 (payment posting), ADR-016 (aging reconciliation).

---

## 2b. Run — results

| Command | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ clean |
| `npm run test:unit` | ✅ 175/175 |
| `npm run build` | ✅ ok |
| `npm run test:integration` (full, post-remediation) | ✅ **359/359** (31 files, incl. the 3 new guard regressions + `gate3-acceptance`) |
| `npm run test:gl` (release gate, incl. GL-T018) | ✅ covered by the integration run |
| `gate3-acceptance` (this gate's scenario) | ✅ 2/2 (§3) |

The full post-remediation suite is green locally (**359** = the pre-remediation 356 + the 3
new guard tests); it also runs as this PR's required **"Integration (ephemeral Neon branch)"**
CI job. CI on the LL-046 merge (`3d150d9`) was green across every job: Lint/types/unit/build,
Integration, GL regression (release gate), and E2E.

---

## 3. Manual acceptance scenario — executed

Reproduced exactly as `tests/integration/gate3-acceptance.test.ts` on a synthetic company
(`standard` chart, which provides the A/R and Sales Tax Payable system accounts, plus a
named Sales Revenue and Cash account). One customer, "Acme". Every balance is the
natural-direction balance the **trial balance derives from journal lines alone**; the
aging total is the **A/R subsidiary** derived from invoices and non-void applications.

| Stage | A/R control | Cash | Revenue | Tax payable | Aging total | Aging == A/R? |
|---|---|---|---|---|---|---|
| Finalize invoice #1 — $1,000, no tax | **1,000.00** | 0 | 1,000.00 | 0 | **1,000.00** | ✅ |
| Finalize invoice #2 — $500 + 10% tax | **1,550.00** | 0 | 1,500.00 | 50.00 | **1,550.00** | ✅ |
| Receive $400 partial on invoice #1 | **1,150.00** | 400.00 | 1,500.00 | 50.00 | **1,150.00** | ✅ |
| Receive $550 full on invoice #2 → **PAID** | **600.00** | 950.00 | 1,500.00 | 50.00 | **600.00** | ✅ |
| Void invoice #2 (PAID) → refused `INVOICE_NOT_OPEN`; void invoice #1 (OPEN, paid-against) → refused `INVOICE_HAS_PAYMENTS` | 600.00 | 950.00 | — | — | 600.00 | ✅ (unchanged) |
| Void the $400 payment (a reversal) | **1,000.00** | 550.00 | 1,500.00 | 50.00 | **1,000.00** | ✅ |

Also asserted by the test at every stage: the **trial balance balances** (`balanced === true`);
a **PAID** invoice leaves the aging entirely; the voided payment is marked **`VOID`** (not
deleted) and its receivable returns to the books; and `assertLedgerIntegrity(company)`
passes over everything posted. Invoice #2's tax leg proves the three-way split
(Dr A/R 550 / Cr Revenue 500 / Cr Sales Tax Payable 50) balances to the penny.

**No A/R balance is stored** — a second test scans `information_schema` and finds no
`%balance%` / `%outstanding%` / `%running%` / `%cached%` column on `customers`, `invoices`,
`invoice_lines`, `payments`, or `payment_applications`. The invoice document totals
(`subtotal`/`tax_total`/`total`) and a payment's `amount` are properties of the source
document (ADR-013), always service-derived from lines — a customer's open balance is
computed, never held.

---

## 4. Negative cases — structural vs conventional

| Negative case | Through the service | Raw SQL (service bypassed) | Enforcement |
|---|---|---|---|
| Cross-company invoice/payment/customer reference | `*_NOT_FOUND` (company-scoped query) | **Rejected** — composite FKs `payments_customer_same_company_fk`, `payment_applications_{payment,invoice}_same_company_fk`, `payments_deposit_account_same_company_fk`, `journal_lines_customer_same_company_fk` | **Structural** |
| Same source posted twice (double finalize / double receive) | Invoice/payment locked `FOR UPDATE` + status guard → one entry | **Rejected** — ledger partial unique index `journal_entries_source_posted_once` on (`source_type`,`source_id`); finalize posts sourceType `INVOICE`/`sourceId=invoice`, receive `CUSTOMER_PAYMENT`/`sourceId=payment` | **Structural** |
| Duplicate invoice in one payment | `DUPLICATE_INVOICE_APPLICATION` | **Rejected** — `payment_applications_payment_invoice_unique (payment_id, invoice_id)` | **Structural** |
| Negative payment / application amount | Zod rejects (money string, positive) | **Rejected** — `payments_amount_positive`, `payment_applications_amount_positive` CHECKs | **Structural** |
| Unbalanced invoice/payment entry | totals recomputed & asserted before posting | **Rejected** at COMMIT — the ledger's deferred balance trigger (Sprint 3) | **Structural** |
| Finalize a non-DRAFT invoice | `INVOICE_NOT_DRAFT` (pre-check + locked re-check) | not applicable (status is app state) | **Conventional** |
| Deposit account is non-asset or is A/R | `DEPOSIT_ACCOUNT_INVALID` | **SUCCEEDS** — no account-type constraint on payments | **Conventional (by design)** |
| Over-apply a payment beyond open balance | `OVERAPPLIED` (decimal.js vs derived open balance) | **SUCCEEDS** — open balance is derived, not a stored ceiling | **Conventional** |
| Apply a payment to another customer's invoice | `INVOICE_WRONG_CUSTOMER` | **SUCCEEDS** — no DB tie between a payment's customer and its applications' invoices | **Conventional** |
| Void an invoice that has payments applied | `INVOICE_HAS_PAYMENTS` | **SUCCEEDS** — the guard is an app-layer query on `payment_applications` | **Conventional** |
| **Crafted invoice line naming the A/R control account** | **Rejected** — `LINE_ACCOUNT_INVALID` at create/edit and at finalize (a line account may not be a system control account) | not applicable — the service refuses to build such an entry | **Conventional (service, remediated — item 1)** |
| **Manual journal entry to the A/R control account** | *No guard* — a manual JE can post to A/R | **SUCCEEDS** — nothing restricts posting to the control account | **UNENFORCED — see item 2 (policy)** |

The aging↔control reconciliation (GL-T018) holds because A/R is only moved by invoices and
payments. Item 1 (a crafted invoice line to A/R) previously violated that; it is now
**rejected by the service** (`LINE_ACCOUNT_INVALID`), enforced at create/edit and again at
finalize, with regression tests. Item 2 (a manual JE to A/R) remains a genuine policy
decision, since some manual A/R entries (bad-debt, opening balances) are legitimate — see
§7. Both paths are documented in ADR-016.

---

## 5. Independent implementation-blind reviews

### 5a. Correctness / accounting review — engine is strong; one reconciliation gap

An implementation-blind agent read every Sprint 4 file plus the ledger cores and boundary
code and reasoned independently (it did not execute the suite). **Bottom line: no defect
that automatically corrupts money, balance, atomicity, immutability, tenancy, idempotency,
or the aging↔control reconciliation in the normal operating flows** — the double-entry
math, the reversal-based voids, the tenancy scoping, and the subsidiary↔control
reconciliation are correct and DB-backed. It verified, and the gate may cite:

- **Money typing:** `string` at every boundary, `Decimal` in computation, throughout
  invoices/payments/aging; the only `Number(...)` uses are a tax-rate bound and integer
  row/day counts; every `toFixed(4)` is on a `Decimal`. No JS `number` holds money.
- **Invoice finalize** balances by construction across multi-line, mixed taxed/untaxed,
  same-account-merge, penny/ROUND_HALF_EVEN rounding, and the zero-group skip; A/R debit =
  stored `total` = fresh recompute (ADR-013 tripwire); invoice-number allocation is
  race-safe (atomic `UPDATE…RETURNING` + unique index); double-finalize impossible
  (DRAFT-guarded `FOR UPDATE` + `journal_entries_source_posted_once`).
- **Void** reverses via `reverseEntryCore` (never mutates; DB enforces POSTED→REVERSED);
  the `INVOICE_HAS_PAYMENTS` guard is race-safe (both void and receive hold the invoice
  `FOR UPDATE`).
- **Payment receive/void, aging:** amount derived (Σ applications, decimal.js); deposit
  account guarded (ASSET, not A/R); aging open balance = `total − Σ(non-void applications)`
  with **no invoice-line fan-out** and correct UTC day-math at the bucket boundaries;
  `ar-aging.ts` and `listOpenInvoices` use the **identical** open-balance derivation (they
  cannot diverge); the grand total reconciles to the GL A/R control **by construction**
  (re-derived), matching GL-T018.
- **Atomicity / LedgerService-only:** every A/R write uses `getDbTx()` + interactive
  transaction with `postEntryCore`/`reverseEntryCore` and audit inside the tx; no `getDb()`
  (HTTP) on a write path; no feature module inserts journal rows directly.

The **one genuine gap** it raised is item 1 in §7 (invoice line accounts unconstrained →
the A/R control account can be used as a line account, breaking GL-T018 via a crafted
request) — rated **MEDIUM** because it defeats a release-gate invariant, though it requires
deliberate misuse (the UI datalist only offers REVENUE accounts; the service, which is the
enforcement boundary per AGENTS §6, did not enforce it). **This was remediated during the
review**: the service now rejects a system control account as a line account
(`LINE_ACCOUNT_INVALID`), at create/edit and at finalize, with regression tests (§7 item 1).
Its two lower items map to §7 items 5 (payment receive has no idempotency key) and 6
(`voidPayment` relies on the implicit UPDATE lock rather than an explicit `FOR UPDATE` —
verified safe in practice).

### 5b. Security review — **no exploitable vulnerability found**

An implementation-blind agent traced every reachable A/R operation end to end against the
AGENTS §6/§9 contract and confirmed it is enforced **in code**, not merely in tests:

- **Authorize-before-write, fail-closed.** `requirePermission` / `requireCompanyMembership`
  is the first statement in every operation (customers create; invoices
  create/update/get/list/finalize/void; payments receive/void/get/list/`listOpenInvoices`;
  `getArAging`). The membership lookup is UUID-shape-checked, wrapped in try/catch whose
  catch **denies**; capabilities are a typed union with a total grant record, so an
  ungranted capability is a compile error, not a silent default.
- **Company from session, never the body.** All actions build context via
  `requireContext()` → `getActiveCompanyMembership`; the active-company cookie is
  revalidated against the DB on every read and never falls back to another tenant. The
  validation schemas reject a `companyId` field outright; every id is `z.uuid()`, money is
  a string.
- **No cross-tenant IDOR / no existence leak.** Every id-based query is scoped
  `company_id = <session> AND id = <input>`; a foreign id resolves identically to a
  nonexistent one, and all denials share one shape (`NOT_FOUND` / "Not found.").
- **Payment application is customer- and company-safe.** Each applied invoice must belong
  to the payment's customer and be OPEN and locked; the deposit account must be in-company,
  ACTIVE, ASSET, and not A/R; over-application is blocked with decimal.js.
- **Parameterized SQL; redaction.** No `sql.raw` anywhere in the A/R surface; the
  has-payments guard, `invoiceAppliedTotal`, `listOpenInvoices`, and the aging query all
  use bound parameters and are company-scoped (`asOfDate` is `isCalendarDate`-validated).
  Audit writes route through `redact()`; no `console.*`; actions return short error codes,
  never `error.message`/stack.

Three **LOW / non-exploitable** items for the reviewer to ratify (see §7 items 2–4):
customer contact fields + free-text `notes` are stored unredacted in the audit trail; there
is no distinct *void* capability (any writer who can post may void); and invoice line
accounts are not constrained to revenue-type accounts.

---

## 6. Invariant enforcement matrix (AGENTS §4) — the A/R surface

| # | Invariant | Enforced by (in A/R) | Evidence |
|---|---|---|---|
| 1 | Debits = credits, exact at NUMERIC(19,4) | **DB** (ledger deferred trigger) + app (totals recomputed & asserted) | §3; GL-T016/T017 |
| 2 | Balances derived, none stored | **DB** (no balance column on A/R tables) + app (aging derives every open balance) | §3 schema scan |
| 3 | Posted entries immutable; correct by reversal | app (`void*` → `reverseEntryCore`) + **DB** (immutability triggers, Sprint 3) | §3 (payment marked VOID, receivable restored) |
| 4 | No cross-company line | **DB** (composite FKs, incl. the customer tag) | §4; `isolation` suite; §5b |
| 6 | Source posts once; retries idempotent | **DB** (source-posted-once unique index) + app (`FOR UPDATE` + status guard) | §4 |
| 7 | Posting is atomic | **DB** (Pool tx + deferred trigger at COMMIT); A/R writes use `getDbTx()` only | §5a driver-policy grep |
| 8 | `LedgerService` is the only posting path | **App / convention** — A/R posts only through `postEntryCore`/`reverseEntryCore` | §5a (no direct journal insert in `invoices`/`payments`) |

Invariant 5 (no posting into a closed period) is inherited structurally from Sprint 3
(ADR-012 trigger); `finalizeInvoice`/`voidInvoice`/`receivePayment` resolve and check the
period before the tx as well. The A/R-specific reconciliation invariant (subsidiary ⇔
control) is enforced by **GL-T018** as a required release-gate check — but rests on the
manual-JE assumption in §4 / §7 item 1.

---

## 7. Items surfaced

**Items 1 and 2 are the gate's real decision** — two ways the aging⇔A/R-control
reconciliation (GL-T018) can be broken by an in-tenant actor. GL-T018 proves the tie holds
for documents posted through the normal flows; it does **not** prevent either path below.
Both trace back to the ADR-016 assumption that A/R is moved only by invoices and payments.

1. **✅ RESOLVED (was MEDIUM) — an invoice line could name a system control account.**
   `validateReferences` previously checked only that a line account is in-company, not its
   type — so a crafted request to `createInvoiceAction`/`finalizeInvoiceAction` (the line
   `accountId` is a hidden, client-supplied field) could name the **A/R control account** as
   a "revenue" line. Finalize would post `Dr A/R = total` **and** `Cr A/R = subtotal`: the
   entry balances (so every trigger passes), but the invoice's full `total` counts as open
   in the aging while the ledger A/R moved only by the tax — **aging ≠ control**. Both
   independent reviews flagged it (correctness rated it MEDIUM: it defeats a release-gate
   invariant). **Fixed during this review:** a new `assertLineAccountsPostable` rejects any
   line account with a non-null `systemAccountType` (blocks A/R, Sales Tax Payable, Retained
   Earnings, …) with `LINE_ACCOUNT_INVALID`, called from `validateReferences` (create/edit)
   **and** from `finalizeInvoice` on the stored lines (defense in depth — catches a draft
   created before the guard). Regression tests in `invoice-posting.test.ts` prove a line
   naming A/R or Sales Tax Payable is rejected and that a stored draft force-set to A/R is
   refused at finalize with **nothing posted**. ADR-016 updated to record the enforcement.
2. **✅ ACCEPTED, ticketed as [LL-050](tickets/LL-050.md) — the A/R control account is not
   locked against manual journal entry.** A manual JE to A/R (via the LL-035 UI) also breaks
   the reconciliation and nothing prevents it (ADR-016). Unlike item 1 this has **legitimate
   uses** — bad-debt write-offs (Dr Bad Debt Expense / Cr A/R) and opening balances (Dr A/R /
   Cr Opening Equity) both touch A/R — so a blanket lock would be wrong; it needs a considered
   design (sanctioned write-off/opening-balance documents + a structural default block), which
   is why it is a human decision rather than an auto-fix. **The product owner accepted this
   as a known limitation for Gate 3 and filed LL-050** to close it (preferably structurally)
   before free-form A/R adjustments are exposed.
3. **Customer PII in the audit trail (LOW, likely by-design).** Customer create/update/
   deactivate audit events store the full row; the shared `redact()` helper has no pattern
   for `email`/`phone`/`billing_address`/`notes`, so those persist verbatim in
   `audit_events`. Not on stdout, not in an error, not in AGENTS §9's "never log" list, and
   the audit table is access-controlled — but `notes` (2,000 chars) is unbounded free text.
   *Ratify, or add those keys to the redactor / log a non-PII diff.*
4. **No distinct void capability (LOW, policy).** `voidInvoice` requires `invoice.post`
   and `voidPayment` requires `payment.create`, both `ALL_WRITERS` (incl. BOOKKEEPER), so
   any writer who can post can void. Capability-based and fail-closed, but coarser than a
   dedicated `invoice.void`/`payment.void`. *Ratify "post implies void," or add a narrower
   void capability.*
5. **Payment receive has no idempotency key (LOW).** A double-submitted *partial* payment
   creates two payments (both serialize on the invoice `FOR UPDATE`, both see it still
   OPEN). Not an invariant violation — each payment is a distinct source and the ledger
   still reconciles — but "retries are idempotent" (AGENTS §4.6) is unwired on this path.
   A full payment's second submit is correctly rejected (invoice → PAID → `INVOICE_NOT_OPEN`).
   *Consider a submit-once guard or per-form idempotency key.*
6. **`voidPayment` relies on the implicit UPDATE lock, not an explicit `FOR UPDATE` (LOW,
   informational).** It reverts PAID→OPEN with `where status='PAID'` without locking the
   invoice rows first. Verified **safe in practice**: the status UPDATE conflicts with
   `receivePayment`'s `FOR UPDATE`, applications are strictly positive (so voiding any
   contributing payment always correctly drops applied below total), and `where status='PAID'`
   prevents double-revert. Flagged only so the gate knows the safety rests on the implicit
   lock. *Optional: take `FOR UPDATE` explicitly for clarity.*

---

## 8. Human sign-off

The reviewer confirms, by reading the code and this evidence:

- [ ] I have read the A/R schema, the composite FKs (including the ledger customer tag),
      and the invoice/payment/aging services in full (§2).
- [ ] The manual acceptance scenario derives correctly and the aging reconciles to the GL
      A/R control at every stage (§3).
- [ ] I accept the structural-vs-conventional split in §4: A/R tenancy and double-post
      protection are **structural**; the document guards (deposit-account type, over-apply,
      wrong-customer, has-payments) are **conventional by design**.
- [ ] I accept the §7 **item 1 remediation** (an invoice line may not post to a system
      control account; enforced at create/edit and finalize, with tests). *§7 item 2 (manual
      JE → A/R) is already **accepted as a known limitation and ticketed as
      [LL-050](tickets/LL-050.md)** — no decision outstanding here.*
- [ ] The independent correctness (§5a) and security (§5b) reviews raise nothing blocking;
      §7 items 3–6 are each accepted or ticketed.
- [ ] **Gate 3 is passed. Sprint 5 may begin.**

_Prepared by Claude Code. Sign-off is the human reviewer's._
