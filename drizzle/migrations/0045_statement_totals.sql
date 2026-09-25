ALTER TABLE "bank_import_batches" ADD COLUMN "stated_beginning_balance" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "stated_total_credits" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "stated_total_debits" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "stated_ending_balance" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD COLUMN "extraction_attempts" integer DEFAULT 1 NOT NULL;