ALTER TYPE "public"."audit_action" ADD VALUE 'BANK_IMPORT_LINE_AMENDED';--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD COLUMN "amended_from" numeric(19, 4);--> statement-breakpoint
-- ===========================================================================
-- LL-107 (ADR-046) — a decided import line's amount is frozen, structurally.
--
-- A STAGED line's amount may be corrected by the reviewer (the extractor misread a digit);
-- the figure it read is kept in amended_from and the correction is audited. Once the line has
-- been decided — posted, ignored, marked personal, taken by another company, marked or
-- matched as a transfer — its amount is what the ledger and the reconciliation carry, and it
-- must never drift from that, even under raw SQL. Status compared as text; idempotent
-- (CREATE OR REPLACE + DROP TRIGGER IF EXISTS) for the CI clean-slate replay.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "assert_import_line_amount_editable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text <> 'STAGED' AND NEW."amount" IS DISTINCT FROM OLD."amount" THEN
    RAISE EXCEPTION 'LINE_NOT_STAGED: the amount of a decided import line cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bank_import_lines_amount_frozen_when_decided" ON "bank_import_lines";
--> statement-breakpoint
CREATE TRIGGER "bank_import_lines_amount_frozen_when_decided"
  BEFORE UPDATE OF "amount" ON "bank_import_lines"
  FOR EACH ROW EXECUTE FUNCTION "assert_import_line_amount_editable"();
