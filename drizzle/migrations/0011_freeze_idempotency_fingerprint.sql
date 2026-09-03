-- ===========================================================================
-- Close a gap in the LL-030 posted-entry immutability trigger.
--
-- INVARIANT 7 (migration 0006) permits exactly one change to a POSTED entry:
-- status POSTED -> REVERSED with reversed_by_id going NULL -> set, and EVERY
-- other column held IS NOT DISTINCT FROM OLD. That frozen-column list was written
-- for the journal_entries table as it stood at 0006. Migration 0008 later added
-- "idempotency_fingerprint" but did NOT extend the list, so a raw UPDATE could
-- flip a posted entry to REVERSED while also rewriting idempotency_fingerprint —
-- a change the invariant is supposed to forbid.
--
-- This CREATE OR REPLACE reinstalls journal_entries_immutable() verbatim from
-- 0006 with a single added assertion freezing idempotency_fingerprint too, so the
-- permitted transition once again changes NOTHING beyond status + reversed_by_id.
-- The trigger journal_entries_no_mutate_posted already references this function by
-- name, so it is not dropped or recreated; the new body takes effect immediately.
-- Function replacement only: no table, column, data, or constraint object changes.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "journal_entries_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'POSTED' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: a posted entry cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" = 'REVERSED'
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
