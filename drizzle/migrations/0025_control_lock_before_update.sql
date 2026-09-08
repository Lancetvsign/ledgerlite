-- Manual-relabel control-account guard — LL-066 (ADR-025).
--
-- The 0023 BEFORE INSERT guard (assert_no_manual_post_to_control_account) blocks a
-- JOURNAL_ENTRY-sourced line into an A/R or A/P control account at INSERT time — but it
-- reads the PARENT entry's source_type, and journal_entries_immutable (0020) leaves a
-- DRAFT entry mutable. So a raw-SQL path could insert a DRAFT entry sourced 'EXPENSE'
-- (whose control lines the INSERT guard allows — EXPENSE is a document source, not
-- JOURNAL_ENTRY), then UPDATE it to source_type 'JOURNAL_ENTRY' / status 'POSTED',
-- landing a manual entry on a control account and evading the INSERT guard.
--
-- This BEFORE UPDATE guard closes that relabel path: when an entry is (or becomes)
-- POSTED as JOURNAL_ENTRY, none of its lines may reference A/R or A/P. The application
-- never reaches it — postEntryCore INSERTs entries already POSTED, and reversal sets
-- reversed_by_id / status='REVERSED', never status='POSTED' via UPDATE — so it fires
-- only on the raw-SQL relabel attack: pure defense-in-depth, making the manual-post lock
-- structural (holds even under raw SQL). Idempotent (CREATE OR REPLACE FUNCTION + DROP
-- TRIGGER IF EXISTS) so the CI clean-slate replay, which keeps functions, does not error
-- — matching 0018/0023.

CREATE OR REPLACE FUNCTION "assert_no_manual_relabel_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Only the terminal state that would evade the INSERT guard: a POSTED manual entry.
  -- A reversal UPDATE (status -> 'REVERSED') and any non-POSTED transition fall through.
  IF NEW."status" = 'POSTED' AND NEW."source_type" = 'JOURNAL_ENTRY' THEN
    IF EXISTS (
      SELECT 1
        FROM "journal_lines" l
        JOIN "accounts" a
          ON a."company_id" = l."company_id" AND a."id" = l."account_id"
       WHERE l."journal_entry_id" = NEW."id"
         AND a."system_account_type" IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')
    ) THEN
      RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual journal entry may not post to a control account (Accounts Receivable / Accounts Payable)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "journal_entries_no_manual_relabel" ON "journal_entries";--> statement-breakpoint
CREATE TRIGGER "journal_entries_no_manual_relabel"
  BEFORE UPDATE OF "status", "source_type" ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "assert_no_manual_relabel_to_control_account"();
