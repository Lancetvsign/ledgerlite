ALTER TYPE "public"."audit_action" ADD VALUE 'COMPANY_UPDATED';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_one_template" ON "companies" USING btree ("is_template") WHERE "companies"."is_template" = true;