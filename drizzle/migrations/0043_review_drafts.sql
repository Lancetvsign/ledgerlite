CREATE TYPE "public"."bank_import_draft_action" AS ENUM('post', 'ignore', 'apply_invoice', 'apply_bill', 'match_transfer', 'personal', 'intercompany_transfer', 'match_intercompany', 'take', 'skip');--> statement-breakpoint
CREATE TABLE "bank_import_line_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"action" "bank_import_draft_action" NOT NULL,
	"account_id" uuid,
	"document_id" uuid,
	"counterpart_company_id" uuid,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_import_line_drafts_line_company_unique" UNIQUE("line_id","company_id")
);
--> statement-breakpoint
ALTER TABLE "bank_import_line_drafts" ADD CONSTRAINT "bank_import_line_drafts_line_id_bank_import_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."bank_import_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_line_drafts" ADD CONSTRAINT "bank_import_line_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_line_drafts" ADD CONSTRAINT "bank_import_line_drafts_counterpart_company_id_companies_id_fk" FOREIGN KEY ("counterpart_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_line_drafts" ADD CONSTRAINT "bank_import_line_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_line_drafts" ADD CONSTRAINT "bank_import_line_drafts_account_same_company_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_import_line_drafts_company_line_idx" ON "bank_import_line_drafts" USING btree ("company_id","line_id");-- ===========================================================================
-- LL-105 (ADR-045) — review drafts live only while a line is STAGED, structurally.
--
-- A draft is a reviewer's saved-but-not-posted choice for one staged line, kept per
-- drafting company. It must never describe a line that has already been decided: the
-- moment a line leaves STAGED (posted, ignored, personal, taken by another company, marked
-- or matched as a transfer — by any service, today's or tomorrow's) every draft of it is
-- dropped, and a draft can never be written for a decided line in the first place. Status is
-- compared as text (the migrator runs all pending files in one transaction). Idempotent
-- (CREATE OR REPLACE + DROP TRIGGER IF EXISTS) for the CI clean-slate replay.
-- ===========================================================================
CREATE OR REPLACE FUNCTION "bank_import_line_drafts_drop_when_decided"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status"::text <> 'STAGED' THEN
    DELETE FROM "bank_import_line_drafts" WHERE "line_id" = NEW."id";
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bank_import_lines_drop_drafts_when_decided" ON "bank_import_lines";
--> statement-breakpoint
CREATE TRIGGER "bank_import_lines_drop_drafts_when_decided"
  AFTER UPDATE OF "status" ON "bank_import_lines"
  FOR EACH ROW
  WHEN (NEW."status"::text <> 'STAGED')
  EXECUTE FUNCTION "bank_import_line_drafts_drop_when_decided"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_draft_line_is_staged"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "bank_import_lines" WHERE "id" = NEW."line_id";
  IF v_status IS DISTINCT FROM 'STAGED' THEN
    RAISE EXCEPTION 'DRAFT_LINE_NOT_STAGED: a review draft may only describe a STAGED import line'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bank_import_line_drafts_only_staged" ON "bank_import_line_drafts";
--> statement-breakpoint
CREATE TRIGGER "bank_import_line_drafts_only_staged"
  BEFORE INSERT OR UPDATE ON "bank_import_line_drafts"
  FOR EACH ROW EXECUTE FUNCTION "assert_draft_line_is_staged"();
