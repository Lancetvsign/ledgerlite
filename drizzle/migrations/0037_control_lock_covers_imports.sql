-- LL-091 / Gate 6 H2: the control-account lock covers every NON-DOCUMENT source.
-- 0018/0023/0025 refused a JOURNAL_ENTRY line into Accounts Receivable / Accounts Payable
-- so the aging ⇔ control tie holds even under raw SQL. Bank-statement import (BANK_IMPORT)
-- and opening balances (OPENING_BALANCE) are equally non-document sources — the services
-- already exclude the control accounts as categories, but nothing structural did. Both
-- functions are replaced in place (CREATE OR REPLACE; the triggers are unchanged), so this
-- is expand-only and idempotent like its predecessors. Documents (INVOICE, CUSTOMER_PAYMENT,
-- EXPENSE, BILL_PAYMENT, CREDIT_MEMO, VENDOR_CREDIT, BAD_DEBT_WRITEOFF), REVERSAL and CLOSING
-- stay allowed. The exception text keeps the CONTROL_ACCOUNT_MANUAL_POST prefix the service
-- maps to its typed error.
CREATE OR REPLACE FUNCTION "assert_no_manual_post_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_system_type text;
  v_source "journal_source_type";
BEGIN
  SELECT "system_account_type" INTO v_system_type
    FROM "accounts"
    WHERE "company_id" = NEW."company_id" AND "id" = NEW."account_id";

  -- Only control accounts that HAVE a subsidiary ledger are guarded: A/R and A/P.
  IF v_system_type IS NULL
     OR v_system_type NOT IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE') THEN
    RETURN NEW;
  END IF;

  SELECT "source_type" INTO v_source
    FROM "journal_entries"
    WHERE "id" = NEW."journal_entry_id";

  IF v_source IN ('JOURNAL_ENTRY', 'BANK_IMPORT', 'OPENING_BALANCE') THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual, imported or opening-balance entry may not post to a control account (Accounts Receivable / Accounts Payable)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_no_manual_relabel_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'POSTED' AND NEW."source_type" IN ('JOURNAL_ENTRY', 'BANK_IMPORT', 'OPENING_BALANCE') THEN
    IF EXISTS (
      SELECT 1
        FROM "journal_lines" l
        JOIN "accounts" a
          ON a."company_id" = l."company_id" AND a."id" = l."account_id"
       WHERE l."journal_entry_id" = NEW."id"
         AND a."system_account_type" IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')
    ) THEN
      RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual, imported or opening-balance entry may not post to a control account (Accounts Receivable / Accounts Payable)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
