CREATE TYPE "public"."bill_status" AS ENUM('DRAFT', 'OPEN', 'PAID', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BILL_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BILL_UPDATED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BILL_FINALIZED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BILL_VOIDED';--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_lines_bill_line_number_unique" UNIQUE("bill_id","line_number"),
	CONSTRAINT "bill_lines_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"bill_number" text,
	"status" "bill_status" DEFAULT 'DRAFT' NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date,
	"memo" text,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "bills_company_number_unique" UNIQUE("company_id","bill_number")
);
--> statement-breakpoint
ALTER TABLE "company_counters" ADD COLUMN "next_bill_number" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_same_company_fk" FOREIGN KEY ("company_id","bill_id") REFERENCES "public"."bills"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_account_same_company_fk" FOREIGN KEY ("company_id","account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_vendor_same_company_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_lines_company_bill_idx" ON "bill_lines" USING btree ("company_id","bill_id");--> statement-breakpoint
CREATE INDEX "bills_company_status_idx" ON "bills" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "bills_company_vendor_idx" ON "bills" USING btree ("company_id","vendor_id");--> statement-breakpoint
-- LL-061 (hand-added data backfill): tag each existing company's standard Accounts
-- Payable account (2000) as the ACCOUNTS_PAYABLE system/control account, so bills can
-- resolve it (the A/P mirror of the A/R system tag). New companies get the tag from the
-- updated default chart (default-coa.ts). The NOT EXISTS guard keeps the
-- (company_id, system_account_type) partial-unique index satisfied.
UPDATE "accounts" SET "system_account_type" = 'ACCOUNTS_PAYABLE'
WHERE "account_number" = '2000'
  AND "account_subtype" = 'accounts_payable'
  AND "system_account_type" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "accounts" a2
    WHERE a2."company_id" = "accounts"."company_id"
      AND a2."system_account_type" = 'ACCOUNTS_PAYABLE'
  );