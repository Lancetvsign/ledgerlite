ALTER TYPE "public"."audit_action" ADD VALUE 'INVOICE_FINALIZED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'INVOICE_VOIDED';--> statement-breakpoint
ALTER TABLE "company_counters" ADD COLUMN "next_invoice_number" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_company_system_account_type_key" ON "accounts" USING btree ("company_id","system_account_type") WHERE system_account_type is not null;--> statement-breakpoint
-- Backfill: flag the standard chart's Sales Tax Payable account as a system
-- account so invoice tax posting (LL-042) can resolve it for companies created
-- before this migration. Matched narrowly (number + name + not-yet-flagged), and
-- there is at most one such account per company, so this cannot violate the
-- unique index created above. New companies get the flag from the updated
-- installer (default-coa.ts); this covers the ones that predate it.
UPDATE "accounts" SET "system_account_type" = 'SALES_TAX_PAYABLE'
WHERE "account_number" = '2200' AND "name" = 'Sales Tax Payable' AND "system_account_type" IS NULL;