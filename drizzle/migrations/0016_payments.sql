CREATE TYPE "public"."payment_status" AS ENUM('POSTED', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'PAYMENT_RECEIVED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'PAYMENT_VOIDED';--> statement-breakpoint
CREATE TABLE "payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_applied" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_applications_payment_invoice_unique" UNIQUE("payment_id","invoice_id"),
	CONSTRAINT "payment_applications_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "payment_applications_amount_positive" CHECK ("payment_applications"."amount_applied" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"deposit_account_id" uuid NOT NULL,
	"method" text,
	"reference" text,
	"memo" text,
	"status" "payment_status" DEFAULT 'POSTED' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_payment_same_company_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payments"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_invoice_same_company_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."invoices"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_same_company_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_deposit_account_same_company_fk" FOREIGN KEY ("company_id","deposit_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_applications_company_invoice_idx" ON "payment_applications" USING btree ("company_id","invoice_id");--> statement-breakpoint
CREATE INDEX "payments_company_customer_idx" ON "payments" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "payments_company_status_idx" ON "payments" USING btree ("company_id","status");