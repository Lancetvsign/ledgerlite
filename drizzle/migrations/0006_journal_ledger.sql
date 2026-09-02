CREATE TYPE "public"."journal_source_type" AS ENUM('INVOICE', 'CUSTOMER_PAYMENT', 'CUSTOMER_REFUND', 'CREDIT_MEMO', 'EXPENSE', 'DEPOSIT', 'TRANSFER', 'JOURNAL_ENTRY', 'OPENING_BALANCE', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TABLE "company_counters" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"next_entry_number" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_number" bigint,
	"transaction_date" date NOT NULL,
	"posting_date" date NOT NULL,
	"description" text,
	"status" "journal_status" DEFAULT 'DRAFT' NOT NULL,
	"source_type" "journal_source_type" NOT NULL,
	"source_id" text,
	"idempotency_key" text,
	"reversal_of_id" uuid,
	"reversed_by_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "journal_entries_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"customer_id" uuid,
	"vendor_id" uuid,
	"description" text,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_entry_line_number_unique" UNIQUE("journal_entry_id","line_number"),
	CONSTRAINT "journal_lines_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "journal_lines_sign" CHECK (
      "journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0
      and ("journal_lines"."debit" > 0) <> ("journal_lines"."credit" > 0)
    )
);
--> statement-breakpoint
ALTER TABLE "company_counters" ADD CONSTRAINT "company_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_same_company_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_same_company_fk" FOREIGN KEY ("company_id","journal_entry_id") REFERENCES "public"."journal_entries"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_idempotency_unique" ON "journal_entries" USING btree ("company_id","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_posted_once" ON "journal_entries" USING btree ("company_id","source_type","source_id") WHERE status = 'POSTED' and source_id is not null;--> statement-breakpoint
CREATE INDEX "journal_entries_company_txn_date_idx" ON "journal_entries" USING btree ("company_id","transaction_date");--> statement-breakpoint
CREATE INDEX "journal_entries_company_status_idx" ON "journal_entries" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "journal_lines_company_account_idx" ON "journal_lines" USING btree ("company_id","account_id");--> statement-breakpoint
-- ===========================================================================
-- HAND-WRITTEN: the two invariants Drizzle cannot express. Read carefully.
-- Functions are defined BEFORE the triggers that reference them.
-- ===========================================================================

-- Backfill company_counters for every EXISTING company (ADR-003: one row per
-- company). Companies created after this get theirs in createCompanyWithOwner.
INSERT INTO "company_counters" ("company_id", "next_entry_number")
  SELECT "id", 1 FROM "companies"
  ON CONFLICT ("company_id") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- INVARIANT 6 — debits equal credits, at COMMIT, for POSTED entries only.
--
-- One function, keyed off the entry id, shared by two DEFERRABLE constraint
-- triggers (one on lines, one on entries). DEFERRABLE INITIALLY DEFERRED so the
-- check runs at COMMIT — lines arrive one at a time and an entry is legitimately
-- unbalanced mid-transaction. A DRAFT is never checked (that is what draft is);
-- a POSTED entry must have >= 2 lines and balance exactly at NUMERIC(19,4).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "assert_entry_balanced"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id uuid;
  v_status   "journal_status";
  v_lines    integer;
  v_debits   numeric(19,4);
  v_credits  numeric(19,4);
BEGIN
  -- The entry id, from whichever table fired: journal_lines rows carry
  -- journal_entry_id; journal_entries rows carry id.
  IF TG_TABLE_NAME = 'journal_lines' THEN
    v_entry_id := COALESCE(NEW."journal_entry_id", OLD."journal_entry_id");
  ELSE
    v_entry_id := COALESCE(NEW."id", OLD."id");
  END IF;

  SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = v_entry_id;

  -- Entry gone (cascade delete) or not POSTED → nothing to enforce.
  IF v_status IS NULL OR v_status <> 'POSTED' THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO v_lines, v_debits, v_credits
    FROM "journal_lines" WHERE "journal_entry_id" = v_entry_id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'POSTED entry % has % line(s); at least 2 are required', v_entry_id, v_lines
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL_ENTRY: entry % debits % <> credits %',
      v_entry_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_lines_balanced"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_entry_balanced"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_entries_balanced"
  AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_entry_balanced"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- INVARIANT 7 — posted entries are immutable.
--
-- Once status = 'POSTED', the ONLY permitted change is POSTED → REVERSED with
-- reversed_by_id going NULL → set and NOTHING else altered. Every other update,
-- and any delete, of a posted entry (or a line of one) raises
-- POSTED_ENTRY_IMMUTABLE. Drafts remain freely editable.
-- ---------------------------------------------------------------------------
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
--> statement-breakpoint
CREATE TRIGGER "journal_entries_no_mutate_posted"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "journal_entries_immutable"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_lines_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status "journal_status";
BEGIN
  SELECT "status" INTO v_status FROM "journal_entries"
    WHERE "id" = COALESCE(OLD."journal_entry_id", NEW."journal_entry_id");
  IF v_status = 'POSTED' THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: lines of a posted entry cannot be %', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "journal_lines_no_mutate_posted"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "journal_lines_immutable"();
