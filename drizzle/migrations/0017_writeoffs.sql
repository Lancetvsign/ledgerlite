CREATE TYPE "public"."writeoff_status" AS ENUM('POSTED', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'WRITEOFF_POSTED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'WRITEOFF_VOIDED';--> statement-breakpoint
ALTER TYPE "public"."journal_source_type" ADD VALUE 'BAD_DEBT_WRITEOFF';--> statement-breakpoint
CREATE TABLE "writeoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"writeoff_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reason" text,
	"status" "writeoff_status" DEFAULT 'POSTED' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writeoffs_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "writeoffs_amount_positive" CHECK ("writeoffs"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "writeoffs" ADD CONSTRAINT "writeoffs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeoffs" ADD CONSTRAINT "writeoffs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeoffs" ADD CONSTRAINT "writeoffs_invoice_same_company_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeoffs" ADD CONSTRAINT "writeoffs_customer_same_company_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writeoffs" ADD CONSTRAINT "writeoffs_expense_account_same_company_fk" FOREIGN KEY ("company_id","expense_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "writeoffs_company_invoice_idx" ON "writeoffs" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE INDEX "writeoffs_company_customer_idx" ON "writeoffs" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "writeoffs_company_status_idx" ON "writeoffs" USING btree ("company_id","status");