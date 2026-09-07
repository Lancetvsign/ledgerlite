CREATE TYPE "public"."bill_payment_status" AS ENUM('POSTED', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BILL_PAYMENT_MADE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'BILL_PAYMENT_VOIDED';--> statement-breakpoint
ALTER TYPE "public"."journal_source_type" ADD VALUE 'BILL_PAYMENT';--> statement-breakpoint
CREATE TABLE "bill_payment_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_payment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount_applied" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_payment_applications_payment_bill_unique" UNIQUE("bill_payment_id","bill_id"),
	CONSTRAINT "bill_payment_applications_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "bill_payment_applications_amount_positive" CHECK ("bill_payment_applications"."amount_applied" > 0)
);
--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"method" text,
	"reference" text,
	"memo" text,
	"status" "bill_payment_status" DEFAULT 'POSTED' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_payments_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "bill_payments_amount_positive" CHECK ("bill_payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "bill_payment_applications" ADD CONSTRAINT "bill_payment_applications_payment_same_company_fk" FOREIGN KEY ("company_id","bill_payment_id") REFERENCES "public"."bill_payments"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payment_applications" ADD CONSTRAINT "bill_payment_applications_bill_same_company_fk" FOREIGN KEY ("company_id","bill_id") REFERENCES "public"."bills"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_vendor_same_company_fk" FOREIGN KEY ("company_id","vendor_id") REFERENCES "public"."vendors"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_cash_account_same_company_fk" FOREIGN KEY ("company_id","cash_account_id") REFERENCES "public"."accounts"("company_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_payment_applications_company_bill_idx" ON "bill_payment_applications" USING btree ("company_id","bill_id");--> statement-breakpoint
CREATE INDEX "bill_payments_company_vendor_idx" ON "bill_payments" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE INDEX "bill_payments_company_status_idx" ON "bill_payments" USING btree ("company_id","status");--> statement-breakpoint
-- LL-062 (hand-added): generalize the A/R control-account guard (0018) to cover the
-- A/P control account too. A/P is now moved solely by documents (bills, bill payments,
-- and — LL-063 — vendor credits) and their reversals; a manual JOURNAL_ENTRY line into
-- either control account (A/R or A/P) is rejected structurally, so the aging⇔control tie
-- holds even when the application is bypassed. Replaces the A/R-only function/trigger with
-- a generically-named control-account guard (AGENTS §0 — the name matches what it does).
DROP TRIGGER "journal_lines_no_manual_ar_post" ON "journal_lines";--> statement-breakpoint
DROP FUNCTION "assert_no_manual_post_to_ar"();--> statement-breakpoint
CREATE FUNCTION "assert_no_manual_post_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_system_type text;
  v_source "journal_source_type";
BEGIN
  SELECT "system_account_type" INTO v_system_type
    FROM "accounts"
    WHERE "company_id" = NEW."company_id" AND "id" = NEW."account_id";

  -- Only control accounts that HAVE a subsidiary ledger are guarded: A/R and A/P.
  -- Other system accounts (Sales Tax Payable, Retained Earnings, Opening Balance
  -- Equity) stay manually postable — legitimate for tax corrections, year-end
  -- closing, and opening balances.
  IF v_system_type IS NULL
     OR v_system_type NOT IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE') THEN
    RETURN NEW;
  END IF;

  SELECT "source_type" INTO v_source
    FROM "journal_entries"
    WHERE "id" = NEW."journal_entry_id";

  IF v_source = 'JOURNAL_ENTRY' THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual journal entry may not post to a control account (Accounts Receivable / Accounts Payable)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "journal_lines_no_manual_control_post"
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW
  EXECUTE FUNCTION "assert_no_manual_post_to_control_account"();