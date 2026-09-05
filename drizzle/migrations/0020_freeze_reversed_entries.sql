-- ===========================================================================
-- Extend posted-entry immutability to REVERSED entries — LL-052 (Gate 2 §7 item 6).
--
-- INVARIANT 3/7: a posted entry is immutable, corrected only by reversal. The
-- LL-030 triggers (0006), with the 0011 fingerprint fix, froze entries while
-- status = 'POSTED' and permitted exactly the POSTED -> REVERSED transition. But
-- once an entry became REVERSED it fell OUT of the guard: `IF OLD.status <> 'POSTED'
-- THEN RETURN NEW` let any later UPDATE/DELETE of a reversed original — or of its
-- lines — through. A reversed entry is history; it must be as immutable as a posted
-- one.
--
-- Both functions are CREATE OR REPLACE only (function-body replacement, verbatim
-- from 0011/0006 apart from the widened guard). The triggers
-- journal_entries_no_mutate_posted / journal_lines_no_mutate_posted reference these
-- by name, so they are not dropped or recreated; the new bodies take effect
-- immediately. No table, column, data, or constraint object changes.
--
-- The change: only a DRAFT is freely editable. A POSTED entry still allows exactly
-- the POSTED -> REVERSED transition (a reversed original already has reversed_by_id
-- set, so a further UPDATE cannot re-take that branch and falls to the RAISE); a
-- DELETE of either raises; and a REVERSED entry's lines are now frozen too. Nothing
-- in the application mutates a REVERSED entry — reversal only ever drives the one
-- transition — so no legitimate path is affected.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "journal_entries_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
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

  RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: a posted or reversed entry may only transition POSTED -> REVERSED'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_lines_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status "journal_status";
BEGIN
  SELECT "status" INTO v_status FROM "journal_entries"
    WHERE "id" = COALESCE(OLD."journal_entry_id", NEW."journal_entry_id");
  IF v_status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: lines of a posted or reversed entry cannot be %', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
