CREATE TYPE "public"."bank_import_line_status" AS ENUM('STAGED', 'POSTED', 'IGNORED');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BANK_IMPORT_POSTED';--> statement-breakpoint
ALTER TYPE "public"."journal_source_type" ADD VALUE 'BANK_IMPORT';--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"filename" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_import_batches_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "bank_import_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"txn_date" date NOT NULL,
	"description" text,
	"amount" numeric(19, 4) NOT NULL,
	"ai_category" text,
	"suggested_account_id" uuid,
	"chosen_account_id" uuid,
	"status" "bank_import_line_status" DEFAULT 'STAGED' NOT NULL,
	"dedup_hash" text NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_import_lines_batch_line_number_unique" UNIQUE("batch_id","line_number"),
	CONSTRAINT "bank_import_lines_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_account_same_company_fk" FOREIGN KEY ("company_id","bank_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_batch_same_company_fk" FOREIGN KEY ("company_id","batch_id") REFERENCES "public"."bank_import_batches"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_suggested_account_same_company_fk" FOREIGN KEY ("company_id","suggested_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_chosen_account_same_company_fk" FOREIGN KEY ("company_id","chosen_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_lines" ADD CONSTRAINT "bank_import_lines_entry_same_company_fk" FOREIGN KEY ("company_id","journal_entry_id") REFERENCES "public"."journal_entries"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_import_batches_company_idx" ON "bank_import_batches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_import_lines_company_batch_idx" ON "bank_import_lines" USING btree ("company_id","batch_id");