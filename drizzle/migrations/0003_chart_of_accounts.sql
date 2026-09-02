CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_number" text,
	"name" text NOT NULL,
	"account_type" "account_type" NOT NULL,
	"account_subtype" text,
	"parent_account_id" uuid,
	"system_account_type" text,
	"description" text,
	"status" "account_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "accounts_company_number_unique" UNIQUE("company_id","account_number"),
	CONSTRAINT "accounts_no_self_parent" CHECK ("accounts"."parent_account_id" is distinct from "accounts"."id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_company_type_idx" ON "accounts" USING btree ("company_id","account_type");--> statement-breakpoint
CREATE INDEX "accounts_company_parent_idx" ON "accounts" USING btree ("company_id","parent_account_id");
--> statement-breakpoint
-- THE composite parent foreign key. Makes a cross-company parent STRUCTURALLY
-- IMPOSSIBLE rather than a rule the service must remember: (company_id,
-- parent_account_id) must reference a row sharing this account's company_id.
-- Drizzle's single-column .references() cannot express a two-column FK, so it
-- is written here by hand against the (company_id, id) unique. ON DELETE
-- RESTRICT: a referenced parent can never be hard deleted (ADR-006).
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_parent_same_company_fk"
  FOREIGN KEY ("company_id", "parent_account_id")
  REFERENCES "accounts" ("company_id", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
