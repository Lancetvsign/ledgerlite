CREATE TYPE "public"."period_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "period_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_periods_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_periods_company_dates_idx" ON "accounting_periods" USING btree ("company_id","start_date","end_date");
--> statement-breakpoint
-- Overlap prevention at the DATABASE. btree_gist lets a GiST index mix the
-- equality on company_id with the range-overlap (&&) on the period's date range.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- No two periods in one company may overlap. daterange(..,'[]') is inclusive on
-- both ends, matching the inclusive [start_date, end_date] the app stores. This
-- holds under CONCURRENT inserts — the race an application-level check loses.
ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_no_overlap"
  EXCLUDE USING gist (
    "company_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  );
