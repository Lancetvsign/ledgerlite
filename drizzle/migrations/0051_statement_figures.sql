ALTER TYPE "public"."audit_action" ADD VALUE 'BANK_IMPORT_SUMMARY_AMENDED';--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "stated_figures" jsonb;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "summary_amended_from" jsonb;