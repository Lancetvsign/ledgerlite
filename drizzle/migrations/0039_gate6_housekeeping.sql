ALTER TABLE "bank_import_lines" DROP CONSTRAINT "bank_import_lines_batch_same_company_fk";
--> statement-breakpoint
ALTER TABLE "bank_reconciliation_lines" DROP CONSTRAINT "bank_reconciliation_lines_reconciliation_same_account_fk";
--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD COLUMN "mirror_of_line_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_mirror_same_company_fk" FOREIGN KEY ("company_id","mirror_of_line_id") REFERENCES "public"."bank_import_lines"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_batch_same_company_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."bank_import_batches"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_lines" ADD CONSTRAINT "bank_reconciliation_lines_reconciliation_same_account_fk" FOREIGN KEY ("company_id","reconciliation_id","bank_account_id") REFERENCES "public"."bank_reconciliations"("company_id","id","bank_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_mirror_of_line_id_unique" UNIQUE("mirror_of_line_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_template_is_active" CHECK (not "companies"."is_template" or "companies"."status" = 'ACTIVE');--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_posted_has_entry" CHECK (("bank_import_lines"."status" = 'POSTED') = ("bank_import_lines"."journal_entry_id" is not null));--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_targets_only_when_posted" CHECK ("bank_import_lines"."status" = 'POSTED' or num_nonnulls("bank_import_lines"."chosen_account_id", "bank_import_lines"."payment_id", "bank_import_lines"."bill_payment_id", "bank_import_lines"."mirror_of_line_id") = 0);--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_amount_nonzero" CHECK ("bank_import_lines"."amount" <> 0);--> statement-breakpoint
-- LL-095 (Gate 6 L7): journal_entries_immutable returned NEW for a DRAFT on DELETE — NULL in a
-- BEFORE DELETE trigger, which silently cancelled the delete. Return the row that applies.
-- Behaviour for POSTED/REVERSED rows is unchanged. Idempotent (CREATE OR REPLACE).
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
     AND NEW."created_by"       IS NOT DISTINCT FROM OLD."created_by"
     AND NEW."created_at"       IS NOT DISTINCT FROM OLD."created_at"
     AND NEW."posted_at"        IS NOT DISTINCT FROM OLD."posted_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: a posted entry may only transition to REVERSED'
    USING ERRCODE = 'restrict_violation';
END;
$$;
