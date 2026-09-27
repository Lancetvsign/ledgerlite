ALTER TABLE "bank_import_lines" ADD COLUMN "amended_date_from" date;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD COLUMN "amended_description_from" text;--> statement-breakpoint
-- ===========================================================================
-- LL-112 (ADR-046 amendment) — a decided import line's date and description are frozen too.
--
-- LL-107 froze the amount of a decided line. A STAGED line's date and description may now be
-- corrected by the reviewer as well (the extractor misread them); the values it read are kept in
-- amended_date_from / amended_description_from and the correction is audited. Once decided, the
-- date is the entry's posting date and the description its memo — they must never drift, even
-- under raw SQL. Same function and trigger names; idempotent for the CI clean-slate replay.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "assert_import_line_amount_editable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text <> 'STAGED' AND (
       NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."txn_date" IS DISTINCT FROM OLD."txn_date"
    OR NEW."description" IS DISTINCT FROM OLD."description"
  ) THEN
    RAISE EXCEPTION 'LINE_NOT_STAGED: the amount, date and description of a decided import line cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bank_import_lines_amount_frozen_when_decided" ON "bank_import_lines";
--> statement-breakpoint
CREATE TRIGGER "bank_import_lines_amount_frozen_when_decided"
  BEFORE UPDATE OF "amount", "txn_date", "description" ON "bank_import_lines"
  FOR EACH ROW EXECUTE FUNCTION "assert_import_line_amount_editable"();
