-- ===========================================================================
-- LL-121 (ADR-044 amendment) — a reversal is never dated before the entry it reverses.
--
-- The service resolves every reversal's date against the locked original first (a chosen date
-- before it is refused, REVERSAL_BEFORE_ORIGINAL; a defaulted "today" is lifted to the original's
-- date). This trigger makes the rule structural: any row that links to an original
-- (a REVERSAL row with its reversal_of_id) may not carry a posting_date earlier than that original's.
-- A row of any other source type carrying reversal_of_id is a SHAPE error, left to the CHECK
-- journal_entries_reversal_link_consistent (0042) so it keeps its own message. It fires only when
-- posting_date, reversal_of_id or source_type is written, so a status transition of an existing row is never
-- re-checked. The original is found by id alone (journal_entries_reversal_of_fk guarantees it exists),
-- so the check can never be skipped by a company mismatch. Idempotent for the CI replay.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "assert_reversal_not_before_original"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  original_posting date;
BEGIN
  SELECT "posting_date" INTO original_posting
  FROM "journal_entries"
  WHERE "id" = NEW."reversal_of_id";
  IF original_posting IS NOT NULL AND NEW."posting_date" < original_posting THEN
    RAISE EXCEPTION 'REVERSAL_BEFORE_ORIGINAL: a reversal dated % precedes the entry it reverses (%)',
      NEW."posting_date", original_posting
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "journal_entries_reversal_not_before_original" ON "journal_entries";
--> statement-breakpoint
CREATE TRIGGER "journal_entries_reversal_not_before_original"
  BEFORE INSERT OR UPDATE OF "posting_date", "reversal_of_id", "source_type" ON "journal_entries"
  FOR EACH ROW
  WHEN (NEW."source_type"::text = 'REVERSAL' AND NEW."reversal_of_id" IS NOT NULL)
  EXECUTE FUNCTION "assert_reversal_not_before_original"();
