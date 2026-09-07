CREATE TYPE "public"."vendor_credit_status" AS ENUM('POSTED', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'VENDOR_CREDIT_ISSUED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'VENDOR_CREDIT_VOIDED';--> statement-breakpoint
ALTER TYPE "public"."journal_source_type" ADD VALUE 'VENDOR_CREDIT';--> statement-breakpoint
CREATE TABLE "vendor_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"credit_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reason" text,
	"status" "vendor_credit_status" DEFAULT 'POSTED' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_credits_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "vendor_credits_amount_positive" CHECK ("vendor_credits"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_bill_same_company_fk" FOREIGN KEY ("company_id","bill_id") REFERENCES "public"."bills"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_vendor_same_company_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_expense_account_same_company_fk" FOREIGN KEY ("company_id","expense_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_credits_company_bill_idx" ON "vendor_credits" USING btree ("company_id","bill_id");--> statement-breakpoint
CREATE INDEX "vendor_credits_company_vendor_idx" ON "vendor_credits" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_credits_company_status_idx" ON "vendor_credits" USING btree ("company_id","status");