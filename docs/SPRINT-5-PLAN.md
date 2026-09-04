# Sprint 5 — Ticket Plan (DRAFT for review)

> **Theme: make Accounts Receivable trustworthy end-to-end, and make it visible.**
> Sprint 4 built the A/R *engine* (customers → invoices → payments → aging) and proved it
> at Gate 3. It left three deliberate gaps: the aging⇔control reconciliation is only
> *assumed* safe against manual entry, A/R has no credits/refunds, and **every report is a
> service with no screen**. Sprint 5 closes those before a new domain (Accounts Payable) is
> opened in Sprint 6 — the same "prove and complete before expanding" discipline the ledger
> got in Sprint 3.
>
> This is a **draft**. Numbers, scope splits, and the two open scope questions (below) are
> yours to adjust before any ticket starts.

## Sequencing principles (unchanged from the project)
- **Decisions precede code** — the schema/accounting tickets (LL-050, LL-051) carry an ADR
  decided *before* DDL, in **plan mode**.
- **One migration per PR** — each schema ticket lands one logical migration.
- **UI last within the sprint** — services first (LL-054), screens after (LL-055).
- **Tests ship with the code they cover**; every reconciliation change extends the release
  gate; a **human Gate** closes the sprint.

---

## Tickets

| # | Ticket | Schema? | Plan mode? | Builds on / closes |
|---|---|---|---|---|
| 1 | **LL-050** — Control accounts protected from ad-hoc manual entry (+ bad-debt write-off) | ✅ trigger + write-off | ✅ | Gate 3 item 2 / ADR-016 |
| 2 | **LL-051** — Customer credits & refunds | ✅ | ✅ | LL-043 next; ADR-016 "revisit if" |
| 3 | **LL-052** — Ledger & audit hardening (gate follow-ups) | ✅ trigger widen | ✅ | Gate 2 items 5–6, Gate 3 item 3 |
| 4 | **LL-053** — Void authorization & idempotent writes | ~ maybe tiny | — | Gate 2 item 9, Gate 3 items 4–6 |
| 5 | **LL-054** — Customer statements (reporting service) | — | — | LL-046 next |
| 6 | **LL-055** — Reporting UI (Trial Balance, Aging, Statement) | — | — | LL-046 next; UI-last |
| — | **GATE 4** — reporting & A/R-completion acceptance (human review) | — | — | closes Sprint 5 |

---

## Ticket detail

### LL-050 — Control accounts protected from ad-hoc manual entry (+ bad-debt write-off)
*Already authored: [tickets/LL-050.md](tickets/LL-050.md). First, because it is a schema +
ADR ticket and everything downstream relies on a trustworthy A/R control.*
- **Structural block:** a `BEFORE INSERT` trigger on `journal_lines` rejects a line to any
  system control account unless it carries a *sanctioned* source type — mirrors the
  closed-period trigger (ADR-012), so it holds with the application bypassed.
- **Sanctioned path:** a **bad-debt write-off** document (Dr Bad Debt Expense / Cr A/R,
  customer-tagged, posted through `LedgerService`) so A/R can still be reduced legitimately
  and the write-off stays *in the subsidiary*. Extend **GL-T018** to include it.
- **ADR** picks the approach (sanctioned-documents-plus-default-block is the recommended
  one). Opening-balance import is out of scope here (its own later ticket if needed).

### LL-051 — Customer credits & refunds
- **Credit memos** (reduce what a customer owes without cash: Cr A/R / Dr Sales Returns or
  a contra-revenue) and **cash refunds** (return money on an overpayment/credit: Dr the
  customer's credit / Cr Cash), both customer-tagged and posted through `LedgerService`
  (`CUSTOMER_REFUND` was reserved in LL-043).
- **The ADR question:** unapplied customer credit makes the A/R subsidiary *richer than
  "open invoices"* (ADR-016 flagged exactly this). Decide whether the aging/subsidiary
  gains a "credits / unapplied cash" column and how it reconciles to control. This is the
  ticket's real design work.

### LL-052 — Ledger & audit hardening (gate follow-ups)
Defense-in-depth items the gates surfaced, none currently exploitable:
- Widen the immutability/fingerprint triggers to guard `('POSTED','REVERSED')` and include
  `idempotency_fingerprint` (Gate 2 item 6).
- A typed sum-overflow guard so an over-`NUMERIC(19,4)` entry fails with a domain error, not
  an opaque one (Gate 2 item 5).
- Add `email` / `phone` / `billing_address` / `notes` to the audit **redactor** so customer
  PII is not retained verbatim in `audit_events` (Gate 3 item 3).

### LL-053 — Void authorization & idempotent writes
- A distinct **`invoice.void` / `payment.void`** capability (granted to MANAGERS), instead
  of "any writer who can post may void" (Gate 3 item 4).
- A **submit-once / idempotency key** for `receivePayment` and the manual journal entry, so a
  double-submit cannot create two entries (Gate 2 item 9, Gate 3 item 5). One small migration
  if a key column is needed.
- Explicit `FOR UPDATE` on the invoices `voidPayment` reverts (Gate 3 item 6).

### LL-054 — Customer statements (reporting service)
- `getCustomerStatement(customerId, asOf)` — per-customer activity (invoices, payments,
  credits) and open items, built on the LL-045 open-balance derivation and the aging. Pure
  service, `report.view`-gated, decimal.js, no schema (invariant 2).

### LL-055 — Reporting UI (UI last)
- The first user-facing reports, which today exist only as services: **Trial Balance**,
  **A/R Aging**, and **Customer Statement** pages under `/reports`, `report.view`-gated,
  money advisory-only, mirroring the `/accounts` + `/journal` UI patterns. A nav entry on
  the account page.

### GATE 4 — reporting & A/R-completion acceptance
Human review, like Gate 3: the reports tie to the ledger (trial balance balances; aging and
statements reconcile to control **including** write-offs and credits); the control-account
lock holds **in raw SQL**; two implementation-blind reviews; sign-off before Sprint 6.

---

## Scope decisions (resolved — the defaults)
1. **Credits/refunds (LL-051) — kept in Sprint 5.** It is the most conceptually involved
   ticket (it changes what "the A/R balance" means) and carries its own ADR; it stays in
   scope so A/R is complete before Sprint 6.
2. **Reporting UI (LL-055) — the three screens only** (Trial Balance, Aging, Statement). A
   reports dashboard/landing is deferred to Sprint 6+.

_Revisit either if priorities change; each ticket is expanded in `tickets/LL-05x.md`._

## Rough effort
Six tickets; three touch schema/ledger (LL-050, LL-051, LL-052) and deserve unhurried
plan-mode review — comparable to a Sprint-3-sized effort. LL-054/055 are mechanical
(mirroring existing services and UI).

## Explicitly NOT in Sprint 5 (Sprint 6+ candidates)
Accounts Payable (vendors / bills / bill payments — `expense.*` capabilities were reserved
in LL-012); bank/cash reconciliation; financial statements (P&L, Balance Sheet, Cash Flow);
point-in-time historical aging (ADR-016); receipts/attachments; multi-currency.
