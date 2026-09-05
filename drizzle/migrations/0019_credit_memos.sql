CREATE TYPE "public"."credit_memo_status" AS ENUM('POSTED', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CREDIT_MEMO_ISSUED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CREDIT_MEMO_VOIDED';--> statement-breakpoint
CREATE TABLE "credit_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"revenue_account_id" uuid NOT NULL,
	"credit_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reason" text,
	"status" "credit_memo_status" DEFAULT 'POSTED' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_memos_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "credit_memos_amount_positive" CHECK ("credit_memos"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_invoice_same_company_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_customer_same_company_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_memos" ADD CONSTRAINT "credit_memos_revenue_account_same_company_fk" FOREIGN KEY ("company_id","revenue_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_memos_company_invoice_idx" ON "credit_memos" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE INDEX "credit_memos_company_customer_idx" ON "credit_memos" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "credit_memos_company_status_idx" ON "credit_memos" USING btree ("company_id","status");