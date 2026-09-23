# Sprint 7 — Ticket Plan (DRAFT for review)

> **Theme: Organizations — one credit card, several companies.**
> The owner runs several companies and pays for all of them with one card. Today the card
> statement is imported into ONE company and the other companies' charges can only be ignored
> (LL-089), which leaves that company's card liability short of the statement and the
> reconciliation off by exactly those charges. This sprint groups companies into an
> **organization**, lets an organization-shared card statement be reviewed from ANY member
> company, and posts each charge to the company it belongs to — **without breaking the rule
> that the cardholder company's card balance must equal the statement.**
>
> This is a **draft**. The accounting model in §1 is the decision to make before any ticket
> starts; everything else follows from it.

## 1. The accounting model (decide first)

A credit card is a liability of exactly one company: the one whose name is on the card
(**the cardholder company, "A"**). A charge that belongs to another company in the
organization (**"B"**) is still A's liability to the bank. Ignoring it in A is wrong: A owes
the bank for it. The correct treatment is **intercompany**:

| Disposition of a line on the shared statement | Entry in A (cardholder) | Entry in B |
|---|---|---|
| **Apply here** (belongs to A) — today's `post` | Dr Expense / Cr Card | — |
| **Assign to B** (new) | Dr *Due from B* / Cr Card | Dr Expense (B's chart) / Cr *Due to A* |
| **Personal** (new) | Dr *Owner Distributions* (3200) / Cr Card | — |
| **Ignore** (kept, narrowed) | — (not the company's charge at all: fraud/dispute, duplicate) | — |
| **Match transfer** (LL-094) — the card payment | unchanged | — |

Consequences the owner should accept explicitly:

1. **A's card account always ties to the statement.** Every charge line hits A's card
   liability. Reconciliation of the card in A keeps working exactly as today.
2. **B carries the expense and an intercompany payable.** B's P&L is right (the expense is
   B's); B's balance sheet shows *Due to A*. A's balance sheet shows *Due from B*. The two
   mirror each other to the cent, and a release-gate check (GL-T029) proves it across the
   organization.
3. **Settlement is a later, separate action.** When B actually pays A back (a bank transfer)
   or the owner decides to leave the balance as capital, that is posted then — Sprint 7
   ships the receivable/payable; **LL-099** ships settlement.
4. **"Personal" is an owner distribution, not an ignore.** The charge still reduces A's card
   liability correctly; equity absorbs it. (If the owner later reimburses the company, that is
   a deposit to the same equity account — already possible via bank import.)
5. **Refunds and credits** on the card use the same accounts with the signs reversed.
   A card **payment** line can only be matched/posted in A (LL-088 rule, unchanged).
6. **Ignore stays** for lines that are genuinely not a charge (disputed, duplicate) — the
   review screen will say so and the reconciliation will still show them as a difference,
   which is the correct signal.

The alternative — giving every company its own slice of the card as its own liability — was
rejected: no company's card account could ever be reconciled to the bank's statement.

## 2. Authorization model

- An **organization** is a grouping of companies; it holds no money and no ledger.
- **Company membership stays the authorization unit** (AGENTS.md §6). No organization-level
  role is introduced in this sprint.
- A company joins an organization only by action of one of **its own OWNERS**, and only into
  an organization where that user is already an OWNER of a member company (or the
  organization is new). Leaving mirrors joining. A company with open intercompany balances
  cannot leave (`ORG_HAS_INTERCOMPANY_BALANCE`).
- A shared statement's lines are visible from company B to a user who holds `journal.post`
  **in B** and is a member of A (any role). The line data is A's; B's reviewer sees only the
  lines that are still **unassigned** (`STAGED`) plus those already assigned **to B**. Lines
  posted in A, assigned to a third company C, marked personal, or ignored are not shown in B
  — no existence leak beyond what membership in A already grants.
- Assigning to B requires `journal.post` in **both** A and B (the action posts in both).

## 3. Schema (expand-only; one migration per ticket; plan mode)

**LL-096** — `organizations` (id, name, created_by, timestamps);
`companies.organization_id uuid null` (FK, `ON DELETE RESTRICT`).
Intercompany accounts are ordinary accounts with a new system role each:
`INTERCOMPANY_RECEIVABLE` / `INTERCOMPANY_PAYABLE` plus `intercompany_company_id` on
`accounts` (nullable; FK to `companies.id`; `UNIQUE (company_id, system_account_type,
intercompany_company_id)`), auto-created on first use as *Due from <B legal name>* (ASSET,
1300-series) and *Due to <A legal name>* (LIABILITY, 2300-series). They are statement-excluded
and protected like the other system accounts.

**LL-097** — `bank_import_batches.shared_with_organization boolean not null default false`;
`bank_import_line_status` gains `ASSIGNED` and `PERSONAL`;
`bank_import_lines.assigned_company_id uuid null` (FK companies, RESTRICT) and
`assigned_journal_entry_id uuid null` (the entry posted **in B**; cross-company by design,
FK to `journal_entries.id` alone with a CHECK that it is set iff `status = 'ASSIGNED'`).
(`journal_source_type` already gained `INTERCOMPANY` in LL-096.) CHECKs (compare enum values as `::text`): `ASSIGNED` ⇒ both ids set and
`assigned_company_id <> company_id`; `PERSONAL` ⇒ `journal_entry_id` set (posted in A).
`journal_entries.intercompany_group_id uuid null` links the A-side and B-side entries.

**LL-099** — none expected beyond LL-097's `intercompany_group_id`; every intercompany side posts with source `INTERCOMPANY` (the trigger allow-list requires it).

### Intercompany bank transfers (owner's addition, 2026-09-23)
Symmetric, either side first. A's bank shows −5,000 "TFR TO B"; B's shows +5,000 two days later.
- **Mark as intercompany transfer** on A's review (picker = other member companies): posts in A
  `Dr Due from B / Cr Bank A`, source `INTERCOMPANY`, `source_id` = line id, a new
  `intercompany_group_id`. A's line is POSTED; A's bank reconciles as usual.
- **Match from B**: `findTransferCandidates` gains an organization-wide branch — POSTED `INTERCOMPANY`
  entries in other member companies whose Due line equals `-amount` within the 3-day window and whose
  group has no entry in B yet. B's line defaults to *Match intercompany transfer from A* and posts in B
  `Dr Bank B / Cr Due to A` with the same group id. If B imports first, B marks and A matches. If both
  marked independently, *Link* joins the two entries into one group without posting (LL-094's shape).
- `UNIQUE (intercompany_group_id, company_id)`: one side per company per group. A card-charge
  settlement (B repays A) is exactly such a transfer.

## 4. Posting rules (LedgerService only — invariant 8)

- Assign = **one transaction on the Pool client** that posts A's entry (`postEntryCore`,
  source `INTERCOMPANY`, source_id = line id) and B's entry (same source, same source_id
  suffixed `:b`), with **both** companies' `company_counters` rows locked FOR UPDATE in id order
  before the first post (deadlock-free), and updates the line. Either both post or neither (invariant 7).
- Un-assign (before settlement) = reverse both entries via `reverseEntryCore` and return the
  line to `STAGED`. After a settlement entry references the pair, un-assign is refused.
- Periods: A's entry is dated on the card date; B's too. A closed period in **either** company
  blocks the assignment (invariant 5) with a clear message naming the company.
- Money: strings and Decimal throughout; the two entries are the same `NUMERIC(19,4)` amount.

## 5. Tickets

| # | Ticket | Schema? | Plan mode? | Builds on |
|---|---|---|---|---|
| 1 | **LL-096** — Organizations + intercompany system accounts — **implemented** (ADR-043, migration 0040) | ✅ | ✅ | LL-083 (templates), LL-042 (system roles) |
| 2 | **LL-097** — Shared card statements: personal in the cardholder, take-from-the-other-company, intercompany posting — **implemented** (migration 0041) | ✅ + ledger | ✅ | LL-088/089/094 |
| 3 | **LL-098** — Organization reports: intercompany balances by pair, and GL-T029 (A's *Due from B* = B's *Due to A*, every pair, every day) — **implemented** | — | — | LL-064 pattern |
| 4 | **LL-099** — Intercompany settlement (B pays A: posts both sides; bank-import transfer matching recognises it) | — | ✅ (ledger) | LL-094 |
| 5 | **Gate 7** — human review of the intercompany model across two real companies | — | — | Gate 6 |

### LL-096 — Organizations
- Account page: "Create organization" (names it; the creating company joins), "Add to
  organization" (one the owner already has a stake in), "Remove". New capability
  `company.organization` (OWNER).
- `ensureIntercompanyPair(tx, actor, a, b)` in `accounts/internal.ts`: returns the pair, creating
  (or reactivating) both if absent; never two per pair (the unique). Only `INTERCOMPANY`/`REVERSAL`
  may post to them (trigger allow-list).
- Tests: join/leave rules, cross-owner refusal, `roleCovers` untouched, intercompany pair
  uniqueness, the CHECKs.

### LL-097 — Shared card statements
- Upload: a card statement in A can be marked **"Share with organization"** (only if A is in
  one). Review in A gains **Personal** (and a share/unshare toggle); a shared batch appears under
  **Bank Import → Shared with you** in every other member company, listing only STAGED lines and
  lines assigned to that company. *Assign from A's page was dropped: B picks B's account from B.*
- From B the reviewer chooses B's expense account (AI suggestion via B's chart — the existing
  `mapCategoryToAccount`) and posts; the A-side entry is generated. Bulk controls (LL-089)
  extend naturally: "Assign all remaining to B".
- Reconciliation in A: assigned and personal lines are cleared like posted ones (they have an
  A-side entry on the card).
- Duplicate/transfer flags unchanged. `deleteImportBatch` refuses when anything is assigned.
- Tests: both entries post or neither (fault injection between the two posts); closed period
  in B blocks; un-assign reverses both; visibility matrix (member of A only / B only / both /
  neither); a third company cannot see lines assigned to B; e2e: one card statement split
  across two companies, both trial balances right, A's card reconciles to zero.

### LL-098 — Intercompany report + GL-T029
- `/reports/intercompany` in any member company: each counterpart, *Due from* / *Due to*,
  and the mirror difference (always 0.0000 or the gate fails).
- GL-T029 joins the release gate.

### LL-099 — Settlement
- "Settle with A" in B (or "Collect from B" in A): amount up to the open balance, dated,
  posts Dr *Due to A* / Cr Bank in B and Dr Bank / Cr *Due from B* in A atomically.
- Bank-import transfer matching (LL-094) learns the intercompany pattern so the two bank
  statements each match rather than re-post.

## 6. Out of scope (say so now)
- Organization-level roles, invitations, or billing.
- Consolidated organization financial statements (a later sprint; requires elimination of
  intercompany balances — GL-T029 is the prerequisite).
- Sharing anything other than **card** statements (a shared bank account across companies is a
  different problem: which company owns the cash?).
- Cash-basis reporting (raised 2026-09; still a separate decision).

## 7. Open questions for the owner
1. Accept the intercompany model in §1 (yes/no)? It is the only one under which the card
   still reconciles.
2. **Resolved (LL-097):** Personal posts to the equity or asset account the reviewer picks per line;
   the review page defaults to Owner Distributions (3200). No settings column.
3. May a user assign a line to a company they are **not** a member of? (Proposed: no — the
   B-side expense account must be chosen by someone with `journal.post` in B.)
