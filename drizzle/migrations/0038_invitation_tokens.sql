ALTER TYPE "public"."audit_action" ADD VALUE 'INVITATION_LINK_ISSUED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'INVITATION_CLAIMED';--> statement-breakpoint
ALTER TABLE "company_invitations" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "company_invitations" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "company_invitations_token_hash_unique" ON "company_invitations" USING btree ("token_hash") WHERE "company_invitations"."token_hash" is not null;