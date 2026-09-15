# Gate 6 — Post-go-live features (LL-076 … LL-089) · MANDATORY HUMAN REVIEW

> Since go-live (2026-09-11) seventeen pull requests landed on `main` (#68–#92): bank-statement import
> with an AI extractor (LL-076/077), bank and credit-card reconciliation (LL-078/081), two-decimal money
> display (LL-079), chart-aware categorisation that learns from corrections (LL-080/084), company deletion
> (LL-082), the master template company (LL-083), the account register (LL-085), team invitations with a
> role ceiling (LL-086), deleting an uploaded statement (LL-087), credit-card statement import (LL-088) and
> review-screen ignore controls (LL-089). ADRs 034–042. None of it had an independent review.
>
> This gate is a **human acceptance review** before real statements and a second user go through those
> paths. Three implementation-blind reviews were performed on `main` @ `39bb70f` — security & tenant
> isolation, accounting correctness, data integrity & schema — read-only, without touching the shared
> database. Every finding below was re-verified against the cited code by the author before ranking.
> **The sign-off in §7 is the human reviewer's** — Claude does not pass its own gate.
>
> **Headline for the reviewer.** The ledger engine and every posting path are sound: no finding corrupts
> money, balance, atomicity, immutability, tenancy or idempotency inside the new modules, and invariant 8
> (LedgerService only) holds. The findings sit at the **edges the new features created**: three HIGH items
> that must be fixed before this gate passes — (1) an invitation can be claimed by whoever registers the
> invited email, because sign-up is open and unverified; (2) a system control account can be turned into a
> "statement account" and then moved by imports with no document behind it; (3) the posting engine reads
> the company row unlocked, so template designation, settings edits and archiving can race a posting — plus
> six MEDIUM and a set of LOW/NOTE items, each with a proposed disposition in §6.

**Key term.** *Structural* = enforced by the database (holds even under raw SQL). *Conventional* =
enforced only by application code.

---

## 1. Checklist

| # | Item | Status |
|---|---|---|
| 1 | Every ticket LL-076 … LL-089 merged to `main` with green CI on merge | ✓ (#68–#92) |
| 2 | Migrations 0031–0036 expand-only; `drizzle-kit check` passes; no schema drift | ✓ (reviewed, §5c) |
| 3 | Production deployed at every merge; migrations applied | ✓ (production-deploy.yml, all success) |
| 4 | Independent security review | ✓ §5a — **1 HIGH, 1 MEDIUM, 3 LOW, 5 NOTE** |
| 5 | Independent accounting review | ✓ §5b — **2 HIGH, 2 MEDIUM, 5 LOW, 5 NOTE** |
| 6 | Independent data-integrity review | ✓ §5c — **1 HIGH, 2 MEDIUM, 6 LOW, 7 NOTE** |
| 7 | Findings consolidated, deduplicated and re-verified by the author | ✓ §6 |
| 8 | Human sign-off | ✓ §7 (2026-09-14) |

## 2. What was reviewed and how

Each reviewer received AGENTS.md, the relevant docs and ADRs, and the list of tickets — and was told to
trust nothing the docs claim. Read-only: `npm run lint`, `npx tsc --noEmit`, `npx vitest run --project unit`
(259/259), `npx drizzle-kit check` (pass) and a drift check (no schema changes) were run; the
integration and e2e suites were not (they wipe the shared dev database; CI is their proof, and every PR
was green there). The three reports are reproduced in condensed form in §5; the consolidated, re-verified
list with the author's proposed disposition is §6.

## 3. Invariant enforcement matrix — the new surface

| Invariant (AGENTS §4) | New path | Enforced by | Structural? |
|---|---|---|---|
| 1 Balanced entries | bank-import post/apply, template never posts | `postEntryCore` + deferred balance trigger | ✓ |
| 2 Derived balances | reconciliation figures, account register, dashboard | computed on read; no balance column added | ✓ (no column) |
| 3 Immutability | delete company purge, delete import batch | purge only with 0 POSTED/REVERSED entries; batch delete only with 0 POSTED lines; triggers unchanged | ✓ triggers |
| 4 Tenancy | every new table | `unique(company_id,id)` + composite FKs; isolation registry complete | ✓ |
| 5 Closed periods | import posting | period resolved before tx, re-checked in `postEntryCore`, DB trigger | ✓ |
| 6 Source-once | import lines, apply paths | line `FOR UPDATE` + `journal_entries_source_posted_once` | ✓ |
| 7 Atomicity | all new writes | Pool client transactions; no HTTP-client writes | ✓ (driver policy verified) |
| 8 LedgerService only | bank import, payment cores | only `src/server/ledger` inserts journal rows (verified by grep) | conventional (+fence) |
| Control accounts move only through documents | **bank import into A/R or A/P** | **NOT enforced** — see H2 | ✗ |
| Template never posts / settings lock | `postEntryCore` company read | **racy** — see H3 | ✗ until fixed |

## 4. Manual acceptance — owed by the product owner

The reviews are code-level. Two runtime checks remain with the owner and were requested at go-live:
upload the real bank statement once more and confirm every recommendation arrives pre-selected (LL-084);
reconcile the real statement to a zero difference (LL-078). With LL-088 the card statement can go through
the same two steps.

## 5. Independent implementation-blind reviews

### 5a. Security & tenant isolation

**Bottom line: no cross-tenant read or write through any authorized path; one HIGH at the boundary the
product itself does not control — who owns an email address.**

- **HIGH — invitations are claimed by whoever registers the invited email.** Sign-up is open
  (`src/lib/auth/index.ts` enables email+password with no verification; `src/app/sign-in/page.tsx` exposes
  self-registration) and `claimPendingInvitations` (`src/server/members/claim.ts`) grants the invited role to
  any app user whose email string matches. An OWNER invites `cfo@victim.example` as OWNER; anyone who
  learns that address signs up with it first and holds OWNER in the company on their next request — full
  ledger, `company.delete`, `user.manage`. Tests cover only the positive claim. ADR-041 never states the
  email-ownership assumption.
- **MEDIUM — the instance-wide template slot is claimable by any self-registered user** (`setCompanyTemplate`
  needs only OWNER of one's own company; ADR-039's "single operator" assumption is not enforced by the
  product). Attacker-authored account names/descriptions and settings would seed every new company; the
  operator cannot displace it.
- **LOW** — `postImportLinesAction` never `isUuid`-checks `batchId` (a malformed id is a 500, not a
  not-found); the `CARD_CANNOT_APPLY` block sits inside the per-decision loop (N queries, over-broad
  refusal); `inviteMember`'s add-vs-invite result is an account-existence oracle for anyone who creates a
  company, and it force-adds an existing user without their consent.
- **NOTE** — actor role is proven before the transaction (one stale privileged action after concurrent
  demotion; pre-existing pattern, last-owner rule still holds); gateway error messages are logged on any
  status (apply the 4xx allow-list); a stale PENDING invitation could overwrite a role when archived
  companies become reactivatable; `account/actions.ts` takes `companyId` from the form but every service
  re-authorizes (not a defect); `RETAINED_EARNINGS` is a pickable import category.
- **Sound:** role ceiling derived from the grant matrix and applied to granted, current and new roles;
  last-owner rule under the company row lock in every interleaving walked; uniform denials; Zod on every
  boundary; every bank-import/reconciliation/members action derives the company from the session cookie;
  purge order and audit; template copy limited to structure; the internal-module lint fence intact incl.
  dynamic imports; only PDF text, the pickable chart and past decisions leave the system; logs carry counts
  and codes only; no new routes or middleware; cookie flags; isolation registry complete.

### 5b. Accounting correctness

**Bottom line: no defect corrupts money, balance, atomicity, immutability, tenancy or idempotency inside
the new posting paths; the two HIGH items are the edges of "control accounts move only through documents"
and "a transaction posts exactly once".**

- **HIGH — a system account can become a statement account.** `updateAccount` spreads `accountSubtype`
  and `cashFlowCategory` onto any account, system accounts included; `isStatementAccount` never excludes a
  `systemAccountType`; the control-account trigger guards only `JOURNAL_ENTRY`. An ADMIN sets A/R's cash-flow
  section to CASH (or A/P's subtype to `credit_card`), imports a statement "into" it, and lines post to the
  control account with no invoice or bill — aging no longer equals control (GL-T018/T026 violated).
- **HIGH (author-triaged to MEDIUM, see §6 M1) — a transfer between two statement accounts double-posts**
  when both statements are imported: the checking statement's "payment to card" and the card statement's
  "payment received" each post the same entry. No invariant trips; both accounts are misstated by the
  transfer until reconciliation surfaces an unmatched line. Dedup is keyed per statement account, so it
  cannot see the mirror line.
- **MEDIUM** — credit-card sign correctness rests on one prompt sentence with no on-screen Charge/Payment
  label and no bulk flip (a model that signs charges positive inverts a whole statement, visibly only as
  amounts); the reconciliation "Update statement" form defaults the amount to `toInputAmount` (2 dp) and
  always submits it, so editing only the date rewrites a 4-dp stored figure.
- **LOW** — `postEntryCore` reads `isTemplate` before the counter lock (same root as §5c HIGH);
  `startReconciliation`'s date-after-last check runs outside the transaction; `normalizeDate` treats `d/m`
  as `m/d`; duplicate detection ignores STAGED lines in other batches; multi-line submit is per-line
  atomic while the docstring claims submit-atomic.
- **NOTE** — card guard placement; `isIdempotencyViolation` matches any duplicate key; a UI string
  comparison on money; stale comments; `-0.00` rendering.
- **Sound:** both import posting directions and the card sign convention given a correct sign; apply paths
  (direction, cumulative over-application, document locks, real payment documents); `normalize.ts` edge
  cases; every reconciliation rule and the liability sign; register ≡ trial balance for all six account
  types; template copy with the required-accounts guarantee; purge order and triggers; no JS number holds
  money anywhere; invariant 8.

### 5c. Data integrity & schema

**Bottom line: migrations are expand-only and replay cleanly; driver policy holds; every new table carries
the tenancy constraints; the one HIGH is a lock-ordering gap in the posting engine.**

- **HIGH — `postEntryCore` reads the company row unlocked** before `allocateEntryNumber` takes the counter
  lock, while `setCompanyTemplate`, `updateCompanySettings` and `deleteCompany` rely on "counter lock, then
  count posted entries" as their guarantee. A posting in flight passes the check, the designation / settings
  edit / archive commits, then the posting lands: a template with history, an entry whose period was
  derived from the old fiscal-year start and is now frozen by `SETTINGS_LOCKED`, or a post into an archived
  company. One-line fix: read the company row `FOR KEY SHARE` in `postEntryCore`.
- **MEDIUM** — `bank_import_lines → bank_import_batches` and `bank_reconciliation_lines →
  bank_reconciliations` are `ON DELETE CASCADE`, so only the service guards keep POSTED import lines and
  cleared reconciliation lines from vanishing with a raw parent delete (dedup would then forget them and a
  re-upload posts again); a stale PENDING invitation survives a direct add and the claim's unconditional
  upsert later **overwrites the member's role** (silent demotion audited as `MEMBER_ADDED`, bypassing the
  last-owner rule).
- **LOW** — the pre-existing `journal_entries_immutable` trigger returns `NEW` on DELETE of a DRAFT
  (cancels the delete; unreachable today); `PURGE_ORDER` is tested for set equality only, not order;
  `startReconciliation`'s sequence rule is app-only and outside the tx; archive-then-post window (same
  root as the HIGH). *Rejected after re-verification:* "the template safety net can skip a required
  account on a number collision" — `installChartFromTemplate` inserts any missing role unnumbered after
  the safety net, and `company-template.test.ts` ("squats on 1100") proves it.
- **NOTE** — `bank_import_lines` lacks status↔link CHECKs; `is_template` lacks a `status='ACTIVE'` CHECK;
  claim re-check of company status inside the tx; half-posted batches by design; 0033's UNIQUE build
  holds `ACCESS EXCLUSIVE` (fine at this size); CI ephemeral branches fork the project's default Neon
  branch without an explicit parent; no real-DB concurrency tests for delete-vs-post, double-submit, or
  save-vs-complete.
- **Sound:** all six migrations expand-only, correctly ordered, no enum value used in its own file,
  replay verified; migrator locking; every `getDb()` use is a read and every financial write is a Pool
  transaction; `deleteCompany` order walked against the full FK graph incl. self-references; `deleteImportBatch`
  safe in both race orders; claim/template/invite arbitration by partial unique indexes; `setCleared` /
  `completeReconciliation` locking; one-IN_PROGRESS is structural; tenancy constraints on all new tables;
  `truncateAll` guards; CI touches only ephemeral and preview branches.

## 6. Consolidated findings — author-verified, with proposed disposition

Severity is the author's after re-verifying each cited line; where it differs from a reviewer's it says so.
Dispositions are proposals for §7; nothing has been changed.

| # | Sev | Finding | Proposed disposition |
|---|---|---|---|
| H1 | HIGH | Invitation claimable by whoever registers the invited email (open, unverified sign-up) | **FIXED — [LL-090](tickets/LL-090.md)** (token join links; production sign-up invitation-only) — token-based invitations (no mail provider needed): a random secret handed over out of band, claimed by presenting it; until then refuse OWNER/ADMIN claims. Decide separately whether production sign-up stays open (§7 item 1). |
| H2 | HIGH | System control account can be made a statement account and moved by imports | **FIXED — [LL-091](tickets/LL-091.md)** (PR #96) — `isStatementAccount` excludes system roles; `updateAccount` refuses subtype/cash-flow edits on system accounts; extend the control-account trigger to `BANK_IMPORT`; exclude `RETAINED_EARNINGS` from pickable categories; GL regression. |
| H3 | HIGH | `postEntryCore` reads the company row unlocked → template / settings / archive races | **FIXED — [LL-092](tickets/LL-092.md)** (PR #95, merged) — `FOR KEY SHARE` on the company row in `postEntryCore`; concurrency test. Also closes §5b LOW-5 and §5c LOW-6. |
| M1 | MEDIUM (reviewer: HIGH) | Transfers between two statement accounts double-post | **FIXED — [LL-094](tickets/LL-094.md)**: staging flags the mirror; `match_transfer` posts once; the exact mirror is refused. |
| M2 | MEDIUM | Template slot claimable by any self-registered user | **FIXED — LL-090** (no self-registration in production). If sign-up stays open: operator allow-list for `setCompanyTemplate`. |
| M3 | MEDIUM | Stale PENDING invitation overwrites a role on claim; direct add does not resolve it | **FIXED — LL-090**: resolve pending invitations on direct add; conditional upsert (only INACTIVE reactivates); company lock in the claim. |
| M4 | MEDIUM | Reconciliation update form rewrites 4-dp amount as 2-dp | **FIXED — [LL-093](tickets/LL-093.md)**: only changed fields are sent. |
| M5 | MEDIUM | Card sign depends on the prompt; no Charge/Payment label or flip control | Ticket — derived Charge/Payment column on card batches, "flip all signs", staging warning when a card statement is mostly positive. |
| M6 | MEDIUM→LOW (author) | `ON DELETE CASCADE` on the two statement line tables | **FIXED — [LL-095](tickets/LL-095.md)** (RESTRICT, migration 0039). |
| L1 | LOW | `postImportLinesAction` batch id unvalidated | **FIXED — LL-093**. |
| L2 | LOW | Card guard inside the decision loop | **FIXED — LL-093**. |
| L3 | LOW | Add-vs-invite oracle and forced membership of existing users | Decide in §7: keep (documented) or make invitations always require acceptance. |
| L4 | LOW | `startReconciliation` sequence check outside the tx | **FIXED — LL-095** (under the account row lock; completion takes it too). |
| L5 | LOW | Duplicate detection ignores STAGED lines in other batches | **FIXED — LL-095** ("also staged in another import"). |
| L6 | LOW | `normalizeDate` assumes US month/day | **DOCUMENTED — LL-095**: US locale is the product assumption (ADR-034); impossible months are no longer swapped. |
| L7 | LOW | `PURGE_ORDER` order untested; `journal_entries_immutable` returns NEW on DRAFT delete | **FIXED — LL-095** (topological test; trigger replaced). |
| N1–N9 | NOTE | Gateway-error log allow-list; broad `isIdempotencyViolation`; UI money string compare; stale comments; `-0.00`; missing CHECKs on `bank_import_lines`/`is_template`; CI branch parent pin; concurrency test gaps; actor proven outside tx | **FIXED — LL-095** except the actor-outside-tx note (accepted: the last-owner rule reads live rows) and the transfer mirror, which is now structural (`mirror_of_line_id` unique). |

## 7. Human sign-off

Decisions requested of the product owner:

1. **Open sign-up on the production URL.** DECIDED (2026-09-14): invitation-only; links copied and sent by
   the owner. Implemented in LL-090.
2. **Accept the proposed dispositions in §6**, or adjust severities/order. H1–H3 are proposed as
   blocking: the gate passes when LL-090/091/092 are merged and the "fix now" items (M4, L1, L2) ship.
3. **L3** — keep the add-vs-invite behaviour (documented in ADR-041) or require acceptance for every invite.
4. **Manual acceptance (§4)** — the real-statement re-upload and reconciliation.

| Reviewer | Decision | Date |
|---|---|---|
| Lance (Lancetvsign) | **Approved.** Sign-up made invitation-only (item 1); dispositions in §6 accepted (item 2); H1–H3 and M2/M3 fixed and deployed via LL-090/091/092 (PRs #97, #96, #95) before this sign-off; L3 kept as documented; manual acceptance (§4) remains owed. | 2026-09-14 |
