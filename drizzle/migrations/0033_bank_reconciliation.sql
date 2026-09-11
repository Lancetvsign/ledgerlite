CREATE TYPE "public"."reconciliation_status" AS ENUM('IN_PROGRESS', 'COMPLETED');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RECONCILIATION_STARTED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RECONCILIATION_COMPLETED';--> statement-breakpoint
CREATE TABLE "bank_reconciliation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliation_lines_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "bank_reconciliation_lines_line_once_unique" UNIQUE("company_id","journal_line_id")
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"statement_date" date NOT NULL,
	"statement_ending_amount" numeric(19, 4) NOT NULL,
	"status" "reconciliation_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bank_reconciliations_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "bank_reconciliations_company_id_account_unique" UNIQUE("company_id","id","bank_account_id"),
	CONSTRAINT "bank_reconciliations_account_statement_unique" UNIQUE("company_id","bank_account_id","statement_date"),
	CONSTRAINT "bank_reconciliations_completed_stamp" CHECK (("bank_reconciliations"."status" = 'COMPLETED') = ("bank_reconciliations"."completed_at" is not null and "bank_reconciliations"."completed_by" is not null))
);
--> statement-breakpoint
-- The composite FK below references (company_id, id, account_id) on journal_lines, so that
-- unique must exist FIRST (drizzle-kit emitted it last; reordered by hand — same statements).
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_id_account_unique" UNIQUE("company_id","id","account_id");--> statement-breakpoint
ALTER TABLE "bank_reconciliation_lines" ADD CONSTRAINT "bank_reconciliation_lines_reconciliation_same_account_fk" FOREIGN KEY ("company_id","reconciliation_id","bank_account_id") REFERENCES "public"."bank_reconciliations"("company_id","id","bank_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_lines" ADD CONSTRAINT "bank_reconciliation_lines_line_same_account_fk" FOREIGN KEY ("company_id","journal_line_id","bank_account_id") REFERENCES "public"."journal_lines"("company_id","id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_account_same_company_fk" FOREIGN KEY ("company_id","bank_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_reconciliation_lines_recon_idx" ON "bank_reconciliation_lines" USING btree ("company_id","reconciliation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliations_one_in_progress" ON "bank_reconciliations" USING btree ("company_id","bank_account_id") WHERE "bank_reconciliations"."status" = 'IN_PROGRESS';--> statement-breakpoint
CREATE INDEX "bank_reconciliations_company_account_idx" ON "bank_reconciliations" USING btree ("company_id","bank_account_id","statement_date");
