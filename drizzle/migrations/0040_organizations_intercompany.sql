ALTER TYPE "public"."audit_action" ADD VALUE 'ORGANIZATION_CREATED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'COMPANY_JOINED_ORGANIZATION';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'COMPANY_LEFT_ORGANIZATION';--> statement-breakpoint
ALTER TYPE "public"."journal_source_type" ADD VALUE 'INTERCOMPANY';--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_name_nonempty" CHECK (length(trim("organizations"."name")) > 0)
);
--> statement-breakpoint
DROP INDEX "accounts_company_system_account_type_key";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "intercompany_company_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_intercompany_company_id_companies_id_fk" FOREIGN KEY ("intercompany_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_organization_idx" ON "companies" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_company_intercompany_pair_key" ON "accounts" USING btree ("company_id","system_account_type","intercompany_company_id") WHERE intercompany_company_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_company_system_account_type_key" ON "accounts" USING btree ("company_id","system_account_type") WHERE system_account_type is not null and intercompany_company_id is null;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_template_not_in_organization" CHECK (not "companies"."is_template" or "companies"."organization_id" is null);--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_member_is_active" CHECK ("companies"."organization_id" is null or "companies"."status" = 'ACTIVE');--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_intercompany_role_pairing" CHECK (("accounts"."intercompany_company_id" is not null) = coalesce("accounts"."system_account_type" in ('INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE'), false));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_intercompany_not_self" CHECK ("accounts"."intercompany_company_id" is distinct from "accounts"."company_id");--> statement-breakpoint
-- LL-096 (ADR-043): the control-account lock extends to the intercompany accounts, as an
-- ALLOW-list. "Due from B" / "Due to A" mirror each other across two companies; that mirror
-- holds only if nothing but an INTERCOMPANY posting (or its REVERSAL) can move them — not a
-- manual journal, not a bank-import category, not a deposit, bill payment, write-off or memo.
-- A/R and A/P keep their existing rule exactly. Both 0037 functions are replaced in place
-- (CREATE OR REPLACE; the triggers are unchanged) — expand-only and idempotent. The source is
-- compared as text because the INTERCOMPANY enum value is added in this same transaction and
-- cannot be referenced as an enum literal until it commits.
CREATE OR REPLACE FUNCTION "assert_no_manual_post_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_system_type text;
  v_source text;
BEGIN
  SELECT "system_account_type" INTO v_system_type
    FROM "accounts"
    WHERE "company_id" = NEW."company_id" AND "id" = NEW."account_id";

  IF v_system_type IS NULL
     OR v_system_type NOT IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE') THEN
    RETURN NEW;
  END IF;

  SELECT "source_type"::text INTO v_source
    FROM "journal_entries"
    WHERE "id" = NEW."journal_entry_id";

  IF v_system_type IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')
     AND v_source IN ('JOURNAL_ENTRY', 'BANK_IMPORT', 'OPENING_BALANCE') THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual, imported or opening-balance entry may not post to a control account (Accounts Receivable / Accounts Payable)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_system_type IN ('INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE')
     AND v_source NOT IN ('INTERCOMPANY', 'REVERSAL') THEN
    RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: only an intercompany posting or its reversal may move an intercompany account (Due from / Due to)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_no_manual_relabel_to_control_account"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'POSTED' THEN
    IF NEW."source_type"::text IN ('JOURNAL_ENTRY', 'BANK_IMPORT', 'OPENING_BALANCE') AND EXISTS (
      SELECT 1
        FROM "journal_lines" l
        JOIN "accounts" a
          ON a."company_id" = l."company_id" AND a."id" = l."account_id"
       WHERE l."journal_entry_id" = NEW."id"
         AND a."system_account_type" IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')
    ) THEN
      RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: a manual, imported or opening-balance entry may not post to a control account (Accounts Receivable / Accounts Payable)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."source_type"::text NOT IN ('INTERCOMPANY', 'REVERSAL') AND EXISTS (
      SELECT 1
        FROM "journal_lines" l
        JOIN "accounts" a
          ON a."company_id" = l."company_id" AND a."id" = l."account_id"
       WHERE l."journal_entry_id" = NEW."id"
         AND a."system_account_type" IN ('INTERCOMPANY_RECEIVABLE', 'INTERCOMPANY_PAYABLE')
    ) THEN
      RAISE EXCEPTION 'CONTROL_ACCOUNT_MANUAL_POST: only an intercompany posting or its reversal may move an intercompany account (Due from / Due to)'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
