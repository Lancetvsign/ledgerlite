-- Closed-period structural guard — Gate 2 remediation (invariant 5 / ADR-012).
--
-- Until now "no posting into a CLOSED period" (AGENTS §4.5) lived ONLY in
-- LedgerService: a raw INSERT bypassed it entirely, and an in-flight post could
-- race a concurrent close and commit into a period that closed underneath it
-- (the LL-036 adversarial pass documented that TOCTOU window). This trigger makes
-- the rule STRUCTURAL and closes the race in one move.
--
-- It fires only for POSTED entries — a DRAFT carries no ledger effect. It reads the
-- containing period FOR SHARE, and that shared lock is held until the posting
-- commits: closePeriod's UPDATE takes a row-exclusive lock, so it must WAIT for any
-- in-flight post, and a post that begins after the close commits sees CLOSED and is
-- refused. The lock and the status read are one statement, so there is no window
-- between "checked open" and "committed". Concurrent posts into the same period take
-- compatible share locks and never block each other (they already serialise on the
-- per-company counter regardless), so the only interaction is post-vs-close.
--
-- A posting_date with NO period row is deliberately left alone: the application
-- always creates the OPEN period before posting, and a period-less POSTED row is a
-- separate anomaly out of scope for invariant 5 (see ADR-012). This keeps the guard
-- surgical and changes no existing behaviour for open periods.
CREATE OR REPLACE FUNCTION "assert_posting_period_open"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status "period_status";
BEGIN
  SELECT "status" INTO v_status
    FROM "accounting_periods"
    WHERE "company_id" = NEW."company_id"
      AND NEW."posting_date" BETWEEN "start_date" AND "end_date"
    FOR SHARE;

  IF FOUND AND v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: posting_date % falls in a closed accounting period', NEW."posting_date"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "journal_entries_posting_period_open"
  BEFORE INSERT ON "journal_entries"
  FOR EACH ROW
  WHEN (NEW."status" = 'POSTED')
  EXECUTE FUNCTION "assert_posting_period_open"();
