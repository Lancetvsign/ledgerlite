ALTER TYPE "public"."audit_action" ADD VALUE 'BANK_IMPORT_ASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BANK_IMPORT_UNASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BANK_IMPORT_SHARING_CHANGED';--> statement-breakpoint
ALTER TYPE "public"."bank_import_line_status" ADD VALUE 'ASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."bank_import_line_status" ADD VALUE 'PERSONAL';--> statement-breakpoint
ALTER TABLE "bank_import_lines" DROP CONSTRAINT "bank_import_lines_posted_has_entry";--> statement-breakpoint
ALTER TABLE "bank_import_lines" DROP CONSTRAINT "bank_import_lines_targets_only_when_posted";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "intercompany_group_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "shared_with_organization" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD COLUMN "assigned_company_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD COLUMN "assigned_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_assigned_company_id_companies_id_fk" FOREIGN KEY ("assigned_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_assigned_entry_same_assigned_company_fk" FOREIGN KEY ("assigned_company_id","assigned_journal_entry_id") REFERENCES "public"."journal_entries"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_intercompany_group_company_unique" UNIQUE("intercompany_group_id","company_id");--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_assigned_journal_entry_id_unique" UNIQUE("assigned_journal_entry_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_group_only_intercompany" CHECK ("journal_entries"."intercompany_group_id" is null or "journal_entries"."source_type"::text = 'INTERCOMPANY');--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_assigned_shape" CHECK (num_nonnulls("bank_import_lines"."assigned_company_id", "bank_import_lines"."assigned_journal_entry_id") = (case when "bank_import_lines"."status"::text = 'ASSIGNED' then 2 else 0 end) and ("bank_import_lines"."assigned_company_id" is null or "bank_import_lines"."assigned_company_id" <> "bank_import_lines"."company_id") and ("bank_import_lines"."assigned_journal_entry_id" is null or "bank_import_lines"."assigned_journal_entry_id" <> "bank_import_lines"."journal_entry_id"));--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_personal_has_account" CHECK ("bank_import_lines"."status"::text <> 'PERSONAL' or "bank_import_lines"."chosen_account_id" is not null);--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_posted_has_entry" CHECK (("bank_import_lines"."status"::text in ('POSTED', 'PERSONAL', 'ASSIGNED')) = ("bank_import_lines"."journal_entry_id" is not null));--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_targets_only_when_posted" CHECK ("bank_import_lines"."status"::text in ('POSTED', 'PERSONAL') or num_nonnulls("bank_import_lines"."chosen_account_id", "bank_import_lines"."payment_id", "bank_import_lines"."bill_payment_id", "bank_import_lines"."mirror_of_line_id") = 0);--> statement-breakpoint
-- LL-097 (ADR-043): journal_entries.intercompany_group_id joins the columns a POSTED entry may never
-- change, including on the POSTED -> REVERSED transition. Body otherwise identical to 0039.
CREATE OR REPLACE FUNCTION "journal_entries_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: a posted entry cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'REVERSED'
     AND OLD."status" = 'POSTED'
     AND OLD."reversed_by_id" IS NULL
     AND NEW."reversed_by_id" IS NOT NULL
     AND NEW."id"               IS NOT DISTINCT FROM OLD."id"
     AND NEW."company_id"       IS NOT DISTINCT FROM OLD."company_id"
     AND NEW."entry_number"     IS NOT DISTINCT FROM OLD."entry_number"
     AND NEW."transaction_date" IS NOT DISTINCT FROM OLD."transaction_date"
     AND NEW."posting_date"     IS NOT DISTINCT FROM OLD."posting_date"
     AND NEW."description"      IS NOT DISTINCT FROM OLD."description"
     AND NEW."source_type"      IS NOT DISTINCT FROM OLD."source_type"
     AND NEW."source_id"        IS NOT DISTINCT FROM OLD."source_id"
     AND NEW."idempotency_key"  IS NOT DISTINCT FROM OLD."idempotency_key"
     AND NEW."idempotency_fingerprint" IS NOT DISTINCT FROM OLD."idempotency_fingerprint"
     AND NEW."reversal_of_id"   IS NOT DISTINCT FROM OLD."reversal_of_id"
     AND NEW."intercompany_group_id" IS NOT DISTINCT FROM OLD."intercompany_group_id"
     AND NEW."created_by"       IS NOT DISTINCT FROM OLD."created_by"
     AND NEW."created_at"       IS NOT DISTINCT FROM OLD."created_at"
     AND NEW."posted_at"        IS NOT DISTINCT FROM OLD."posted_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: a posted entry may only transition to REVERSED'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
-- LL-097: an INTERCOMPANY posting is a non-document source like a manual entry — it may never move
-- Accounts Receivable / Accounts Payable in the receiving company. Both 0040 functions replaced in
-- place with 'INTERCOMPANY' added to the A/R–A/P blocked list; the Due-account allow-list is unchanged.
CREATE OR REPLACE FUNCTION "assert_no_manual_post_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_system_type text;
  v_source text;
BEGIN
  SELECT "system_account_type" INTO v_system_type
    FROM "accounts"
    WHERE "company_id" = NEW."company_id" AND "id" = NEW."account_id";

  IF v_system_type IS NULL
     OR v_system_type NOT IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE') THEN
    RETURN NEW;
  END IF;

  SELECT "source_type"::text INTO v_source
    FROM "journal_entries"
    WHERE "id" = NEW."journal_entry_id";

  IF v_system_type IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')
     AND v_source IN ('JOURNAL_ENTRY', 'BANK_IMPORT', 'OPENING_BALANCE', 'INTERCOMPANY') THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual, imported or opening-balance entry may not post to a control account (Accounts Receivable / Accounts Payable)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_system_type IN ('INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE')
     AND v_source NOT IN ('INTERCOMPANY', 'REVERSAL') THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: only an intercompany posting or its reversal may move an intercompany account (Due from / Due to)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_no_manual_relabel_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'POSTED' THEN
    IF NEW."source_type"::text IN ('JOURNAL_ENTRY', 'BANK_IMPORT', 'OPENING_BALANCE', 'INTERCOMPANY') AND EXISTS (
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
    IF NEW."source_type"::text NOT IN ('INTERCOMPANY', 'REVERSAL') AND EXISTS (
      SELECT 1
        FROM "journal_lines" l
        JOIN "accounts" a
          ON a."company_id" = l."company_id" AND a."id" = l."account_id"
       WHERE l."journal_entry_id" = NEW."id"
         AND a."system_account_type" IN ('INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE')
    ) THEN
      RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: only an intercompany posting or its reversal may move an intercompany account (Due from / Due to)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
