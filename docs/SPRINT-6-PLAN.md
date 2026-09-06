# Sprint 6 — Ticket Plan (DRAFT for review)

> **Theme: Accounts Payable (A/P) — the mirror of Accounts Receivable.**
> Sprints 4–5 built and completed A/R (customers → invoices → payments → write-offs / credit
> memos → aging → statements → reporting UI), reconciling the subsidiary to the general-ledger
> control at every step and passing Gate 4. Sprint 6 opens the domain the Sprint 5 plan reserved:
> the money the company **owes** its vendors. It is a structural mirror of A/R and low-risk to
> build — the proven patterns carry over and the ledger is already prepared (`vendor_id` on
> journal lines; the `EXPENSE` source type; the `expense.*` capabilities reserved in LL-012).
>
> This is a **draft**. The scope defaults (below) are yours to adjust before any ticket starts.

## The A/R → A/P mirror

| A/R (built) | A/P (this sprint) | Posted entry |
|---|---|---|
| Customers | **Vendors** | — |
| Invoices → finalize | **Bills** → finalize | Dr Expense (by line) / **Cr A/P** (vendor-tagged) |
| Payments (Dr Cash / Cr A/R) | **Bill payments** | **Dr A/P** / Cr Cash |
| Credit memos (reduce A/R) | **Vendor credits / debit memos** (reduce A/P) | Dr A/P / Cr Expense (contra) |
| A/R aging ⇔ A/R control | **A/P aging ⇔ A/P control** | reconciliation **GL-T023** |
| Customer statement | **Vendor statement** | derived from vendor-tagged A/P lines |

## Sequencing principles (unchanged from the project)
- **Decisions precede code** — the schema/ledger tickets (LL-060, LL-061, LL-062) carry their
  ADR decided *before* DDL, in **plan mode**.
- **One migration per PR** — each schema ticket lands one logical migration.
- **UI last within the sprint** — services first (LL-060…LL-064), screens after (LL-065).
- **Tests ship with the code they cover**; the A/P reconciliation extends the release gate
  (GL-T023); a **human Gate 5** closes the sprint.
- **`LedgerService` only** — every bill/payment/credit posts via `postEntryCore` /
  `reverseEntryCore`; corrections are by **reversal**, never mutation.

---

## Tickets

| # | Ticket | Schema? | Plan mode? | Builds on / mirrors |
|---|---|---|---|---|
| 1 | **LL-060** — Vendors | ✅ | ✅ | LL-040 (customers) |
| 2 | **LL-061** — Bills + posting | ✅ + ledger | ✅ | LL-041/042 (invoices + posting) |
| 3 | **LL-062** — Bill payments + A/P control-account lock | ✅ + ledger + trigger | ✅ | LL-043/045 (payments); ADR-018 (0018 guard) |
| 4 | **LL-063** — Vendor credits (debit memos) | ✅ + ledger | ✅ | LL-051 (credit memos) |
| 5 | **LL-064** — A/P aging + vendor statement | — | — | LL-046/054 |
| 6 | **LL-065** — A/P reporting UI (UI last) | — | — | LL-055 |
| — | **GATE 5** — Accounts Payable acceptance (human review) | — | — | closes Sprint 6 |

---

## Ticket detail

### LL-060 — Vendors
Mirror of LL-040 customers. A `vendors` table (name, vendor number, contact, `status`
ACTIVE/INACTIVE — **deactivate, never delete**, ADR-006), composite-FK tenancy
`UNIQUE (company_id, id)` so a journal line's `vendor_id` can never reference another tenant's
vendor (the FK hook already anticipated in the ledger schema). New capabilities **`vendor.view`**
(EVERYONE) / **`vendor.manage`** (ALL_WRITERS); update the exhaustive `rbac.test.ts` matrix.

### LL-061 — Bills + posting
Mirror of LL-041/042. A `bills` table (vendor, bill date, due date, lines with an expense
account + amount, derived `subtotal`/`tax`/`total` stored-but-derived per ADR-013), DRAFT →
**finalize** posts **Dr Expense (by line account) / Cr A/P (vendor-tagged)** through
`LedgerService`, source type **`EXPENSE`** (existing enum value — no enum migration). A line may
**not** post to a system control account (mirror `assertLineAccountsPostable` / ADR-016 item 1).
Void = reversal. Capabilities: `expense.view`/`expense.create` (reserved) for view/create, plus a
new **`bill.void`** (LEDGER_WRITERS).

### LL-062 — Bill payments + A/P control-account lock
Mirror of LL-043/045. A `bill_payments` (+ `bill_payment_applications`) pair: **Dr A/P / Cr Cash**
(a withdrawal from an in-company ACTIVE ASSET account that is **not** A/P), applied to one or more
of the vendor's OPEN bills, marking a bill **PAID** when cleared; void reverses and reverts
PAID→OPEN under an explicit `FOR UPDATE`. **A/P control lock:** generalize the LL-050 0018 trigger
so a manual `JOURNAL_ENTRY` line into the **A/P** control account is also rejected structurally
(one guard covering every control account with a subsidiary), keeping A/P moved only by documents.
Capabilities: `bill_payment.view`/`create`/`void` on the A/R precedent.

### LL-063 — Vendor credits (debit memos)
Mirror of LL-051 credit memos. A vendor credit reduces a bill's open balance without cash
(**Dr A/P / Cr Expense-contra**, vendor-tagged), through `LedgerService`. Extend the **shared A/P
open-balance derivation** (the mirror of `open-balance.ts`) so a bill's open balance =
`total − Σ(non-void bill-payments + vendor-credits)`; the LL-062 void guard counts vendor credits
too (mirror of `INVOICE_HAS_ADJUSTMENTS`). Capabilities: `vendor_credit.view`/`create`/`void`.

### LL-064 — A/P aging + vendor statement
Mirror of LL-046/054, pure services (`report.view`, decimal.js, no schema). `getApAging(asOf)` —
the A/P subsidiary bucketed by age, whose grand total **reconciles to the GL A/P control**
(**GL-T023**, the A/P analogue of GL-T018), and `getVendorStatement(vendorId, from, to)` —
opening / activity / closing from the vendor-tagged A/P journal lines (mirror ADR-022).

### LL-065 — A/P reporting UI (UI last)
Mirror of LL-055. Screens under `/bills` (list/detail + finalize/void), a bill-payment flow, and
`/reports/ap-aging` + `/reports/vendor-statement`; money **display-only** from the services'
strings (no JS number — extend the money-safety guard to the new report files), company from the
session context, `report.view`/`expense.*`-gated, `data-testid` throughout, Playwright e2e.

### GATE 5 — Accounts Payable acceptance
Human review, like Gate 4: a full A/P lifecycle scenario (bill → payment → vendor credit → void)
where the **A/P subsidiary reconciles to the A/P control at every stage**; the A/P control lock
holds **in raw SQL**; two implementation-blind reviews (correctness + security); sign-off before
Sprint 7.

---

## Scope decisions (proposed defaults — adjust before starting)
1. **Vendor credits (LL-063) — in scope.** Symmetric with A/R (A/P is "complete" with payments +
   vendor credits; there is no A/P analogue of a bad-debt write-off). Drop it for a leaner
   5-ticket sprint if preferred.
2. **Bill source type — reuse `EXPENSE`** (no enum migration); introduce a distinct value only if
   bills and direct cash expenses later need to diverge.
3. **A/P control lock — generalize the 0018 trigger** to guard any control account with a
   subsidiary (A/R and A/P), rather than adding a second bespoke trigger.

_Each ticket is expanded in `tickets/LL-06x.md`._

## Rough effort
Six tickets; three touch schema/ledger (LL-060, LL-061, LL-062) and deserve unhurried plan-mode
review; LL-063 mirrors credit memos; LL-064/065 are mechanical mirrors of existing services and
UI. Comparable to Sprint 5.

## Explicitly NOT in Sprint 6 (Sprint 7+ candidates)
**Financial statements** (P&L, Balance Sheet, Cash Flow — highest-value next, wants both A/R and
A/P in place); **bank/cash reconciliation** (`reconciliation.*` reserved); **accountant export**
(`accountant_export.create` reserved); **operational hardening** (submit-once idempotency for
payments/JE/bills; customer + vendor **PII redaction** in the audit trail; a **shared-core
refactor** for the now-four near-twin adjustment services; the 0018 **allowlist** hardening);
[LL-056](tickets/LL-056.md) production-deploy credentials; point-in-time historical aging
(ADR-016); receipts/attachments; multi-currency.
