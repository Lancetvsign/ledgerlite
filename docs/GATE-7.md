# Gate 7 — Organizations and the intercompany model (LL-096 … LL-099) · MANDATORY HUMAN REVIEW

> Sprint 7 landed on `main` in five pull requests (#101, #102, #104, #105 and #103): organizations with
> per-pair intercompany system accounts (LL-096), shared credit-card statements — personal charges and
> lines taken by another company (LL-097), the intercompany balances report and the mirror invariant
> GL-T029 (LL-098), and intercompany bank transfers marked on one statement and matched from the other,
> which is also how balances settle (LL-099). ADR-043 and its amendments. Migrations 0040 and 0041.
>
> This gate is a **human acceptance review** before the owner runs a real card statement and a real bank
> transfer across two of their companies. Three implementation-blind reviews were performed on the LL-099
> tip (`8eb4bd4`, identical in content to `main` after #105) — security & tenant isolation across the new
> organization boundary, accounting correctness of the intercompany model, data integrity, schema and
> concurrency — read-only, without touching the shared database. Every finding below was re-verified
> against the cited code by the author before ranking. **The sign-off in §7 is the human reviewer's** —
> Claude does not pass its own gate.

**Key term.** *Structural* = enforced by the database (holds even under raw SQL). *Conventional* =
enforced only by application code.

---

## 1. Checklist

| # | Item | Status |
|---|---|---|
| 1 | Every ticket LL-096 … LL-099 merged to `main` with green CI on merge | ✓ (#101, #102, #104, #105) |
| 2 | Migrations 0040–0041 expand-only; `drizzle-kit check` passes; no schema drift | ✓ (§5c) |
| 3 | Production deployed at every merge; migrations applied | ✓ (production-deploy.yml, all success) |
| 4 | Independent security review | ✓ §5a |
| 5 | Independent accounting review | ✓ §5b |
| 6 | Independent data-integrity review | ✓ §5c |
| 7 | Findings consolidated, deduplicated and re-verified by the author | ✓ §6 |
| 8 | Blocking fixes (LL-100 … LL-103) merged and deployed | ✓ (#107, #108, #109, #111) |
| 8a | M5 structural line immutability (LL-104, owner's direction decision) | ✓ (ADR-044, migration 0042) |
| 9 | Human sign-off | ☐ §7 |

## 2. What was reviewed and how

Each reviewer received AGENTS.md, ADR-043 with its amendments, the sprint plan and the four ticket reports —
and was told to trust nothing the docs claim. Read-only on the LL-099 tip: `npm run lint`, `npx tsc
--noEmit`, `npx vitest run --project unit` (281/281), `npx drizzle-kit check` (pass) and a drift probe
(no schema changes) were run by the author; the integration and e2e suites were not run locally (they
wipe the shared dev database; CI is their proof, and every PR was green there, including the fault-injection
and concurrency cases).

## 3. Invariant enforcement matrix — the new surface

| Invariant (AGENTS §4) | New path | Enforced by | Structural? |
|---|---|---|---|---|
| 1 Balanced entries | assign (two entries), personal, mark, match | `postEntryCore` + deferred balance trigger, per entry | ✓ |
| 2 Derived balances | intercompany report, in-transit figures | computed from journal lines on read; no balance column | ✓ (no column) |
| 3 Immutability | `intercompany_group_id` | `journal_entries_immutable` lists it; unassign/give-back only by reversal | ✓ trigger |
| 4 Tenancy | `assigned_journal_entry_id`, `intercompany_company_id` | composite FK to the assigned company's entry; pair FKs; the two cross-company references are by design (ADR-043) | ✓ |
| 5 Closed periods | both companies of a two-company posting | plan-phase check naming the company + `postEntryCore` re-read + DB trigger | ✓ |
| 6 Source-once | assign, mark, match | line `FOR UPDATE` + `journal_entries_source_posted_once` + `(intercompany_group_id, company_id)` unique | ✓ |
| 7 Atomicity | assign/unassign (two companies) | one Pool transaction; fault-injection test | ✓ |
| 8 LedgerService only | every intercompany posting | `postEntryCore` / `reverseEntryCore`; counters locked through `lockEntryCounters` in the ledger module | conventional (+fence) |
| Intercompany accounts move only through INTERCOMPANY / REVERSAL | all | control-account trigger allow-list (0040/0041) | ✓ |
| Mirror: Σ Due-from = Σ Due-to per pair, net of cash in transit | all | `findIntercompanyMismatches` (GL-T029 + report); both sides post together, or a single-sided group is "in transit" | conventional (gate-proven) |

## 4. Manual acceptance — owed by the product owner

Two runtime checks with real data remain with the owner: (1) upload a real card statement into the
cardholder company shared with the organization, mark a personal line, take a line from another company,
and reconcile the card to zero; (2) mark a real bank transfer between two companies from one statement and
match it from the other, then confirm the Intercompany Balances report shows zero in transit and "Mirrored"
in both companies.

## 5. Independent implementation-blind reviews

### 5a. Security & tenant isolation

**Bottom line: no HIGH. No cross-tenant read or write through any authorized path that ADR-043 did not
design in; every two-company write proves `journal.post` in both companies; guessed organization, batch
and entry ids collapse to the uniform denial or one not-found / mismatch code; the only cross-company read
(the report's mirror figure) is limited to the pair account facing the reader; a one-sided reversal is
impossible through the manual API.**

- **MEDIUM (M1)** — `transferCounterparts` (`src/server/bank-import/intercompany.ts:66-85`) is an
  unauthorized company-scoped read exported at the module root and called from the review page; its
  siblings (`markIntercompanyTransfer`, `matchIntercompanyTransfer`, `findIntercompanyCandidates`) live in a
  module the LL-014 lint fence (`*/internal`) does not cover. Unexploitable today (output self-scoped to the
  actor's memberships) — the LL-014 anti-pattern nonetheless. Fix: `requireCompanyMembership` inside it;
  extend the fence to `shared` / `intercompany` modules.
- **LOW** — (L1) `?detail=` free text reflected into the shared page's PERIOD_CLOSED notice (React-escaped;
  attacker text in a first-party notice). (L2) the intercompany report keeps reading a FORMER member's
  live legal name and pair account after it left (balances are provably zero). (L3) organization joins are
  audited only in the joining company; existing members' logs never show a new member. (L4) isolation
  registry lacks attempts for `getIntercompanyReport`, `transferCounterparts` and the two transfer
  decisions; no `organizations` descriptor. (L5) `addCompanyToOrganization` locks the guessed org row
  before proving a stake (timing oracle; UUIDs make it impractical). (L6) `deactivateIntercompanyPairs`
  writes in the counterpart with an actor who may hold no membership there — by design; audit payload
  should name the leaver.
- **NOTE** — (N1) plan §2 says "membership in A (any role)"; code requires a `journal.post` ROLE in A
  (stricter — docs drift). (N2) plan §4 "un-assign refused after settlement" is not implemented (signed
  balances chosen instead; a give-back after settlement leaves a negative receivable). (N3) the match
  re-proves the entry in-tx but the actor's counterpart role only pre-tx (impact nil: it writes only the
  actor's company); an un-share racing an in-flight take goes through. (N4) the redactor blanks the chart
  `accountNumber` in `ACCOUNT_CREATED` payloads (over-redaction, pre-existing). (N5) A's line description
  crosses into B's entry description by design. (N6) visibility predicates derive from `CAPABILITY_GRANTS`
  everywhere; no role-name literal outside rbac.
- **Sound:** uniform denials proven for every negative; both-company authorization on assign/unassign;
  browser inputs re-proven (viewer from the cookie, counterpart ∈ `transferCounterparts`, entry id = the
  server-computed candidate, account ∈ pickable); `manualOnly` reversal root walk; trigger allow-list;
  atomicity + fault injection; source-once partial on POSTED (re-take after give-back); group unique +
  immutable trigger; leave/join/archive races proven; shared-view filter; report leakage bounded; no
  statement content in logs; lint fence intact.

### 5b. Accounting correctness

**Bottom line: the mechanics are sound — no money in a JS `number`; signs right in assign (charge and
refund), personal, mark and match against the natural directions of card liability, bank asset,
receivable and payable; both sides of every assign / give-back in ONE transaction from the SAME amount;
the allow-list complete in both trigger functions; the manual posting and reversal APIs cannot reach
INTERCOMPANY entries; `assertLedgerIntegrity` holds on every path. The problems are all in what the
LL-099 "net of cash in transit" relaxation lets through and in the absence of a correction path.**

- **HIGH (H1) — a mistaken mark or match cannot be corrected by any application path.** No un-mark
  action; the manual reversal API refuses non-manual roots (`reversal.ts:158-179`); the line is POSTED. A
  `-5000` supplier payment marked as a transfer to B stays wrong forever, A's P&L misses the expense, the
  report shows it "in transit, mirrored" indefinitely, and the leave rule blocks B from ever leaving.
  Fix: `unmarkIntercompanyTransfer` — reverse this side if the group has no other side, else reverse both
  in one transaction (journal.post in both) or refuse; a review-page Undo for POSTED INTERCOMPANY lines.
- **HIGH (H2) — the mirror invariant is vacuous for single-sided grouped entries; GL-T029 does not prove
  what ADR-043 claims.** `invariants.ts:137-154` and the report subtract ANY single-sided grouped entry.
  A marks `-5000` (G1); B independently marks `+4500` (G2): A Due from B 5000, B Due to A 4500; gap 500 =
  in transit 500 → the invariant passes and the badge says "Mirrored". The corruption test seeds a
  one-sided entry WITHOUT a group; the same insert WITH a group passes. Fix: three states on the report
  (mirrored / in transit — amber, with amount and age / mismatch), never "Mirrored" while in-transit ≠ 0;
  tighten "single-sided" to entries whose source is a POSTED statement line of the same company on the
  pair account; fail the gate on single-sided groups older than N days; add the unequal-marks case.
- **MEDIUM (M1)** — the report's as-of ignores the date when deciding single-sidedness (`intercompany.ts:
  141-143`): a transfer marked 07-01 and matched 07-03 shows MISMATCH as of 07-02 (any month-end between
  the two statement dates). Fix: date-bound the partner lookup. **(M2)** — a card PAYMENT line can be
  taken through the shared path (no sign / transfer-candidate check in `assignSharedLines`); GL-T029 has
  C take the +2000 payment to an expense → negative expense in C, negative receivable in A, and A's bank
  line then finds no candidate and double-posts the card. The plan's rule "a card payment is only
  posted/matched in the cardholder" is not enforced. Fix: exclude/refuse positive lines that have a
  same-company transfer candidate; fix GL-T029 to match the payment in A. **(M3)** — with pairs in both
  directions `pairAccountsFor` always picks the payer's RECEIVABLE, so a repayment grosses up instead of
  settling (four open balances after one repayment; leave blocked forever). Fix: prefer the pair whose
  balance the movement reduces. **(M4)** — docs drift: ADR-043's "can only be broken by a posting that
  fails both sides" is no longer true (H2); plan §3 still describes Link and §4 "un-assign refused after
  settlement"; "statement-excluded" pair accounts do appear on the balance sheet (correctly).
- **LOW** — (L1) un-assign reversals dated in two timezones can straddle a day (false MISMATCH as of that
  day); use one date. (L2) two equal lines in one submit both target the nearest candidate; the second
  fails `TRANSFER_ALREADY_MATCHED` after the first committed (re-submit works). (L3) both sides marking
  independently leaves permanent "in transit" both ways (auto-link on mark, or restore Link). (L4)
  `pairAccountsFor` sees only ACTIVE pairs → after leave/rejoin a payee-first mark creates the reverse
  pair (seeds M3). (L5) a card CHARGE can be marked as a transfer with no counterpart flow (offer the
  mark only on positive card lines). (L6) pair accounts are hard-coded OPERATING cash flow.
- **NOTE** — (N1) negative "Due from" prints as a negative asset; bookkeepers expect a net position per
  counterpart with the sign explained. (N2) PERSONAL allows any ASSET incl. another bank account (a
  transfer, not a distribution) — restrict to EQUITY + an owner-loan subtype. (N3) give-back after a
  completed reconciliation leaves two uncleared lines netting to zero (standard; document). (N4)
  un-assign after settlement → signed negatives, mirrored (consistent with the amendment). (N5) the
  invariant DOES detect a one-sided reversal of a matched group — keep that when H1's unmark is added.
- **Sound:** money strings everywhere (Zod rejects numbers; `journal_lines_sign`); all four sign tables
  traced incl. a card payment marked in B and matched from A; one transaction / same amount; structural
  mirror via the triggers + group unique + immutable group id; periods checked before and inside; report
  derived from lines with REVERSED counted; invariant 4 via `postEntryCore`'s per-company account check;
  pair creation refusals and reactivation; the leave rule counts single-sided balances; candidates never
  include assign groups or reversals.

### 5c. Data integrity, schema & concurrency

**Bottom line: no HIGH. Every new CHECK is NULL-safe; enum values added in the same migration transaction
are compared as text and the migrator really runs all pending files in one transaction; the composite FK
on `(assigned_company_id, assigned_journal_entry_id)` is present; the 0041 snapshot matches SQL and schema
for the hand-patched `assigned_shape`; `journal_entries_immutable` lists every column; the lock order
(organization → companies sorted → counters sorted → entries) is consistent across join / leave / assign /
give-back / mark / match / archive with no constructible cycle.**

- **MEDIUM (M1) — leave-at-zero bypassed through an INACTIVE pair.** The leave rule's balance query and
  its counterpart-lock set filter on `accounts.status = 'ACTIVE'` (`organizations/index.ts:205,233`); a
  give-back (`unassignSharedLine`) reverses through `reverseEntryCore`, which deliberately ignores account
  status, and never calls `ensureIntercompanyPair` (the only reactivation path). Sequence: take → repay →
  leave (pair deactivated at zero) → rejoin → give the card line back (both REVERSALs post onto the
  INACTIVE Due accounts: −100 / −100) → leave again SUCCEEDS with a standing balance neither company can
  settle. Fix: drop the ACTIVE filters from the leave rule; have the give-back reactivate the pair; test the
  exact sequence.
- **MEDIUM (M2) — `journal_lines` has no BEFORE INSERT immutability guard**, so raw balanced lines can be
  appended to any POSTED `INTERCOMPANY` / `REVERSAL` entry and the new allow-list admits them on the Due
  accounts (`0006:196-198` fires on UPDATE/DELETE only; the deferred balance trigger only requires the
  entry to balance). Pre-existing since 0006 for every posted entry (invariant 3); newly load-bearing
  because ADR-043 calls the mirror "structural". Fix needs a design decision: a BEFORE INSERT trigger with
  a session-local escape for `postEntryCore` / `reverseEntryCore` (which insert lines while the entry is
  already POSTED), or insert-as-DRAFT-then-flip (which the 0010 period guard does not cover on UPDATE).
- **LOW** — (L1) the in-transit netting cannot tell "in transit" from a permanent one-sided entry, and the
  candidate finder keeps offering A's entry to B after B already marked its own side (same defect as
  §5b H2/L3). (L2) the relabel-attack test (`organizations.test.ts:188`) is satisfied by the immutability
  trigger alone; the intercompany branch of the relabel function is only load-bearing on DRAFT→POSTED and
  no test exercises it. (L3) join / leave are not idempotent on retry (`ALREADY_IN_ORGANIZATION` /
  `NOT_IN_ORGANIZATION` after a lost response). (L4) any `REVERSAL`-labelled raw entry is admitted on the
  Due accounts regardless of `reversal_of_id` (same threat model as M2).
- **NOTE** — (N1) 0040/0041 drop and re-create an index and two CHECKs inside one transaction (no window).
  (N2) an organization whose last member left is unreachable and never deleted (ADR-006). (N3)
  `docs/DATABASE.md` "Current schema" still says one table. (N4) pre-existing: the period guard is BEFORE
  INSERT only — a DRAFT→POSTED update bypasses it (relevant to M2's fix). (N5) no structural "both sides"
  rule: a groupless INTERCOMPANY entry or a one-member group is legal at the DB. (N6) the same-organization
  rule for `assigned_company_id` is service-only (adequate: checked under KEY SHARE).
- **Lock order traced** (no cycle): create org → INSERT (private) → company FOR UPDATE; join → org FOR
  UPDATE → company FOR UPDATE; leave → org → [leaver + counterparts sorted] FOR UPDATE; pair → companies
  sorted KEY SHARE → accounts; assign/unassign/mark/match → line FOR UPDATE → companies sorted KEY SHARE →
  counters sorted FOR UPDATE → entries; standalone reversal → company KEY SHARE → entry FOR UPDATE →
  counter (the one inversion vs give-back cannot cycle: the manual API throws before the counter, and no
  document void targets an INTERCOMPANY entry).
- **Sound:** NULL semantics of every CHECK; `::text` enum comparisons; partial uniques; composite-FK tenancy
  plus the two by-design cross-tenant FKs; the trigger allow-list incl. the relabel scan; races (one group
  per company, leave vs KEY SHARE holder, 10-way pair race with a savepoint, assign vs leave, stake under
  the org lock); idempotency of every per-line write; no HTTP-client write; `PURGE_ORDER` still topological
  and guarded; `truncateAll` / isolation registry / topological test cover the new tables and FK;
  fault-injection atomicity.

## 6. Consolidated findings — author-verified, with proposed disposition

Severity is the author's after re-verifying each cited line in the LL-099 tip; every HIGH and MEDIUM was
confirmed by reading the code (the ACTIVE filters, the missing un-mark path, the unbounded single-sided
netting, the date-free partner lookup, the payer-receivable pair rule, the UPDATE/DELETE-only line
trigger). Dispositions were proposals for §7. **Status column added 2026-09-24:** every proposed fix has since been
implemented and merged — LL-100 (#107), LL-101 (#108), LL-102 (#109), LL-103 (#111) — each with its own
`/code-review high` pass, green CI and a production deploy. M5 (LL-104) and the PERSONAL rule remain the
owner's decisions.

| # | Sev | Finding (review) | Proposed disposition | Status (2026-09-24) |
|---|---|---|---|---|
| H1 | HIGH | No correction path for a mistaken mark or match (5b H1) | **Fix now — LL-100**: `unmarkIntercompanyTransfer` (reverse this side if the group has no other side; else reverse both in one transaction with the give-back lock order, `journal.post` in both); review-page Undo on POSTED INTERCOMPANY lines; test mark → unmark → STAGED, balance 0, candidate gone. | FIXED #107 (LL-100) |
| H2 | HIGH | The in-transit relaxation accepts ANY single-sided grouped entry of any amount; the badge says "Mirrored"; GL-T029 does not prove ADR-043's claim (5b H2, 5c L1) | **Fix now — LL-101**: three report states (mirrored / in transit — amber, amount and age / MISMATCH); "single-sided" tightened to an entry whose source is a POSTED statement line of the same company on the pair account; the partner lookup date-bounded (M1); the gate fails on single-sided groups older than the transfer window plus a statement lag (proposed 30 days); candidates never offered when the viewer already marked its own side; tests for unequal independent marks and a group-bearing raw one-sided insert. | FIXED #108 (LL-101) |
| M1 | MEDIUM | Leave-at-zero bypassed via an INACTIVE pair after rejoin + give-back (5c M1) | **Fix now — LL-100**: leave rule counts INACTIVE pair accounts; give-back reactivates the pair; the exact sequence tested. | FIXED #107 (LL-100) |
| M2 | MEDIUM | Report as-of ignores the date when deciding single-sidedness → false MISMATCH between the two statement dates (5b M1) | **Fix now — LL-101** (date-bound `not exists`; as-of test between the dates). | FIXED #108 (LL-101) |
| M3 | MEDIUM | A card PAYMENT line can be taken through the shared path; GL-T029 codifies a negative expense in the taker (5b M2) | **Fix now — LL-102**: refuse/hide positive lines that have a same-company transfer candidate in the cardholder; GL-T029 matches the payment in A instead; assert the taker's P&L. | FIXED #109 (LL-102) |
| M4 | MEDIUM | With pairs in both directions a repayment grosses up instead of settling (5b M3, 5b L4) | **LL-102**: prefer the pair whose balance the movement reduces; `pairAccountsFor` sees INACTIVE pairs (reactivate rather than create the reverse direction). | FIXED #109 (LL-102) |
| M5 | MEDIUM | `journal_lines` accepts INSERT into a POSTED entry; the mirror is not structural against raw SQL (5c M2, 5c L4) | **Decide in §7 — LL-104** (migration): BEFORE INSERT `journal_lines_immutable` with a session-local escape (`set local ledgerlite.posting = on`) set only by `postEntryCore` / `reverseEntryCore`; `CHECK (source_type <> 'REVERSAL' or reversal_of_id is not null)`. Pre-existing invariant-3 gap, now load-bearing. | FIXED #113 (LL-104, ADR-044): guard on INSERT with NO escape; the engine posts DRAFT→lines→POSTED; period guard on the transition (N4); reversal-link CHECK (L4) |
| M6 | MEDIUM | `transferCounterparts` unauthorized at the module root; the lint fence does not cover `shared` / `intercompany` (5a M1) | **Fix now — LL-103**: `requireCompanyMembership` inside; fence pattern extended. | FIXED #111 (LL-103) |
| L1 | LOW | `?detail=` free text reflected into the shared-page notice (5a L1) | LL-103: structured `closedIn` discriminator; name resolved on render. | FIXED #111 (LL-103) |
| L2 | LOW | Report keeps reading a former member's live legal name and pair account (5a L2) | LL-103: ACTIVE-pair / same-organization filter, or a "former member" label. | FIXED #111 (LL-103) |
| L3 | LOW | Organization joins invisible in existing members' audit logs; pair deactivation audit lacks the leaver (5a L3, L6) | LL-103. | FIXED #111 (LL-103) |
| L4 | LOW | Isolation registry lacks the report, `transferCounterparts`, the two transfer decisions, an `organizations` descriptor (5a L4) | LL-103. | FIXED #111 (LL-103) |
| L5 | LOW | Org row locked before the stake is proven (timing oracle) (5a L5) | LL-103: stake query first. | FIXED #111 (LL-103) |
| L6 | LOW | Give-back reversals dated in two timezones can straddle a day (5b L1) | LL-100: one reversal date, open in both. | FIXED #107 (LL-100) |
| L7 | LOW | Two equal lines in one submit both target the nearest candidate (5b L2) | LL-101: allocate candidates per submit. | FIXED #108 (LL-101) |
| L8 | LOW | Both sides marking independently leaves permanent in-transit both ways (5b L3, 5c L1) | LL-101: auto-link on mark to a mirror single-sided group of the same amount in the window. | FIXED #108 (LL-101) |
| L9 | LOW | A card CHARGE can be marked as a transfer with no counterpart flow (5b L5) | LL-102: offer the mark only on positive card lines. | FIXED #109 (LL-102) |
| L10 | LOW | Relabel test satisfied by the immutability trigger alone; DRAFT→POSTED path untested (5c L2) | LL-103: the DRAFT→POSTED relabel test. | FIXED #111 (LL-103) |
| L11 | LOW | Join / leave not idempotent on retry (5c L3) | LL-103. | FIXED #111 (LL-103) |
| N1–N | NOTE | Docs drift — plan §2 "(any role)", §3 Link, §4 "un-assign refused after settlement", "statement-excluded"; ADR-043's "can only be broken by…" (5a N1/N2, 5b M4, 5c N3) | **Fixed in this PR** (plan and ADR wording corrected; `docs/DATABASE.md` pointer). | FIXED #106 |
| N | NOTE | PERSONAL allows any ASSET incl. another bank account (5b N2); negative "Due from" presentation (5b N1); pair accounts hard-coded OPERATING (5b L6); over-redacted chart number in audit (5a N4); A's line description crosses into B's entry (5a N5); orphan organizations (5c N2); period guard BEFORE INSERT only (5c N4) | Decide in §7 (item 3) for the PERSONAL rule; the rest accepted and documented. | DECIDED 2026-09-24 — PERSONAL rule kept as is (any equity or asset account the reviewer picks); rest accepted |

## 7. Human sign-off

Decisions requested of the product owner:

1. **Accept the proposed dispositions in §6**, or adjust severities/order. H1, H2 and M1–M3 are proposed as
   blocking: the gate passes when LL-100, LL-101 and LL-102 are merged. LL-103 (housekeeping) follows.
   **Update 2026-09-24: all four are merged and deployed (#107, #108, #109, #111); the blocking items are
   closed — what remains is your acceptance of the dispositions as executed.**
2. **M5 — make line immutability structural** (`journal_lines` BEFORE INSERT guard with a session-local
   escape, LL-104). This touches the ledger engine's posting mechanics and needs plan mode; approve the
   direction or accept the gap as documented.
   **Decided 2026-09-24 ("start LL-104"):** built without the escape — the engine posts by transition
   instead (ADR-044); 5c L4 and 5c N4 closed with it.
3. **PERSONAL account rule** — keep "any equity or asset account the reviewer picks" (today), or restrict
   to equity plus an explicit owner-loan asset subtype.
   **Decided 2026-09-24 ("Keep PERSONAL as any equity or asset account the reviewer picks"):** kept as
   built in LL-097; no restriction. Recorded in ADR-043.
4. **Manual acceptance (§4)** — the real card statement split and the real bank transfer across two of
   your companies.

| Reviewer | Decision | Date |
|---|---|---|
| Lance (Lancetvsign) | _pending_ | |
