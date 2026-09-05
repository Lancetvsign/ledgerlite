-- Accounts-Receivable control-account guard — LL-050 PR2 (ADR-016 / ADR-018).
--
-- The A/R aging is a SUBSIDIARY ledger that must reconcile to the A/R CONTROL
-- balance in the general ledger (GL-T018). That tie holds only because A/R is moved
-- solely by document paths the subsidiary can see — invoices, payments, and bad-debt
-- write-offs (and their reversals). A raw MANUAL journal entry to A/R would move the
-- control without moving the subsidiary, breaking the reconciliation with nothing to
-- detect it (ADR-016 recorded this as the last open gap). This trigger makes the rule
-- STRUCTURAL: it holds even when the application is bypassed (a raw INSERT).
--
-- Scope is A/R ONLY (the one control account with a subsidiary). Other system
-- accounts (Sales Tax Payable, Retained Earnings, Opening Balance Equity) stay
-- manually postable — legitimate for tax corrections, year-end closing, and
-- opening-balance setup. The guard keys off the PARENT entry's source_type: the
-- manual path is 'JOURNAL_ENTRY'; documents ('INVOICE', 'CUSTOMER_PAYMENT',
-- 'BAD_DEBT_WRITEOFF') and 'REVERSAL' are allowed, so a future document type that
-- posts to A/R needs no change here. The parent journal_entries row is inserted
-- before its lines, so it is readable at line-insert time (the same read the
-- immutability trigger `journal_lines_immutable` does).
CREATE OR REPLACE FUNCTION "assert_no_manual_post_to_ar"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_system_type text;
  v_source "journal_source_type";
BEGIN
  SELECT "system_account_type" INTO v_system_type
    FROM "accounts"
    WHERE "company_id" = NEW."company_id" AND "id" = NEW."account_id";

  -- Only the Accounts Receivable control account is guarded here.
  IF v_system_type IS DISTINCT FROM 'ACCOUNTS_RECEIVABLE' THEN
    RETURN NEW;
  END IF;

  SELECT "source_type" INTO v_source
    FROM "journal_entries"
    WHERE "id" = NEW."journal_entry_id";

  IF v_source = 'JOURNAL_ENTRY' THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual journal entry may not post to the Accounts Receivable control account'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "journal_lines_no_manual_ar_post"
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "assert_no_manual_post_to_ar"();
