CREATE TYPE "public"."vendor_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'VENDOR_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'VENDOR_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'VENDOR_DEACTIVATED';--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_number" text,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"notes" text,
	"status" "vendor_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "vendors_company_number_unique" UNIQUE("company_id","vendor_number")
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendors_company_name_idx" ON "vendors" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_vendor_same_company_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE restrict ON UPDATE no action;