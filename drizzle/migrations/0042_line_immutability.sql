ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_link_consistent" CHECK (("journal_entries"."source_type"::text = 'REVERSAL') = ("journal_entries"."reversal_of_id" is not null));--> statement-breakpoint
-- ===========================================================================
-- LL-104 (Gate 7 M5 / 5c L4 / 5c N4) — structural line immutability, ADR-044.
--
-- INVARIANT 3: a posted entry is immutable. journal_lines_immutable (0006, widened to
-- REVERSED in 0020) fired on UPDATE OR DELETE only, so a raw balanced pair of lines
-- could be APPENDED to any POSTED or REVERSED entry — the deferred balance trigger only
-- asks that the entry still balance, and on an INTERCOMPANY entry the Due-account
-- allow-list admits the append. The trigger now fires on INSERT too, with NO escape
-- hatch: nothing may add a line under a POSTED/REVERSED entry, the engine included.
-- LedgerService therefore posts by TRANSITION — the entry is inserted as a DRAFT, its
-- lines are added, and the last statement flips it to POSTED (postEntryCore /
-- reverseEntryCore). The 0025 remark "postEntryCore INSERTs entries already POSTED" is
-- historical from this migration on.
--
-- Function body unchanged apart from the message (for INSERT, OLD is NULL and the
-- COALESCE resolves to NEW). Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS),
-- like 0023/0025, for the CI clean-slate replay.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "journal_lines_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status "journal_status";
BEGIN
  SELECT "status" INTO v_status FROM "journal_entries"
    WHERE "id" = COALESCE(OLD."journal_entry_id", NEW."journal_entry_id");
  IF v_status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: lines of a posted or reversed entry cannot be added, changed or deleted (%)', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "journal_lines_no_mutate_posted" ON "journal_lines";
--> statement-breakpoint
CREATE TRIGGER "journal_lines_no_mutate_posted"
  BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "journal_lines_immutable"();
--> statement-breakpoint
-- The closed-period guard (0010, ADR-012) fired on INSERT of a POSTED row only; now that
-- posting is a DRAFT -> POSTED transition it must judge that UPDATE as well (Gate 7 5c N4
-- — the bypass existed before, for a raw relabel). Same function: it reads the containing
-- period FOR SHARE, so a close in flight and a posting in flight still serialise. The
-- INSERT trigger stays, so a raw INSERT of a POSTED row remains guarded.
DROP TRIGGER IF EXISTS "journal_entries_posting_period_open_on_post" ON "journal_entries";
--> statement-breakpoint
CREATE TRIGGER "journal_entries_posting_period_open_on_post"
  BEFORE UPDATE OF "status" ON "journal_entries"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM 'POSTED' AND NEW."status" = 'POSTED')
  EXECUTE FUNCTION "assert_posting_period_open"();
